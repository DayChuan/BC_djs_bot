import logger from '@/core/logger'
import scheduler, {nextWeeklyDate} from '@/core/scheduler'
import {
    addVoteEntry,
    buildThreadName,
    castVote,
    createPoll,
    deletePoll,
    getEntries,
    getPoll,
    hasReminded,
    listActivePolls,
    markReminded,
    pendingReminders,
    removeVoteEntry,
    resolveNoticeRole,
    threadParentId,
    updatePoll,
    wantsRaid,
    wantsThread,
} from '@/core/pollStore'
import config from '@/config'
import {OPT_OUT_EMOJI, REMIND_HOURS} from '@/config/polls'
import {archivePoll} from '@/core/pollArchive'
import {addDays, applyDates, basesOf, optionDateRange, refreshDatedOptions} from '@/core/pollTemplate'
import {clearDraft, getDraft, setDraft} from '@/core/pollDraft'
import {ChannelType, PermissionFlagsBits} from 'discord.js'
import {
    ADMIN_PREFIX,
    applyEdit,
    buildAdminDetail,
    buildAdminList,
    buildResultView,
    collectAdminItems,
    findAdminItem,
    parseEditFields,
    purgeRecord,
} from '@/core/pollAdmin'
import {
    buildLineupMessages,
    buildMemberPanel,
    buildQuickMessage,
    buildClosedMessage,
    buildReminderMessages,
    buildPollMessage,
    buildResultMessage,
    canPeek,
} from '@/core/pollRender'
import {LINEUP_IDENTITY_GROUP} from '@/config/lineup'

//排程的 key。用投票 id 當一部分，重複註冊時 scheduler 會自動蓋掉舊的，
//所以同一場投票不管經過幾次重啟或還原，都只會有一份排程、只會結算一次。
const closeKey = (pollId) => `poll:close:${pollId}`
const openKey = (pollId) => `poll:open:${pollId}`

//截止前提醒，一個時間點一個 key。小時數帶在裡面，
//所以 REMIND_HOURS 加一個時間點就自動多一組排程，不必再改 key 的規則。
const remindJobKey = (hours, pollId) => `poll:remind${hours}:${pollId}`

//快速投票與一般投票的訊息長得不一樣：前者公開即時顯示比數，
//後者只放按鈕、內容藏在個人面板裡。
const messagePayload = (poll) => (poll.type === 'quick'
    ? buildQuickMessage(poll)
    : buildPollMessage(poll))

const fetchChannel = async (client, channelId) => {
    const channel = await client.channels.fetch(channelId).catch(() => null)
    if(!channel || !channel.isTextBased()) return null
    return channel
}

/////////////////////////////// 發布 ///////////////////////////////

//為一場投票開一個鎖定的討論串，回傳「訊息要發到哪裡」。
//
//母頻道一律取 parentChannelId：每週續辦時 poll.channelId 已經是上一輪的
//討論串，拿它建串必定失敗(討論串裡不能再開討論串)。
//
//建串或鎖定失敗時退回母頻道，不讓整場投票發不出來 ——
//投票本身比「發在討論串」重要得多，鎖不起來也只是會被聊天洗。
const openPollThread = async (client, poll) => {
    let parentId = threadParentId(poll)

    if(!parentId){
        //理論上不會發生(/poll 一定會帶，續辦會整份複製)。
        //真的缺了就當 channelId 是母頻道，至少投票發得出去。
        logger.error(`投票 ${poll.id} 要開討論串卻沒有 parentChannelId，改用 channelId ${poll.channelId}`)
        parentId = poll.channelId
    }

    const parent = await fetchChannel(client, parentId)
    if(!parent) return null

    if(typeof (parent.threads && parent.threads.create) !== 'function'){
        logger.error(`投票 ${poll.id} 的頻道 ${parentId} 不支援討論串，改發在該頻道`)
        return parent
    }

    try{
        const thread = await parent.threads.create({
            //名稱裡的日期用「選項涵蓋的範圍」(08/18~08/24)，
            //選項上沒有日期的投票才退回用今天(見 buildThreadName)。
            name: buildThreadName(poll.title, optionDateRange(poll.options, poll.dateStart)),
            //上限 7 天。每週投票的週期剛好也是 7 天，設短一點會在結算前就封存。
            autoArchiveDuration: 10080,
            type: ChannelType.PublicThread,
            reason: `投票 ${poll.id}`,
        })

        //鎖定只擋發訊息，不擋按鈕與面板互動，所以投票流程完全不受影響。
        //鎖失敗不回頭 —— 討論串已經開好了，退回母頻道反而更亂。
        await thread.setLocked(true).catch((e) => {
            logger.warn(`投票 ${poll.id} 的討論串鎖定失敗(缺 ManageThreads?)，維持未鎖定：`, e)
        })

        return thread
    }
    catch(e){
        logger.error(`投票 ${poll.id} 建立討論串失敗(缺 CreatePublicThreads?)，退回母頻道 ${parentId}：`, e)
        return parent
    }
}

//把一場投票送進頻道，並排好截止時間。
//poll 必須已經寫進 polls/ —— 先落盤再送訊息，
//反過來的話送出訊息後當機，頻道裡就會留下一則永遠不會結算的殭屍投票。
//
//開討論串時把 channelId 換成討論串 id 就結束了：結算、編輯、取消、開機還原
//全都只認 channelId，討論串在 Discord 也就是一種頻道，所以它們自動跟著走。
const sendPollMessage = async (client, poll) => {
    const channel = wantsThread(poll)
        ? await openPollThread(client, poll)
        : await fetchChannel(client, poll.channelId)

    if(!channel){
        logger.error(`投票 ${poll.id} 找不到頻道 ${poll.channelId}，取消這場投票`)
        await deletePoll(poll.id)
        return null
    }

    //開在討論串裡時提及通知身分組。討論串預設不會出現在大家的頻道列表上，
    //沒有這個提及就只有剛好點進去的人看得到 —— 那等於把投票藏起來。
    //只在真的開成討論串時提及：退回母頻道的情況照原本的樣子發，不多 tag 一次。
    //用 isThread() 判斷，不要用「channel.id 有沒有變」——
    //每週續辦而且建串失敗時，channelId(上一輪的討論串)與母頻道本來就不同，
    //那種情況拿 id 比會誤判成開串成功，變成在母頻道 tag 人。
    //也要看 wantsThread：有人會在既有的討論串裡下 thread:false 的 /poll，
    //那是「發在這裡就好」，不是我們開的串，不該 tag 全體。
    const inThread = wantsThread(poll)
        && typeof channel.isThread === 'function'
        && channel.isThread()
    const roleId = inThread
        ? resolveNoticeRole(config.noticeRoles && config.noticeRoles.poll, poll.guildId)
        : ''

    const payload = messagePayload(poll)
    const message = await channel.send(roleId
        //allowedMentions 一定要明講：預設會把訊息裡出現的所有提及都送出去，
        //而這裡只該通知這一個身分組。
        ? {...payload, content: `<@&${roleId}>`, allowedMentions: {roles: [roleId]}}
        : payload)

    const updated = await updatePoll(poll.id, (record) => {
        record.messageId = message.id
        record.status = 'open'
        //發在討論串時才會不一樣。下游全部改認新的 channelId。
        if(channel.id !== record.channelId) record.channelId = channel.id
    })

    scheduler.scheduleAt(closeKey(poll.id), new Date(poll.closeAt), () => closePoll(client, poll.id))

    //❎ 與截止前提醒只在組隊模式下做(2026-09-04)。
    //一般投票(臨時問大家吃什麼)被按上 ❎、又在截止前被 tag，是純粹的噪音。
    //快速投票天然不會進來：它壽命只有幾分鐘，模板與 /poll 的 raid 都碰不到它。
    if(wantsRaid(poll)){
        //提醒排程要用 updated —— messageId 與(開串時)新的 channelId 都在那上面，
        //提醒時要靠它們把訊息抓回來讀 ❎。
        scheduleReminders(client, updated || poll)

        //bot 自己先按一顆 ❎，否則沒有人知道有「這次不參與」這個機制，
        //而且鎖定的討論串裡成員只點得動已經存在的表情。
        //一定要 await 並接住：未 await 的 Promise 若 reject，外層 try/catch 攔不到，
        //Node 會直接終止整個行程。按不上去只是少一個入口，不該讓發布失敗。
        await message.react(OPT_OUT_EMOJI).catch((e) => {
            logger.warn(`投票 ${poll.id} 按不上 ${OPT_OUT_EMOJI}(缺 AddReactions?)：`, e)
        })
    }

    logger.info(
        `投票已發布：${poll.id}「${poll.title}」channel=${channel.id} ` +
        `thread=${wantsThread(poll) ? 'yes' : 'no'} ` +
        `close=${poll.closeAt} weekly=${poll.weekly ? 'yes' : 'no'}`
    )

    return updated
}

//指令建立的第一場。closeAt 由呼叫端算好再傳進來。
export const createAndPublish = async (client, draft) => {
    const poll = await createPoll({...draft, status: 'pending', messageId: null})
    return sendPollMessage(client, poll)
}

//每週投票的下一輪。時間到了才算截止時間，然後發出去。
export const publishPending = async (client, pollId) => {
    const poll = await getPoll(pollId)
    if(!poll){
        logger.warn(`要發布的投票 ${pollId} 已不存在，略過`)
        return null
    }
    if(poll.status !== 'pending'){
        logger.warn(`投票 ${pollId} 狀態是 ${poll.status}，不是 pending，略過發布`)
        return null
    }

    const closeAt = nextWeeklyDate(poll.weekly.closeDay, poll.weekly.closeTime).toISOString()

    //選項標籤是上一輪結算當下算好寫進檔案的，發布前依 base 再算一次。
    //開機時 restorePolls() 已經算過一輪，這裡是第二道保險：
    //涵蓋「開機之後才變成 pending、還沒經過重啟」的那些場次。
    const refreshed = refreshDatedOptions(poll.options, poll.dateStart)

    const ready = await updatePoll(pollId, (record) => {
        record.closeAt = closeAt
        if(refreshed) record.options = refreshed
    })

    return sendPollMessage(client, ready)
}

/////////////////////////// 截止前提醒 ///////////////////////////

const HOUR_MS = 60 * 60 * 1000

const remindAt = (poll, hours) => new Date(new Date(poll.closeAt).getTime() - hours * HOUR_MS)

//掛上截止前的提醒排程。發布、開機還原、編輯截止時間之後都要呼叫。
//
//兩種情況不掛：已經發過的、時間點已經過去的。
//scheduleAt() 對過去的時間會「立刻執行」（結算就是靠這個補做），
//少了這道判斷，重啟一次就會補送一則三小時前該發的提醒 —— 只會讓人困惑。
const scheduleReminders = (client, poll, now = Date.now()) => {
    if(!poll || !poll.closeAt) return 0

    let scheduled = 0
    for(const hours of REMIND_HOURS){
        if(hasReminded(poll, hours)) continue

        const at = remindAt(poll, hours)
        if(!Number.isFinite(at.getTime()) || at.getTime() <= now) continue

        scheduler.scheduleAt(remindJobKey(hours, poll.id), at, () => remindPoll(client, poll.id, hours))
        scheduled += 1
    }

    return scheduled
}

//結算與取消時要一併收掉，否則排程會留到時間點才醒來，發現投票沒了才放棄。
const cancelReminders = (pollId) => {
    for(const hours of REMIND_HOURS) scheduler.cancel(remindJobKey(hours, pollId))
}

//讀出在投票訊息上按了 ❎ 的人。
//
//不監聽 messageReactionAdd：要用的時候才抓訊息、讀當下的表情清單，
//沒有狀態要維護，也不會因為漏接事件而算錯（誰按了又取消也一律看當下）。
//已經開著 Partials.Message/Reaction，快取裡的 reaction 可能是半截的，
//讀 users 之前要先 fetch()。
//
//抓不到就當作沒有人按：名單可能多幾個人，但比整個提醒發不出去好。
const fetchOptedOut = async (message) => {
    const reaction = message.reactions.cache.get(OPT_OUT_EMOJI)
    if(!reaction) return []

    try{
        const full = reaction.partial ? await reaction.fetch() : reaction
        const users = await full.users.fetch()
        return [...users.keys()]
    }
    catch(e){
        logger.warn(`讀取 ${OPT_OUT_EMOJI} 的使用者清單失敗，這次不扣除任何人：`, e)
        return []
    }
}

//通知身分組的成員 id。沒設定對照表就回空陣列 —— 沒有對象等於不用提醒。
//
//一次 fetch 整個伺服器再過濾，不用 role.members：後者只看得到快取裡的成員，
//剛重啟時會少一大半人，而且少了誰完全看不出來。
const fetchNoticeMemberIds = async (guild, guildId) => {
    const roleId = resolveNoticeRole(config.noticeRoles && config.noticeRoles.poll, guildId)
    if(!guild || !roleId) return []

    try{
        const members = await guild.members.fetch()
        return [...members.values()]
            .filter((member) => !member.user.bot && member.roles.cache.has(roleId))
            .map((member) => member.id)
    }
    catch(e){
        logger.warn(`取得通知身分組 ${roleId} 的成員失敗，這次不提醒：`, e)
        return []
    }
}

//發一次截止前提醒。由排程呼叫。
//
//對象＝通知身分組的成員，扣掉已經投票的、扣掉按了 ❎ 的、扣掉機器人。
//扣完沒有人就完全不發訊息 —— 發一則「大家都投完了」也是洗版。
export const remindPoll = async (client, pollId, hours) => {
    const poll = await getPoll(pollId)
    if(!poll || poll.status !== 'open') return 0

    //重啟還原與手動觸發都可能重複進來，這是最後一道：發過就不再發
    if(hasReminded(poll, hours)) return 0

    const channel = await fetchChannel(client, poll.channelId)
    if(!channel){
        logger.warn(`投票 ${pollId} 的 ${hours} 小時提醒找不到頻道 ${poll.channelId}，略過`)
        return 0
    }

    let optedOutIds = []
    if(poll.messageId){
        try{
            optedOutIds = await fetchOptedOut(await channel.messages.fetch(poll.messageId))
        }
        catch(e){
            logger.warn(`投票 ${pollId} 的原訊息抓不到，${OPT_OUT_EMOJI} 這次不扣除：`, e)
        }
    }

    const botId = client.user ? client.user.id : null
    const userIds = pendingReminders({
        memberIds: await fetchNoticeMemberIds(channel.guild, poll.guildId),
        poll,
        optedOutIds,
        //bot 自己按的那顆 ❎ 會出現在清單裡，濾掉才不會把自己算進去
        botIds: botId ? [botId] : [],
    })

    //先記下「這個時間點處理過」再發訊息。反過來的話，發到一半當機
    //會在下次重啟時整串重發一次 —— 重複洗版比漏發一次嚴重。
    await markReminded(pollId, hours)

    if(userIds.length === 0){
        logger.info(`投票 ${pollId} 的 ${hours} 小時提醒：沒有人需要提醒，不發訊息`)
        return 0
    }

    //allowedMentions 用 parse: ['users']：只放行訊息裡出現的個人提及，
    //不會連帶把身分組或 @everyone 一起送出去。
    //不列舉 users 清單是因為那個欄位上限 100 人，超過就整則被退回。
    for(const content of buildReminderMessages(poll, {userIds, hours})){
        await channel.send({content, allowedMentions: {parse: ['users']}})
    }

    logger.info(`投票 ${pollId}「${poll.title}」已發出 ${hours} 小時提醒：${userIds.length} 人`)
    return userIds.length
}

/////////////////////////////// 結算 ///////////////////////////////

//每週投票結算後，排定下一輪。
//下一輪是一筆全新的 pending 紀錄，不是沿用舊的 —— 舊的那筆連同票數會被刪掉，
//符合「結算後清空」的要求，也不會讓上週的票混進這週。
const scheduleNextRound = async (client, poll) => {
    const openAt = nextWeeklyDate(poll.weekly.openDay, poll.weekly.openTime).toISOString()

    //整份複製，只覆寫「這一輪專屬」的欄位。
    //早期版本用白名單逐一列舉要帶過去的設定，結果 multiChar 與 peek 都漏了 ——
    //開了一人多角色的每週投票，下一週會變回單角色，而且不公開中途結果的設定
    //也會被還原成公開。白名單只要新增欄位就會漏，所以改成反過來做。
    const {id, messageId, closeAt, archivedAt, archivedBy, result, ...carried} = poll

    //有標日期的投票，下一輪整組往後推一週：起日 +7 天，選項的日期跟著重算。
    //重算的依據是 option.base(沒有日期的原始文字)，不是 label ——
    //拿 label 去接第二次日期會變成「星期二(8/18)(8/25)」。
    if(carried.dateStart){
        const nextStart = addDays(carried.dateStart, 7)
        const dated = nextStart ? applyDates(basesOf(carried.options), nextStart) : null

        //推不動就原封不動帶過去。日期算錯不該讓整個下一輪消失 ——
        //標籤舊了看得出來，投票沒排到下一輪則是沒有人會發現的那種故障。
        if(dated){
            carried.dateStart = nextStart
            carried.options = dated
        }
        else{
            logger.error(`投票 ${poll.id} 的起日「${carried.dateStart}」無法推進，下一輪沿用原本的選項日期`)
        }
    }

    const next = await createPoll({
        ...carried,
        status: 'pending',
        messageId: null,
        openAt,
        closeAt: null,
        votes: {},
    })

    scheduler.scheduleAt(openKey(next.id), new Date(openAt), () => publishPending(client, next.id))
    logger.info(`每週投票下一輪已排定：${next.id}「${next.title}」open=${openAt}`)

    return next
}

//討論串封存之後，編輯訊息與發訊息都會失敗。
//自動封存上限是 7 天，而每週投票的週期剛好也是 7 天 ——
//結算就正好踩在那條邊界上，少了這一步會變成最難查的那種偶發故障。
//
//不是討論串就原樣回傳，呼叫端不必自己判斷型別。
const wakeThread = async (channel, pollId) => {
    if(!channel || typeof channel.isThread !== 'function' || !channel.isThread()) return channel

    //快取裡的 archived 可能是舊的(封存事件發生時 bot 不一定在線)，
    //所以重抓一次才問得到真實狀態。抓失敗就用手上這個繼續。
    const fresh = await channel.fetch().catch(() => channel)
    if(!fresh.archived) return fresh

    try{
        await fresh.setArchived(false)
        logger.info(`投票 ${pollId} 的討論串已封存，結算前先解除封存`)
    }
    catch(e){
        //解不開就照原流程走：編輯與貼結果會失敗，但那兩步本來就各自有容錯，
        //不該讓整場結算(排下一輪、歸檔)跟著停住。
        logger.error(`投票 ${pollId} 的討論串解除封存失敗(缺 ManageThreads?)，結果可能貼不進去：`, e)
    }

    return fresh
}

//人員表裡查不到角色名時的退路：Discord 上的顯示名稱。
//一次把整場投票的人抓回來，不要一人一個 fetch —— 十幾個人就是十幾次 API 呼叫。
//抓不到就回空表，名單那邊會再退一層改用 mention，不會因此少列人。
const fetchDisplayNames = async (guild, userIds) => {
    const names = {}
    if(!guild || userIds.length === 0) return names

    try{
        const members = await guild.members.fetch({user: userIds})
        for(const [id, member] of members) names[id] = member.displayName
    }
    catch(e){
        logger.warn('取出團名單的顯示名稱失敗，改用 mention：', e)
    }

    return names
}

//結果報表之後**再貼一則**出團名單(不是塞進原本那則)。
//只有楓之谷的投票有名單，其他群組安靜跳過、不報錯。
//
//整段包起來且一定 await：名單只是附加資訊，貼不出來不該讓結算(排下一輪、歸檔)跟著停住，
//而未 await 的 Promise 若 reject，外層的 try/catch 攔不到，整個行程會被 Node 終止。
const sendLineup = async (channel, poll) => {
    //改用明確的 raid 開關，不再從身分群組推斷(2026-09-04)。
    //身分群組管的是「顯示哪個職業選單」，跟「要不要編隊」是兩件事。
    //但名單的編隊規則寫死楓之谷的六個職業，所以身分群組仍然要對得上，
    //否則會拿 TRPG 的角色去湊箭神與聖騎士。
    if(!wantsRaid(poll)) return
    if(poll.identityGroup !== LINEUP_IDENTITY_GROUP) return

    try{
        const displayNames = await fetchDisplayNames(channel.guild, Object.keys(poll.votes || {}))
        const messages = buildLineupMessages(poll, {displayNames})

        for(const content of messages){
            await channel.send({content, allowedMentions: {parse: []}})
        }
        if(messages.length > 0) logger.info(`投票 ${poll.id} 已貼出團名單 ${messages.length} 則`)
    }
    catch(e){
        logger.error(`投票 ${poll.id} 的出團名單貼不出來(結算本身不受影響)：`, e)
    }
}

export const closePoll = async (client, pollId) => {
    //先在佇列裡把狀態改成 closed。同一瞬間有第二個結算進來時，
    //它看到的就已經是 closed，會直接放棄，不會重複貼結果。
    let skipped = false
    const poll = await updatePoll(pollId, (record) => {
        if(record.status !== 'open'){
            skipped = true
            return false
        }
        record.status = 'closed'
    })

    if(!poll){
        logger.warn(`要結算的投票 ${pollId} 已不存在，略過`)
        return null
    }
    if(skipped){
        logger.warn(`投票 ${pollId} 狀態是 ${poll.status}，略過重複結算`)
        return null
    }

    //poll.channelId 可能是討論串(見發布那段)，封存了就先解開再貼結果
    const channel = await wakeThread(await fetchChannel(client, poll.channelId), pollId)

    //原訊息可能已被刪除。刪掉就算了，重點是結果要貼得出來，
    //所以這裡失敗只記錄，不中斷後面的流程。
    //快速投票就地把原訊息換成最終結果，不另外再發一則 ——
    //它本來就是即時顯示的，語音現場再洗一則訊息只是噪音。
    const quick = poll.type === 'quick'

    if(channel && poll.messageId){
        try{
            const message = await channel.messages.fetch(poll.messageId)
            await message.edit(quick ? buildQuickMessage(poll, {closed: true}) : buildClosedMessage(poll))
        }
        catch(e){
            logger.warn(`投票 ${pollId} 的原訊息無法更新(可能已被刪除)：`, e)
        }
    }

    if(!quick){
        if(channel){
            await channel.send(buildResultMessage(poll))
            //貼在同一個 channel，所以 U10 把投票開在討論串時，名單也會跟著在討論串裡
            await sendLineup(channel, poll)
        }
        else logger.error(`投票 ${pollId} 找不到頻道 ${poll.channelId}，結果無法公布`)
    }

    //有每週設定就先排好下一輪，再處理這一筆。
    //順序反過來的話，中間當機就會兩邊都沒有。
    if(poll.weekly) await scheduleNextRound(client, poll)

    //從 polls/ 搬到 archive/，並補上結果快照。
    //「結算後清空」的語意是「移出進行中」，不是銷毀 —— 之後可用 /poll_admin 查。
    await archivePoll(poll)
    scheduler.cancel(closeKey(pollId))
    cancelReminders(pollId)

    logger.info(`投票已結算：${pollId}「${poll.title}」投票人數=${Object.keys(poll.votes || {}).length}`)
    return poll
}

/////////////////////////// 開機還原 ///////////////////////////

//開機時把排程中的投票標籤依 base 重算一次，算出來有變才寫檔。
//
//日期規則改過之後，靠這一步讓既有排程「重啟就立刻更正」，不必等到發布那一刻。
//少了它，管理面板會一路顯示舊日期到下次發布為止，中間既看不出修好了沒，
//管理員看了也會以為修正沒生效(2026-08-28 實際發生)。
//
//只動 pending。open 的投票訊息已經貼在頻道裡，改存檔會讓檔案與畫面對不上，
//那比標籤舊了更難查。
const refreshPendingOptions = async (poll) => {
    const next = refreshDatedOptions(poll.options, poll.dateStart)
    if(!next) return

    await updatePoll(poll.id, (record) => {
        //重讀之後狀態可能已經變了，此時放棄這次異動
        if(record.status !== 'pending') return false
        record.options = next
    })

    logger.info(`排程投票 ${poll.id}「${poll.title}」的選項日期已依現行規則重算`)
}

//bot 重啟後，記憶體裡的排程全部消失，但投票檔案還在。
//沒有這一步，重啟過的投票就永遠不會結算。
export const restorePolls = async (client) => {
    const polls = await listActivePolls()
    if(polls.length === 0) return 0

    for(const poll of polls){
        try{
            if(poll.status === 'pending') await refreshPendingOptions(poll)

            if(poll.status === 'open'){
                //已經過期的(停機期間錯過的截止時間)會立刻執行，補結算
                scheduler.scheduleAt(closeKey(poll.id), new Date(poll.closeAt), () => closePoll(client, poll.id))

                //提醒相反：已經發過的、時間點已經過去的都不補
                //(見 scheduleReminders)。截止可以晚一點做，提醒晚了只是噪音。
                scheduleReminders(client, poll)
            }
            else{
                scheduler.scheduleAt(openKey(poll.id), new Date(poll.openAt), () => publishPending(client, poll.id))
            }
        }
        catch(e){
            logger.error(`還原投票 ${poll.id} 的排程失敗：`, e)
        }
    }

    logger.info(`已還原 ${polls.length} 場未結束的投票排程`)
    return polls.length
}

/////////////////////////// 面板互動 ///////////////////////////

//面板上的所有操作。回傳「可以直接丟給 editReply() 的內容」，
//或回 null 代表「不需要重繪畫面」。
//
//選選項與選身分只寫進記憶體草稿、不重繪 —— 每點一下都重繪一次面板的話，
//使用者每一下都要等一次 Discord 往返，體驗很差。
//真正寫檔的只有「投票 / 修改」按鈕。
//
//entryId 是要操作哪一隻角色。改版前發出的舊投票訊息不帶這個值，
//此時一律當作第一筆處理，舊訊息才不會突然點不動。
export const handlePollAction = async (interaction, {kind, pollId, entryId}, {fromPanel = true} = {}) => {
    const userId = interaction.user.id

    const poll = await getPoll(pollId)
    if(!poll) return {content: '這場投票已經結束並清除了。'}
    if(poll.status !== 'open') return {content: '這場投票已經截止，不能再更改。'}

    const entries = getEntries(poll, userId)
    const targetId = entryId || (entries[0] ? entries[0].entryId : 'e0')
    const draft = getDraft(pollId, userId)

    const panel = (activeId, notice) =>
        buildMemberPanel(poll, userId, activeId, {draft: getDraft(pollId, userId), notice})

    //選單操作：只更新草稿。草稿以「目前這隻角色」為單位，
    //換角色前必須先送出或清除，對應「一次投票就是一隻角色」的邏輯。
    if(kind === 'opt' || kind === 'idt'){
        const base = (draft && draft.entryId === targetId)
            ? draft
            : (entries.find((entry) => entry.entryId === targetId) || {options: [], identity: null})

        setDraft(pollId, userId, {
            entryId: targetId,
            options: kind === 'opt' ? interaction.values : base.options,
            identity: kind === 'idt' ? (interaction.values[0] || null) : base.identity,
        })

        //從面板來的就不重繪，省下一次往返。
        //從公開訊息(改版前的舊選單)來的沒有面板可以更新，還是得回一個。
        return fromPanel ? null : panel(targetId)
    }

    //送出：草稿寫進檔案
    if(kind === 'save'){
        if(!draft || draft.entryId !== targetId){
            return panel(targetId, '沒有需要送出的變更。')
        }

        await castVote(pollId, userId, {options: draft.options, identity: draft.identity}, targetId)
        clearDraft(pollId, userId)

        const updated = await getPoll(pollId)
        const done = getEntries(updated, userId).some((entry) =>
            entry.entryId === targetId && entry.options.length > 0)

        return buildMemberPanel(updated, userId, targetId, {
            notice: done ? '✅ 已送出。' : '✅ 已更新（這隻角色目前沒有選任何選項）。',
        })
    }

    //刪除這隻角色：立即生效，並丟掉草稿。
    //它同時是「不想送出」時的逃生口，所以不能也變成草稿操作。
    if(kind === 'del'){
        clearDraft(pollId, userId)
        await removeVoteEntry(pollId, userId, targetId)

        const updated = await getPoll(pollId)
        return buildMemberPanel(updated, userId, null, {notice: '已清除這筆登記。'})
    }

    //新增角色：有未送出的變更就擋下來
    if(kind === 'add'){
        if(draft) return panel(draft.entryId, '⚠️ 請先按「投票」送出目前這隻角色，或按「清除我的登記」放棄。')

        const updated = await addVoteEntry(pollId, userId)
        if(!updated) return panel(targetId)

        const list = getEntries(updated, userId)
        const last = list[list.length - 1]
        return buildMemberPanel(updated, userId, last ? last.entryId : null, {notice: '已新增一隻角色。'})
    }

    //切換角色：同樣要求先處理掉未送出的變更
    if(kind === 'sel'){
        if(draft) return panel(draft.entryId, '⚠️ 請先按「投票」送出目前這隻角色，或按「清除我的登記」放棄。')

        const picked = (interaction.values && interaction.values[0]) || entryId || null
        return panel(picked)
    }

    //'open'：把面板叫出來
    return panel(draft ? draft.entryId : targetId)
}

/////////////////////////// 中途查看結果 ///////////////////////////

//回傳可以直接丟給 interaction.editReply() 的內容。
//查不到或不允許查看時回一段文字，呼叫端不必自己判斷型別。
//byAdmin 為 true 時略過 peek 設定 —— 管理員從 /poll_admin 進來永遠看得到。
export const peekPoll = async (pollId, {byAdmin = false} = {}) => {
    const poll = await getPoll(pollId)
    if(!poll) return {content: '這場投票已經結束並清除了。'}
    if(!byAdmin && !canPeek(poll)) return {content: '這場投票不開放中途查看結果。'}

    return buildResultMessage(poll, {live: true})
}

/////////////////////////// 管理面板 ///////////////////////////

//取消一場投票：不結算、不公布結果，但仍然歸檔留痕跡。
//誰在什麼時候砍掉一場投票是該查得到的事，所以不是直接刪檔。
export const cancelPoll = async (client, pollId, by = null) => {
    let skipped = false
    const poll = await updatePoll(pollId, (record) => {
        if(record.status !== 'open' && record.status !== 'pending'){
            skipped = true
            return false
        }
        record.status = 'cancelled'
    })

    if(!poll || skipped) return null

    //已經發出去的訊息要改掉，不然頻道裡會留一則點得動卻沒作用的投票
    if(poll.messageId){
        const channel = await fetchChannel(client, poll.channelId)
        if(channel){
            try{
                const message = await channel.messages.fetch(poll.messageId)
                await message.edit({
                    embeds: [{
                        title: `🗳️ ${poll.title}（已取消）`,
                        description: '這場投票已被管理員取消，不會公布結果。',
                        color: 0xED4245,
                    }],
                    components: [],
                })
            }
            catch(e){
                logger.warn(`取消投票 ${pollId} 時無法更新原訊息(可能已被刪除)：`, e)
            }
        }
    }

    scheduler.cancel(closeKey(pollId))
    scheduler.cancel(openKey(pollId))
    cancelReminders(pollId)

    await archivePoll(poll, {reason: 'cancelled', by})
    logger.info(`投票已取消：${pollId}「${poll.title}」by=${by}`)

    return poll
}

//編輯之後要做兩件收尾：把排程重掛(時間可能改了)、把頻道訊息更新(標題可能改了)。
//少了任何一件，畫面與實際行為就會對不上。
export const applyPollEdit = async (client, pollId, patch) => {
    const poll = await applyEdit(pollId, patch)
    if(!poll) return null

    if(poll.status === 'open'){
        scheduler.scheduleAt(closeKey(poll.id), new Date(poll.closeAt), () => closePoll(client, poll.id))

        //截止時間可能被改掉了，提醒的時間點跟著算。
        //改成更晚才截止時，已經發過的那次不會再發一遍(hasReminded 擋著)。
        cancelReminders(poll.id)
        scheduleReminders(client, poll)

        if(poll.messageId){
            const channel = await fetchChannel(client, poll.channelId)
            if(channel){
                try{
                    const message = await channel.messages.fetch(poll.messageId)
                    await message.edit(messagePayload(poll))
                }
                catch(e){
                    logger.warn(`編輯投票 ${pollId} 後無法更新原訊息：`, e)
                }
            }
        }
    }
    else if(poll.status === 'pending' && poll.openAt){
        scheduler.scheduleAt(openKey(poll.id), new Date(poll.openAt), () => publishPending(client, poll.id))
    }

    logger.info(`投票已編輯：${pollId}「${poll.title}」`)
    return poll
}

//管理面板的動作分派。回傳可直接丟給 editReply() 的內容。
//'edit' 不在這裡處理 —— 開啟 Modal 必須直接對 interaction 呼叫 showModal()，
//不能先 defer，所以由事件層處理。
export const handleAdminAction = async (interaction, {action, pollId}) => {
    const by = interaction.user.tag
    const client = interaction.client

    const backToList = async (notice) => buildAdminList(await collectAdminItems(), {notice})

    const detailOf = async (id, notice) => {
        const item = await findAdminItem(id)
        if(!item) return backToList('那場投票已經不存在了。')
        return buildAdminDetail(item, {notice})
    }

    //選單選了一場，或按鈕回到某一場
    if(action === 'pick') return detailOf(interaction.values[0])
    if(action === 'back') return backToList()

    if(!pollId) return backToList()

    const item = await findAdminItem(pollId)
    if(!item) return backToList('那場投票已經不存在了。')

    if(action === 'peek' || action === 'view'){
        //結果單獨顯示，附一顆回去的按鈕，不然管理員會卡在結果畫面
        return {
            ...buildResultView(item),
            components: [{
                type: 1,
                components: [{
                    type: 2, style: 2, label: '◀ 回列表',
                    custom_id: `${ADMIN_PREFIX}back`,
                }],
            }],
        }
    }

    if(action === 'close'){
        if(item.kind !== 'open') return detailOf(pollId, '這場投票不是進行中，無法結算。')
        await closePoll(client, pollId)
        return backToList(`已結算「${item.poll.title}」，結果已貼在原頻道。`)
    }

    if(action === 'publish'){
        if(item.kind !== 'pending') return detailOf(pollId, '這場投票不是排程中，無法立即發布。')
        await publishPending(client, pollId)
        return backToList(`已立即發布「${item.poll.title}」。`)
    }

    if(action === 'cancel'){
        const cancelled = await cancelPoll(client, pollId, by)
        if(!cancelled) return detailOf(pollId, '這場投票的狀態已經改變，沒有執行取消。')
        return backToList(`已取消「${item.poll.title}」，紀錄保留在歷史中。`)
    }

    if(action === 'share'){
        if(item.kind !== 'archived') return detailOf(pollId, '只有已結束的投票才能公開分享。')
        await interaction.channel.send({
            content: `📌 ${interaction.user} 分享了一場過往投票的結果`,
            ...buildResultMessage(item.poll),
        })
        logger.info(`公開分享歷史投票：${pollId}「${item.poll.title}」by=${by}`)
        return detailOf(pollId, '已把結果貼到這個頻道。')
    }

    if(action === 'purge'){
        if(item.kind !== 'archived') return detailOf(pollId, '只有已結束的投票才能刪除紀錄。')
        await purgeRecord(pollId, by)
        return backToList(`已刪除「${item.poll.title}」的歷史紀錄。`)
    }

    return backToList()
}

//Modal 送出後的處理。驗證失敗時回錯誤文字，不寫入任何東西。
export const handleAdminEditSubmit = async (interaction, pollId, fields) => {
    const item = await findAdminItem(pollId)
    if(!item) return buildAdminList(await collectAdminItems(), {notice: '那場投票已經不存在了。'})
    if(item.kind === 'archived'){
        return buildAdminDetail(item, {notice: '已結束的投票不能編輯。'})
    }

    const {patch, error} = parseEditFields(item.poll, fields)
    if(error) return buildAdminDetail(item, {notice: `⚠️ ${error}　沒有做任何修改。`})

    await applyPollEdit(interaction.client, pollId, patch)

    const updated = await findAdminItem(pollId)
    return buildAdminDetail(updated, {notice: '已更新。'})
}

//這個物件必須放在檔案最後。
//它在模組載入時就會求值，擺在函式宣告之前的話，const 還在 TDZ，
//會直接丟 ReferenceError: Cannot access 'x' before initialization，
//而且是在 loader 載入指令/事件的當下爆掉 —— 整組斜線指令都會註冊不上。

/////////////////////////// 快速投票 ///////////////////////////

//點顏色。同一個顏色再按一次就是取消 —— 語音現場常常按錯，
//沒有取消的話只能重開一場。
export const handleQuickVote = async (interaction, {pollId, entryId}) => {
    const optionKey = entryId
    const userId = interaction.user.id

    const poll = await getPoll(pollId)
    if(!poll) return {content: '這場投票已經結束了。'}
    if(poll.status !== 'open') return {content: '這場投票已經結束了。'}
    if(!poll.options.some((option) => option.key === optionKey)) return null

    const current = getEntries(poll, userId)[0]
    const cancel = Boolean(current && current.options.includes(optionKey))

    const updated = await castVote(pollId, userId, {options: cancel ? [] : [optionKey]}, 'e0')
    return buildQuickMessage(updated || poll)
}

//只有發起人與管理員能提早結束。
//回傳錯誤字串或 null —— 權限要在 defer 之前檢查完，
//因為 deferUpdate 之後就不能再用 ephemeral 回覆拒絕了。
export const checkQuickEnd = async (interaction, pollId) => {
    const poll = await getPoll(pollId)
    if(!poll || poll.status !== 'open') return '這場投票已經結束了。'

    const isAdmin = Boolean(interaction.memberPermissions
        && interaction.memberPermissions.has(PermissionFlagsBits.Administrator))

    if(poll.createdBy !== interaction.user.id && !isAdmin){
        return '只有發起人或管理員可以結束這場投票。'
    }

    return null
}

export default {
    createAndPublish,
    publishPending,
    closePoll,
    remindPoll,
    restorePolls,
    handlePollAction,
    peekPoll,
    cancelPoll,
    applyPollEdit,
    handleAdminAction,
    handleAdminEditSubmit,
    handleQuickVote,
    checkQuickEnd,
}
