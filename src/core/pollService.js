import logger from '@/core/logger'
import scheduler, {nextWeeklyDate} from '@/core/scheduler'
import {
    addVoteEntry,
    castVote,
    createPoll,
    deletePoll,
    getEntries,
    getPoll,
    listActivePolls,
    listOpenPolls,
    removeVoteEntry,
    updatePoll,
} from '@/core/pollStore'
import {archivePoll} from '@/core/pollArchive'
import {clearDraft, getDraft, setDraft} from '@/core/pollDraft'
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
    buildMemberPanel,
    buildClosedMessage,
    buildPollMessage,
    buildResultMessage,
    canPeek,
} from '@/core/pollRender'

//排程的 key。用投票 id 當一部分，重複註冊時 scheduler 會自動蓋掉舊的，
//所以同一場投票不管經過幾次重啟或還原，都只會有一份排程、只會結算一次。
const closeKey = (pollId) => `poll:close:${pollId}`
const openKey = (pollId) => `poll:open:${pollId}`

const fetchChannel = async (client, channelId) => {
    const channel = await client.channels.fetch(channelId).catch(() => null)
    if(!channel || !channel.isTextBased()) return null
    return channel
}

/////////////////////////////// 發布 ///////////////////////////////

//把一場投票送進頻道，並排好截止時間。
//poll 必須已經寫進 polls/ —— 先落盤再送訊息，
//反過來的話送出訊息後當機，頻道裡就會留下一則永遠不會結算的殭屍投票。
const sendPollMessage = async (client, poll) => {
    const channel = await fetchChannel(client, poll.channelId)
    if(!channel){
        logger.error(`投票 ${poll.id} 找不到頻道 ${poll.channelId}，取消這場投票`)
        await deletePoll(poll.id)
        return null
    }

    const message = await channel.send(buildPollMessage(poll))

    const updated = await updatePoll(poll.id, (record) => {
        record.messageId = message.id
        record.status = 'open'
    })

    scheduler.scheduleAt(closeKey(poll.id), new Date(poll.closeAt), () => closePoll(client, poll.id))
    logger.info(
        `投票已發布：${poll.id}「${poll.title}」channel=${poll.channelId} ` +
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
    const ready = await updatePoll(pollId, (record) => {
        record.closeAt = closeAt
    })

    return sendPollMessage(client, ready)
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

    const channel = await fetchChannel(client, poll.channelId)

    //原訊息可能已被刪除。刪掉就算了，重點是結果要貼得出來，
    //所以這裡失敗只記錄，不中斷後面的流程。
    if(channel && poll.messageId){
        try{
            const message = await channel.messages.fetch(poll.messageId)
            await message.edit(buildClosedMessage(poll))
        }
        catch(e){
            logger.warn(`投票 ${pollId} 的原訊息無法更新(可能已被刪除)：`, e)
        }
    }

    if(channel) await channel.send(buildResultMessage(poll))
    else logger.error(`投票 ${pollId} 找不到頻道 ${poll.channelId}，結果無法公布`)

    //有每週設定就先排好下一輪，再處理這一筆。
    //順序反過來的話，中間當機就會兩邊都沒有。
    if(poll.weekly) await scheduleNextRound(client, poll)

    //從 polls/ 搬到 archive/，並補上結果快照。
    //「結算後清空」的語意是「移出進行中」，不是銷毀 —— 之後可用 /poll_admin 查。
    await archivePoll(poll)
    scheduler.cancel(closeKey(pollId))

    logger.info(`投票已結算：${pollId}「${poll.title}」投票人數=${Object.keys(poll.votes || {}).length}`)
    return poll
}

/////////////////////////// 開機還原 ///////////////////////////

//bot 重啟後，記憶體裡的排程全部消失，但 polls.json 還在。
//沒有這一步，重啟過的投票就永遠不會結算。
export const restorePolls = async (client) => {
    const polls = await listActivePolls()
    if(polls.length === 0) return 0

    for(const poll of polls){
        try{
            if(poll.status === 'open'){
                //已經過期的(停機期間錯過的截止時間)會立刻執行，補結算
                scheduler.scheduleAt(closeKey(poll.id), new Date(poll.closeAt), () => closePoll(client, poll.id))
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
//byAdmin 為 true 時略過 peek 設定 —— 管理員用 /poll_peek 永遠看得到。
export const peekPoll = async (pollId, {byAdmin = false} = {}) => {
    const poll = await getPoll(pollId)
    if(!poll) return {content: '這場投票已經結束並清除了。'}
    if(!byAdmin && !canPeek(poll)) return {content: '這場投票不開放中途查看結果。'}

    return buildResultMessage(poll, {live: true})
}

//指令沒指定 id 時，用「這個頻道進行中的投票」來推斷。
//剛好一場就直接用它，多於一場就要求指定 —— 猜錯會結算到不該結算的那場。
export const findOpenPollsInChannel = async (channelId) => {
    const polls = await listOpenPolls()
    return polls.filter((poll) => poll.channelId === channelId)
}

///poll_close 與 /poll_peek 共用的目標解析。
//回傳 {poll} 或 {error}，呼叫端只要判斷有沒有 error 就好。
export const resolveCommandPoll = async (channelId, pollId) => {
    if(pollId){
        const poll = await getPoll(pollId)
        if(!poll) return {error: `找不到 id 為 \`${pollId}\` 的投票，它可能已經結算並清除了。`}
        return {poll}
    }

    const polls = await findOpenPollsInChannel(channelId)
    if(polls.length === 0) return {error: '這個頻道目前沒有進行中的投票。'}
    if(polls.length > 1){
        const list = polls.map((poll) => `　\`${poll.id}\`　${poll.title}`).join('\n')
        return {error: `這個頻道有 ${polls.length} 場進行中的投票，請用 \`id\` 參數指定：\n${list}`}
    }

    return {poll: polls[0]}
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

        if(poll.messageId){
            const channel = await fetchChannel(client, poll.channelId)
            if(channel){
                try{
                    const message = await channel.messages.fetch(poll.messageId)
                    await message.edit(buildPollMessage(poll))
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

    //一人多角色是建立時的參數，但 Modal 只放得下五個輸入框，已經滿了。
    //做成開關按鈕：已經在跑的投票也能改，不必取消重開。
    //已投的票不受影響 —— 舊資料本來就是一人一筆，開啟後只是可以再加第二筆。
    if(action === 'mchar'){
        if(item.kind === 'archived') return detailOf(pollId, '已結束的投票不能修改。')
        await applyPollEdit(client, pollId, {multiChar: !item.poll.multiChar})
        return detailOf(pollId, item.poll.multiChar ? '已關閉一人多角色。' : '已開啟一人多角色。')
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
export default {
    createAndPublish,
    publishPending,
    closePoll,
    restorePolls,
    handlePollAction,
    peekPoll,
    findOpenPollsInChannel,
    resolveCommandPoll,
    cancelPoll,
    applyPollEdit,
    handleAdminAction,
    handleAdminEditSubmit,
}
