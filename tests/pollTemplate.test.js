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

describe('endDateOf', () => {
    it('迄日由起日與選項數推算', () => {
        expect(tpl.endDateOf('2026-08-18', 7)).toBe('2026-08-24')
    })

    it('只有一個選項時起迄同一天', () => {
        expect(tpl.endDateOf('2026-08-18', 1)).toBe('2026-08-18')
    })
})

describe('applyDates', () => {
    const WEEK = ['星期二', '星期三', '星期四', '星期五', '星期六', '星期日', '星期一']

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
        const options = tpl.applyDates(WEEK, '2026-08-30')
        expect(options.map((option) => option.label)).toEqual([
            '星期二(8/30)', '星期三(8/31)', '星期四(9/1)', '星期五(9/2)',
            '星期六(9/3)', '星期日(9/4)', '星期一(9/5)',
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

    it('列表依名稱排序', async () => {
        await tpl.saveTemplate(sample({id: 't_b', name: '乙'}))
        await tpl.saveTemplate(sample({id: 't_a', name: '甲'}))
        expect((await tpl.listTemplates()).map((item) => item.name)).toEqual(['甲', '乙'])
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
