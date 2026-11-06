import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as queue from '@/core/geminiQueue'
import mcConfig from '@/config/minecraft'
import * as state from '@/core/state'
import config from '@/config'

//真正的 logger 會開檔與串流，在測試 jail 裡會讓 vitest 卡住跑不完(同 minecraftFeed.test.js)
vi.mock('@/core/logger', () => ({
    default: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}))

const MIN = 60 * 1000
const HOUR = 60 * MIN

//台灣時間 → UTC timestamp(台灣固定 UTC+8)
const taipei = (year, month, day, hour, minute = 0) => Date.UTC(year, month - 1, day, hour - 8, minute)

let tmpDir = null

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-queue-'))
    process.env.STATE_DATA_DIR = tmpDir
    state.resetQueue()
})

afterEach(() => {
    delete process.env.STATE_DATA_DIR
    fs.rmSync(tmpDir, {recursive: true, force: true})
})

describe('下次重試時間', () => {
    it('429 → 隔天 09:00(台灣)', () => {
        expect(queue.nextQuotaRetryAt(taipei(2026, 11, 6, 10, 25))).toBe(taipei(2026, 11, 7, 9))
    })

    it('台灣 23:59 失敗 → 隔天 09:00', () => {
        expect(queue.nextQuotaRetryAt(taipei(2026, 11, 6, 23, 59))).toBe(taipei(2026, 11, 7, 9))
    })

    it('台灣凌晨 0:30 失敗 → 照字面排到下一個日期，不是當天 09:00(那時額度還沒重置)', () => {
        expect(queue.nextQuotaRetryAt(taipei(2026, 11, 7, 0, 30))).toBe(taipei(2026, 11, 8, 9))
    })

    it('月底與年底會進位', () => {
        expect(queue.nextQuotaRetryAt(taipei(2026, 11, 30, 12))).toBe(taipei(2026, 12, 1, 9))
        expect(queue.nextQuotaRetryAt(taipei(2026, 12, 31, 12))).toBe(taipei(2027, 1, 1, 9))
    })

    it('一般失敗 → 30 分鐘後；429 → 隔天；達上限 → null', () => {
        const now = taipei(2026, 11, 6, 10, 25)
        expect(queue.nextRetryAt(now, 1, false)).toBe(now + 30 * MIN)
        expect(queue.nextRetryAt(now, 1, true)).toBe(taipei(2026, 11, 7, 9))
        expect(queue.nextRetryAt(now, mcConfig.QUEUE_MAX_ATTEMPTS - 1, false)).not.toBeNull()
        expect(queue.nextRetryAt(now, mcConfig.QUEUE_MAX_ATTEMPTS, false)).toBeNull()
        expect(queue.nextRetryAt(now, mcConfig.QUEUE_MAX_ATTEMPTS, true)).toBeNull()
    })
})

describe('要不要排佇列', () => {
    it.each([
        ['all-failed', true],
        ['article-fetch-failed', true],
        ['error(socket hang up)', true],
        ['no-key', false],
        ['bad-key', false],
        ['http-400', false],
        ['http-401', false],
    ])('%s → %s', (reason, expected) => {
        expect(queue.isRetryable({text: null, reason})).toBe(expected)
    })

    it('成功的結果不排', () => {
        expect(queue.isRetryable({text: '訳文', model: 'x'})).toBe(false)
    })
})

describe('工作的建立與失敗紀錄', () => {
    const spec = {id: 'summary:L:ja', kind: 'summary', channelId: 'thread-1', url: 'L', label: 'Snapshot 7（日文摘要）'}
    const now = taipei(2026, 11, 6, 10, 25)

    it('第一次失敗就算 1 次，429 記成額度錯誤', () => {
        const job = queue.buildJob(spec, {reason: 'all-failed', quota: true}, now)
        expect(job).toMatchObject({
            id: 'summary:L:ja', channelId: 'thread-1', messageId: null,
            attempts: 1, createdAt: now, nextAt: taipei(2026, 11, 7, 9), quota: true,
            lastError: 'all-failed（429 額度用完）',
        })
    })

    it('再失敗一次 → 次數加 1、重算時間；到上限 → giveUp', () => {
        const job = queue.buildJob(spec, {reason: 'all-failed'}, now)
        const second = queue.recordFailure(job, {reason: 'all-failed'}, now + HOUR)
        expect(second).toMatchObject({giveUp: false, job: {attempts: 2, nextAt: now + HOUR + 30 * MIN}})

        const last = queue.recordFailure({...job, attempts: mcConfig.QUEUE_MAX_ATTEMPTS - 1}, {reason: 'all-failed'}, now)
        expect(last.giveUp).toBe(true)
        expect(last.job.attempts).toBe(mcConfig.QUEUE_MAX_ATTEMPTS)
    })

    it('同一個 id 再排一次不會把累積的次數洗掉', () => {
        const old = {...queue.buildJob(spec, {reason: 'all-failed'}, now), attempts: 3}
        const again = queue.buildJob(spec, {reason: 'all-failed'}, now + HOUR)
        expect(queue.upsertJob([old], again)).toEqual([old])
        expect(queue.upsertJob([], again)).toEqual([again])
    })

    it('只挑出 nextAt 已經到的', () => {
        const jobs = [{id: 'a', nextAt: now - 1}, {id: 'b', nextAt: now}, {id: 'c', nextAt: now + 1}, {id: 'd', nextAt: null}]
        expect(queue.dueJobs(jobs, now).map((job) => job.id)).toEqual(['a', 'b'])
    })

    it('管理員通知含項目、網址、最後錯誤、首次失敗時間(台灣時間)', () => {
        const job = {...queue.buildJob(spec, {reason: 'all-failed', quota: true}, now), attempts: 5}
        const text = queue.buildAdminNotice(job)
        expect(text).toContain('Gemini 連續失敗 5 次')
        expect(text).toContain('項目：Snapshot 7（日文摘要）')
        expect(text).toContain('網址：L')
        expect(text).toContain('最後錯誤：all-failed（429 額度用完）')
        expect(text).toContain('首次失敗：2026-11-06 10:25')
    })

    it('金鑰問題的通知：含項目、網址、錯誤，並提示去查 .env', () => {
        const text = queue.buildKeyFailureNotice({label: '公告翻譯：明天維修', url: 'https://discord.com/x'}, {reason: 'http-400'})
        expect(text).toContain('金鑰或請求有問題，不會自動重試')
        expect(text).toContain('項目：公告翻譯：明天維修')
        expect(text).toContain('網址：https://discord.com/x')
        expect(text).toContain('錯誤：http-400')
        expect(text).toContain('GEMINI_API_KEY')
    })

    it.each([
        ['http-400', true],
        ['bad-key', true],
        ['no-key', false],
        ['all-failed', false],
    ])('%s → 要不要發金鑰通知：%s', (reason, expected) => {
        expect(queue.needsKeyFailureNotice({text: null, reason})).toBe(expected)
    })
})

/////////////////////////// 落地與執行(假的 client) ///////////////////////////

const makeClient = () => {
    const sent = []
    return {
        sent,
        channels: {
            fetch: async(id) => ({
                id,
                send: async({content}) => {
                    sent.push({channel: id, content})
                    return {}
                },
            }),
        },
    }
}

//已經到期的工作(兩小時前排的，nextAt 早就過了)
const dueSpec = (kind) => ({id: `${kind}:x`, kind, channelId: 'c1', url: 'U', label: `L-${kind}`})
const enqueueDue = async(kind, attempts = 1) => {
    const job = {...queue.buildJob(dueSpec(kind), {reason: 'all-failed'}, Date.now() - 2 * HOUR), attempts}
    await queue.saveJob(job)
    return job
}

describe('落地', () => {
    it('排入的工作寫進 state.json，同一個 id 只留一份', async() => {
        const client = makeClient()
        expect(await queue.enqueue(client, dueSpec('t1'), {reason: 'all-failed'})).toBe(true)
        expect(await queue.enqueue(client, dueSpec('t1'), {reason: 'all-failed'})).toBe(true)
        const jobs = await queue.getJobs()
        expect(jobs).toHaveLength(1)
        expect(jobs[0]).toMatchObject({id: 't1:x', attempts: 1})

        const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state.json'), 'utf8'))
        expect(onDisk[queue.SECTION].jobs).toHaveLength(1)
    })

    it('依 id 移除，不動其他筆', async() => {
        await enqueueDue('a')
        await enqueueDue('b')
        await queue.removeJob('a:x')
        expect((await queue.getJobs()).map((job) => job.id)).toEqual(['b:x'])
    })
})

describe('runQueue', () => {
    it('成功 → 移出佇列', async() => {
        const run = vi.fn(async() => ({ok: true}))
        queue.registerKind('ok', {run})
        await enqueueDue('ok')

        const counts = await queue.runQueue(makeClient())
        expect(counts.done).toBe(1)
        expect(run).toHaveBeenCalledTimes(1)
        expect(await queue.getJobs()).toEqual([])
    })

    it('還沒到期的不跑', async() => {
        const run = vi.fn(async() => ({ok: true}))
        queue.registerKind('later', {run})
        await queue.enqueue(makeClient(), dueSpec('later'), {reason: 'all-failed'})

        await queue.runQueue(makeClient())
        expect(run).not.toHaveBeenCalled()
        expect(await queue.getJobs()).toHaveLength(1)
    })

    it('all-failed → 次數加 1，留在佇列', async() => {
        queue.registerKind('flaky', {run: async() => ({ok: false, result: {reason: 'all-failed'}})})
        await enqueueDue('flaky')

        expect((await queue.runQueue(makeClient())).retry).toBe(1)
        const [job] = await queue.getJobs()
        expect(job.attempts).toBe(2)
        expect(job.nextAt).toBeGreaterThan(Date.now())
    })

    it('處理器丟例外 → 當一般失敗重排，不會讓整個佇列停下', async() => {
        queue.registerKind('throws', {run: async() => {
            throw new Error('socket hang up')
        }})
        await enqueueDue('throws')

        expect((await queue.runQueue(makeClient())).retry).toBe(1)
        expect((await queue.getJobs())[0].lastError).toContain('socket hang up')
    })

    it('第 5 次失敗 → 發管理員通知、呼叫 onGiveUp、移出佇列', async() => {
        const onGiveUp = vi.fn(async() => undefined)
        queue.registerKind('dead', {run: async() => ({ok: false, result: {reason: 'all-failed', quota: true}}), onGiveUp})
        await enqueueDue('dead', mcConfig.QUEUE_MAX_ATTEMPTS - 1)
        const client = makeClient()

        expect((await queue.runQueue(client)).gaveUp).toBe(1)
        expect(await queue.getJobs()).toEqual([])
        expect(onGiveUp).toHaveBeenCalledTimes(1)

        //jail 的 .env 決定是哪個環境，所以從 config 拿，不寫死 id
        const notice = client.sent.find((m) => m.channel === config.channels.admin)
        expect(notice.content).toContain('L-dead')
        expect(notice.content).toContain('429 額度用完')
    })

    it('重試時變成金鑰錯誤 → 移出佇列、發金鑰問題的管理員通知', async() => {
        const onGiveUp = vi.fn(async() => undefined)
        queue.registerKind('key', {run: async() => ({ok: false, result: {reason: 'http-400'}}), onGiveUp})
        await enqueueDue('key')
        const client = makeClient()

        expect((await queue.runQueue(client)).dropped).toBe(1)
        expect(await queue.getJobs()).toEqual([])
        expect(client.sent).toHaveLength(1)
        expect(client.sent[0].channel).toBe(config.channels.admin)
        expect(client.sent[0].content).toContain('金鑰或請求有問題')
        expect(client.sent[0].content).toContain('L-key')
        expect(onGiveUp).toHaveBeenCalledTimes(1)
    })

    it('重試時變成 no-key(環境拿掉了金鑰)→ 移出佇列，不通知', async() => {
        queue.registerKind('nokey', {run: async() => ({ok: false, result: {reason: 'no-key'}})})
        await enqueueDue('nokey')
        const client = makeClient()

        expect((await queue.runQueue(client)).dropped).toBe(1)
        expect(client.sent).toEqual([])
    })

    it('drop → 安靜地移出佇列', async() => {
        queue.registerKind('gone', {run: async() => ({drop: '原公告已被刪除'})})
        await enqueueDue('gone')
        const client = makeClient()

        expect((await queue.runQueue(client)).dropped).toBe(1)
        expect(await queue.getJobs()).toEqual([])
        expect(client.sent).toEqual([])
    })

    it('沒有登記處理器的 kind → 留著不動', async() => {
        await enqueueDue('nobody')
        expect((await queue.runQueue(makeClient())).skipped).toBe(1)
        expect((await queue.getJobs())[0].attempts).toBe(1)
    })

    it('執行途中新排進來的工作不會被蓋掉', async() => {
        const client = makeClient()
        queue.registerKind('slow', {run: async() => {
            await queue.enqueue(client, dueSpec('newcomer'), {reason: 'all-failed'})
            return {ok: false, result: {reason: 'all-failed'}}
        }})
        await enqueueDue('slow')

        await queue.runQueue(client)
        expect((await queue.getJobs()).map((job) => job.id).sort()).toEqual(['newcomer:x', 'slow:x'])
    })
})
