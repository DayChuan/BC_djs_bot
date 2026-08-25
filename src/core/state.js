import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import logger from '@/core/logger'

//小量、需要撐過 bot 重啟的狀態。單一 JSON 檔，用具名區段(section)分租給各功能。
//這裡不認識任何業務欄位 —— 一旦認識了，用到它的功能就得共同維護這個檔案。

//以檔案位置推導專案根目錄，不依賴當前工作目錄(同 pollStore.js)
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

//路徑一律在「用到時」才解析，不在模組載入時定死。
//載入時就讀環境變數的話，測試想指到暫存資料夾就得重新載入整個模組(vi.resetModules)，
//那在測試 jail 裡會連帶重載其他模組而卡死。
export const dataDir = () => process.env.STATE_DATA_DIR
    ? path.resolve(process.env.STATE_DATA_DIR)
    : path.join(ROOT_DIR, 'data')

export const stateFile = () => path.join(dataDir(), 'state.json')

/////////////////////////// 檔案讀寫 ///////////////////////////

//讀不到就回 null(呼叫端一律當作「還沒有這個檔」)。
//內容壞掉時保留現場再回 null —— 直接覆蓋會讓所有 section 的狀態一起無聲蒸發，
//而這個檔案裡放的正是「重啟後要靠它接回去」的東西，蒸發了就再也接不回來。
//非 ENOENT 的錯誤一律當成壞檔處理(跟 pollStore.readJson 同一套)：
//不細分 EACCES 之類「檔案其實沒壞」的情況，兩支檔案的錯誤處理一致比較好維護，
//而且真的是權限問題時 rename 也會失敗，原檔還在原地。
const readJson = async (file) => {
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
const writeJson = async (file, data) => {
    await fs.mkdir(path.dirname(file), {recursive: true})
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, file)
}

//整份 state.json 共用一條佇列。
//pollStore 能做到「一場投票一條佇列」是因為它一場一個檔案；
//這裡所有 section 住在同一個檔案裡，每次寫入都要重寫整份，
//分成多條佇列會讓兩段的「讀→改→寫」交錯，後寫的把先寫的那段蓋掉。
//資料量是幾十筆、寫入頻率極低，序列化的代價可以忽略。
let queue = Promise.resolve()

const enqueue = (task) => {
    const result = queue.then(task, task)
    //佇列本身要吞掉錯誤，否則一次失敗會讓後面所有操作跟著 reject
    queue = result.then(() => undefined, () => undefined)
    return result
}

//測試用：丟掉佇列狀態
export const resetQueue = () => {
    queue = Promise.resolve()
}

/////////////////////////////// 公開 API ///////////////////////////////

const normalizeSection = (section) => {
    const name = String(section || '').trim()
    if(!name) throw new TypeError('state section 不可為空')
    return name
}

//section 是 JSON 的鍵，不會進檔名，所以不需要像 pollId 那樣防路徑穿越。

const readAll = async () => await readJson(stateFile()) || {}

//回傳的物件每次都是重新 parse 出來的，呼叫端拿到的天然就是副本，改它不會影響檔案。
//沒有這個 section 就回 {}，讓呼叫端不必到處判斷 null。
export const getState = async (section) => {
    const name = normalizeSection(section)
    const all = await readAll()
    const value = all[name]
    return value === undefined || value === null ? {} : value
}

//整段覆寫。
export const setState = async (section, value) => enqueue(async () => {
    const name = normalizeSection(section)
    const all = await readAll()
    all[name] = value
    await writeJson(stateFile(), all)
    return value
})

//讀→改→寫，整段走佇列。
//mutator 收到目前的值(沒有就是 {})，回傳新值；回傳 undefined 視為「就地改動」，沿用同一個物件。
export const updateState = async (section, mutator) => enqueue(async () => {
    const name = normalizeSection(section)
    const all = await readAll()
    const current = all[name] === undefined || all[name] === null ? {} : all[name]
    const next = await mutator(current)
    all[name] = next === undefined ? current : next
    await writeJson(stateFile(), all)
    return all[name]
})

///////////////////////// 開機還原的登記表 /////////////////////////

//記憶體裡的一次性計時在重啟時全部消失，state.json 還在 —— 少了這一步，
//重啟過的靜音、排定的分享就永遠等不到到期(同 pollService.restorePolls 的處境)。
//
//這張表只存 name → fn，state.js 仍然不認識 vmute、japanese 是什麼；
//「哪些狀態要重掛排程」由各功能自己在模組載入時登記。
//這樣做而不是在 ready/index.js 直接列舉，是因為 ready/index.js 不在各功能的
//檔案領域裡：改成登記制，新功能只要動自己的模組，不必跟別的單元搶同一支檔案。
const restores = new Map()

export const registerRestore = (name, fn) => {
    if(typeof fn !== 'function') throw new TypeError(`還原掛鉤「${name}」必須是函式`)
    restores.set(String(name), fn)
}

export const restoreNames = () => [...restores.keys()]

//測試用：清掉登記表
export const clearRestores = () => {
    restores.clear()
}

//逐項跑，單項失敗只記 log 不往外拋：
//一個功能還原失敗不該連累其他功能，而呼叫端是 ready 事件 ——
//那裡的 rejection 沒人接得到，會直接終止整個行程。
export const runRestores = async (...args) => {
    for(const [name, fn] of restores){
        try{
            await fn(...args)
        }
        catch(e){
            logger.error(`狀態還原「${name}」失敗(已攔截，其餘項目繼續)：`, e)
        }
    }
}

export default {
    dataDir,
    stateFile,
    getState,
    setState,
    updateState,
    resetQueue,
    registerRestore,
    restoreNames,
    clearRestores,
    runRestores,
}
