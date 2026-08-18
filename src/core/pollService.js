import logger from '@/core/logger'
import scheduler, {nextWeeklyDate} from '@/core/scheduler'
import {
    castVote,
    createPoll,
    deletePoll,
    getPoll,
    listActivePolls,
    updatePoll,
} from '@/core/pollStore'
import {
    buildBallotReply,
    buildClosedMessage,
    buildPollMessage,
    buildResultMessage,
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
//poll 必須已經存在於 polls.json —— 先落盤再送訊息，
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

    const next = await createPoll({
        type: poll.type,
        guildId: poll.guildId,
        channelId: poll.channelId,
        title: poll.title,
        description: poll.description,
        options: poll.options,
        multi: poll.multi,
        identityGroup: poll.identityGroup,
        weekly: poll.weekly,
        createdBy: poll.createdBy,
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

    //有每週設定就先排好下一輪，再刪這一筆。
    //順序反過來的話，中間當機就會兩邊都沒有。
    if(poll.weekly) await scheduleNextRound(client, poll)

    await deletePoll(pollId)
    scheduler.cancel(closeKey(pollId))

    logger.info(`投票已結算並清除：${pollId}「${poll.title}」投票人數=${Object.keys(poll.votes || {}).length}`)
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

/////////////////////////// 選單互動 ///////////////////////////

//選單送回來的一定是「這個人當下的完整選擇」，所以直接覆蓋。
//kind 為 identity 時只帶身分，不動選項。
export const handlePollSelect = async (interaction, kind, pollId) => {
    const ballot = kind === 'identity'
        ? {identity: interaction.values[0] || null}
        : {options: interaction.values}

    const poll = await castVote(pollId, interaction.user.id, ballot)

    if(!poll){
        return '這場投票已經結束並清除了。'
    }
    if(poll.status !== 'open'){
        return '這場投票已經截止，不能再更改。'
    }

    return buildBallotReply(poll, interaction.user.id)
}

export default {
    createAndPublish,
    publishPending,
    closePoll,
    restorePolls,
    handlePollSelect,
}
