import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as store from '@/core/pollStore'
import * as archive from '@/core/pollArchive'

//把 logger 換成假的。真正的 logger 會開檔與串流，在測試 jail 裡會讓 vitest
//卡住跑不完 —— 症狀跟 fileParallelism 那個坑一樣：沒有錯誤訊息，就是不結束。
vi.mock('@/core/logger', () => ({
    default: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}))

let tmpDir = null

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-arc-'))
    process.env.POLL_DATA_DIR = tmpDir
    store.resetCache()
})

afterEach(async () => {
    delete process.env.POLL_DATA_DIR
    store.resetCache()
    await fs.rm(tmpDir, {recursive: true, force: true})
})

const samplePoll = (overrides = {}) => ({
    type: 'standard',
    channelId: 'c1',
    title: '本週副本時段',
    multi: true,
    identityGroup: null,
    status: 'closed',
    closeAt: '2026-08-18T06:00:00.000Z',
    weekly: null,
    options: [
        {key: 'o0', label: '星期二'},
        {key: 'o1', label: '星期三'},
    ],
    votes: {
        u1: {options: ['o0'], identity: null},
        u2: {options: ['o0'], identity: null},
    },
    ...overrides,
})

const DAY_MS = 24 * 60 * 60 * 1000

describe('monthOf', () => {
    it('從 ISO 時間取出年月當資料夾名', () => {
        expect(archive.monthOf('2026-08-18T06:00:00.000Z')).toBe('2026-08')
    })
})

describe('archivePoll', () => {
    it('搬進 archive/年月/，原本的進行中檔案消失', async () => {
        const poll = await store.createPoll(samplePoll())
        await archive.archivePoll(poll)

        expect(await store.getPoll(poll.id)).toBeNull()

        const file = path.join(tmpDir, 'archive', '2026-08', `${poll.id}.json`)
        const saved = JSON.parse(await fs.readFile(file, 'utf8'))
        expect(saved.title).toBe('本週副本時段')
    })

    it('附上結果快照，日後統計程式改了也不會影響已公布的數字', async () => {
        const poll = await store.createPoll(samplePoll())
        const record = await archive.archivePoll(poll)

        expect(record.result.voterCount).toBe(2)
        expect(record.result.options[0]).toMatchObject({key: 'o0', count: 2, percent: 100})
        expect(record.archivedAt).toBeTruthy()
        expect(record.status).toBe('closed')
    })

    it('按年月分資料夾，不同月份不會混在一起', async () => {
        const july = await store.createPoll(samplePoll({closeAt: '2026-07-01T00:00:00.000Z'}))
        const august = await store.createPoll(samplePoll({closeAt: '2026-08-01T00:00:00.000Z'}))

        await archive.archivePoll(july)
        await archive.archivePoll(august)

        const months = await fs.readdir(path.join(tmpDir, 'archive'))
        expect(months.sort()).toEqual(['2026-07', '2026-08'])
    })
})

describe('getArchived', () => {
    it('跨月份也找得到', async () => {
        const poll = await store.createPoll(samplePoll({closeAt: '2026-06-15T00:00:00.000Z'}))
        await archive.archivePoll(poll)

        const found = await archive.getArchived(poll.id)
        expect(found.title).toBe('本週副本時段')
    })

    it('查不到回 null，id 不合法也回 null', async () => {
        expect(await archive.getArchived('p_nothere')).toBeNull()
        expect(await archive.getArchived('../../etc/passwd')).toBeNull()
    })
})

describe('listArchived', () => {
    it('由新到舊排列', async () => {
        for(const closeAt of ['2026-06-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z']){
            await archive.archivePoll(await store.createPoll(samplePoll({closeAt})))
        }

        const list = await archive.listArchived()
        expect(list.map((record) => record.closeAt.slice(0, 7))).toEqual(['2026-08', '2026-07', '2026-06'])
    })

    it('limit 生效', async () => {
        for(const closeAt of ['2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z']){
            await archive.archivePoll(await store.createPoll(samplePoll({closeAt})))
        }

        expect(await archive.listArchived({limit: 1})).toHaveLength(1)
    })

    it('keyword 比對標題', async () => {
        await archive.archivePoll(await store.createPoll(samplePoll({title: '楓之谷副本'})))
        await archive.archivePoll(await store.createPoll(samplePoll({title: 'TRPG 開團'})))

        const list = await archive.listArchived({keyword: 'trpg'})
        expect(list).toHaveLength(1)
        expect(list[0].title).toBe('TRPG 開團')
    })

    it('還沒有任何歷史時回空陣列，不會拋錯', async () => {
        expect(await archive.listArchived()).toEqual([])
    })
})

describe('purgeExpired', () => {
    const now = new Date('2026-08-18T00:00:00.000Z').getTime()

    it('刪掉超過保留期限的，保留期限內的留著', async () => {
        const old = await store.createPoll(samplePoll({
            closeAt: new Date(now - 100 * DAY_MS).toISOString(),
        }))
        const fresh = await store.createPoll(samplePoll({
            closeAt: new Date(now - 10 * DAY_MS).toISOString(),
        }))
        await archive.archivePoll(old)
        await archive.archivePoll(fresh)

        expect(await archive.purgeExpired(90, now)).toBe(1)
        expect(await archive.getArchived(old.id)).toBeNull()
        expect(await archive.getArchived(fresh.id)).toBeTruthy()
    })

    it('剛好在邊界上的留著(未超過就是未超過)', async () => {
        const poll = await store.createPoll(samplePoll({
            closeAt: new Date(now - 90 * DAY_MS).toISOString(),
        }))
        await archive.archivePoll(poll)

        expect(await archive.purgeExpired(90, now)).toBe(0)
    })

    it('清空的年月資料夾會一併移除', async () => {
        const poll = await store.createPoll(samplePoll({
            closeAt: new Date(now - 200 * DAY_MS).toISOString(),
        }))
        await archive.archivePoll(poll)
        await archive.purgeExpired(90, now)

        expect(await fs.readdir(path.join(tmpDir, 'archive'))).toEqual([])
    })

    it('時間讀不出來的不刪，寧可佔空間也不要誤刪', async () => {
        const poll = await store.createPoll(samplePoll({closeAt: null}))
        const record = await archive.archivePoll(poll)
        //把兩個時間都拿掉，模擬損壞或人為編輯過的紀錄
        const month = archive.monthOf(record.archivedAt)
        const file = path.join(tmpDir, 'archive', month, `${poll.id}.json`)
        await fs.writeFile(file, JSON.stringify({...record, closeAt: null, archivedAt: null}), 'utf8')

        expect(await archive.purgeExpired(1, now)).toBe(0)
    })

    it('沒有 archive 資料夾時回 0，不會拋錯', async () => {
        expect(await archive.purgeExpired(90, now)).toBe(0)
    })
})
