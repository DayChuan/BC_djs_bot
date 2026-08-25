import {getState, updateState, registerRestore} from '@/core/state'
import {scheduleAt, cancel} from '@/core/scheduler'
import logger from '@/core/logger'

//語音暫時靜音的本體。這裡刻意不 import discord.js —— 需要的 member / client
//一律由呼叫端傳進來，這樣純邏輯的部分才能寫單元測試
//(測試檔只要直接或間接 import 到 discord.js，測試 jail 就會卡住跑不完)。
//
//這是「伺服器靜音」，不是 Discord 內建的 timeout：內建 timeout 到期由 Discord 端處理，
//伺服器靜音則是改了成員身上的一個旗標，不解除就會一直留著，所以到期時間必須自己記，
//而且要撐過重啟 —— 這就是本單元依賴 U03(state.js)的原因。

export const SECTION = 'vmute'

//六個級距。指令的 addChoices 與這裡共用同一份，Discord 端擋掉的東西
//直接打 API 還是進得來，所以伺服器端要再驗一次。
export const ALLOWED_SECONDS = [60, 120, 180, 240, 300, 600]

/////////////////////////// 純函式(可單獨做單元測試) ///////////////////////////

//同時當 state 的 key 與 scheduler 的 key。scheduler 的 key 是全域共用的，
//所以要帶 vmute: 前綴，不能只用 guildId:userId。
export const muteKey = (guildId, userId) => `vmute:${guildId}:${userId}`

export const parseSeconds = (value) => {
    const seconds = Number(value)
    if(!Number.isInteger(seconds)) return null
    return ALLOWED_SECONDS.includes(seconds) ? seconds : null
}

//剩餘毫秒。時間壞掉或沒有 until 一律當成 0(已到期)——
//算不出來的紀錄留著只會變成永遠不會到期的殭屍。
export const remainMs = (entry, now = Date.now()) => {
    const until = new Date(entry && entry.until).getTime()
    if(!Number.isFinite(until)) return 0
    return Math.max(0, until - now)
}

export const isExpired = (entry, now = Date.now()) => remainMs(entry, now) <= 0

//pending = 時間到了但當下解不掉(人不在語音)，還欠他一次解除。
//伺服器靜音是掛在「成員」身上而不是掛在頻道上，所以他換到哪個語音頻道都還是靜音的；
//因此這裡只比對 guild，不比對頻道 —— 比對頻道的話，離開後改進別的頻道就永遠對不上，
//那筆紀錄會永遠解不掉。
export const shouldUnmuteOnJoin = (entry, guildId) =>
    Boolean(entry && entry.pending && entry.guildId === guildId)

//解除靜音的權限判斷集中在這裡。
//測試期依使用者要求全面開放(沒指定對象就是解除自己)。
//之後要改成「限具靜音成員權限的人，或限本人」時**只改這個函式**，
//指令檔只認 ok 與 reason，不自己判斷權限。
export const canUnmute = () => ({ok: true, reason: null})

/////////////////////////////// state 讀寫 ///////////////////////////////

export const readEntries = async() => await getState(SECTION)

export const readEntry = async(guildId, userId) => {
    const entries = await readEntries()
    return entries[muteKey(guildId, userId)] || null
}

const saveEntry = async(key, entry) => await updateState(SECTION, (current) => {
    current[key] = entry
    return current
})

const removeEntry = async(key) => await updateState(SECTION, (current) => {
    delete current[key]
    return current
})

/////////////////////////////// 靜音與解除 ///////////////////////////////

//抓不到就回 null。呼叫端不會因此刪掉紀錄 —— 暫時抓不到(網路、快取)就把紀錄丟掉的話，
//那個人身上的靜音就再也沒有人記得要解除了。
const fetchMember = async(client, guildId, userId) => {
    try{
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId)
        return await guild.members.fetch(userId)
    }
    catch(e){
        logger.warn(`vmute 取不到成員 ${guildId}/${userId}(紀錄保留)：`, e)
        return null
    }
}

//靜音。setMute 失敗時直接往外拋，由指令端給友善訊息 ——
//這種情況下不能寫 state，否則會留下一筆「其實沒靜音成功」的到期紀錄。
export const mute = async(member, {seconds, reason = null, by = null}, now = Date.now()) => {
    const key = muteKey(member.guild.id, member.id)

    //覆蓋而不是疊加：先取消舊排程，state 整筆換掉。
    cancel(key)
    await member.voice.setMute(true, reason || '語音暫時靜音')

    const entry = {
        guildId: member.guild.id,
        userId: member.id,
        until: new Date(now + seconds * 1000).toISOString(),
        seconds,
        reason,
        by,
    }
    await saveEntry(key, entry)
    scheduleAt(key, entry.until, () => expire(member.client, entry))
    return entry
}

//解除靜音。回傳 status：
//  done    已解除，紀錄已清掉
//  pending 當下解不掉(人不在語音)，紀錄留著標記 pending，等他下次進語音再解
//  failed  權限不足(50013)，紀錄留著標記 pending，讓人補權限後還有機會解掉
export const unmute = async(client, entry, reason = '解除語音靜音') => {
    const key = muteKey(entry.guildId, entry.userId)
    cancel(key)

    const member = await fetchMember(client, entry.guildId, entry.userId)
    if(!member || !member.voice.channelId){
        await saveEntry(key, {...entry, pending: true})
        return {status: 'pending', member}
    }

    try{
        await member.voice.setMute(false, reason)
        await removeEntry(key)
        return {status: 'done', member}
    }
    catch(e){
        await saveEntry(key, {...entry, pending: true})
        if(e && e.code === 50013){
            logger.error(`vmute 解除失敗(權限不足) ${key}：`, e)
            return {status: 'failed', member, error: e}
        }
        //人剛好在這一瞬間離開語音(40032)等情況：吞掉只記 log，紀錄轉 pending。
        //這裡絕對不能往外拋 —— 呼叫端之一是排程器，那裡的 rejection 沒人接得到。
        logger.warn(`vmute 解除未成功，轉為待解除 ${key}：`, e)
        return {status: 'pending', member, error: e}
    }
}

//到期時由排程呼叫。scheduler 的 runSafely 已經包了一層，這裡再記一則好追。
const expire = async(client, entry) => {
    const result = await unmute(client, entry, '語音靜音時間到期')
    const key = muteKey(entry.guildId, entry.userId)
    if(result.status === 'done') logger.info(`vmute 到期已解除：${key}`)
    else logger.warn(`vmute 到期未能解除(${result.status})，待他下次進語音時解除：${key}`)
}

//有人進入(或切換)語音頻道時呼叫。這是唯一能得知「他回來了」的時機。
export const handleVoiceJoin = async(client, guildId, userId) => {
    const entry = await readEntry(guildId, userId)
    if(!shouldUnmuteOnJoin(entry, guildId)) return false

    const result = await unmute(client, entry, '待解除的語音靜音，重新進入語音時解除')
    if(result.status === 'done'){
        logger.info(`vmute 待解除已補上：${muteKey(guildId, userId)}`)
        return true
    }
    return false
}

/////////////////////////////// 開機還原 ///////////////////////////////

//記憶體裡的一次性排程重啟時全部消失，state.json 還在。
//少了這一步，重啟過的靜音就永遠等不到到期。
export const restore = async(client) => {
    const entries = await readEntries()
    let scheduled = 0
    let released = 0

    for(const [key, entry] of Object.entries(entries)){
        if(!entry || !entry.guildId || !entry.userId){
            await removeEntry(key)
            continue
        }
        //pending 或停機期間已經過期的，立刻解除(解不掉就繼續留著等他進語音)
        if(entry.pending || isExpired(entry)){
            await expire(client, entry)
            released += 1
            continue
        }
        scheduleAt(muteKey(entry.guildId, entry.userId), entry.until, () => expire(client, entry))
        scheduled += 1
    }

    if(scheduled || released) logger.info(`vmute 還原：重掛 ${scheduled} 筆、立即處理 ${released} 筆`)
}

//登記制。ready 事件會呼叫 runRestores，所以不需要改 events/ready/index.js。
registerRestore(SECTION, restore)

export default {
    SECTION,
    ALLOWED_SECONDS,
    muteKey,
    parseSeconds,
    remainMs,
    isExpired,
    shouldUnmuteOnJoin,
    canUnmute,
    readEntries,
    readEntry,
    mute,
    unmute,
    handleVoiceJoin,
    restore,
}
