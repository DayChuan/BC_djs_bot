import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as store from '@/core/pollStore'

//把 logger 換成假的。真正的 logger 會開檔與串流，在測試 jail 裡會讓 vitest
//卡住跑不完(同 pollStore.test.js)。
vi.mock('@/core/logger', () => ({
    default: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}))

//U12-A：截止前提醒。
//這裡只測純函式與檔案欄位 —— 抓訊息、讀 ❎ 的使用者清單、掛排程都要碰
//discord.js，測試檔不能 import 它，那幾段一律在測試伺服器實機驗收。

let tmpDir = null

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-rmd-'))
    process.env.POLL_DATA_DIR = tmpDir
    store.resetCache()
})

afterEach(async () => {
    delete process.env.POLL_DATA_DIR
    store.resetCache()
    await fs.rm(tmpDir, {recursive: true, force: true})
})

//u1~u10 十個人
const members = Array.from({length: 10}, (_, i) => `u${i + 1}`)

const pollWith = (votes = {}) => ({
    id: 'p_test',
    title: '本週副本時段',
    status: 'open',
    options: [{key: 'o0', label: '星期二'}],
    votes,
})

//「投了票」的最小形狀：至少選了一個選項
const voted = (userIds) => Object.fromEntries(
    userIds.map((id) => [id, [{entryId: 'e0', options: ['o0'], identity: null}]])
)

describe('votedUserIds', () => {
    it('只算「至少選了一個選項」的人', () => {
        expect([...store.votedUserIds(pollWith(voted(['u1', 'u2'])))]).toEqual(['u1', 'u2'])
    })

    it('按了新增角色卻什麼都沒選的空白登記不算投過票', () => {
        //tally() 也是這樣算的，兩邊不一致就會出現
        //「報表上沒有他、卻也不提醒他」的黑洞
        const poll = pollWith({u1: [{entryId: 'e0', options: [], identity: null}]})
        expect([...store.votedUserIds(poll)]).toEqual([])
    })

    it('一人多角色只要有一隻投了就算他投過', () => {
        const poll = pollWith({
            u1: [
                {entryId: 'e0', options: [], identity: null},
                {entryId: 'e1', options: ['o0'], identity: null},
            ],
        })
        expect([...store.votedUserIds(poll)]).toEqual(['u1'])
    })

    it('舊格式(一人一個物件)也讀得出來', () => {
        expect([...store.votedUserIds(pollWith({u1: {options: ['o0'], identity: null}}))]).toEqual(['u1'])
    })

    it('沒有 votes 欄位不會拋錯', () => {
        expect([...store.votedUserIds({})]).toEqual([])
        expect([...store.votedUserIds(null)]).toEqual([])
    })
})

describe('pendingReminders', () => {
    it('驗收 1：身分組 10 人、投了 3 人、按 ❎ 2 人 → 待提醒 5 人', () => {
        const list = store.pendingReminders({
            memberIds: members,
            poll: pollWith(voted(['u1', 'u2', 'u3'])),
            optedOutIds: ['u4', 'u5'],
        })

        expect(list).toEqual(['u6', 'u7', 'u8', 'u9', 'u10'])
    })

    it('驗收 2：全部投完 → 待提醒 0 人（呼叫端據此完全不發訊息）', () => {
        const list = store.pendingReminders({
            memberIds: members,
            poll: pollWith(voted(members)),
        })

        expect(list).toEqual([])
    })

    it('驗收 3：bot 自己按的 ❎ 不算在扣除名單裡，也不會被提醒', () => {
        //發布時 bot 會自己先按一顆，那顆的使用者清單裡就有 bot 自己
        const list = store.pendingReminders({
            memberIds: [...members, 'bot1'],
            poll: pollWith(voted(['u1'])),
            optedOutIds: ['bot1'],
            botIds: ['bot1'],
        })

        expect(list).not.toContain('bot1')
        //真人一個都沒有少：bot 那顆 ❎ 不會把別人也扣掉
        expect(list).toEqual(['u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10'])
    })

    it('驗收 4：同一人既投票又按 ❎ → 只扣一次，不會變成負數或重複', () => {
        const list = store.pendingReminders({
            memberIds: members,
            poll: pollWith(voted(['u1', 'u2'])),
            optedOutIds: ['u1', 'u2'],
        })

        expect(list).toHaveLength(8)
        expect(list).toEqual(['u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10'])
    })

    it('維持 memberIds 原本的順序，訊息裡的排列不會每次都跳動', () => {
        const list = store.pendingReminders({memberIds: ['u3', 'u1', 'u2'], poll: pollWith()})
        expect(list).toEqual(['u3', 'u1', 'u2'])
    })

    it('名單裡重複的成員只會出現一次', () => {
        const list = store.pendingReminders({memberIds: ['u1', 'u1', 'u2'], poll: pollWith()})
        expect(list).toEqual(['u1', 'u2'])
    })

    it('身分組沒有成員(沒設定對照表)時回空陣列，不拋錯', () => {
        expect(store.pendingReminders({poll: pollWith()})).toEqual([])
        expect(store.pendingReminders()).toEqual([])
    })

    it('id 的型別不一致(數字 vs 字串)也比對得起來', () => {
        //Discord 的 id 一律是字串，但寫死在設定或測試資料裡時很容易變成數字
        const list = store.pendingReminders({memberIds: [1, 2], optedOutIds: [1], poll: pollWith()})
        expect(list).toEqual(['2'])
    })
})

describe('hasReminded / markReminded', () => {
    it('驗收 5：reminded 欄位不存在的舊紀錄 → 當成兩次都沒發過', () => {
        const poll = pollWith()
        expect(store.hasReminded(poll, 12)).toBe(false)
        expect(store.hasReminded(poll, 3)).toBe(false)
        expect(store.hasReminded(null, 12)).toBe(false)
    })

    it('驗收 6：發過的時間點會留在檔案裡，重啟後讀得到(排程據此不重掛)', async () => {
        //重掛排程那一段在 pollService.scheduleReminders()，它要碰 discord.js，
        //只能實機驗收(驗收 11)。這裡守住它依賴的那個判斷。
        const poll = await store.createPoll(pollWith())

        await store.markReminded(poll.id, 12)
        const saved = await store.getPoll(poll.id)

        expect(store.hasReminded(saved, 12)).toBe(true)
        //另一個時間點不受影響，不會兩次一起被吃掉
        expect(store.hasReminded(saved, 3)).toBe(false)
    })

    it('兩個時間點各自獨立記錄', async () => {
        const poll = await store.createPoll(pollWith())

        await store.markReminded(poll.id, 12)
        await store.markReminded(poll.id, 3)
        const saved = await store.getPoll(poll.id)

        expect(saved.reminded).toEqual({h12: true, h3: true})
    })

    it('已經結算的投票不寫 reminded(那筆檔案馬上要被搬走)', async () => {
        const poll = await store.createPoll(pollWith())
        await store.updatePoll(poll.id, (record) => {
            record.status = 'closed'
        })

        await store.markReminded(poll.id, 12)
        expect((await store.getPoll(poll.id)).reminded).toBeUndefined()
    })
})
