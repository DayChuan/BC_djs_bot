import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tpl from '@/core/pollTemplate'

//把 logger 換成假的。真正的 logger 會開檔與串流，在測試 jail 裡會讓 vitest
//卡住跑不完 —— 症狀跟 fileParallelism 那個坑一樣：沒有錯誤訊息，就是不結束。
vi.mock('@/core/logger', () => ({
    default: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}))

//跟 pollStore.test.js 同一套做法：路徑是「用到時才解析」的，
//所以只要換掉環境變數就好，不必 vi.resetModules() 把 discord.js 一起重載。
let tmpDir = null

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-tpl-'))
    process.env.POLL_DATA_DIR = tmpDir
})

afterEach(async () => {
    delete process.env.POLL_DATA_DIR
    await fs.rm(tmpDir, {recursive: true, force: true})
})

describe('parseDateOnly', () => {
    it('接受 YYYY-MM-DD，回傳的是 UTC 毫秒', () => {
        expect(tpl.parseDateOnly('2026-08-18')).toBe(Date.UTC(2026, 7, 18))
    })

    it('個位數的月與日不必補零', () => {
        expect(tpl.parseDateOnly('2026-8-1')).toBe(Date.UTC(2026, 7, 1))
    })

    it('不存在的日期要擋掉，不能被 Date.UTC 自動進位吃掉', () => {
        //Date.UTC(2026, 1, 31) 會變成 3 月 3 日
        expect(tpl.parseDateOnly('2026-02-31')).toBeNull()
        expect(tpl.parseDateOnly('2026-13-01')).toBeNull()
        expect(tpl.parseDateOnly('2026/08/18')).toBeNull()
        expect(tpl.parseDateOnly('')).toBeNull()
        expect(tpl.parseDateOnly(null)).toBeNull()
    })

    it('閏年的 2 月 29 日是合法的，平年不是', () => {
        expect(tpl.parseDateOnly('2028-02-29')).toBe(Date.UTC(2028, 1, 29))
        expect(tpl.parseDateOnly('2026-02-29')).toBeNull()
    })
})

describe('addDays', () => {
    it('同月內加天數', () => {
        expect(tpl.addDays('2026-08-18', 6)).toBe('2026-08-24')
    })

    it('跨月會自動進位', () => {
        expect(tpl.addDays('2026-08-30', 3)).toBe('2026-09-02')
    })

    it('跨年會自動進位', () => {
        expect(tpl.addDays('2026-12-30', 3)).toBe('2027-01-02')
    })

    it('跨過閏年的 2 月', () => {
        expect(tpl.addDays('2028-02-27', 3)).toBe('2028-03-01')
        expect(tpl.addDays('2026-02-27', 3)).toBe('2026-03-02')
    })

    it('每週投票推進一輪就是 +7 天', () => {
        expect(tpl.addDays('2026-08-18', 7)).toBe('2026-08-25')
        expect(tpl.addDays('2026-12-29', 7)).toBe('2027-01-05')
    })

    it('起日不合法時回 null，而不是丟出 Invalid Date', () => {
        expect(tpl.addDays('2026-02-31', 7)).toBeNull()
    })
})

//2026-08-18 是星期二。底下依星期對齊的案例都以它當起日。
const WEEK = ['星期二', '星期三', '星期四', '星期五', '星期六', '星期日', '星期一']

//實際在用的 MapleStory 模板：週末拆成早上／下午／晚上三段。
const MAPLE = [
    '星期二', '星期三', '星期四', '星期五',
    '星期六早上', '星期六下午', '星期六晚上',
    '星期日早上', '星期日下午', '星期日晚上',
    '星期一',
]

//測試站的模板實際上是英文的（data/templates/t_mszufcpodq.json）
const MAPLE_EN = ['Tue', 'Wed', 'Thu', 'Fri', 'Sat(Mor)', 'Sat(noon)', 'Sun(Mor)', 'Sun(noon)', 'Mon']

describe('weekdayOf', () => {
    it('認得出星期幾', () => {
        expect(tpl.weekdayOf('星期日')).toBe(0)
        expect(tpl.weekdayOf('星期一')).toBe(1)
        expect(tpl.weekdayOf('星期六')).toBe(6)
    })

    it('「天」等同「日」', () => {
        expect(tpl.weekdayOf('星期天')).toBe(0)
    })

    it('週／周／禮拜都認', () => {
        expect(tpl.weekdayOf('週六')).toBe(6)
        expect(tpl.weekdayOf('周六')).toBe(6)
        expect(tpl.weekdayOf('禮拜六')).toBe(6)
    })

    it('後面接時段也認得出來（這是 bug 的關鍵）', () => {
        expect(tpl.weekdayOf('星期六早上')).toBe(6)
        expect(tpl.weekdayOf('星期六下午')).toBe(6)
        expect(tpl.weekdayOf('星期六晚上')).toBe(6)
    })

    it('英文全名與縮寫都認，不分大小寫', () => {
        expect(tpl.weekdayOf('Sunday')).toBe(0)
        expect(tpl.weekdayOf('Sun')).toBe(0)
        expect(tpl.weekdayOf('MONDAY')).toBe(1)
        expect(tpl.weekdayOf('tue')).toBe(2)
        expect(tpl.weekdayOf('Tues')).toBe(2)
        expect(tpl.weekdayOf('Wed')).toBe(3)
        expect(tpl.weekdayOf('Thu')).toBe(4)
        expect(tpl.weekdayOf('Thurs')).toBe(4)
        expect(tpl.weekdayOf('Fri')).toBe(5)
        expect(tpl.weekdayOf('Saturday')).toBe(6)
    })

    it('英文後面接時段也認得出來（測試站模板的實際寫法）', () => {
        expect(tpl.weekdayOf('Sat(Mor)')).toBe(6)
        expect(tpl.weekdayOf('Sat(noon)')).toBe(6)
        expect(tpl.weekdayOf('Sun(Mor)')).toBe(0)
        expect(tpl.weekdayOf('Sat 晚上')).toBe(6)
    })

    it('開頭字母串整個比對，不做前綴比對', () => {
        //這幾個如果用前綴比對就會被誤判成星期日與星期一
        expect(tpl.weekdayOf('Sunny 場次')).toBeNull()
        expect(tpl.weekdayOf('Monster 團')).toBeNull()
        expect(tpl.weekdayOf('Satellite')).toBeNull()
    })

    it('物件原型上的名稱不會被當成星期', () => {
        //WEEKDAY_WORDS 是物件字面值，用 in 判斷的話 constructor 會查得到東西
        expect(tpl.weekdayOf('constructor')).toBeNull()
        expect(tpl.weekdayOf('toString')).toBeNull()
    })

    it('沒有星期就回 null', () => {
        expect(tpl.weekdayOf('甲')).toBeNull()
        expect(tpl.weekdayOf('早上')).toBeNull()
        expect(tpl.weekdayOf('')).toBeNull()
        expect(tpl.weekdayOf(null)).toBeNull()
    })

    it('星期不在開頭時不算（避免「第三星期二」這種誤判）', () => {
        expect(tpl.weekdayOf('第三星期二')).toBeNull()
    })
})

describe('dayOffsets', () => {
    it('全部認得出星期時依星期對齊', () => {
        expect(tpl.dayOffsets(WEEK, '2026-08-18')).toEqual([0, 1, 2, 3, 4, 5, 6])
    })

    it('同一天的三個時段偏移相同', () => {
        expect(tpl.dayOffsets(MAPLE, '2026-08-18')).toEqual([0, 1, 2, 3, 4, 4, 4, 5, 5, 5, 6])
    })

    it('英文模板也依星期對齊', () => {
        expect(tpl.dayOffsets(MAPLE_EN, '2026-08-18')).toEqual([0, 1, 2, 3, 4, 4, 5, 5, 6])
    })

    it('中英混用時兩邊都認得出來，不會退回逐日遞增', () => {
        expect(tpl.dayOffsets(['星期二', 'Wed', '禮拜四'], '2026-08-18')).toEqual([0, 1, 2])
    })

    it('只要有一個認不出星期，整組退回逐日遞增', () => {
        expect(tpl.dayOffsets(['星期二', '機動場次', '星期四'], '2026-08-18')).toEqual([0, 1, 2])
    })

    it('完全沒有星期的選項維持逐日遞增', () => {
        expect(tpl.dayOffsets(['甲', '乙', '丙'], '2026-08-18')).toEqual([0, 1, 2])
    })

    it('起日的星期與第一個選項不同時，以起日為錨點往後推', () => {
        //2026-08-23 是星期日，第一個選項是星期二 → 往後兩天
        expect(tpl.dayOffsets(WEEK, '2026-08-23')).toEqual([2, 3, 4, 5, 6, 0, 1])
    })

    it('起日不合法或沒有選項時回 null', () => {
        expect(tpl.dayOffsets(WEEK, '2026-02-31')).toBeNull()
        expect(tpl.dayOffsets([], '2026-08-18')).toBeNull()
    })
})

describe('endDateOf', () => {
    it('迄日取實際算出來的最大日期，不是起日加選項數', () => {
        //11 個選項但只跨 7 天。用選項數會算成 8/28。
        expect(tpl.endDateOf(MAPLE, '2026-08-18')).toBe('2026-08-24')
    })

    it('一天一個選項時就是起日加選項數減一', () => {
        expect(tpl.endDateOf(WEEK, '2026-08-18')).toBe('2026-08-24')
    })

    it('認不出星期時退回逐日遞增', () => {
        expect(tpl.endDateOf(['甲', '乙', '丙'], '2026-08-18')).toBe('2026-08-20')
    })

    it('只有一個選項時起迄同一天', () => {
        expect(tpl.endDateOf(['星期二'], '2026-08-18')).toBe('2026-08-18')
    })
})

describe('applyDates', () => {
    it('週末的三個時段落在同一天（2026-08-27 回報的 bug）', () => {
        const options = tpl.applyDates(MAPLE, '2026-08-18')
        expect(options.map((option) => option.label)).toEqual([
            '星期二(8/18)', '星期三(8/19)', '星期四(8/20)', '星期五(8/21)',
            '星期六早上(8/22)', '星期六下午(8/22)', '星期六晚上(8/22)',
            '星期日早上(8/23)', '星期日下午(8/23)', '星期日晚上(8/23)',
            '星期一(8/24)',
        ])
    })

    it('同一天的三個時段各自有獨立的 key，票不會混在一起', () => {
        const options = tpl.applyDates(MAPLE, '2026-08-18')
        expect(new Set(options.map((option) => option.key)).size).toBe(MAPLE.length)
    })

    it('下一輪 +7 天後，同一天的三段仍然是同一天', () => {
        const options = tpl.applyDates(MAPLE, '2026-08-25')
        expect(options.slice(4, 7).map((option) => option.label)).toEqual([
            '星期六早上(8/29)', '星期六下午(8/29)', '星期六晚上(8/29)',
        ])
    })

    it('同年的區間不帶年份', () => {
        const options = tpl.applyDates(WEEK, '2026-08-18')
        expect(options.map((option) => option.label)).toEqual([
            '星期二(8/18)', '星期三(8/19)', '星期四(8/20)', '星期五(8/21)',
            '星期六(8/22)', '星期日(8/23)', '星期一(8/24)',
        ])
    })

    it('key 依序編號，base 保留沒有日期的原始文字', () => {
        const options = tpl.applyDates(WEEK, '2026-08-18')
        expect(options.map((option) => option.key)).toEqual(['o0', 'o1', 'o2', 'o3', 'o4', 'o5', 'o6'])
        expect(options.map((option) => option.base)).toEqual(WEEK)
    })

    it('跨月的區間日期要正確接續', () => {
        //2026-09-29 是星期二。原本這個案例用 2026-08-30，但那天是星期日，
        //改成依星期對齊之後「星期二」就不再是起日當天了，案例本身要跟著改。
        const options = tpl.applyDates(WEEK, '2026-09-29')
        expect(options.map((option) => option.label)).toEqual([
            '星期二(9/29)', '星期三(9/30)', '星期四(10/1)', '星期五(10/2)',
            '星期六(10/3)', '星期日(10/4)', '星期一(10/5)',
        ])
    })

    it('跨年時整批補上年份，不會一半帶一半不帶', () => {
        const options = tpl.applyDates(WEEK, '2026-12-29')
        expect(options.map((option) => option.label)).toEqual([
            '星期二(2026/12/29)', '星期三(2026/12/30)', '星期四(2026/12/31)',
            '星期五(2027/1/1)', '星期六(2027/1/2)', '星期日(2027/1/3)', '星期一(2027/1/4)',
        ])
    })

    it('剛好在 12/31 結束的區間仍算同年，不補年份', () => {
        const options = tpl.applyDates(['甲', '乙', '丙'], '2026-12-29')
        expect(options.map((option) => option.label)).toEqual(['甲(12/29)', '乙(12/30)', '丙(12/31)'])
    })

    it('標籤超長時截斷的是文字本身，日期要完整保留', () => {
        const long = 'ㄅ'.repeat(200)
        const [option] = tpl.applyDates([long], '2026-08-18')
        expect(option.label.length).toBeLessThanOrEqual(100)
        expect(option.label.endsWith('(8/18)')).toBe(true)
    })

    it('起日不合法或沒有選項時回 null', () => {
        expect(tpl.applyDates(WEEK, '2026-02-31')).toBeNull()
        expect(tpl.applyDates([], '2026-08-18')).toBeNull()
    })
})

describe('buildPollOptions / basesOf', () => {
    it('沒有起日時 label 等於 base', () => {
        const options = tpl.buildPollOptions(['甲', '乙'])
        expect(options).toEqual([
            {key: 'o0', base: '甲', label: '甲'},
            {key: 'o1', base: '乙', label: '乙'},
        ])
    })

    it('有起日時 label 帶上日期', () => {
        const options = tpl.buildPollOptions(['甲', '乙'], '2026-08-18')
        expect(options.map((option) => option.label)).toEqual(['甲(8/18)', '乙(8/19)'])
    })

    it('起日不合法時退回不標日期，而不是整個爆掉', () => {
        const options = tpl.buildPollOptions(['甲', '乙'], '2026-02-31')
        expect(options.map((option) => option.label)).toEqual(['甲', '乙'])
    })

    it('basesOf 取得的是原始文字，可以再套一次日期而不會疊加', () => {
        const first = tpl.buildPollOptions(['星期二', '星期三'], '2026-08-18')
        const second = tpl.applyDates(tpl.basesOf(first), '2026-08-25')
        expect(second.map((option) => option.label)).toEqual(['星期二(8/25)', '星期三(8/26)'])
    })

    it('舊投票的選項沒有 base 欄位時退回用 label', () => {
        expect(tpl.basesOf([{key: 'o0', label: '星期二'}])).toEqual(['星期二'])
    })
})

describe('refreshDatedOptions', () => {
    //模擬正式站 p_mtan08kdu9 的實際資料：base 正確，label 是舊規則算出來的
    const stale = [
        {key: 'o0', base: '星期六早上', label: '星期六早上(9/12)'},
        {key: 'o1', base: '星期六下午', label: '星期六下午(9/13)'},
        {key: 'o2', base: '星期六晚上', label: '星期六晚上(9/14)'},
    ]

    it('把舊規則算出來的標籤更正成同一天', () => {
        //2026-09-08 是星期二，星期六 = +4 天 = 9/12
        const next = tpl.refreshDatedOptions(stale, '2026-09-08')
        expect(next.map((option) => option.label)).toEqual([
            '星期六早上(9/12)', '星期六下午(9/12)', '星期六晚上(9/12)',
        ])
    })

    it('沿用原本的 key，已投的票才不會對不上', () => {
        //刻意用不是 o0..oN 的編號，確認不會被重新編號
        const odd = [
            {key: 'o5', base: '星期六早上', label: '星期六早上(9/12)'},
            {key: 'o9', base: '星期六下午', label: '星期六下午(9/13)'},
        ]
        expect(tpl.refreshDatedOptions(odd, '2026-09-08').map((option) => option.key))
            .toEqual(['o5', 'o9'])
    })

    it('算出來跟現在一樣時回 null，呼叫端才不會每次重啟都寫檔', () => {
        const fresh = tpl.applyDates(['星期二', '星期三'], '2026-09-08')
        expect(tpl.refreshDatedOptions(fresh, '2026-09-08')).toBeNull()
    })

    it('沒有起日就回 null（這場投票本來就不標日期）', () => {
        expect(tpl.refreshDatedOptions(stale, null)).toBeNull()
        expect(tpl.refreshDatedOptions(stale, '')).toBeNull()
    })

    it('起日不合法或沒有選項時回 null', () => {
        expect(tpl.refreshDatedOptions(stale, '2026-02-31')).toBeNull()
        expect(tpl.refreshDatedOptions([], '2026-09-08')).toBeNull()
    })

    it('認不出星期的選項維持逐日遞增，也算重算成功', () => {
        const plain = [
            {key: 'o0', base: '甲', label: '甲(9/1)'},
            {key: 'o1', base: '乙', label: '乙(9/2)'},
        ]
        expect(tpl.refreshDatedOptions(plain, '2026-09-08').map((option) => option.label))
            .toEqual(['甲(9/8)', '乙(9/9)'])
    })
})

describe('parseWeeklyText', () => {
    it('解析「發起星期,時間 / 結算星期,時間」', () => {
        expect(tpl.parseWeeklyText('2,10:00 / 1,22:00').weekly).toEqual({
            openDay: 2, openTime: '10:00', closeDay: 1, closeTime: '22:00',
        })
    })

    it('時間補零成兩位數', () => {
        expect(tpl.parseWeeklyText('0,9:05 / 3,8:00').weekly).toEqual({
            openDay: 0, openTime: '09:05', closeDay: 3, closeTime: '08:00',
        })
    })

    it('全形逗號也吃得下', () => {
        expect(tpl.parseWeeklyText('2，10:00 / 1，22:00').weekly.openDay).toBe(2)
    })

    it('格式錯時回 error 而不是拋錯', () => {
        expect(tpl.parseWeeklyText('2,10:00').error).toBeTruthy()
        expect(tpl.parseWeeklyText('9,10:00 / 1,22:00').error).toBeTruthy()
        expect(tpl.parseWeeklyText('2,25:00 / 1,22:00').error).toBeTruthy()
    })

    it('formatWeeklyText 與 parseWeeklyText 對得起來', () => {
        const weekly = {openDay: 2, openTime: '10:00', closeDay: 1, closeTime: '22:00'}
        expect(tpl.parseWeeklyText(tpl.formatWeeklyText(weekly)).weekly).toEqual(weekly)
        expect(tpl.formatWeeklyText(null)).toBe('')
    })
})

describe('parseTemplateFields', () => {
    const fields = (overrides = {}) => ({
        name: '楓之谷週常',
        options: '星期二,星期三,星期四,星期五,星期六,星期日,星期一',
        startDate: '2026-08-18',
        identity: 'maplestory',
        weekly: '2,10:00 / 1,22:00',
        ...overrides,
    })

    it('完整填寫時產生一份可用的模板', () => {
        const {template, error} = tpl.parseTemplateFields(fields())
        expect(error).toBeUndefined()
        expect(template.name).toBe('楓之谷週常')
        expect(template.options).toHaveLength(7)
        expect(template.applyDate).toBe(true)
        expect(template.startDate).toBe('2026-08-18')
        expect(template.identityGroup).toBe('maplestory')
        expect(template.weekly.openDay).toBe(2)
        expect(tpl.isValidTemplateId(template.id)).toBe(true)
    })

    it('起日留空就是不套用日期', () => {
        const {template} = tpl.parseTemplateFields(fields({startDate: ''}))
        expect(template.applyDate).toBe(false)
        expect(template.startDate).toBeNull()
    })

    it('選項會去除重複與空白（沿用 /poll 的規則）', () => {
        const {template} = tpl.parseTemplateFields(fields({options: '甲, 甲 ,乙,,丙'}))
        expect(template.options).toEqual(['甲', '乙', '丙'])
    })

    it('選項不足兩個要退回', () => {
        expect(tpl.parseTemplateFields(fields({options: '甲'})).error).toBeTruthy()
    })

    it('名稱空白要退回', () => {
        expect(tpl.parseTemplateFields(fields({name: '   '})).error).toBeTruthy()
    })

    it('起日格式錯要退回', () => {
        expect(tpl.parseTemplateFields(fields({startDate: '2026/08/18'})).error).toBeTruthy()
    })

    it('不存在的身分群組要退回', () => {
        expect(tpl.parseTemplateFields(fields({identity: 'wow'})).error).toBeTruthy()
    })

    it('編輯時保留原本的 id 與三個開關', () => {
        const existing = {
            id: 't_abc', name: '舊的', options: ['甲', '乙'],
            multi: true, multiChar: true, peek: false,
            identityGroup: 'maplestory', startDate: null, applyDate: false, weekly: null,
        }
        const {template} = tpl.parseTemplateFields(fields({name: '新的'}), existing)
        expect(template.id).toBe('t_abc')
        expect(template.name).toBe('新的')
        expect(template.multi).toBe(true)
        expect(template.multiChar).toBe(true)
        expect(template.peek).toBe(false)
    })

    it('把身分表清空時，一人多角色要跟著關掉', () => {
        const existing = {id: 't_abc', multiChar: true, identityGroup: 'maplestory'}
        const {template} = tpl.parseTemplateFields(fields({identity: ''}), existing)
        expect(template.identityGroup).toBeNull()
        expect(template.multiChar).toBe(false)
    })

    it('新建時預設開放中途查看', () => {
        expect(tpl.parseTemplateFields(fields()).template.peek).toBe(true)
    })
})

describe('isValidTemplateId', () => {
    it('擋掉會被拿去組檔名的路徑字元', () => {
        expect(tpl.isValidTemplateId('t_abc123')).toBe(true)
        expect(tpl.isValidTemplateId('../../../etc/passwd')).toBe(false)
        expect(tpl.isValidTemplateId('t_../x')).toBe(false)
        expect(tpl.isValidTemplateId('')).toBe(false)
        expect(tpl.isValidTemplateId(null)).toBe(false)
    })

    it('makeTemplateId 產生的 id 一定通過驗證', () => {
        expect(tpl.isValidTemplateId(tpl.makeTemplateId(1755500000000, 0.5))).toBe(true)
    })
})

describe('模板讀寫', () => {
    const sample = (overrides = {}) => ({
        id: tpl.makeTemplateId(),
        name: '楓之谷週常',
        options: ['星期二', '星期三'],
        applyDate: true,
        startDate: '2026-08-18',
        identityGroup: 'maplestory',
        multi: true,
        multiChar: false,
        peek: true,
        weekly: null,
        ...overrides,
    })

    it('資料夾還不存在時列出空陣列，不是拋錯', async () => {
        expect(await tpl.listTemplates()).toEqual([])
    })

    it('存進去再讀出來是同一份', async () => {
        const template = sample()
        await tpl.saveTemplate(template)
        expect(await tpl.getTemplate(template.id)).toEqual(template)
    })

    it('id 不合法時不寫檔也不讀檔', async () => {
        expect(await tpl.saveTemplate({id: '../evil', name: 'x'})).toBeNull()
        expect(await tpl.getTemplate('../evil')).toBeNull()
    })

    it('列表依名稱排序，且不依賴 ICU 的中文定序', async () => {
        await tpl.saveTemplate(sample({id: 't_b', name: 'B 週常'}))
        await tpl.saveTemplate(sample({id: 't_a', name: 'A 週常'}))
        expect((await tpl.listTemplates()).map((item) => item.name)).toEqual(['A 週常', 'B 週常'])
    })

    it('同名的模板用 id 決定先後，順序才不會每次不一樣', async () => {
        await tpl.saveTemplate(sample({id: 't_b', name: '同名'}))
        await tpl.saveTemplate(sample({id: 't_a', name: '同名'}))
        expect((await tpl.listTemplates()).map((item) => item.id)).toEqual(['t_a', 't_b'])
    })

    it('刪除後就讀不到了，重複刪除回 false', async () => {
        const template = sample()
        await tpl.saveTemplate(template)
        expect(await tpl.deleteTemplate(template.id)).toBe(true)
        expect(await tpl.getTemplate(template.id)).toBeNull()
        expect(await tpl.deleteTemplate(template.id)).toBe(false)
    })

    it('templateChoices 的形狀符合 addChoices() 的要求', async () => {
        await tpl.saveTemplate(sample({id: 't_a', name: '甲'}))
        expect(await tpl.templateChoices()).toEqual([{name: '甲', value: 't_a'}])
    })

    it('模板數量超過上限時只取前 25 個，指令註冊才不會失敗', async () => {
        for(let i = 0; i < 30; i += 1){
            await tpl.saveTemplate(sample({id: `t_x${i.toString(36)}`, name: `模板${String(i).padStart(2, '0')}`}))
        }
        expect(await tpl.templateChoices()).toHaveLength(tpl.MAX_TEMPLATES)
    })
})
