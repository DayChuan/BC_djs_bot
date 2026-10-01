import {getState, updateState, registerRestore} from '@/core/state'
import {scheduleCron} from '@/core/scheduler'
import logger from '@/core/logger'
import config from '@/config'
import {
    ROOM_NAME_SUFFIX,
    ROOM_NAME_MAX_LENGTH,
    ROOM_NAME_FALLBACK,
    CREATE_COOLDOWN_SECONDS,
    SWEEP_CRON,
} from '@/config/voiceRoom'

//動態語音頻道(U13)：有人點進大廳，幫他開一間專屬房間並拉過去；房間沒人就刪掉。
//
//這裡刻意不 import discord.js(同 vmute.js)—— guild / member / client 一律由呼叫端傳進來，
//純邏輯的部分才能寫單元測試(測試檔只要碰到 discord.js，測試 jail 就會卡住跑不完)。
//因此 discord.js 的常數在下面直接寫值。
//
//⚠️ 本檔最危險的是「刪頻道」：Discord 的頻道刪了救不回來，伺服器上又有很多原有的靜態語音頻道。
//所有刪除都只走 cleanupRoom() 這一條路，判斷集中在純函式 decideCleanup()，
//三道防線(不在紀錄裡不碰、永遠不刪大廳、型別不對不刪)分開寫，不要合併、不要改成看名稱。
//每一次判斷的依據與結果都寫進 log —— 判斷拿到錯的輸入時，log 上要看得出來。

export const SECTION = 'voiceRooms'
export const SWEEP_KEY = 'voiceRoom:sweep'

//ChannelType.GuildVoice。不用 isVoiceBased()：那個連舞台頻道也算，我們開的房間只會是一般語音。
export const GUILD_VOICE = 2

//RESTJSONErrorCodes.UnknownChannel。房主有 ManageChannels，可能自己先把房間刪掉。
const UNKNOWN_CHANNEL = 10003

//房主在自己房間的權限(交接文件指定)。字串形式 discord.js 收得進去。
const OWNER_PERMISSIONS = ['ViewChannel', 'Connect', 'ManageChannels', 'MoveMembers']

//bot 自己需要的權限，開機時檢查。
const BOT_PERMISSIONS = ['ManageChannels', 'MoveMembers']

/////////////////////////// 純函式(可單獨做單元測試) ///////////////////////////

//房名 = displayName + 後綴，總長不超過上限。截的是 displayName，後綴永遠保留。
//以 UTF-16 長度計(.length)，並且整個字元整個字元地加，不會把 emoji 的代理對切成一半。
export const buildRoomName = (displayName) => {
    const base = String(displayName || '').trim() || ROOM_NAME_FALLBACK
    const room = ROOM_NAME_MAX_LENGTH - ROOM_NAME_SUFFIX.length
    let name = ''
    for(const ch of base){
        if(name.length + ch.length > room) break
        name += ch
    }
    return `${name}${ROOM_NAME_SUFFIX}`
}

//所有伺服器的大廳 id。比對大廳時用「全部的大廳」而不是「這個伺服器的大廳」——
//guildId 傳錯時，後者會安靜地比對不到，大廳就失去了保護。
export const lobbyIdsOf = (lobbies = config.voiceLobbies) =>
    Object.values(lobbies || {}).filter(Boolean).map(String)

export const lobbyIdOf = (guildId, lobbies = config.voiceLobbies) => {
    const id = (lobbies || {})[guildId]
    return id ? String(id) : null
}

//要不要刪這個頻道。輸出 {action, reason}：
//  delete  刪頻道 ＋ 刪紀錄
//  forget  只刪紀錄，絕不刪頻道
//  keep    什麼都不做
//輸入有任何一項不合法，一律 keep —— 拿到錯的輸入時寧可留著空房間，也不能刪錯。
//exists / isVoice 必須是真正的 true / false，undefined 不會被當成 false。
export const decideCleanup = ({record, guildId, channelId, lobbyIds, exists, isVoice, memberCount} = {}) => {
    if(!channelId) return {action: 'keep', reason: 'bad-input:channelId'}
    if(!Array.isArray(lobbyIds)) return {action: 'keep', reason: 'bad-input:lobbyIds'}

    //① 不在我們的紀錄裡 → 絕對不碰
    if(!record) return {action: 'keep', reason: 'not-tracked'}
    if(record.guildId !== guildId) return {action: 'keep', reason: 'guild-mismatch'}

    //② 永遠不刪大廳本身。大廳出現在紀錄裡本來就不該發生，紀錄清掉，頻道不動
    if(lobbyIds.includes(String(channelId))) return {action: 'forget', reason: 'is-lobby'}

    if(exists === false) return {action: 'forget', reason: 'gone'}
    if(exists !== true) return {action: 'keep', reason: 'bad-input:exists'}

    //③ 型別不對就不刪
    if(isVoice === false) return {action: 'forget', reason: 'not-voice'}
    if(isVoice !== true) return {action: 'keep', reason: 'bad-input:isVoice'}

    if(!Number.isInteger(memberCount) || memberCount < 0) return {action: 'keep', reason: 'bad-input:memberCount'}
    if(memberCount > 0) return {action: 'keep', reason: 'occupied'}

    return {action: 'delete', reason: 'empty'}
}

//點進大廳時要做什麼：
//  move-existing  他已經有房間 → 搬回去，不開第二間(優先於 cooldown)
//  skip           cooldown 內 → 不建立
//  create         開新房間
export const decideJoin = ({existingRoomId, lastCreatedAt, now = Date.now(), cooldownSeconds = CREATE_COOLDOWN_SECONDS} = {}) => {
    if(existingRoomId) return {action: 'move-existing', reason: 'has-room'}
    const last = Number(lastCreatedAt)
    if(lastCreatedAt !== undefined && lastCreatedAt !== null && Number.isFinite(last)
        && now - last < cooldownSeconds * 1000){
        return {action: 'skip', reason: 'cooldown'}
    }
    return {action: 'create', reason: 'no-room'}
}

//這個人在這個伺服器的房間 id，沒有就 null。
export const findRoomByOwner = (records, guildId, ownerId) => {
    for(const [channelId, record] of Object.entries(records || {})){
        if(record && record.guildId === guildId && record.ownerId === ownerId) return channelId
    }
    return null
}

/////////////////////////////// state 讀寫 ///////////////////////////////

//紀錄以 channelId 為 key：{guildId, ownerId, createdAt}
export const readRooms = async() => await getState(SECTION)

const saveRoom = async(channelId, record) => await updateState(SECTION, (current) => {
    current[channelId] = record
    return current
})

const removeRoom = async(channelId) => await updateState(SECTION, (current) => {
    delete current[channelId]
    return current
})

/////////////////////////////// Discord 操作 ///////////////////////////////

//抓頻道，分清楚「確定不存在」與「暫時抓不到」——
//後者若當成不存在，紀錄會被丟掉，那間房就再也沒有人記得要刪。
const fetchChannel = async(guild, channelId) => {
    try{
        const channel = await guild.channels.fetch(channelId)
        return channel ? {status: 'ok', channel} : {status: 'gone'}
    }
    catch(e){
        if(e && e.code === UNKNOWN_CHANNEL) return {status: 'gone'}
        return {status: 'error', error: e}
    }
}

//唯一會刪頻道的地方。trigger 只用來寫 log(leave / sweep / move-failed)。
//回傳最後採取的 action，給定期清理統計用。
export const cleanupRoom = async(guild, channelId, trigger) => {
    const guildId = guild && guild.id
    const records = await readRooms()
    const record = records[channelId] || null
    const lobbyIds = lobbyIdsOf()

    //不在紀錄裡就不必去抓頻道(判斷第一關就會 keep)
    let exists = null
    let isVoice = null
    let memberCount = null
    let channel = null
    if(record){
        const probe = await fetchChannel(guild, channelId)
        if(probe.status === 'error'){
            logger.warn(`voiceRoom 清理(${trigger}) 抓不到頻道 ${channelId}，這次不判斷、紀錄保留：`, probe.error)
            return 'keep'
        }
        exists = probe.status === 'ok'
        if(exists){
            channel = probe.channel
            isVoice = channel.type === GUILD_VOICE
            memberCount = channel.members ? channel.members.size : undefined
        }
    }

    const {action, reason} = decideCleanup({record, guildId, channelId, lobbyIds, exists, isVoice, memberCount})
    logger.info(
        `voiceRoom 清理判斷(${trigger}) guild=${guildId} channel=${channelId} ` +
        `紀錄=${record ? `有(owner=${record.ownerId} guild=${record.guildId})` : '無'} ` +
        `大廳=[${lobbyIds.join(',')}] 存在=${exists} 型別=${channel ? channel.type : '-'} 人數=${memberCount} ` +
        `→ ${action}(${reason})`
    )

    if(action === 'forget'){
        await removeRoom(channelId)
        return action
    }
    if(action !== 'delete') return action

    try{
        await channel.delete(`動態語音房間已無人(${trigger})`)
        logger.info(`voiceRoom 已刪除房間 ${channelId}「${channel.name}」`)
    }
    catch(e){
        if(!(e && e.code === UNKNOWN_CHANNEL)){
            //刪不掉就留著紀錄，下次定期清理再試
            logger.warn(`voiceRoom 刪除房間 ${channelId} 失敗，紀錄保留待下次清理：`, e)
            return 'keep'
        }
        logger.info(`voiceRoom 房間 ${channelId} 已不存在(可能是房主自己刪的)，只清紀錄`)
    }
    await removeRoom(channelId)
    return action
}

//每人最後一次「開始建立房間」的時間。只是保險，不需要撐過重啟。
const lastCreated = new Map()
const cooldownKey = (guildId, userId) => `${guildId}:${userId}`

//把大廳的權限覆寫抄給新房間，再加上房主的。
//建立頻道時有給 permissionOverwrites 就不會繼承 Category，
//不抄的話，原本只開放給特定身分組看的分類底下會多出一間所有人都看得到的房間。
const buildOverwrites = (lobby, ownerId) => {
    const overwrites = [...lobby.permissionOverwrites.cache.values()]
        .filter((o) => o.id !== ownerId)
        .map((o) => ({id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield}))
    overwrites.push({id: ownerId, allow: OWNER_PERMISSIONS})
    return overwrites
}

const moveTo = async(member, channel, why) => {
    await member.voice.setChannel(channel, why)
}

const handleLobbyJoin = async(member, guild, lobbyId) => {
    const key = cooldownKey(guild.id, member.id)
    const now = Date.now()

    let existingId = findRoomByOwner(await readRooms(), guild.id, member.id)
    let existing = null
    if(existingId){
        const probe = await fetchChannel(guild, existingId)
        if(probe.status === 'ok') existing = probe.channel
        else if(probe.status === 'gone'){
            //紀錄還在但房間已經沒了 → 清紀錄，當作沒有房間
            logger.info(`voiceRoom ${member.id} 的房間 ${existingId} 已不存在，清掉紀錄後重新判斷`)
            await removeRoom(existingId)
            existingId = null
        }
        else{
            logger.warn(`voiceRoom 抓不到 ${member.id} 的既有房間 ${existingId}，這次不處理：`, probe.error)
            return
        }
    }

    const {action, reason} = decideJoin({existingRoomId: existingId, lastCreatedAt: lastCreated.get(key), now})
    logger.info(
        `voiceRoom 大廳判斷 guild=${guild.id} user=${member.id} 既有房間=${existingId || '無'} ` +
        `上次建立=${lastCreated.has(key) ? new Date(lastCreated.get(key)).toISOString() : '無'} → ${action}(${reason})`
    )

    if(action === 'skip') return

    if(action === 'move-existing'){
        try{
            await moveTo(member, existing, '動態語音：回到自己的房間')
        }
        catch(e){
            logger.warn(`voiceRoom 搬 ${member.id} 回房間 ${existingId} 失敗：`, e)
        }
        return
    }

    //先記時間再 await —— 建立途中又觸發一次時，第二次會被 cooldown 擋下
    lastCreated.set(key, now)

    const lobbyProbe = await fetchChannel(guild, lobbyId)
    if(lobbyProbe.status !== 'ok'){
        logger.error(`voiceRoom 找不到大廳 ${lobbyId}(guild=${guild.id})，無法開房：`, lobbyProbe.error || lobbyProbe.status)
        return
    }
    const lobby = lobbyProbe.channel

    let channel = null
    try{
        channel = await guild.channels.create({
            name: buildRoomName(member.displayName),
            type: GUILD_VOICE,
            parent: lobby.parentId || null,
            permissionOverwrites: buildOverwrites(lobby, member.id),
            reason: `動態語音：${member.user ? member.user.username : member.id} 進入大廳`,
        })
    }
    catch(e){
        //多半是缺 ManageChannels。這時什麼都還沒建，不用收拾
        logger.error(`voiceRoom 建立房間失敗(guild=${guild.id} user=${member.id})：`, e)
        return
    }

    //先寫紀錄再搬人：搬失敗時要走 cleanupRoom 刪掉，而 cleanupRoom 只刪紀錄裡有的頻道。
    try{
        await saveRoom(channel.id, {guildId: guild.id, ownerId: member.id, createdAt: new Date(now).toISOString()})
    }
    catch(e){
        //不在紀錄裡的頻道我們一律不刪，這間只能手動處理
        logger.error(`voiceRoom 房間 ${channel.id} 已建立但紀錄寫入失敗，需手動刪除：`, e)
        return
    }
    logger.info(`voiceRoom 已建立房間 ${channel.id}「${channel.name}」owner=${member.id}`)

    try{
        await moveTo(member, channel, '動態語音：進入自己的房間')
    }
    catch(e){
        //搬不過去(人已經走了、缺 MoveMembers)→ 這間是空的，而且不會再有人觸發「離開」，馬上收掉
        logger.warn(`voiceRoom 搬 ${member.id} 進房間 ${channel.id} 失敗，立刻清理：`, e)
        await cleanupRoom(guild, channel.id, 'move-failed')
    }
}

//voiceStateUpdate 的入口。沒設定大廳的伺服器不做任何事(也不寫 log，那是設定上刻意關閉的)。
export const handleDynamicVoice = async(oldState, newState) => {
    const guild = newState.guild || oldState.guild
    if(!guild) return
    const lobbyId = lobbyIdOf(guild.id)
    if(!lobbyId) return

    //離開(或換走)某個頻道 → 看看那間是不是我們的空房間
    if(oldState.channelId && oldState.channelId !== newState.channelId){
        await cleanupRoom(guild, oldState.channelId, 'leave')
    }

    //進入大廳 → 開房或搬回既有房間。bot 自己不算
    if(newState.channelId === lobbyId && oldState.channelId !== lobbyId){
        const member = newState.member
        if(!member || (member.user && member.user.bot)) return
        await handleLobbyJoin(member, guild, lobbyId)
    }
}

/////////////////////////////// 開機與定期清理 ///////////////////////////////

//開機與每 10 分鐘都跑這一支(同一支，不要寫兩份)。
//補 bot 離線期間、或 gateway 斷線期間漏掉的「最後一人離開」。
export const sweep = async(client) => {
    const records = await readRooms()
    const counts = {}

    for(const [channelId, record] of Object.entries(records)){
        if(!record || !record.guildId){
            logger.warn(`voiceRoom 紀錄 ${channelId} 格式不對，清掉紀錄(不動頻道)：`, record)
            await removeRoom(channelId)
            continue
        }
        const guild = client.guilds.cache.get(record.guildId)
            || await client.guilds.fetch(record.guildId).catch(() => null)
        if(!guild){
            logger.warn(`voiceRoom 清理抓不到伺服器 ${record.guildId}，房間 ${channelId} 紀錄保留`)
            continue
        }
        const action = await cleanupRoom(guild, channelId, 'sweep')
        counts[action] = (counts[action] || 0) + 1
    }

    const total = Object.keys(records).length
    if(total) logger.info(`voiceRoom 定期清理：紀錄 ${total} 筆，結果 ${JSON.stringify(counts)}`)
}

//開機檢查 bot 在各大廳伺服器的權限。只警告，不擋。
const checkPermissions = async(client) => {
    for(const [guildId, lobbyId] of Object.entries(config.voiceLobbies || {})){
        const guild = client.guilds.cache.get(guildId)
        const me = guild && guild.members.me
        if(!me){
            logger.warn(`voiceRoom 啟用中的伺服器 ${guildId} 找不到(bot 不在裡面？)`)
            continue
        }
        const missing = BOT_PERMISSIONS.filter((p) => !me.permissions.has(p))
        if(missing.length) logger.warn(`voiceRoom 伺服器 ${guildId} 的 bot 缺少權限：${missing.join(', ')}，開房會失敗`)
        logger.info(`voiceRoom 啟用：guild=${guildId} 大廳=${lobbyId}`)
    }
}

export const restore = async(client) => {
    await checkPermissions(client)
    await sweep(client)
    scheduleCron(SWEEP_KEY, SWEEP_CRON, () => sweep(client))
}

//登記制。ready 事件會呼叫 runRestores，所以不需要改 events/ready/index.js。
registerRestore(SECTION, restore)

export default {
    SECTION,
    SWEEP_KEY,
    GUILD_VOICE,
    buildRoomName,
    lobbyIdsOf,
    lobbyIdOf,
    decideCleanup,
    decideJoin,
    findRoomByOwner,
    readRooms,
    cleanupRoom,
    handleDynamicVoice,
    sweep,
    restore,
}
