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

//選項數決定迄日：起日 8/18、七個選項 → 迄日 8/24。
//不另外存迄日 —— 兩份資料總有一天會對不上。
export const endDateOf = (startDate, count) => addDays(startDate, Math.max(0, count - 1))

//把「星期二,星期三,...」配上日期，變成「星期二(8/18),星期三(8/19),...」。
//
//跨年的那一輪整批補上年份(星期二(2026/12/29) … 星期一(2027/1/4))，
//而不是只在跨過去的那幾個選項補 —— 同一場投票裡一半帶年份一半不帶，
//看起來像壞掉。同年的則一律不帶，日常使用不必看到多餘的資訊。
export const applyDates = (bases, startDate) => {
    const start = parseDateOnly(startDate)
    if(start === null) return null
    if(!Array.isArray(bases) || bases.length === 0) return null

    const last = start + (bases.length - 1) * DAY_MS
    const crossYear = new Date(start).getUTCFullYear() !== new Date(last).getUTCFullYear()

    return bases.map((base, index) => {
        const date = new Date(start + index * DAY_MS)
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

    return templates.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hant'))
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
    endDateOf,
    applyDates,
    buildPollOptions,
    basesOf,
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
