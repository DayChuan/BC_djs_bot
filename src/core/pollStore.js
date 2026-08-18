import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import logger from '@/core/logger'

//以檔案位置推導專案根目錄，不依賴當前工作目錄(同 logger.js，避免 M-05)
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

//路徑一律在「用到時」才解析，不在模組載入時定死。
//載入時就讀環境變數的話，測試想指到暫存資料夾就得重新載入整個模組，
//那會連帶把 discord.js 一起重載，在測試 jail 裡會卡死(詳見 docs/PLAN.md)。
export const dataDir = () => process.env.POLL_DATA_DIR
    ? path.resolve(process.env.POLL_DATA_DIR)
    : path.join(ROOT_DIR, 'data')

//進行中的投票，一場一個檔案。已結算的由 pollArchive.js 搬到 archive/。
export const pollsDir = () => path.join(dataDir(), 'polls')

//舊版本把所有投票塞在同一個檔案裡，開機時會自動遷移(見 migrateLegacyStore)
export const legacyStoreFile = () => path.join(dataDir(), 'polls.json')

///////////////////////// 純函式(可單獨做單元測試) /////////////////////////

//投票 id。夠短(進得了 100 字元上限的 customId)、夠唯一(同一毫秒內也不會撞)。
export const makePollId = (now = Date.now(), rand = Math.random()) =>
    `p_${now.toString(36)}${Math.floor(rand * 1296).toString(36).padStart(2, '0')}`

//id 會被拿去組檔名，所以一定要驗格式。
//少了這道關卡，`/poll_close id:../../../etc/passwd` 就能讓 bot 去讀寫任意路徑。
export const isValidPollId = (id) => /^p_[a-z0-9]{1,40}$/i.test(String(id || ''))

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

//一個人最多能登記幾個角色。純粹是防呆上限 ——
//沒有上限的話一個人可以按到幾百筆，把結算報表塞爆。
export const MAX_ENTRIES_PER_USER = 10

//一個人的投票是「一筆或多筆」：一人多角色時，每個角色一筆。
//舊資料是單一物件(一人一筆)，這裡統一轉成陣列，讓上層只需要處理一種形狀。
//轉換不寫回檔案 —— 讀到就轉，下次寫入時自然變成新格式。
export const normalizeEntries = (raw) => {
    if(!raw) return []
    if(Array.isArray(raw)) return raw
    return [{entryId: 'e0', options: raw.options || [], identity: raw.identity || null}]
}

export const getEntries = (poll, userId) => normalizeEntries((poll.votes || {})[userId])

//下一個沒被用過的 entryId。不重用已刪除的編號，
//避免「剛刪掉 e1、又新增 e1」讓還開著舊面板的人改到不同的角色。
export const nextEntryId = (entries) => {
    const used = entries.map((entry) => Number(String(entry.entryId || '').slice(1)))
    const max = used.filter(Number.isFinite).reduce((a, b) => Math.max(a, b), -1)
    return `e${max + 1}`
}

//把一筆選擇寫進 poll(直接改傳入的物件)。
//選單送回來的一定是「這個角色當下的完整選擇」，所以是整組覆蓋而不是累加。
//entryId 沒指定時視為操作第一筆(相容於改版前發出的舊投票訊息)。
export const applyVote = (poll, userId, ballot = {}, entryId = null) => {
    if(!poll.votes) poll.votes = {}

    const valid = new Set(poll.options.map((option) => option.key))
    const entries = getEntries(poll, userId)

    const targetId = entryId || (entries[0] ? entries[0].entryId : 'e0')
    const index = entries.findIndex((entry) => entry.entryId === targetId)
    const previous = index >= 0 ? entries[index] : {entryId: targetId, options: [], identity: null}

    const chosen = (ballot.options === undefined ? null : ballot.options)
    const nextOptions = chosen === null
        //只更新身分、不動選項(身分選單與選項選單是兩個獨立的 interaction)
        ? previous.options
        : [...new Set(chosen)].filter((key) => valid.has(key))

    //單選的投票即使前端傳多個也只取第一個，後端不能信任前端
    const limited = poll.multi ? nextOptions : nextOptions.slice(0, 1)

    const identity = ballot.identity === undefined
        ? previous.identity
        : (ballot.identity || null)

    const updated = {entryId: targetId, options: limited, identity}
    const next = index >= 0
        ? entries.map((entry, i) => (i === index ? updated : entry))
        : [...entries, updated]

    //只動目標那一筆，其他角色一律原封不動。
    //早期版本會把所有「空的」角色一起清掉 —— 於是按了新增角色之後，
    //只要回頭改前一個角色，那筆剛新增、還沒選東西的就被順手刪了，
    //切換選單跟著消失，看起來就像不能修改其他角色。
    //空的角色留著沒有副作用：tally 只看有選項的，統計不會被影響。
    const onlyOneAndEmpty = next.length === 1
        && next[0].options.length === 0
        && !next[0].identity

    if(onlyOneAndEmpty) delete poll.votes[userId]
    else poll.votes[userId] = next

    return poll
}

//新增一個角色(空的一筆)。回傳新的 entryId，超過上限時回 null。
export const addEntry = (poll, userId) => {
    if(!poll.votes) poll.votes = {}

    const entries = getEntries(poll, userId)
    if(entries.length >= MAX_ENTRIES_PER_USER) return null

    const entryId = nextEntryId(entries)
    poll.votes[userId] = [...entries, {entryId, options: [], identity: null}]
    return entryId
}

export const removeEntry = (poll, userId, entryId) => {
    const entries = getEntries(poll, userId)
    const left = entries.filter((entry) => entry.entryId !== entryId)

    if(left.length === entries.length) return false
    if(left.length === 0) delete poll.votes[userId]
    else poll.votes[userId] = left

    return true
}

//統計。回傳的東西直接給 embed 用，不含任何 Discord 相依。
//一人多角色時「票」的單位是角色而不是人：三個人五隻角色，
//其中四隻選了星期二，那就是 4/5。分母用角色數，人數另外列。
export const tally = (poll) => {
    const votes = poll.votes || {}

    //攤平成一筆一筆，只留有選項目的
    const entries = []
    for(const [userId, raw] of Object.entries(votes)){
        for(const entry of normalizeEntries(raw)){
            if(entry.options.length === 0) continue
            entries.push({userId, options: entry.options, identity: entry.identity || null})
        }
    }

    const entryCount = entries.length
    const voterCount = new Set(entries.map((entry) => entry.userId)).size

    const options = poll.options.map((option) => {
        const picked = entries.filter((entry) => entry.options.includes(option.key))

        //該選項底下各身分各幾隻，結算報表要按身分分組時用
        const identities = {}
        for(const entry of picked){
            const key = entry.identity || 'unknown'
            identities[key] = (identities[key] || 0) + 1
        }

        return {
            key: option.key,
            label: option.label,
            count: picked.length,
            userCount: new Set(picked.map((entry) => entry.userId)).size,
            percent: entryCount === 0 ? 0 : Math.round((picked.length / entryCount) * 1000) / 10,
            //保留 userIds 供舊的呼叫端使用(同一人多角色時會重複出現)
            userIds: picked.map((entry) => entry.userId),
            entries: picked,
            identities,
        }
    })

    const identityTotals = {}
    for(const entry of entries){
        if(!entry.identity) continue
        identityTotals[entry.identity] = (identityTotals[entry.identity] || 0) + 1
    }

    return {voterCount, entryCount, options, identityTotals}
}

/////////////////////////// 檔案讀寫的共用工具 ///////////////////////////

//讀不到就回 null(呼叫端一律當作「沒這筆」)。
//內容壞掉時保留現場再回 null —— 直接覆蓋會讓那場投票的資料無聲蒸發。
export const readJson = async (file) => {
    try{
        return JSON.parse(await fs.readFile(file, 'utf8'))
    }
    catch(e){
        if(e.code === 'ENOENT') return null

        const backup = `${file}.broken-${Date.now()}`
        logger.error(`${path.basename(file)} 讀取失敗，已備份到 ${backup}：`, e)
        await fs.rename(file, backup).catch(() => undefined)
        return null
    }
}

//先寫暫存檔再 rename。rename 在同一個檔案系統上是原子操作，
//行程剛好在寫入途中被殺掉時，原檔仍然是上一份完整的資料，不會變成半截 JSON。
export const writeJson = async (file, data) => {
    await fs.mkdir(path.dirname(file), {recursive: true})
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, file)
}

const pollFile = (id) => path.join(pollsDir(), `${id}.json`)

//以投票為單位串行化「讀 → 改 → 寫」。
//一場投票一個佇列，所以 A 投票的人不會被 B 投票的寫入卡住 ——
//這是拆成一場一檔之後才做得到的事，舊版所有人共用一條佇列。
const queues = new Map()

const enqueue = (id, task) => {
    const previous = queues.get(id) || Promise.resolve()
    const result = previous.then(task, task)
    //佇列本身要吞掉錯誤，否則一次失敗會讓後面所有操作跟著 reject
    queues.set(id, result.then(() => undefined, () => undefined))
    return result
}

//測試用：丟掉所有佇列狀態
export const resetCache = () => {
    queues.clear()
}

/////////////////////////////// 公開 API ///////////////////////////////

export const getPoll = async (id) => {
    if(!isValidPollId(id)) return null
    return readJson(pollFile(id))
}

//掃 polls/ 資料夾。進行中的投票是個位數，成本可以忽略。
const readAllPolls = async () => {
    let names = []
    try{
        names = await fs.readdir(pollsDir())
    }
    catch(e){
        //資料夾還沒建立 = 一場投票都還沒開過
        if(e.code === 'ENOENT') return []
        throw e
    }

    const polls = []
    for(const name of names){
        //只收 .json，略過寫到一半的 .tmp 與壞檔備份 .broken-*
        if(!name.endsWith('.json')) continue
        const poll = await readJson(path.join(pollsDir(), name))
        if(poll && poll.id) polls.push(poll)
    }

    return polls
}

export const readPolls = async () => {
    const polls = await readAllPolls()
    return Object.fromEntries(polls.map((poll) => [poll.id, poll]))
}

export const listOpenPolls = async () =>
    (await readAllPolls()).filter((poll) => poll.status === 'open')

//bot 啟動時用它重新掛回排程。
//pending 是每週投票結算後排定的「下一輪」，還沒發出訊息，
//漏掉它的話重啟一次就再也不會有下一輪了。
export const listActivePolls = async () =>
    (await readAllPolls()).filter((poll) => poll.status === 'open' || poll.status === 'pending')

export const createPoll = async (poll) => {
    let id = poll.id || makePollId()
    //極低機率撞號(同毫秒同亂數)，撞到就重抽，不要覆蓋別人的投票
    while(await getPoll(id)) id = makePollId()

    const record = {
        ...poll,
        id,
        status: poll.status || 'open',
        votes: poll.votes || {},
    }

    return enqueue(id, async () => {
        await writeJson(pollFile(id), record)
        return record
    })
}

//mutator 收到的是剛從檔案讀出來的物件，可以直接改。
//回傳 false 代表放棄這次異動(例如投票已經結算)，此時不寫檔。
export const updatePoll = async (id, mutator) => {
    if(!isValidPollId(id)) return null

    return enqueue(id, async () => {
        const poll = await readJson(pollFile(id))
        if(!poll) return null

        if(mutator(poll) === false) return poll

        await writeJson(pollFile(id), poll)
        return poll
    })
}

//結算完由 pollArchive 呼叫。只刪這一場的檔案，其他投票完全不受影響。
export const deletePoll = async (id) => {
    if(!isValidPollId(id)) return false

    return enqueue(id, async () => {
        try{
            await fs.unlink(pollFile(id))
            return true
        }
        catch(e){
            if(e.code === 'ENOENT') return false
            throw e
        }
    })
    //刻意不從 queues 移除這個 id：移除的瞬間若有另一個操作已經排進佇列，
    //再下一個操作就會另起一條鏈、不等前一個完成，反而製造出併發問題。
    //一個 Map entry 的記憶體可以忽略。
}

//投票的入口。整個「讀 → 套用 → 寫」都在該場投票的佇列內完成。
export const castVote = (id, userId, ballot, entryId = null) => updatePoll(id, (poll) => {
    if(poll.status !== 'open') return false
    applyVote(poll, userId, ballot, entryId)
})

//新增一個角色。回傳更新後的投票；新的那一筆一定是該使用者的最後一筆，
//呼叫端要把面板切過去的話從 getEntries() 取最後一個即可。
export const addVoteEntry = (id, userId) => updatePoll(id, (poll) => {
    if(poll.status !== 'open') return false
    addEntry(poll, userId)
})

export const removeVoteEntry = (id, userId, entryId) => updatePoll(id, (poll) => {
    if(poll.status !== 'open') return false
    removeEntry(poll, userId, entryId)
})

/////////////////////////// 舊格式遷移 ///////////////////////////

//舊版把所有投票放在單一個 data/polls.json。開機時偵測到就拆成一場一檔，
//然後把舊檔改名為 .migrated 保留 —— 不刪掉，萬一拆錯還救得回來。
export const migrateLegacyStore = async () => {
    const file = legacyStoreFile()
    const legacy = await readJson(file)
    if(!legacy || !legacy.polls) return 0

    let migrated = 0
    for(const [id, poll] of Object.entries(legacy.polls)){
        if(!isValidPollId(id)){
            logger.warn(`舊資料裡的投票 id 格式不合法，略過：${id}`)
            continue
        }
        //已經有單檔版本就不要覆蓋(重複執行遷移時的保護)
        if(await getPoll(id)) continue

        await writeJson(pollFile(id), {...poll, id})
        migrated += 1
    }

    await fs.rename(file, `${file}.migrated`).catch((e) => {
        logger.error('舊 polls.json 改名失敗，下次開機會再遷移一次(內容不會重複)：', e)
    })

    logger.info(`已將舊格式的 ${migrated} 場投票遷移為一場一檔`)
    return migrated
}

export default {
    dataDir,
    pollsDir,
    getEntries,
    normalizeEntries,
    addEntry,
    removeEntry,
    addVoteEntry,
    removeVoteEntry,
    readPolls,
    getPoll,
    listOpenPolls,
    listActivePolls,
    createPoll,
    updatePoll,
    deletePoll,
    castVote,
    tally,
    applyVote,
    parseOptionsInput,
    makePollId,
    isValidPollId,
    migrateLegacyStore,
    resetCache,
}
