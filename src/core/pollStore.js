import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import logger from '@/core/logger'

//以檔案位置推導專案根目錄，不依賴當前工作目錄(同 logger.js，避免 M-05)
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const DEFAULT_POLLS_FILE = path.join(ROOT_DIR, 'data', 'polls.json')

//路徑刻意在「用到時」才解析，不在模組載入時就定死。
//載入時就讀環境變數的話，任何想換路徑的人(例如測試想指到暫存檔)
//都得先設好環境變數再重新載入整個模組 —— 那會連帶把 discord.js 一起重載，
//在測試 jail 裡會直接卡死。詳見 docs/PLAN.md 的環境限制。
export const pollsFilePath = () => process.env.POLLS_FILE
    ? path.resolve(process.env.POLLS_FILE)
    : DEFAULT_POLLS_FILE

const emptyStore = () => ({polls: {}})

///////////////////////// 純函式(可單獨做單元測試) /////////////////////////

//投票 id。夠短(進得了 100 字元上限的 customId)、夠唯一(同一毫秒內也不會撞)。
export const makePollId = (now = Date.now(), rand = Math.random()) =>
    `p_${now.toString(36)}${Math.floor(rand * 1296).toString(36).padStart(2, '0')}`

//Discord 的選單一次最多 25 個選項，標籤最多 100 字
export const MAX_OPTIONS = 25
export const MAX_OPTION_LABEL = 100

//把指令參數的「A,B,C」拆成選項。
//全形逗號一起吃：中文輸入法下打出來的幾乎都是全形，
//只認半形的話使用者會得到一個只有一個選項的投票，而且不知道為什麼。
export const parseOptionsInput = (text) => {
    const seen = new Set()
    const options = []

    for(const raw of String(text || '').split(/[,，]/)){
        const label = raw.trim().slice(0, MAX_OPTION_LABEL)
        if(!label) continue
        //重複的選項會讓統計出現兩個一模一樣的欄位，直接去掉
        if(seen.has(label)) continue
        seen.add(label)
        options.push({key: `o${options.length}`, label})
    }

    return options.slice(0, MAX_OPTIONS)
}

//把一個人的選擇寫進 poll(直接改傳入的物件)。
//選單送回來的一定是「完整的當前選擇」，所以是整組覆蓋而不是累加。
//選項清空 = 取消投票，直接把這個人從名單移除，避免留下一堆空票影響分母。
export const applyVote = (poll, userId, ballot = {}) => {
    if(!poll.votes) poll.votes = {}

    const valid = new Set(poll.options.map((option) => option.key))
    const chosen = (ballot.options === undefined ? null : ballot.options)

    const previous = poll.votes[userId]
    const nextOptions = chosen === null
        //只更新身分、不動選項(身分選單與選項選單是兩個獨立的 interaction)
        ? (previous ? previous.options : [])
        : [...new Set(chosen)].filter((key) => valid.has(key))

    //單選的投票即使前端傳多個也只取第一個，後端不能信任前端
    const limited = poll.multi ? nextOptions : nextOptions.slice(0, 1)

    const identity = ballot.identity === undefined
        ? (previous ? previous.identity : null)
        : (ballot.identity || null)

    if(limited.length === 0 && !identity){
        delete poll.votes[userId]
        return poll
    }

    poll.votes[userId] = {options: limited, identity}
    return poll
}

//統計。回傳的東西直接給 embed 用，不含任何 Discord 相依。
//分母一律是「有投任何選項的人數」：複選時總票數會大於人數，用票數當分母
//百分比加起來會超過 100%，看起來像壞掉。
export const tally = (poll) => {
    const votes = poll.votes || {}
    const entries = Object.entries(votes).filter(([, vote]) => vote.options.length > 0)
    const voterCount = entries.length

    const options = poll.options.map((option) => {
        const userIds = entries
            .filter(([, vote]) => vote.options.includes(option.key))
            .map(([userId]) => userId)

        //該選項底下各身分各幾人，結算報表要按身分分組時用
        const identities = {}
        for(const [userId] of entries.filter(([id]) => userIds.includes(id))){
            const key = votes[userId].identity || 'unknown'
            identities[key] = (identities[key] || 0) + 1
        }

        return {
            key: option.key,
            label: option.label,
            count: userIds.length,
            percent: voterCount === 0 ? 0 : Math.round((userIds.length / voterCount) * 1000) / 10,
            userIds,
            identities,
        }
    })

    const identityTotals = {}
    for(const [, vote] of entries){
        if(!vote.identity) continue
        identityTotals[vote.identity] = (identityTotals[vote.identity] || 0) + 1
    }

    return {voterCount, options, identityTotals}
}

/////////////////////////// 檔案層(序列化寫入) ///////////////////////////

//記憶體快取。只有這個行程會寫這個檔，所以快取與檔案不會不同步。
//但每次異動都會立刻落盤 —— 交接文件第 3 節明確禁止只存在記憶體。
let cache = null

//所有讀寫都排進同一條 Promise 鏈，一次只跑一個。
//多人同時點選單時，「讀 → 改 → 寫」不會交錯，也就不會互相覆寫(交接文件第 4.3 點)。
let queue = Promise.resolve()

const enqueue = (task) => {
    const result = queue.then(task, task)
    //鏈本身要吞掉錯誤，否則一次失敗會讓後面所有操作跟著 reject
    queue = result.then(() => undefined, () => undefined)
    return result
}

const load = async () => {
    if(cache) return cache

    const file = pollsFilePath()

    try{
        const raw = await fs.readFile(file, 'utf8')
        const parsed = JSON.parse(raw)
        cache = (parsed && typeof parsed === 'object' && parsed.polls) ? parsed : emptyStore()
    }
    catch(e){
        if(e.code === 'ENOENT'){
            //第一次執行，還沒有檔案
            cache = emptyStore()
        }
        else{
            //檔案壞掉時保留現場再從空的開始。直接覆蓋會讓當下所有投票資料無聲蒸發。
            const backup = `${file}.broken-${Date.now()}`
            logger.error(`polls.json 讀取失敗，已備份到 ${backup}：`, e)
            await fs.rename(file, backup).catch(() => undefined)
            cache = emptyStore()
        }
    }

    return cache
}

//先寫暫存檔再 rename。rename 在同一個檔案系統上是原子操作，
//行程剛好在寫入途中被殺掉時，polls.json 仍然是上一份完整的資料，不會變成半截 JSON。
const persist = async () => {
    const file = pollsFilePath()
    await fs.mkdir(path.dirname(file), {recursive: true})
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8')
    await fs.rename(tmp, file)
}

//對外一律回複本，避免呼叫端拿到快取本身後在佇列外偷改
const clone = (value) => (value === undefined || value === null ? value : structuredClone(value))

/////////////////////////////// 公開 API ///////////////////////////////

export const readPolls = () => enqueue(async () => {
    const store = await load()
    return clone(store.polls)
})

export const getPoll = (id) => enqueue(async () => {
    const store = await load()
    return clone(store.polls[id]) || null
})

//回傳所有 status === 'open' 的投票
export const listOpenPolls = () => enqueue(async () => {
    const store = await load()
    return Object.values(store.polls)
        .filter((poll) => poll.status === 'open')
        .map(clone)
})

//bot 啟動時用它重新掛回排程。
//pending 是每週投票結算後排定的「下一輪」，還沒發出訊息，
//漏掉它的話重啟一次就再也不會有下一輪了。
export const listActivePolls = () => enqueue(async () => {
    const store = await load()
    return Object.values(store.polls)
        .filter((poll) => poll.status === 'open' || poll.status === 'pending')
        .map(clone)
})

export const createPoll = (poll) => enqueue(async () => {
    const store = await load()
    const id = poll.id || makePollId()
    store.polls[id] = {...clone(poll), id, status: poll.status || 'open', votes: poll.votes || {}}
    await persist()
    return clone(store.polls[id])
})

//mutator 收到的是快取裡的實體，可以直接改。
//回傳 false 代表放棄這次異動(例如投票已經結算)，此時不寫檔。
export const updatePoll = (id, mutator) => enqueue(async () => {
    const store = await load()
    const poll = store.polls[id]
    if(!poll) return null

    if(mutator(poll) === false) return clone(poll)

    await persist()
    return clone(poll)
})

//結算完呼叫。只刪這一筆，其他進行中的投票不受影響。
export const deletePoll = (id) => enqueue(async () => {
    const store = await load()
    if(!store.polls[id]) return false
    delete store.polls[id]
    await persist()
    return true
})

//投票的入口。整個「讀 → 套用 → 寫」都在佇列內完成。
export const castVote = (id, userId, ballot) => updatePoll(id, (poll) => {
    if(poll.status !== 'open') return false
    applyVote(poll, userId, ballot)
})

//測試用：丟掉記憶體快取，下次讀取重新讀檔
export const resetCache = () => {
    cache = null
}

export default {
    pollsFilePath,
    readPolls,
    getPoll,
    listOpenPolls,
    listActivePolls,
    parseOptionsInput,
    createPoll,
    updatePoll,
    deletePoll,
    castVote,
    tally,
    applyVote,
    makePollId,
    resetCache,
}
