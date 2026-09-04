import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '@/core/logger'
import {identityGroups} from '@/config/pollIdentities'
import {parseTimeOfDay, parseWeekday} from '@/core/scheduler'
import {
    MAX_OPTIONS,
    MAX_OPTION_LABEL,
    dataDir,
    parseOptionsInput,
    readJson,
    writeJson,
} from '@/core/pollStore'

//投票模板：把「每次都要重打一遍」的那組設定存起來。
//楓之谷週常那種投票，每週要改的其實只有標題與說明，
//選項、身分表、每週排程全都一樣 —— 那些就是模板的內容。
//
//模板一個檔案，跟投票一樣放在 data/ 底下，可以透過 /poll_admin 維護。

export const templatesDir = () => path.join(dataDir(), 'templates')

//Discord 的 choices 與選單都是 25 個上限，超過的模板列不出來
export const MAX_TEMPLATES = 25
export const MAX_TEMPLATE_NAME = 80

///////////////////////// 純函式(可單獨做單元測試) /////////////////////////

export const makeTemplateId = (now = Date.now(), rand = Math.random()) =>
    `t_${now.toString(36)}${Math.floor(rand * 1296).toString(36).padStart(2, '0')}`

//跟投票 id 一樣，會被拿去組檔名，所以一定要驗格式，
//否則 `../../../etc/passwd` 這種 id 就能讓 bot 讀寫任意路徑。
export const isValidTemplateId = (id) => /^t_[a-z0-9]{1,40}$/i.test(String(id || ''))

const DAY_MS = 24 * 60 * 60 * 1000

//「YYYY-MM-DD」轉成 UTC 毫秒。不合法回 null。
//日期一律用毫秒運算，不自己對月份與日數加減 —— 後者在跨月、跨年、閏年
//都要另外寫特例，而毫秒加減這三種情況都自動正確。
export const parseDateOnly = (text) => {
    const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(text || '').trim())
    if(!matched) return null

    const [, year, month, day] = matched.map(Number)
    if(month < 1 || month > 12 || day < 1 || day > 31) return null

    const ms = Date.UTC(year, month - 1, day)

    //Date.UTC 會把 2 月 31 日自動進位成 3 月 3 日，這種要擋掉
    const check = new Date(ms)
    if(check.getUTCFullYear() !== year) return null
    if(check.getUTCMonth() !== month - 1) return null
    if(check.getUTCDate() !== day) return null

    return ms
}

export const formatDateOnly = (ms) => {
    const date = new Date(ms)
    const pad = (n) => String(n).padStart(2, '0')
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

//加減天數。跨月、跨年、閏年都由毫秒運算自然處理。
export const addDays = (dateText, days) => {
    const ms = parseDateOnly(dateText)
    if(ms === null) return null
    return formatDateOnly(ms + days * DAY_MS)
}

//選項文字開頭的星期。認不出來回 null ——
//呼叫端據此決定要不要退回舊的逐日遞增。
//
//中文認 星期X / 週X / 周X / 禮拜X，「日」與「天」都當星期日。
const WEEKDAY_CHARS = {日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6}

//英文認全名與常見縮寫，不分大小寫。
const WEEKDAY_WORDS = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
}

export const weekdayOf = (text) => {
    const raw = String(text || '')

    const chinese = /^\s*(?:星期|週|周|禮拜)([日天一二三四五六])/.exec(raw)
    if(chinese) return WEEKDAY_CHARS[chinese[1]]

    //英文取開頭那一整串字母去查表，而不是用前綴比對。
    //「Sat(Mor)」的字母串是 Sat，查得到；「Sunny 場次」「Monster 團」的字母串是
    //Sunny 與 Monster，查不到 —— 整串比對不中就是不中，不需要另外寫邊界規則，
    //也不會把不是星期的字誤判成星期日與星期一。
    const english = /^\s*([A-Za-z]+)/.exec(raw)
    if(english){
        //用 typeof 檢查而不是 in：物件字面值帶著 Object.prototype，
        //`WEEKDAY_WORDS['constructor']` 會回一個函式而不是 undefined，
        //於是名為「Constructor」的選項會拿到一個函式當星期幾。
        const day = WEEKDAY_WORDS[english[1].toLowerCase()]
        if(typeof day === 'number') return day
    }

    return null
}

//每個選項相對於起日要往後幾天。
//
//全部選項都認得出星期時依星期對齊：「星期六早上」「星期六下午」「星期六晚上」
//三個都是星期六，就會落在同一天。用索引遞增的話它們會變成連續三天 ——
//那正是 2026-08-27 回報的 bug。
//
//只要有一個選項認不出星期，整組退回「一個選項一天」。
//「甲,乙,丙」這種沒有星期的模板行為完全不變，既有資料不需要動。
//
//起日的星期與第一個選項不一致時，以起日為錨點往後推：
//起日是星期日、第一個選項是「星期二」，那就是起日之後的那個星期二(+2 天)。
//起日的語意是「這一輪從哪天開始算」，不是「第一個選項是哪一天」。
export const dayOffsets = (bases, startDate) => {
    const start = parseDateOnly(startDate)
    if(start === null) return null
    if(!Array.isArray(bases) || bases.length === 0) return null

    const weekdays = bases.map((base) => weekdayOf(base))
    if(weekdays.some((day) => day === null)) return bases.map((_, index) => index)

    const startDay = new Date(start).getUTCDay()
    return weekdays.map((day) => (day - startDay + 7) % 7)
}

//迄日 = 所有選項算出來的日期裡最大的那一個。
//不能用「起日 + 選項數 - 1」：同一天有早中晚三段時選項數會比實際天數多，
//11 個選項會算出 8/28，但實際只到 8/24。
export const endDateOf = (bases, startDate) => {
    const offsets = dayOffsets(bases, startDate)
    if(!offsets) return null
    return addDays(startDate, Math.max(...offsets))
}

//選項涵蓋的日期範圍，短格式：「08/18~08/24」。討論串名稱用它。
//只有一天(或算不出迄日)時就只回起日；沒有起日代表選項上沒有日期，回 null，
//由呼叫端決定要用什麼替代。
//
//迄日一律走 endDateOf，不自己用選項數推 —— 同一天有早中晚三段時，
//選項數比實際天數多，會算出一個根本沒涵蓋到的日期。
export const optionDateRange = (options, dateStart) => {
    if(!dateStart || parseDateOnly(dateStart) === null) return null

    const short = (text) => text.slice(5).replace('-', '/')
    const end = endDateOf(basesOf(options), dateStart)

    if(!end || end === dateStart) return short(dateStart)
    return `${short(dateStart)}~${short(end)}`
}

//把「星期二,星期三,...」配上日期，變成「星期二(8/18),星期三(8/19),...」。
//
//跨年的那一輪整批補上年份(星期二(2026/12/29) … 星期一(2027/1/4))，
//而不是只在跨過去的那幾個選項補 —— 同一場投票裡一半帶年份一半不帶，
//看起來像壞掉。同年的則一律不帶，日常使用不必看到多餘的資訊。
export const applyDates = (bases, startDate) => {
    const start = parseDateOnly(startDate)
    if(start === null) return null

    const offsets = dayOffsets(bases, startDate)
    if(!offsets) return null

    const last = start + Math.max(...offsets) * DAY_MS
    const crossYear = new Date(start).getUTCFullYear() !== new Date(last).getUTCFullYear()

    return bases.map((base, index) => {
        const date = new Date(start + offsets[index] * DAY_MS)
        const stamp = crossYear
            ? `${date.getUTCFullYear()}/${date.getUTCMonth() + 1}/${date.getUTCDate()}`
            : `${date.getUTCMonth() + 1}/${date.getUTCDate()}`

        //先截斷 base 再接日期，不要整串截斷 —— 後者會把日期切掉一半，
        //變成「星期二(8/1」這種看不懂的東西。
        const suffix = `(${stamp})`
        const room = Math.max(1, MAX_OPTION_LABEL - suffix.length)

        return {key: `o${index}`, base, label: `${String(base).slice(0, room)}${suffix}`}
    })
}

//建立投票時用它把「選項文字」變成投票紀錄裡的 options。
//dateStart 為 null 就是不套日期，此時 label 等於 base。
//不管有沒有套日期都保留 base，下一輪重算 label 時要用。
export const buildPollOptions = (bases, dateStart = null) => {
    if(dateStart){
        const dated = applyDates(bases, dateStart)
        if(dated) return dated
    }
    return bases.map((base, index) => ({key: `o${index}`, base, label: String(base)}))
}

//舊投票的 options 沒有 base 欄位，退回用 label 當 base。
export const basesOf = (options) =>
    (options || []).map((option) => option.base || option.label)

//依 base 與起日把標籤重算一次。回傳新的 options，或 null 代表「不需要更新」
//(沒有起日、算不出來、或算出來跟現在完全一樣)。
//
//「一樣就回 null」是給呼叫端判斷要不要寫檔用的：開機還原時每一場都會呼叫它，
//少了這個判斷，每次重啟都會把所有排程投票重寫一遍。
//
//票是綁在 option.key 上的，所以一律沿用原本的 key。applyDates 產生的是
//o0..oN，萬一某場投票的編號不是這個序列，重新編號會讓已投的票全部對不上。
export const refreshDatedOptions = (options, dateStart) => {
    if(!dateStart) return null
    if(!Array.isArray(options) || options.length === 0) return null

    const dated = applyDates(basesOf(options), dateStart)
    if(!dated) return null

    const next = dated.map((option, index) => ({...option, key: options[index].key}))
    const same = next.every((option, index) => option.label === options[index].label)

    return same ? null : next
}

//每週設定在 Modal 裡只佔一格：「發起星期,時間 / 結算星期,時間」。
//Modal 最多五個輸入框，拆成四格就沒有位置放別的了。
export const parseWeeklyText = (text) => {
    const [openPart, closePart] = String(text || '').split('/')
    if(!openPart || !closePart){
        return {error: '每週設定格式要是 `發起星期,時間 / 結算星期,時間`，例如 `2,10:00 / 1,22:00`（0=星期日）。'}
    }

    const parsePair = (raw, which) => {
        const [dayPart, timePart] = String(raw).split(/[,，]/)
        try{
            return {
                day: parseWeekday((dayPart || '').trim()),
                time: parseTimeOfDay((timePart || '').trim()),
            }
        }
        catch(e){
            return {error: `每週${which}：${e.message}`}
        }
    }

    const open = parsePair(openPart, '發起')
    if(open.error) return {error: open.error}
    const close = parsePair(closePart, '結算')
    if(close.error) return {error: close.error}

    const pad = (value) => String(value).padStart(2, '0')
    return {
        weekly: {
            openDay: open.day,
            openTime: `${pad(open.time.hour)}:${pad(open.time.minute)}`,
            closeDay: close.day,
            closeTime: `${pad(close.time.hour)}:${pad(close.time.minute)}`,
        },
    }
}

export const formatWeeklyText = (weekly) => (weekly
    ? `${weekly.openDay},${weekly.openTime} / ${weekly.closeDay},${weekly.closeTime}`
    : '')

//把 Modal 送回來的五個欄位驗成一份完整的模板。回傳 {template} 或 {error}。
//existing 是編輯時的原模板：id 與三個開關(複選/一人多角色/中途查看)不在 Modal 裡，
//要從原本那份帶過來，否則每編輯一次就被重設成預設值。
export const parseTemplateFields = (fields, existing = null) => {
    const name = String(fields.name || '').trim()
    if(!name) return {error: '模板名稱不能空白。'}
    if(name.length > MAX_TEMPLATE_NAME){
        return {error: `模板名稱最多 ${MAX_TEMPLATE_NAME} 個字。`}
    }

    //重複與空白的處理跟 /poll 的 options 完全一樣，直接借用同一個函式
    const options = parseOptionsInput(fields.options).map((option) => option.label)
    if(options.length < 2){
        return {error: '至少要有兩個選項，用逗號分隔，例如：`星期二,星期三,星期四`。'}
    }

    const startText = String(fields.startDate || '').trim()
    let startDate = null
    if(startText){
        if(parseDateOnly(startText) === null){
            return {error: `起日格式要是 \`YYYY-MM-DD\`，收到「${startText}」。`}
        }
        startDate = startText
    }

    const identityText = String(fields.identity || '').trim()
    if(identityText && !identityGroups[identityText]){
        return {
            error: `找不到身分群組「${identityText}」。可用的有：${Object.keys(identityGroups).join('、')}` +
                '（留空代表不附身分選單）',
        }
    }

    const weeklyText = String(fields.weekly || '').trim()
    let weekly = null
    if(weeklyText){
        const parsed = parseWeeklyText(weeklyText)
        if(parsed.error) return {error: parsed.error}
        weekly = parsed.weekly
    }

    const base = existing || {}

    //一人多角色沒有身分表就沒有意義(同 /poll 的規則)，這裡順手關掉，
    //不然模板套下去會在建立階段才被擋，使用者得回頭找原因。
    const multiChar = Boolean(base.multiChar) && Boolean(identityText)

    return {
        template: {
            id: base.id || makeTemplateId(),
            name,
            options,
            //起日有填就是要套日期。另外存一個 applyDate 只會多一個對不上的來源。
            applyDate: Boolean(startDate),
            startDate,
            identityGroup: identityText || null,
            multi: Boolean(base.multi),
            multiChar,
            peek: base.peek === undefined ? true : Boolean(base.peek),
            //跟 multi 一樣是切換按鈕改的，Modal 裡沒有這一格 ——
            //所以一定要從 base 帶過來，否則編輯一次模板就把開關洗掉了。
            thread: Boolean(base.thread),
            raid: Boolean(base.raid),
            weekly,
        },
    }
}

/////////////////////////////// 檔案讀寫 ///////////////////////////////

const templateFile = (id) => path.join(templatesDir(), `${id}.json`)

export const getTemplate = async (id) => {
    if(!isValidTemplateId(id)) return null
    return readJson(templateFile(id))
}

//模板數量是個位數，每次都重掃資料夾的成本可以忽略，
//換來的是「改完檔案立刻生效」，不必管快取失效。
export const listTemplates = async () => {
    let names = []
    try{
        names = await fs.readdir(templatesDir())
    }
    catch(e){
        //資料夾還沒建立 = 一個模板都還沒建
        if(e.code === 'ENOENT') return []
        throw e
    }

    const templates = []
    for(const name of names){
        //只收 .json，略過寫到一半的 .tmp 與壞檔備份 .broken-*
        if(!name.endsWith('.json')) continue
        const template = await readJson(path.join(templatesDir(), name))
        if(template && template.id) templates.push(template)
    }

    //刻意不用 localeCompare：中文排序要靠完整的 ICU，
    //jail 上的 Node 若是 small-icu 會無聲地退回碼點比較，順序跟開發機不一樣。
    //模板是個位數、名稱由使用者自己取，穩定就夠了，不必追求字典序。
    return templates.sort((a, b) => {
        const left = String(a.name)
        const right = String(b.name)
        if(left === right) return String(a.id) < String(b.id) ? -1 : 1
        return left < right ? -1 : 1
    })
}

export const saveTemplate = async (template) => {
    if(!isValidTemplateId(template.id)) return null
    await writeJson(templateFile(template.id), template)
    logger.info(`投票模板已儲存：${template.id}「${template.name}」選項數=${template.options.length}`)
    return template
}

export const deleteTemplate = async (id) => {
    if(!isValidTemplateId(id)) return false

    try{
        await fs.unlink(templateFile(id))
        logger.info(`投票模板已刪除：${id}`)
        return true
    }
    catch(e){
        if(e.code === 'ENOENT') return false
        throw e
    }
}

//給 /poll 的 addChoices() 用，形狀跟 identityChoices() 一致。
//choices 是在指令註冊時決定的，所以新增或改名模板要等 bot 重啟才會出現在下拉選單裡；
//模板的「內容」(選項、起日、每週設定)則是建立投票的當下才讀檔，改完立刻生效。
export const templateChoices = async () => {
    const templates = await listTemplates()
    return templates
        .slice(0, MAX_TEMPLATES)
        .map((template) => ({name: String(template.name).slice(0, 100), value: template.id}))
}

export default {
    templatesDir,
    makeTemplateId,
    isValidTemplateId,
    parseDateOnly,
    formatDateOnly,
    addDays,
    weekdayOf,
    dayOffsets,
    endDateOf,
    optionDateRange,
    applyDates,
    buildPollOptions,
    basesOf,
    refreshDatedOptions,
    parseWeeklyText,
    formatWeeklyText,
    parseTemplateFields,
    getTemplate,
    listTemplates,
    saveTemplate,
    deleteTemplate,
    templateChoices,
    MAX_TEMPLATES,
    MAX_TEMPLATE_NAME,
    MAX_OPTIONS,
}
