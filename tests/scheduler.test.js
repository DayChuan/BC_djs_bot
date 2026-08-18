import {describe, it, expect, afterEach, vi} from 'vitest'
import scheduler, {weeklyCron, chunkDelay, MAX_TIMEOUT} from '@/core/scheduler'

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
