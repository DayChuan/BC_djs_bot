import {describe, it, expect, vi} from 'vitest'
import {
    MAX_THREAD_NAME,
    buildThreadName,
    taipeiDateOnly,
    threadParentId,
    wantsThread,
} from '@/core/pollStore'

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

describe('buildThreadName', () => {
    const now = Date.UTC(2026, 8, 3, 1, 0)

    it('組成【投票】<標題> YYYY-MM-DD', () => {
        expect(buildThreadName('本週副本時段', now)).toBe('【投票】本週副本時段 2026-09-03')
    })

    it('標題過長時截斷，總長不超過 Discord 的上限', () => {
        const name = buildThreadName('長'.repeat(300), now)
        expect(name.length).toBe(MAX_THREAD_NAME)
        //日期一定要留著：每一輪都會開新串，沒有日期就分不出哪個是這週的
        expect(name.endsWith('2026-09-03')).toBe(true)
        expect(name.startsWith('【投票】')).toBe(true)
    })

    it('剛好貼齊上限的標題不會被截掉', () => {
        //【投票】(4) + 標題 + 空格(1) + 日期(10) = 100
        const title = '甲'.repeat(MAX_THREAD_NAME - 4 - 1 - 10)
        const name = buildThreadName(title, now)
        expect(name.length).toBe(MAX_THREAD_NAME)
        expect(name).toBe(`【投票】${title} 2026-09-03`)
    })

    it('標題是空的或 null 也不會爆', () => {
        expect(buildThreadName('', now)).toBe('【投票】 2026-09-03')
        expect(buildThreadName(null, now)).toBe('【投票】 2026-09-03')
    })

    it('標題前後的空白會去掉', () => {
        expect(buildThreadName('  週常  ', now)).toBe('【投票】週常 2026-09-03')
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
