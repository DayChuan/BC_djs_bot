//投票面板的暫存草稿。
//
//為什麼要有它：每點一個選項就寫檔並重繪面板，使用者每一下都要等一次
//Discord 的往返，體驗很差。改成選的時候只記在記憶體、只回一個 ACK，
//等按下「投票」才真正寫入。
//
//一份草稿 = 一隻角色。這對應「一次投票就是一隻角色」的操作邏輯：
//有未儲存的變更時不能新增或切換角色，要先送出或清除。
//
//只存在記憶體，bot 重啟就沒了 —— 草稿的生命週期是幾十秒，
//為它做持久化不划算。

const drafts = new Map()

//超過這個時間沒動作就丟掉，避免有人開了面板不管而讓 Map 無限長大
export const DRAFT_TTL_MS = 30 * 60 * 1000

const keyOf = (pollId, userId) => `${pollId}:${userId}`

//每次存取順手清掉過期的。量很小，不值得為它另外開一個計時器。
const prune = (now) => {
    for(const [key, draft] of drafts){
        if(now - draft.at > DRAFT_TTL_MS) drafts.delete(key)
    }
}

export const getDraft = (pollId, userId, now = Date.now()) => {
    prune(now)
    return drafts.get(keyOf(pollId, userId)) || null
}

export const setDraft = (pollId, userId, draft, now = Date.now()) => {
    prune(now)
    const saved = {...draft, at: now}
    drafts.set(keyOf(pollId, userId), saved)
    return saved
}

export const clearDraft = (pollId, userId) => drafts.delete(keyOf(pollId, userId))

export const hasDraft = (pollId, userId, now = Date.now()) =>
    Boolean(getDraft(pollId, userId, now))

//測試用
export const resetDrafts = () => drafts.clear()

export const draftCount = () => drafts.size

export default {
    DRAFT_TTL_MS,
    getDraft,
    setDraft,
    clearDraft,
    hasDraft,
    resetDrafts,
    draftCount,
}
