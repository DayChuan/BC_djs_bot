import logger from '@/core/logger'

//「同一個人同一時間只留一則 ephemeral 面板」。
//點第二次按鈕時把上一則刪掉，畫面上不會愈疊愈多。
//
//能刪別次互動的訊息，是因為每個 interaction 自己帶著一組 webhook token，
//拿舊的 interaction 呼叫 deleteReply() 就會刪掉當初那則回覆。
//代價是 token 只有 15 分鐘壽命，過期就再也刪不掉 —— 所以這裡只保留 14 分鐘，
//超過的直接丟掉不試，省下一次注定會失敗的 API 往返。
const TTL_MS = 14 * 60 * 1000

//key: `${guildId}:${userId}` → {interaction, at}
const tracked = new Map()

const keyOf = (interaction) => `${interaction.guildId || 'dm'}:${interaction.user.id}`

//每次寫入順手清一次，否則進出過的人會一直留在 Map 裡
const dropExpired = (now) => {
    for(const [key, entry] of tracked){
        if(now - entry.at > TTL_MS) tracked.delete(key)
    }
}

//刪除失敗的情況都不是錯誤：使用者自己按了 Dismiss(10008 Unknown Message)、
//token 過期(50027)、訊息被別的流程收掉。這裡一律吞掉只記 log ——
//這個函式是在使用者等回覆的路徑上被呼叫的，絕對不能因為清垃圾失敗就中斷本次互動。
const deleteQuietly = async(interaction) => {
    try{
        await interaction.deleteReply()
    }
    catch(e){
        logger.warn('刪除上一則 ephemeral 回覆失敗(略過)：', e)
    }
}

//開新面板時呼叫：刪掉上一則、把這次登記為最新。
//要在 deferReply() 之後呼叫 —— Discord 會先顯示「思考中」，中間不會有空窗。
export const trackEphemeral = async(interaction, now = Date.now()) => {
    const key = keyOf(interaction)
    const previous = tracked.get(key)

    tracked.set(key, {interaction, at: now})
    dropExpired(now)

    if(!previous) return
    if(previous.interaction === interaction) return
    if(now - previous.at > TTL_MS) return

    await deleteQuietly(previous.interaction)
}

//就地更新(deferUpdate)時呼叫：訊息還是同一則，但可以換成比較新的 token，
//讓「最後能刪掉它」的期限跟著使用者的操作往後延。
//
//刻意只更新既有項目：沒被我們登記過的 ephemeral 訊息(例如 /poll_admin 開出來的面板)
//不該因為使用者按了別的按鈕就被刪掉。
export const refreshEphemeral = (interaction, now = Date.now()) => {
    const key = keyOf(interaction)
    if(!tracked.has(key)) return
    tracked.set(key, {interaction, at: now})
}

//測試用：清掉所有狀態
export const resetEphemeralTracker = () => tracked.clear()
