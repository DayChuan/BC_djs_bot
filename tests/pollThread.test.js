import {describe, it, expect, vi} from 'vitest'
import {
    MAX_THREAD_NAME,
    buildThreadName,
    resolveNoticeRole,
    taipeiDateOnly,
    taipeiMonthDay,
    threadParentId,
    wantsThread,
} from '@/core/pollStore'
import {optionDateRange} from '@/core/pollTemplate'

//把 logger 換成假的。真正的 logger 會開檔與串流，在測試 jail 裡會讓 vitest
//卡住跑不完(同 pollStore.test.js)。
vi.mock('@/core/logger', () => ({
    default: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}))

//U10：投票開在討論串裡。
//這裡只測純函式 —— 建串、鎖定、解封存都要碰 discord.js 的頻道物件，
//測試檔不能 import discord.js，那幾段一律在測試伺服器實機驗收。

describe('taipeiDateOnly', () => {
    it('回傳台北時間的 YYYY-MM-DD', () => {
        expect(taipeiDateOnly(Date.UTC(2026, 8, 3, 1, 0))).toBe('2026-09-03')
    })

    it('UTC 還是前一天、台北已經跨日時要算成台北的日期', () => {
        //UTC 2026-09-02 16:00 = 台北 2026-09-03 00:00
        expect(taipeiDateOnly(Date.UTC(2026, 8, 2, 16, 0))).toBe('2026-09-03')
        //差一分鐘就還是前一天，邊界不能算錯
        expect(taipeiDateOnly(Date.UTC(2026, 8, 2, 15, 59))).toBe('2026-09-02')
    })

    it('月份與日期都補到兩位數', () => {
        expect(taipeiDateOnly(Date.UTC(2026, 0, 5, 3, 0))).toBe('2026-01-05')
    })
})

describe('taipeiMonthDay', () => {
    it('回傳 MM/DD 的短格式', () => {
        expect(taipeiMonthDay(Date.UTC(2026, 8, 3, 1, 0))).toBe('09/03')
        expect(taipeiMonthDay(Date.UTC(2026, 0, 5, 3, 0))).toBe('01/05')
    })
})

describe('optionDateRange', () => {
    //討論串名稱要用的日期就是這個。選項的日期一律由 base 與起日算出來。
    const options = ['星期二', '星期三', '星期四', '星期五', '星期六', '星期日', '星期一']
        .map((base, index) => ({key: `o${index}`, base, label: base}))

    it('回傳起日～迄日的短格式', () => {
        expect(optionDateRange(options, '2026-08-18')).toBe('08/18~08/24')
    })

    it('迄日算的是實際涵蓋的天數，不是選項數', () => {
        //同一天分早中晚三段：選項有 3 個，但只涵蓋一天
        const slots = ['星期二早', '星期二中', '星期二晚']
            .map((base, index) => ({key: `o${index}`, base, label: base}))
        expect(optionDateRange(slots, '2026-08-18')).toBe('08/18')
    })

    it('沒有起日就回 null，由呼叫端決定替代方案', () => {
        expect(optionDateRange(options, null)).toBeNull()
        expect(optionDateRange(options, '')).toBeNull()
    })

    it('起日格式不合法也回 null，不會組出壞掉的名稱', () => {
        expect(optionDateRange(options, '2026/08/18')).toBeNull()
    })
})

describe('buildThreadName', () => {
    const now = Date.UTC(2026, 8, 3, 1, 0)

    it('用選項的日期範圍組成【投票】<標題> MM/DD~MM/DD', () => {
        expect(buildThreadName('楓之谷週常', '08/18~08/24', now))
            .toBe('【投票】楓之谷週常 08/18~08/24')
    })

    it('選項上沒有日期時退回用今天（台北）', () => {
        expect(buildThreadName('臨時揪團', null, now)).toBe('【投票】臨時揪團 09/03')
    })

    it('標題過長時截斷，總長不超過 Discord 的上限', () => {
        const name = buildThreadName('長'.repeat(300), '08/18~08/24', now)
        expect(name.length).toBe(MAX_THREAD_NAME)
        //日期一定要留著：每一輪都會開新串，沒有日期就分不出哪個是這週的
        expect(name.endsWith('08/18~08/24')).toBe(true)
        expect(name.startsWith('【投票】')).toBe(true)
    })

    it('剛好貼齊上限的標題不會被截掉', () => {
        //【投票】(4) + 標題 + 空格(1) + 日期(11) = 100
        const date = '08/18~08/24'
        const title = '甲'.repeat(MAX_THREAD_NAME - 4 - 1 - date.length)
        expect(buildThreadName(title, date, now)).toBe(`【投票】${title} ${date}`)
        expect(buildThreadName(title, date, now).length).toBe(MAX_THREAD_NAME)
    })

    it('標題是空的或 null 也不會爆', () => {
        expect(buildThreadName('', '08/18', now)).toBe('【投票】 08/18')
        expect(buildThreadName(null, '08/18', now)).toBe('【投票】 08/18')
    })

    it('標題前後的空白會去掉', () => {
        expect(buildThreadName('  週常  ', '08/18', now)).toBe('【投票】週常 08/18')
    })
})

describe('resolveNoticeRole', () => {
    const table = {'974484668252565544': '974484668252565548'}

    it('依伺服器取得要提及的身分組', () => {
        expect(resolveNoticeRole(table, '974484668252565544')).toBe('974484668252565548')
    })

    it('沒填到的伺服器回空字串（不提及，而不是亂 tag）', () => {
        //身分組 id 綁死在單一伺服器，拿 A 的 id 去 B 一定 tag 不到人
        expect(resolveNoticeRole(table, '820702012592619570')).toBe('')
        expect(resolveNoticeRole(undefined, '974484668252565544')).toBe('')
        expect(resolveNoticeRole(table, null)).toBe('')
    })
})

describe('wantsThread', () => {
    it('舊的投票紀錄沒有 thread 欄位，一律當成不開串', () => {
        //這是相容性的重點：undefined 不能漏出去變成意外行為
        expect(wantsThread({id: 'p_old', channelId: '123'})).toBe(false)
        expect(wantsThread({thread: undefined})).toBe(false)
    })

    it('沒有投票物件時也回 false，不丟例外', () => {
        expect(wantsThread(null)).toBe(false)
        expect(wantsThread(undefined)).toBe(false)
    })

    it('thread 為真才開串', () => {
        expect(wantsThread({thread: true})).toBe(true)
        expect(wantsThread({thread: false})).toBe(false)
    })
})

describe('threadParentId', () => {
    it('舊紀錄沒有 parentChannelId 時回 null', () => {
        expect(threadParentId({channelId: '123'})).toBeNull()
        expect(threadParentId(null)).toBeNull()
    })

    it('有母頻道就回母頻道，不會回 channelId', () => {
        //每週續辦時 channelId 已經是上一輪的討論串，拿它建串會失敗
        expect(threadParentId({channelId: 'thread-2', parentChannelId: 'parent-1'})).toBe('parent-1')
    })
})
