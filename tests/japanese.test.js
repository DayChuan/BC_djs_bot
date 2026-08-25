import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as jp from '@/core/japanese'
import * as state from '@/core/state'
import logger from '@/core/logger'
import {japaneseSeed} from '@/config/japaneseSeed'
import production from '@/config/environments/production'
import testEnv from '@/config/environments/test'

//把 logger 換成假的。真正的 logger 會開檔與串流，在測試 jail 裡會讓 vitest
//卡住跑不完 —— 症狀跟 fileParallelism 那個坑一樣：沒有錯誤訊息，就是不結束。
vi.mock('@/core/logger', () => ({
    default: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}))

//japanese.js 的路徑跟 state.js 一樣是「用到時才解析」的，所以這裡不需要重新載入模組，
//只要換掉環境變數並清掉模組層的快取就好。
//(用 vi.resetModules() + 動態 import 會把整串相依模組反覆重載，在測試 jail 裡會卡死。)
let tmpDir = null

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-jp-'))
    process.env.STATE_DATA_DIR = tmpDir
    jp.resetCache()
    state.resetQueue()
    vi.clearAllMocks()
})

afterEach(() => {
    delete process.env.STATE_DATA_DIR
    fs.rmSync(tmpDir, {recursive: true, force: true})
    jp.resetCache()
})

const entry = (id, over = {}) => ({
    id,
    type: 'idiom',
    expression: `表現${id}`,
    reading: `よみ${id}`,
    meaning: `意思${id}`,
    level: 'N2',
    tags: [],
    examples: [{ja: '例文です。', zh: '例句。'}],
    note: '',
    notes: [],
    ...over,
})

const writeEntries = (entries) => {
    fs.mkdirSync(jp.entriesDir(), {recursive: true})
    fs.writeFileSync(jp.entriesFile(), JSON.stringify({version: 1, entries}, null, 4), 'utf8')
    jp.resetCache()
}

const writeRaw = (content) => {
    fs.mkdirSync(jp.entriesDir(), {recursive: true})
    fs.writeFileSync(jp.entriesFile(), content, 'utf8')
    jp.resetCache()
}

const readFile = () => fs.readFileSync(jp.entriesFile(), 'utf8')

///////////////////////////// 資料表的載入 /////////////////////////////

describe('資料表載入', () => {
    it('檔案不存在時用 japaneseSeed 建檔', () => {
        const entries = jp.getEntries()

        expect(entries).toHaveLength(japaneseSeed.length)
        expect(fs.existsSync(jp.entriesFile())).toBe(true)
    })

    it('壞掉的 JSON 退回 seed 並留下 error，不丟例外', () => {
        writeRaw('{這不是 JSON')

        expect(() => jp.getEntries()).not.toThrow()
        expect(jp.getEntries()).toHaveLength(japaneseSeed.length)
        expect(logger.error).toHaveBeenCalled()
    })

    it('壞檔不會被覆蓋掉（留在原地才有機會人工救回來）', () => {
        writeRaw('{這不是 JSON')
        jp.getEntries()

        expect(readFile()).toBe('{這不是 JSON')
    })

    it('缺少 entries 陣列時退回 seed 並留下 warn', () => {
        writeRaw(JSON.stringify({version: 1, roles: []}))

        expect(jp.getEntries()).toHaveLength(japaneseSeed.length)
        expect(logger.warn).toHaveBeenCalled()
    })

    it('舊資料沒有 notes 欄位時自動補成空陣列', () => {
        const old = entry('j_0001')
        delete old.notes
        writeEntries([old])

        expect(jp.getEntries()[0].notes).toEqual([])
    })

    it('缺 id 或 expression 的壞筆會被濾掉，其餘照常', () => {
        writeEntries([entry('j_0001'), {type: 'idiom', meaning: '沒有 id 也沒有表現'}])

        const entries = jp.getEntries()
        expect(entries).toHaveLength(1)
        expect(entries[0].id).toBe('j_0001')
    })
})

///////////////////////////// 挑選規則 /////////////////////////////

describe('挑選規則', () => {
    const five = ['j_0001', 'j_0002', 'j_0003', 'j_0004', 'j_0005'].map((id) => entry(id))

    it('連續挑 N 次不重複', () => {
        const picked = []
        for(let i = 0; i < five.length; i += 1){
            const result = jp.pickFrom(five, picked, () => 0)
            expect(result.roundReset).toBe(false)
            picked.push(result.entry.id)
        }

        expect(new Set(picked).size).toBe(five.length)
    })

    it('第 N+1 次重新開始一輪', () => {
        const all = five.map((item) => item.id)
        const result = jp.pickFrom(five, all, () => 0)

        expect(result.roundReset).toBe(true)
        expect(result.entry.id).toBe('j_0001')
    })

    it('注入固定的 rand 時結果是決定性的', () => {
        expect(jp.pickFrom(five, [], () => 0.5).entry.id).toBe('j_0003')
    })

    it('資料表是空的時候回 null 而不是丟例外', () => {
        expect(jp.pickFrom([], []).entry).toBeNull()
    })

    it('pickDaily 會寫進紀錄，pickRandom 不會', async() => {
        writeEntries(five)

        const daily = await jp.pickDaily(() => 0)
        const afterDaily = await state.getState(jp.SECTION)
        expect(Object.keys(afterDaily.sent)).toEqual([daily.id])

        jp.pickRandom(() => 0.9)
        const afterRandom = await state.getState(jp.SECTION)
        expect(afterRandom.sent).toEqual(afterDaily.sent)
    })

    it('pickDaily 連續兩次不會挑到同一筆', async() => {
        writeEntries(five)

        const first = await jp.pickDaily(() => 0)
        const second = await jp.pickDaily(() => 0)

        expect(second.id).not.toBe(first.id)
        expect(Object.keys((await state.getState(jp.SECTION)).sent)).toHaveLength(2)
    })

    it('一輪發完後 round 加一、紀錄只剩新的那筆', async() => {
        writeEntries([entry('j_0001')])

        await jp.pickDaily(() => 0)
        await jp.pickDaily(() => 0)

        const current = await state.getState(jp.SECTION)
        expect(current.round).toBe(2)
        expect(Object.keys(current.sent)).toEqual(['j_0001'])
    })
})

///////////////////////////// 排版 /////////////////////////////

describe('排版', () => {
    it('缺例句時不炸，只是少那一段', () => {
        const embed = jp.buildEmbed(entry('j_0001', {examples: []}))

        expect(embed.fields.map((field) => field.name)).not.toContain('例句')
        expect(embed.fields.map((field) => field.name)).toContain('意思')
    })

    it('footer 帶得到 id，成員才複製得到', () => {
        expect(jp.buildEmbed(entry('j_0012')).footer.text).toContain('j_0012')
    })

    it('文法的讀音跟表現一樣時不重複顯示', () => {
        const grammar = entry('j_0060', {type: 'grammar', expression: '～ば～ほど', reading: '～ば～ほど'})

        expect(jp.buildEmbed(grammar).fields.map((field) => field.name)).not.toContain('読み方')
    })

    it('筆記顯示成 <@userId> 並帶序號', () => {
        const withNotes = entry('j_0001', {
            notes: [{userId: '123', text: '第一則', at: '2026-08-25T00:00:00.000Z'}],
        })
        const field = jp.buildEmbed(withNotes).fields.find((item) => item.name === '大家的筆記')

        expect(field.value).toContain('<@123>')
        expect(field.value).toContain('1.')
    })

    it('欄位超過 1024 字會截斷（超過的話整則訊息會被 Discord 退掉）', () => {
        const long = jp.buildEmbed(entry('j_0001', {meaning: 'あ'.repeat(2000)}))
        const field = long.fields.find((item) => item.name === '意思')

        expect(field.value.length).toBeLessThanOrEqual(1024)
    })
})

///////////////////////////// 匯入 /////////////////////////////

describe('匯入', () => {
    const good = {type: 'word', expression: '勉強', meaning: '學習', reading: 'べんきょう'}

    it('壞掉的 JSON 直接擋下', () => {
        const result = jp.parseImport([], '{壞的')

        expect(result.ok).toBe(false)
        expect(result.error).toContain('JSON 格式錯誤')
    })

    it('單一物件自動包成一筆', () => {
        const result = jp.parseImport([], JSON.stringify(good))

        expect(result.ok).toBe(true)
        expect(result.added).toHaveLength(1)
    })

    it('缺必填欄位時指出是第幾筆', () => {
        const result = jp.parseImport([], JSON.stringify([good, {type: 'word', expression: '本'}]))

        expect(result.ok).toBe(false)
        expect(result.error).toContain('第 2 筆')
        expect(result.error).toContain('meaning')
    })

    it('type 不在白名單時擋下', () => {
        const result = jp.parseImport([], JSON.stringify([{...good, type: 'kanji'}]))

        expect(result.ok).toBe(false)
        expect(result.error).toContain('type')
    })

    it('examples 不是陣列時擋下，而不是靜默丟掉', () => {
        const result = jp.parseImport([], JSON.stringify([{...good, examples: '例文'}]))

        expect(result.ok).toBe(false)
        expect(result.error).toContain('examples')
    })

    it('examples 少了 ja 時擋下', () => {
        const result = jp.parseImport([], JSON.stringify([{...good, examples: [{zh: '只有中文'}]}]))

        expect(result.ok).toBe(false)
        expect(result.error).toContain('ja')
    })

    it('匯入的 notes 一律清空，不能用貼 JSON 偽造別人的筆記', () => {
        const result = jp.parseImport([], JSON.stringify([
            {...good, notes: [{userId: '999', text: '假的', at: '2026-08-25T00:00:00.000Z'}]},
        ]))

        expect(result.added[0].entry.notes).toEqual([])
    })

    it('沒給 id 時接在現有最大號後面', () => {
        const result = jp.parseImport([entry('j_0060')], JSON.stringify([good]))

        expect(result.added[0].entry.id).toBe('j_0061')
    })

    it('id 跟現有資料重複時改號，既有那筆不動', () => {
        const existing = [entry('j_0001')]
        const result = jp.parseImport(existing, JSON.stringify([{...good, id: 'j_0001'}]))

        expect(result.added[0].renamedFrom).toBe('j_0001')
        expect(result.added[0].entry.id).toBe('j_0002')
        expect(result.entries[0]).toEqual(existing[0])
    })

    it('本批內自己撞號時也會改號', () => {
        const result = jp.parseImport([], JSON.stringify([
            {...good, id: 'j_0001'},
            {...good, id: 'j_0001'},
        ]))

        expect(result.added.map((item) => item.entry.id)).toEqual(['j_0001', 'j_0002'])
    })

    it('id 格式不是 j_NNNN 時重新編號', () => {
        const result = jp.parseImport([], JSON.stringify([{...good, id: '自己取的名字'}]))

        expect(result.added[0].entry.id).toBe('j_0001')
        expect(result.added[0].renamedFrom).toBe('自己取的名字')
    })

    it('任何一筆有問題就整批不寫入，檔案完全沒被動過', () => {
        writeEntries([entry('j_0001')])
        const before = readFile()

        const result = jp.importText(JSON.stringify([good, {type: 'word', expression: '本'}]))

        expect(result.ok).toBe(false)
        expect(readFile()).toBe(before)
        expect(jp.getEntries()).toHaveLength(1)
    })

    it('成功時寫進檔案並留下 .bak', () => {
        writeEntries([entry('j_0001')])

        const result = jp.importText(JSON.stringify([good]))

        expect(result.ok).toBe(true)
        expect(jp.getEntries()).toHaveLength(2)
        expect(fs.existsSync(`${jp.entriesFile()}.bak`)).toBe(true)
    })
})

///////////////////////////// 修改與筆記 /////////////////////////////

describe('修改與筆記', () => {
    beforeEach(() => {
        writeEntries([entry('j_0001'), entry('j_0002')])
    })

    it('改得動白名單內的欄位', () => {
        const result = jp.editEntry('j_0001', 'meaning', '改過的意思')

        expect(result.ok).toBe(true)
        expect(jp.getEntry('j_0001').meaning).toBe('改過的意思')
        expect(result.before).toBe('意思j_0001')
    })

    it('白名單外的欄位不給改', () => {
        expect(jp.applyEdit(jp.getEntries(), 'j_0001', 'examples', '[]').ok).toBe(false)
    })

    it('找不到 id 時回錯誤而不是丟例外', () => {
        expect(jp.editEntry('j_9999', 'meaning', 'x').error).toContain('j_9999')
    })

    it('補充欄位可以用 - 清空，但表現不行', () => {
        expect(jp.editEntry('j_0001', 'note', '-').ok).toBe(true)
        expect(jp.getEntry('j_0001').note).toBe('')
        expect(jp.editEntry('j_0001', 'expression', '-').ok).toBe(false)
    })

    it('加筆記會記下 userId 與時間', () => {
        const result = jp.addNote('j_0001', '123456', '這句很常用')

        expect(result.ok).toBe(true)
        expect(result.index).toBe(1)
        const notes = jp.getEntry('j_0001').notes
        expect(notes[0].userId).toBe('123456')
        expect(notes[0].text).toBe('這句很常用')
        expect(Number.isFinite(new Date(notes[0].at).getTime())).toBe(true)
    })

    it('筆記只會加在指定那一筆上', () => {
        jp.addNote('j_0001', '123456', '只有這筆')

        expect(jp.getEntry('j_0002').notes).toEqual([])
    })

    it('刪得掉指定序號的筆記', () => {
        jp.addNote('j_0001', '1', '第一則')
        jp.addNote('j_0001', '2', '第二則')

        const result = jp.removeNote('j_0001', 1)

        expect(result.removed.text).toBe('第一則')
        expect(jp.getEntry('j_0001').notes.map((item) => item.text)).toEqual(['第二則'])
    })

    it('序號超出範圍時回錯誤', () => {
        expect(jp.removeNote('j_0001', 3).ok).toBe(false)
    })
})

///////////////////////////// 歷史（台北時間） /////////////////////////////

describe('歷史區間', () => {
    //2026-08-25(二) 00:30 台北 = 2026-08-24T16:30Z。
    //刻意選台北的凌晨：這個時刻在 UTC 還是前一天，用本地時間算就會切錯。
    const now = Date.parse('2026-08-24T16:30:00.000Z')

    it('今天從台北的 00:00 起算', () => {
        expect(jp.rangeStart('day', now)).toBe(Date.parse('2026-08-24T16:00:00.000Z'))
    })

    it('本週從台北的週一 00:00 起算', () => {
        expect(jp.rangeStart('week', now)).toBe(Date.parse('2026-08-23T16:00:00.000Z'))
    })

    it('本月從台北的 1 日 00:00 起算', () => {
        expect(jp.rangeStart('month', now)).toBe(Date.parse('2026-07-31T16:00:00.000Z'))
    })

    it('只留區間內的紀錄，新的排前面', () => {
        const entries = [entry('j_0001'), entry('j_0002'), entry('j_0003')]
        const sent = {
            'j_0001': '2026-08-24T16:10:00.000Z',   //台北 8/25 00:10，今天
            'j_0002': '2026-08-24T16:20:00.000Z',   //台北 8/25 00:20，今天
            'j_0003': '2026-08-20T01:00:00.000Z',   //台北 8/20，本月但不是今天
        }

        expect(jp.historyRows(entries, sent, 'day', now).map((row) => row.id))
            .toEqual(['j_0002', 'j_0001'])
        expect(jp.historyRows(entries, sent, 'month', now)).toHaveLength(3)
    })

    it('紀錄對不到資料時略過，不讓查詢掛掉', () => {
        const sent = {'j_9999': '2026-08-24T16:10:00.000Z'}

        expect(jp.historyRows([entry('j_0001')], sent, 'day', now)).toEqual([])
    })

    it('沒有任何紀錄時回空陣列', () => {
        expect(jp.historyRows([entry('j_0001')], undefined, 'day', now)).toEqual([])
    })

    it('清單上的日期用台北時間', () => {
        expect(jp.formatTaipeiDate('2026-08-24T16:10:00.000Z')).toBe('08/25')
    })
})

///////////////////////////// 搜尋 /////////////////////////////

describe('搜尋', () => {
    it('表現、讀音、意思任一命中都算', () => {
        const entries = [
            entry('j_0001', {expression: '猫の手も借りたい', reading: 'ねこ', meaning: '很忙'}),
            entry('j_0002', {expression: '顔が広い', reading: 'かお', meaning: '人脈廣'}),
        ]

        expect(jp.searchEntries(entries, '猫').matched.map((item) => item.id)).toEqual(['j_0001'])
        expect(jp.searchEntries(entries, 'かお').matched.map((item) => item.id)).toEqual(['j_0002'])
        expect(jp.searchEntries(entries, '人脈').matched.map((item) => item.id)).toEqual(['j_0002'])
    })

    it('超過上限時只回前幾筆，但總數照實回報', () => {
        const entries = Array.from({length: 15}, (unused, i) => entry(jp.formatId(i + 1)))
        const result = jp.searchEntries(entries, '表現')

        expect(result.matched).toHaveLength(jp.FIND_LIMIT)
        expect(result.total).toBe(15)
    })

    it('空關鍵字不回全部', () => {
        expect(jp.searchEntries([entry('j_0001')], '   ').total).toBe(0)
    })
})

///////////////////////////// 權限 /////////////////////////////

describe('老師權限', () => {
    const member = (roleIds, guildId) => ({
        guild: {id: guildId},
        roles: {cache: new Map(roleIds.map((id) => [id, {id}]))},
        permissions: {has: () => true},     //管理員權限，這裡刻意不放行
    })

    const table = {'820702012592619570': 'TEACHER'}

    it('對照表查得到且成員有那個身分組才算', () => {
        const roleId = jp.resolveTeacherRole(table, '820702012592619570')

        expect(jp.memberHasRole(member(['TEACHER'], '820702012592619570'), roleId)).toBe(true)
        expect(jp.memberHasRole(member(['其他'], '820702012592619570'), roleId)).toBe(false)
    })

    it('對照表沒有這個伺服器時誰都不能用（fail closed）', () => {
        expect(jp.resolveTeacherRole(table, '1540261363639648318')).toBe('')
        expect(jp.memberHasRole(member(['TEACHER'], '1540261363639648318'), '')).toBe(false)
    })

    it('對照表整個沒設定時也是 fail closed', () => {
        expect(jp.resolveTeacherRole(undefined, '820702012592619570')).toBe('')
        expect(jp.resolveTeacherRole({}, '820702012592619570')).toBe('')
    })

    it('管理員不例外（跟 isGmMember 的慣例相反，依 U05 的指示）', () => {
        //member() 的 permissions.has 一律回 true，代表這是個管理員
        expect(jp.memberHasRole(member([], '820702012592619570'), 'TEACHER')).toBe(false)
    })
})

///////////////////////////// 環境檔結構 /////////////////////////////

describe('兩個環境檔的結構必須一致', () => {
    //src/config/index.js 的 validate() 只比對 roles，沒有比對 channels 與 permissionRoles，
    //所以只加一邊不會有任何警告 —— 而是正式站取到 undefined，發送當下才炸。
    //config/index.js 不在 U05 的檔案領域，改用這裡守住。
    it('channels 的 key 完全相同', () => {
        expect(Object.keys(production.channels).sort()).toEqual(Object.keys(testEnv.channels).sort())
    })

    it('permissionRoles 的 key 完全相同', () => {
        expect(Object.keys(production.permissionRoles).sort())
            .toEqual(Object.keys(testEnv.permissionRoles).sort())
    })

    it('兩邊都有 japanese 頻道', () => {
        expect(production.channels.japanese).toBeTruthy()
        expect(testEnv.channels.japanese).toBeTruthy()
    })
})
