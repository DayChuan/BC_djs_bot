import fs from 'node:fs'
import path from 'node:path'
import config from '@/config'
import {japaneseSeed} from '@/config/japaneseSeed'
import {TAIPEI_OFFSET_MS} from '@/core/scheduler'
import {dataDir, getState, updateState} from '@/core/state'
import logger from '@/core/logger'

//每日日文分享的本體(U05)。
//
//這裡刻意不 import discord.js：排版一律回傳「純物件 embed」，
//channel.send({embeds: [純物件]}) 一樣吃，而且挑選與排版才寫得出單元測試
//(測試檔只要直接或間接 import 到 discord.js，測試 jail 就會卡住跑不完)。
//
//資料表 data/japanese/entries.json 不進版控：正式站與測試站各自維護，
//git 更新不會覆蓋，內容由 /jp_admin import 貼 JSON 維護。

export const SECTION = 'japanese'

export const TYPES = new Set(['idiom', 'word', 'grammar'])

export const TYPE_LABEL = {idiom: '慣用句', word: '單字', grammar: '文法'}

//type → embed 顏色。純粹讓三種內容在頻道裡一眼分得出來。
const TYPE_COLOR = {idiom: 0xE8A33D, word: 0x4E8FD9, grammar: 0x63A375}

//edit 能改的欄位。examples 是陣列包物件，用斜線指令的選項表達會很難用，
//要整筆換掉就重貼 import(單元檔的決策紀錄)。
export const EDITABLE_FIELDS = ['expression', 'reading', 'meaning', 'level', 'note']

//必填欄位空字串送不出去(Discord 的必填選項擋掉)，所以用 - 當作「清空」。
export const CLEAR_TOKEN = '-'

const VERSION = 1

//Discord 的欄位長度上限。超過會被整則訊息退掉，所以在這裡先截斷。
const FIELD_MAX = 1024
const DESC_MAX = 4096

//embed 裡最多顯示幾則筆記。再多就只提示還有幾則，
//否則一筆熱門的內容會把整個 embed 撐爆(單則 field 上限 1024 字)。
const NOTES_SHOWN = 5

//搜尋最多回幾筆
export const FIND_LIMIT = 10

/////////////////////////// 檔案位置 ///////////////////////////

//路徑一律在「用到時」才解析，沿用 state.js 的 dataDir()——
//測試要指到暫存資料夾只需要換 STATE_DATA_DIR，不必 vi.resetModules()
//(那在測試 jail 裡會連帶重載其他模組而卡死)。
export const entriesDir = () => path.join(dataDir(), 'japanese')

export const entriesFile = () => path.join(entriesDir(), 'entries.json')

/////////////////////////// 純函式 ///////////////////////////

const text = (value) => (value === undefined || value === null ? '' : String(value)).trim()

const clamp = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

export const formatId = (number) => `j_${String(number).padStart(4, '0')}`

//id 一律是 j_ + 數字。認不出來的(手貼的、空的)都當成「要重新編號」。
export const idNumber = (id) => {
    const matched = /^j_(\d+)$/.exec(text(id))
    return matched ? Number(matched[1]) : 0
}

export const nextIdNumber = (entries) =>
    entries.reduce((max, entry) => Math.max(max, idNumber(entry.id)), 0) + 1

//匯入與載入共用的欄位檢查。回 {ok:true, entry} 或 {ok:false, error}。
//notes 一律建成空陣列：別人的筆記不該用貼 JSON 的方式偽造。
export const validateEntry = (raw) => {
    if(!raw || typeof raw !== 'object' || Array.isArray(raw)){
        return {ok: false, error: '不是一個物件'}
    }

    const type = text(raw.type)
    if(!TYPES.has(type)){
        return {ok: false, error: `type 只能是 ${[...TYPES].join(' / ')}，收到「${type || '(空白)'}」`}
    }

    const expression = text(raw.expression)
    if(!expression) return {ok: false, error: 'expression 不可留空'}

    const meaning = text(raw.meaning)
    if(!meaning) return {ok: false, error: 'meaning 不可留空'}

    if(raw.tags !== undefined && !Array.isArray(raw.tags)){
        return {ok: false, error: 'tags 必須是陣列'}
    }

    //examples 壞掉時不靜默丟掉：貼的人會以為例句進去了，之後才發現少東西。
    if(raw.examples !== undefined && !Array.isArray(raw.examples)){
        return {ok: false, error: 'examples 必須是陣列'}
    }
    const examples = []
    for(const item of raw.examples || []){
        if(!item || typeof item !== 'object' || Array.isArray(item)){
            return {ok: false, error: 'examples 的每一筆都要是 {ja, zh} 物件'}
        }
        const ja = text(item.ja)
        if(!ja) return {ok: false, error: 'examples 的每一筆都要有 ja'}
        examples.push({ja, zh: text(item.zh)})
    }

    return {
        ok: true,
        entry: {
            id: text(raw.id),
            type,
            expression,
            reading: text(raw.reading),
            meaning,
            level: text(raw.level),
            tags: (raw.tags || []).map(text).filter(Boolean),
            examples,
            note: text(raw.note),
            notes: [],
        },
    }
}

/**
 * 把一段純文字 JSON 併進現有清單。
 *
 * 全部檢查完才回傳新清單(all-or-nothing)：純文字貼上最常見的意外是貼到一半，
 * 半批寫入的話不會知道到底進了幾筆。
 *
 * 序號：沒給、格式不對、跟現有重複、跟本批內其他筆重複 → 接在最大號後面。
 * 既有那筆的號碼永遠不動 —— 已發送紀錄與筆記都靠 id 對應，改號等於紀錄失聯。
 */
export const parseImport = (entries, rawText) => {
    let parsed = null
    try{
        parsed = JSON.parse(text(rawText))
    }
    catch(e){
        return {ok: false, error: `JSON 格式錯誤：${e.message}`}
    }

    const list = Array.isArray(parsed) ? parsed : [parsed]
    if(list.length === 0) return {ok: false, error: '沒有任何資料'}

    const used = new Set(entries.map((entry) => entry.id))
    let next = nextIdNumber(entries)
    const added = []

    for(let i = 0; i < list.length; i += 1){
        const checked = validateEntry(list[i])
        if(!checked.ok) return {ok: false, error: `第 ${i + 1} 筆：${checked.error}`}

        const entry = checked.entry
        let renamedFrom = ''
        if(!entry.id || idNumber(entry.id) === 0 || used.has(entry.id)){
            renamedFrom = entry.id
            //要跳過已經被占走的號碼再發：next 只在「有改號」時才前進，
            //而本批內保留原號的那幾筆同樣占用號碼。少了這個 while，
            //匯入兩筆都叫 j_0001 時第二筆會又被配到 j_0001(2026-08-25 由單元測試抓到)。
            while(used.has(formatId(next))) next += 1
            entry.id = formatId(next)
            next += 1
        }
        used.add(entry.id)
        added.push({entry, renamedFrom})
    }

    return {ok: true, entries: [...entries, ...added.map((item) => item.entry)], added}
}

//挑選：候選＝還沒發過的那批。候選空了就開新的一輪，
//這樣「連續挑 N 次不重複、第 N+1 次重來」是同一段邏輯的自然結果。
//rand 可注入，測試才能決定性驗證。
export const pickFrom = (entries, sentIds, rand = Math.random) => {
    if(entries.length === 0) return {entry: null, roundReset: false}

    const sent = new Set(sentIds || [])
    const fresh = entries.filter((entry) => !sent.has(entry.id))
    const roundReset = fresh.length === 0
    const pool = roundReset ? entries : fresh

    return {entry: pool[Math.floor(rand() * pool.length)], roundReset}
}

export const findEntry = (entries, id) => entries.find((entry) => entry.id === text(id)) || null

//表現／讀音／意思裡任一個命中就算。只回前 FIND_LIMIT 筆，
//順便回總命中數，讓呼叫端可以提示「還有 N 筆」。
export const searchEntries = (entries, keyword, limit = FIND_LIMIT) => {
    const needle = text(keyword).toLowerCase()
    if(!needle) return {matched: [], total: 0}

    const hit = entries.filter((entry) =>
        `${entry.expression} ${entry.reading} ${entry.meaning}`.toLowerCase().includes(needle))

    return {matched: hit.slice(0, limit), total: hit.length}
}

//就地改一個欄位。回新的清單，不動傳進來的那份。
export const applyEdit = (entries, id, field, value) => {
    if(!EDITABLE_FIELDS.includes(field)){
        return {ok: false, error: `不能改「${field}」，只能改 ${EDITABLE_FIELDS.join(' / ')}`}
    }

    const target = findEntry(entries, id)
    if(!target) return {ok: false, error: `找不到 ${text(id)}`}

    const raw = text(value)
    //expression 與 meaning 是內容本體，不允許清空。
    if(raw === CLEAR_TOKEN && (field === 'expression' || field === 'meaning')){
        return {ok: false, error: `${field} 不可清空`}
    }
    const next = raw === CLEAR_TOKEN ? '' : raw
    if(!next && (field === 'expression' || field === 'meaning')){
        return {ok: false, error: `${field} 不可留空`}
    }

    const before = target[field]
    const updated = {...target, [field]: next}
    return {
        ok: true,
        before,
        entry: updated,
        entries: entries.map((entry) => (entry.id === updated.id ? updated : entry)),
    }
}

export const applyNoteAdd = (entries, id, userId, noteText, at) => {
    const target = findEntry(entries, id)
    if(!target) return {ok: false, error: `找不到 ${text(id)}`}

    const body = text(noteText)
    if(!body) return {ok: false, error: '筆記內容不可留空'}

    const updated = {...target, notes: [...target.notes, {userId: text(userId), text: body, at}]}
    return {
        ok: true,
        entry: updated,
        index: updated.notes.length,
        entries: entries.map((entry) => (entry.id === updated.id ? updated : entry)),
    }
}

//index 是給人看的 1 起算序號，跟 embed 上顯示的一致。
export const applyNoteRemove = (entries, id, index) => {
    const target = findEntry(entries, id)
    if(!target) return {ok: false, error: `找不到 ${text(id)}`}

    const position = Number(index)
    if(!Number.isInteger(position) || position < 1 || position > target.notes.length){
        return {ok: false, error: `${target.id} 只有 ${target.notes.length} 則筆記，沒有第 ${index} 則`}
    }

    const removed = target.notes[position - 1]
    const notes = target.notes.filter((item, i) => i !== position - 1)
    const updated = {...target, notes}
    return {
        ok: true,
        removed,
        entry: updated,
        entries: entries.map((entry) => (entry.id === updated.id ? updated : entry)),
    }
}

/////////////////////////// 台北時間的區間 ///////////////////////////

//時區換算一律靠 TAIPEI_OFFSET_MS 位移後用 UTC 取值，
//不要用 getMonth() 之類的本地時間 —— jail 的本地時區不保證是台北。

const DAY_MS = 24 * 60 * 60 * 1000

export const RANGES = ['day', 'week', 'month']

export const RANGE_LABEL = {day: '今天', week: '本週', month: '本月'}

//回傳該區間的起點(UTC 毫秒)。週一為一週的第一天。
export const rangeStart = (range, now = Date.now()) => {
    const shifted = new Date(now + TAIPEI_OFFSET_MS)
    const dayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())

    if(range === 'week'){
        const offset = (shifted.getUTCDay() + 6) % 7
        return dayStart - offset * DAY_MS - TAIPEI_OFFSET_MS
    }
    if(range === 'month'){
        return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - TAIPEI_OFFSET_MS
    }
    return dayStart - TAIPEI_OFFSET_MS
}

//清單上的日期，MM/DD(台北)
export const formatTaipeiDate = (iso) => {
    const shifted = new Date(new Date(iso).getTime() + TAIPEI_OFFSET_MS)
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
    const day = String(shifted.getUTCDate()).padStart(2, '0')
    return `${month}/${day}`
}

/**
 * 把 state 的 sent({id: ISO})換成畫面用的清單，新的排前面。
 *
 * 只存 id 不存內容快照，所以老師修正過的內容，回頭看歷史顯示的是修正後的版本——
 * 這正是「內容有誤可以修正」要的行為(單元檔的設計)。
 * 對不到 id 的紀錄(內容被整批換掉)直接略過，不讓歷史查詢掛掉。
 */
export const historyRows = (entries, sent, range, now = Date.now()) => {
    const start = rangeStart(range, now)
    const byId = new Map(entries.map((entry) => [entry.id, entry]))

    return Object.entries(sent || {})
        .map(([id, at]) => ({id, at, time: new Date(at).getTime()}))
        .filter((row) => Number.isFinite(row.time) && row.time >= start)
        .sort((a, b) => b.time - a.time)
        .map((row) => ({...row, entry: byId.get(row.id) || null}))
        .filter((row) => row.entry)
}

/////////////////////////// 排版(純物件 embed) ///////////////////////////

const exampleLines = (entry) => entry.examples
    .map((item) => (item.zh ? `${item.ja}\n${item.zh}` : item.ja))
    .join('\n\n')

const noteLines = (entry) => {
    const shown = entry.notes.slice(-NOTES_SHOWN)
    const offset = entry.notes.length - shown.length
    const lines = shown.map((item, i) => `${offset + i + 1}. <@${item.userId}>　${item.text}`)
    if(offset > 0) lines.unshift(`（另有較早的 ${offset} 則）`)
    return lines.join('\n')
}

//回傳純物件而不是 EmbedBuilder，理由見檔案開頭。
export const buildEmbed = (entry) => {
    const fields = []

    //grammar 的 reading 就是表現本體，重複顯示沒有意義
    if(entry.reading && entry.reading !== entry.expression){
        fields.push({name: '読み方', value: clamp(entry.reading, FIELD_MAX)})
    }
    fields.push({name: '意思', value: clamp(entry.meaning, FIELD_MAX)})
    if(entry.examples.length > 0){
        fields.push({name: '例句', value: clamp(exampleLines(entry), FIELD_MAX)})
    }
    if(entry.note){
        fields.push({name: '補充', value: clamp(entry.note, FIELD_MAX)})
    }
    if(entry.notes.length > 0){
        fields.push({name: '大家的筆記', value: clamp(noteLines(entry), FIELD_MAX)})
    }

    //id 放 footer：成員要複製它去 /jp_note 與 /jp_admin edit。
    const tail = [entry.id, TYPE_LABEL[entry.type] || entry.type, entry.level].filter(Boolean)

    return {
        title: clamp(entry.expression, 256),
        color: TYPE_COLOR[entry.type] || 0x9B9B9B,
        fields,
        footer: {text: tail.join('　')},
    }
}

export const buildHistoryEmbed = (rows, range) => ({
    title: `每日日文 ${RANGE_LABEL[range] || ''}`.trim(),
    color: 0x4E8FD9,
    description: rows.length === 0
        ? '這段期間還沒有發過。'
        : clamp(
            rows.map((row) =>
                `\`${formatTaipeiDate(row.at)}\`　\`${row.id}\`　${row.entry.expression}`).join('\n'),
            DESC_MAX,
        ),
    footer: {text: `共 ${rows.length} 則　用 /jp_note id:<編號> 加筆記`},
})

export const buildFindEmbed = (matched, total, keyword) => ({
    title: `搜尋「${clamp(text(keyword), 100)}」`,
    color: 0x63A375,
    description: matched.length === 0
        ? '找不到符合的資料。'
        : clamp(
            matched.map((entry) =>
                `\`${entry.id}\`　${entry.expression}　${entry.meaning}`).join('\n'),
            DESC_MAX,
        ),
    footer: {text: total > matched.length ? `命中 ${total} 筆，只顯示前 ${matched.length} 筆` : `命中 ${total} 筆`},
})

/////////////////////////// 權限 ///////////////////////////

//permissionRoles.teacher 是 {伺服器id: 身分組id} 對照表(同 gm，見 U07)：
//身分組 id 綁死在單一伺服器，拿 A 伺服器的 id 去 B 查一定查不到。
//查不到 = 誰都不能用(fail closed)。
export const resolveTeacherRole = (table, guildId) => {
    if(!table || !guildId) return ''
    return text(table[guildId])
}

//刻意**不放行管理員**(2026-08-25 使用者指示)，跟 timerService.isGmMember 的慣例相反。
export const memberHasRole = (member, roleId) => {
    if(!member || !roleId) return false
    return Boolean(member.roles && member.roles.cache && member.roles.cache.has(roleId))
}

export const isTeacherMember = (member) => memberHasRole(
    member,
    resolveTeacherRole(
        config.permissionRoles && config.permissionRoles.teacher,
        member && member.guild && member.guild.id,
    ),
)

/////////////////////////// 檔案讀寫 ///////////////////////////

//資料量是幾十筆、寫入頻率極低，用同步 fs 就夠(同 selfRoles.js)。
let cache = null

//測試用：清掉模組層的快取。
//selfRoles.js 在模組載入時就 load()，這裡刻意不那樣做 ——
//那會在測試換掉 STATE_DATA_DIR 之前就把路徑定死。
export const resetCache = () => {
    cache = null
}

const buildSeed = () => {
    const entries = []
    for(const raw of japaneseSeed){
        const checked = validateEntry(raw)
        if(!checked.ok){
            logger.warn(`japaneseSeed 有一筆不合格(${checked.error})，已略過：${raw && raw.id}`)
            continue
        }
        checked.entry.id = checked.entry.id || formatId(entries.length + 1)
        entries.push(checked.entry)
    }
    return {version: VERSION, updatedAt: new Date().toISOString(), entries}
}

//寫入前先留一份 .bak：匯入貼錯時有東西可以退回去。
const save = (data) => {
    const file = entriesFile()
    try{
        fs.mkdirSync(entriesDir(), {recursive: true})
        if(fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`)
        fs.writeFileSync(file, JSON.stringify(data, null, 4), 'utf8')
        return true
    }
    catch(e){
        logger.error(`寫入 ${file} 失敗：`, e)
        return false
    }
}

//舊檔沒有 notes 欄位，載入時補上，不必刪檔重來(同 selfRoles.migrate)。
//順便濾掉缺 id 或 expression 的壞筆 —— 留著的話 /jp 抽到就是一則空訊息。
const migrate = (data) => {
    let changed = false
    const entries = []

    for(const entry of data.entries){
        if(!entry || !text(entry.id) || !text(entry.expression)){
            logger.warn(`entries.json 有一筆缺 id 或 expression，已略過：${JSON.stringify(entry)}`)
            changed = true
            continue
        }
        if(!Array.isArray(entry.notes)){
            entry.notes = []
            changed = true
        }
        if(!Array.isArray(entry.examples)) entry.examples = []
        if(!Array.isArray(entry.tags)) entry.tags = []
        entries.push(entry)
    }

    data.entries = entries
    if(changed) save(data)
    return data
}

const load = () => {
    if(cache) return cache

    const file = entriesFile()
    try{
        if(fs.existsSync(file)){
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
            if(parsed && Array.isArray(parsed.entries)){
                cache = migrate(parsed)
                return cache
            }
            logger.warn(`${file} 格式不正確(缺少 entries 陣列)，改用 japaneseSeed 的初始清單`)
        }
    }
    catch(e){
        //讀壞了不能讓 bot 起不來，退回 seed 並留下紀錄。
        //這裡不覆蓋壞檔 —— 壞檔留在原地才有機會人工救回來。
        logger.error(`讀取 ${file} 失敗，改用 japaneseSeed 的初始清單：`, e)
        cache = buildSeed()
        return cache
    }

    cache = buildSeed()
    save(cache)
    logger.info(`建立 ${file}，以 japaneseSeed 的 ${cache.entries.length} 筆作為初始清單`)
    return cache
}

//回傳副本，避免呼叫端不小心改到快取
export const getEntries = () => load().entries.map((entry) => ({...entry}))

export const countEntries = () => load().entries.length

const commit = (entries) => {
    const data = load()
    data.entries = entries
    data.updatedAt = new Date().toISOString()
    return save(data)
}

/////////////////////////// 對外的操作 ///////////////////////////

//每日排程與 /jp post 用：挑一則並寫進紀錄。
export const pickDaily = async(rand = Math.random) => {
    const entries = getEntries()
    if(entries.length === 0) return null

    let picked = null
    await updateState(SECTION, (current) => {
        const sent = current.sent && typeof current.sent === 'object' ? current.sent : {}
        const result = pickFrom(entries, Object.keys(sent), rand)
        picked = result.entry

        const at = new Date().toISOString()
        return {
            sent: {...(result.roundReset ? {} : sent), [result.entry.id]: at},
            round: (Number(current.round) || 1) + (result.roundReset ? 1 : 0),
            lastAt: at,
        }
    })

    return picked
}

//`/jp` 用：不讀也不寫紀錄，純粹抽一則複習。
export const pickRandom = (rand = Math.random) => {
    const entries = getEntries()
    if(entries.length === 0) return null
    return entries[Math.floor(rand() * entries.length)]
}

export const importText = (rawText) => {
    const result = parseImport(getEntries(), rawText)
    if(!result.ok) return result
    if(!commit(result.entries)) return {ok: false, error: '寫入檔案失敗，請看 log'}
    return result
}

export const editEntry = (id, field, value) => {
    const result = applyEdit(getEntries(), id, field, value)
    if(!result.ok) return result
    if(!commit(result.entries)) return {ok: false, error: '寫入檔案失敗，請看 log'}
    return result
}

export const addNote = (id, userId, noteText) => {
    const result = applyNoteAdd(getEntries(), id, userId, noteText, new Date().toISOString())
    if(!result.ok) return result
    if(!commit(result.entries)) return {ok: false, error: '寫入檔案失敗，請看 log'}
    return result
}

export const removeNote = (id, index) => {
    const result = applyNoteRemove(getEntries(), id, index)
    if(!result.ok) return result
    if(!commit(result.entries)) return {ok: false, error: '寫入檔案失敗，請看 log'}
    return result
}

export const getHistory = async(range, now = Date.now()) => {
    const current = await getState(SECTION)
    return historyRows(getEntries(), current.sent, range, now)
}

export const find = (keyword) => searchEntries(getEntries(), keyword)

export const getEntry = (id) => findEntry(getEntries(), id)

export default {
    SECTION,
    TYPES,
    TYPE_LABEL,
    EDITABLE_FIELDS,
    CLEAR_TOKEN,
    FIND_LIMIT,
    RANGES,
    RANGE_LABEL,
    entriesDir,
    entriesFile,
    formatId,
    idNumber,
    nextIdNumber,
    validateEntry,
    parseImport,
    pickFrom,
    findEntry,
    searchEntries,
    applyEdit,
    applyNoteAdd,
    applyNoteRemove,
    rangeStart,
    formatTaipeiDate,
    historyRows,
    buildEmbed,
    buildHistoryEmbed,
    buildFindEmbed,
    resolveTeacherRole,
    memberHasRole,
    isTeacherMember,
    resetCache,
    getEntries,
    countEntries,
    pickDaily,
    pickRandom,
    importText,
    editEntry,
    addNote,
    removeNote,
    getHistory,
    find,
    getEntry,
}
