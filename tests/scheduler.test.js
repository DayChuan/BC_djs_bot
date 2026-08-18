import {describe, it, expect, afterEach, vi} from 'vitest'
import scheduler, {
    weeklyCron,
    chunkDelay,
    nextWeeklyDate,
    parseTaipeiDateTime,
    formatTaipeiDateTime,
    MAX_TIMEOUT,
} from '@/core/scheduler'

afterEach(() => {
    scheduler.cancelAll()
    vi.useRealTimers()
})

describe('weeklyCron', () => {
    it('星期日 20:00 轉成 cron', () => {
        expect(weeklyCron(0, '20:00')).toBe('0 20 * * 0')
    })

    it('個位數小時也吃得下', () => {
        expect(weeklyCron(2, '9:05')).toBe('5 9 * * 2')
    })

    it('星期超出範圍要拋錯，不能靜靜排到錯的日子', () => {
        expect(() => weeklyCron(7, '20:00')).toThrow()
    })

    it('時間格式錯誤要拋錯', () => {
        expect(() => weeklyCron(1, '2000')).toThrow()
        expect(() => weeklyCron(1, '25:00')).toThrow()
    })
})

describe('nextWeeklyDate', () => {
    //2026-08-18T00:00:00Z = 台北時間 2026-08-18(星期二) 08:00
    const tuesday0800 = new Date('2026-08-18T00:00:00.000Z')

    it('同一天但時間還沒到 → 就是今天', () => {
        expect(nextWeeklyDate(2, '20:00', tuesday0800).toISOString())
            .toBe('2026-08-18T12:00:00.000Z')
    })

    it('同一天但時間已過 → 推到下週同一天', () => {
        expect(nextWeeklyDate(2, '07:00', tuesday0800).toISOString())
            .toBe('2026-08-24T23:00:00.000Z')
    })

    it('跨到本週稍後的日子', () => {
        //台北星期日 2026-08-23 20:00 = UTC 12:00
        expect(nextWeeklyDate(0, '20:00', tuesday0800).toISOString())
            .toBe('2026-08-23T12:00:00.000Z')
    })

    it('台北的凌晨時段會落在前一天的 UTC，不能算錯', () => {
        //台北星期三 2026-08-19 01:00 = UTC 2026-08-18 17:00
        expect(nextWeeklyDate(3, '01:00', tuesday0800).toISOString())
            .toBe('2026-08-18T17:00:00.000Z')
    })

    it('剛好等於現在這一刻算已經過去，推到下週(否則結算完會排回同一點)', () => {
        //台北時間正好 08:00 星期二
        expect(nextWeeklyDate(2, '08:00', tuesday0800).toISOString())
            .toBe('2026-08-25T00:00:00.000Z')
    })

    it('不受系統時區影響：算出來的絕對時間固定', () => {
        const result = nextWeeklyDate(2, '20:00', tuesday0800)
        //台北 20:00 永遠是 UTC 12:00，台北沒有日光節約時間
        expect(result.getUTCHours()).toBe(12)
    })

    it('參數不合法要拋錯', () => {
        expect(() => nextWeeklyDate(9, '20:00', tuesday0800)).toThrow()
        expect(() => nextWeeklyDate(2, '2000', tuesday0800)).toThrow()
    })
})

describe('chunkDelay', () => {
    it('超過 setTimeout 上限時只等上限，避免立刻觸發', () => {
        expect(chunkDelay(MAX_TIMEOUT + 100000)).toBe(MAX_TIMEOUT)
    })

    it('沒超過就照原值', () => {
        expect(chunkDelay(5000)).toBe(5000)
    })

    it('已過期或不合法的值一律回 0', () => {
        expect(chunkDelay(-1)).toBe(0)
        expect(chunkDelay(Number.NaN)).toBe(0)
    })
})

describe('scheduleAt', () => {
    it('時間到才執行', async () => {
        vi.useFakeTimers()
        const task = vi.fn()
        scheduler.scheduleAt('t1', new Date(Date.now() + 60000), task)

        expect(task).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(60001)
        expect(task).toHaveBeenCalledTimes(1)
    })

    it('已經過期的時間立刻執行(bot 停機期間錯過的截止時間靠這個補結算)', async () => {
        const task = vi.fn()
        scheduler.scheduleAt('t2', new Date(Date.now() - 1000), task)
        await Promise.resolve()
        expect(task).toHaveBeenCalledTimes(1)
    })

    it('同一個 key 重複註冊會蓋掉舊的，不會結算兩次', async () => {
        vi.useFakeTimers()
        const first = vi.fn()
        const second = vi.fn()
        scheduler.scheduleAt('t3', new Date(Date.now() + 1000), first)
        scheduler.scheduleAt('t3', new Date(Date.now() + 1000), second)

        await vi.advanceTimersByTimeAsync(1001)
        expect(first).not.toHaveBeenCalled()
        expect(second).toHaveBeenCalledTimes(1)
    })

    it('cancel 之後不會再執行', async () => {
        vi.useFakeTimers()
        const task = vi.fn()
        scheduler.scheduleAt('t4', new Date(Date.now() + 1000), task)
        expect(scheduler.cancel('t4')).toBe(true)

        await vi.advanceTimersByTimeAsync(2000)
        expect(task).not.toHaveBeenCalled()
        expect(scheduler.has('t4')).toBe(false)
    })

    it('任務拋錯只會被記錄，不會往外拋(否則會終止整個行程)', async () => {
        const task = vi.fn(() => {
            throw new Error('故意失敗')
        })
        expect(() => scheduler.scheduleAt('t5', new Date(Date.now() - 1), task)).not.toThrow()
        await Promise.resolve()
        expect(task).toHaveBeenCalled()
    })

    it('不合法的時間要拋錯', () => {
        expect(() => scheduler.scheduleAt('t6', '不是時間', () => undefined)).toThrow()
    })
})

describe('scheduleCron', () => {
    it('註冊後查得到，取消後查不到', () => {
        scheduler.scheduleCron('c1', '0 20 * * 0', () => undefined)
        expect(scheduler.has('c1')).toBe(true)
        expect(scheduler.keys()).toContain('c1')

        scheduler.cancel('c1')
        expect(scheduler.has('c1')).toBe(false)
    })

    it('不合法的 cron 運算式要拋錯', () => {
        expect(() => scheduler.scheduleCron('c2', 'not a cron', () => undefined)).toThrow()
    })
})

describe('parseTaipeiDateTime / formatTaipeiDateTime', () => {
    it('台北時間轉成 UTC', () => {
        expect(parseTaipeiDateTime('2026-08-18 14:00').toISOString())
            .toBe('2026-08-18T06:00:00.000Z')
    })

    it('台北的凌晨會落在前一天的 UTC', () => {
        expect(parseTaipeiDateTime('2026-08-18 01:00').toISOString())
            .toBe('2026-08-17T17:00:00.000Z')
    })

    it('格式錯誤回 null 而不是拋錯(這是使用者手打的內容)', () => {
        expect(parseTaipeiDateTime('2026/08/18 14:00')).toBeNull()
        expect(parseTaipeiDateTime('2026-08-18')).toBeNull()
        expect(parseTaipeiDateTime('')).toBeNull()
    })

    it('不存在的日期要擋掉，不能自動進位成下個月', () => {
        expect(parseTaipeiDateTime('2026-02-31 10:00')).toBeNull()
        expect(parseTaipeiDateTime('2026-13-01 10:00')).toBeNull()
    })

    it('轉回去顯示的是台北時間', () => {
        expect(formatTaipeiDateTime('2026-08-18T06:00:00.000Z')).toBe('2026-08-18 14:00')
    })

    it('來回轉換不會跑掉', () => {
        const text = '2026-12-31 23:59'
        expect(formatTaipeiDateTime(parseTaipeiDateTime(text).toISOString())).toBe(text)
    })
})

describe('模組載入', () => {
    it('default export 的每個成員在載入時都取得到', () => {
        for(const [name, value] of Object.entries(scheduler)){
            expect(value, `default export 的 ${name}`).toBeDefined()
        }
    })
})
