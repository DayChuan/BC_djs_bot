import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as store from '@/core/pollStore'

//pollStore 的檔案路徑是「用到時才解析」的，所以這裡不需要重新載入模組，
//只要在每個案例前換掉環境變數並清掉快取就好。
//(早期版本用 vi.resetModules() + 動態 import，會把 discord.js 一起反覆重載，
// 在測試 jail 裡會卡死。)
let tmpDir = null

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-poll-'))
    process.env.POLL_DATA_DIR = tmpDir
    //快取是模組層級的，不清掉的話下一個案例會讀到上一個案例的資料
    store.resetCache()
})

afterEach(async () => {
    delete process.env.POLL_DATA_DIR
    store.resetCache()
    await fs.rm(tmpDir, {recursive: true, force: true})
})

const samplePoll = (overrides = {}) => ({
    type: 'standard',
    title: '本週副本時段',
    multi: true,
    identityGroup: 'maplestory',
    options: [
        {key: 'o0', label: '星期二'},
        {key: 'o1', label: '星期三'},
        {key: 'o2', label: '星期四'},
    ],
    votes: {},
    ...overrides,
})

describe('applyVote', () => {
    it('複選會整組覆蓋，而不是累加', () => {
        const poll = samplePoll()
        store.applyVote(poll, 'u1', {options: ['o0', 'o1']})
        store.applyVote(poll, 'u1', {options: ['o2']})
        expect(poll.votes.u1[0].options).toEqual(['o2'])
    })

    it('單選投票即使前端送多個也只留第一個', () => {
        const poll = samplePoll({multi: false})
        store.applyVote(poll, 'u1', {options: ['o0', 'o1']})
        expect(poll.votes.u1[0].options).toEqual(['o0'])
    })

    it('不存在的選項會被丟掉(不信任前端送來的 key)', () => {
        const poll = samplePoll()
        store.applyVote(poll, 'u1', {options: ['o0', 'not-exist']})
        expect(poll.votes.u1[0].options).toEqual(['o0'])
    })

    it('只送身分時不會動到已選的選項', () => {
        const poll = samplePoll()
        store.applyVote(poll, 'u1', {options: ['o0']})
        store.applyVote(poll, 'u1', {identity: 'paladin'})
        expect(poll.votes.u1).toEqual([{entryId: 'e0', options: ['o0'], identity: 'paladin'}])
    })

    it('選項清空且沒有身分 = 取消投票，整筆移除', () => {
        const poll = samplePoll()
        store.applyVote(poll, 'u1', {options: ['o0']})
        store.applyVote(poll, 'u1', {options: []})
        expect(poll.votes.u1).toBeUndefined()
    })
})

describe('tally', () => {
    it('分母是投票人數，複選時百分比不會爆掉', () => {
        const poll = samplePoll()
        store.applyVote(poll, 'u1', {options: ['o0', 'o1'], identity: 'paladin'})
        store.applyVote(poll, 'u2', {options: ['o0'], identity: 'shadower'})

        const result = store.tally(poll)
        expect(result.voterCount).toBe(2)
        expect(result.entryCount).toBe(2)
        expect(result.options[0]).toMatchObject({key: 'o0', count: 2, percent: 100})
        expect(result.options[1]).toMatchObject({key: 'o1', count: 1, percent: 50})
        expect(result.options[2]).toMatchObject({key: 'o2', count: 0, percent: 0})
    })

    it('統計各選項底下的身分分佈與整體身分人數', () => {
        const poll = samplePoll()
        store.applyVote(poll, 'u1', {options: ['o0'], identity: 'paladin'})
        store.applyVote(poll, 'u2', {options: ['o0'], identity: 'paladin'})
        store.applyVote(poll, 'u3', {options: ['o1'], identity: 'shadower'})

        const result = store.tally(poll)
        expect(result.options[0].identities).toEqual({paladin: 2})
        expect(result.identityTotals).toEqual({paladin: 2, shadower: 1})
    })

    it('沒有人投票時不會除以零', () => {
        const result = store.tally(samplePoll())
        expect(result.voterCount).toBe(0)
        expect(result.options.every((option) => option.percent === 0)).toBe(true)
    })
})

describe('檔案持久化', () => {
    it('建立後立刻落盤，重讀快取仍拿得到同一筆', async () => {
        const created = await store.createPoll(samplePoll())
        expect(created.id).toMatch(/^p_/)
        expect(created.status).toBe('open')

        store.resetCache()
        const reloaded = await store.getPoll(created.id)
        expect(reloaded.title).toBe('本週副本時段')
    })

    it('castVote 寫進檔案，模擬重啟後票還在', async () => {
        const created = await store.createPoll(samplePoll())
        await store.castVote(created.id, 'u1', {options: ['o0'], identity: 'paladin'})

        store.resetCache()
        const reloaded = await store.getPoll(created.id)
        expect(reloaded.votes.u1).toEqual([{entryId: 'e0', options: ['o0'], identity: 'paladin'}])
    })

    it('已結算的投票不再收票', async () => {
        const created = await store.createPoll(samplePoll())
        await store.updatePoll(created.id, (poll) => {
            poll.status = 'closed'
        })
        await store.castVote(created.id, 'u1', {options: ['o0']})

        const reloaded = await store.getPoll(created.id)
        expect(reloaded.votes.u1).toBeUndefined()
    })

    it('deletePoll 只刪該筆，其他進行中的投票留著', async () => {
        const a = await store.createPoll(samplePoll({title: 'A'}))
        const b = await store.createPoll(samplePoll({title: 'B'}))

        expect(await store.deletePoll(a.id)).toBe(true)
        store.resetCache()

        const polls = await store.readPolls()
        expect(Object.keys(polls)).toEqual([b.id])
    })

    it('listOpenPolls 只回進行中的', async () => {
        const a = await store.createPoll(samplePoll({title: 'A'}))
        await store.createPoll(samplePoll({title: 'B', status: 'closed'}))

        const open = await store.listOpenPolls()
        expect(open.map((poll) => poll.id)).toEqual([a.id])
    })

    it('併發投票不會互相覆寫', async () => {
        const created = await store.createPoll(samplePoll())

        //不 await、同時打進去，模擬多人同一瞬間點選單
        await Promise.all(
            Array.from({length: 50}, (_, i) =>
                store.castVote(created.id, `u${i}`, {options: ['o0']})
            )
        )

        store.resetCache()
        const reloaded = await store.getPoll(created.id)
        expect(Object.keys(reloaded.votes)).toHaveLength(50)
    })

    it('回傳的是獨立物件，外面改它不會影響檔案內容', async () => {
        const created = await store.createPoll(samplePoll())
        const first = await store.getPoll(created.id)
        first.title = '被改掉了'

        const second = await store.getPoll(created.id)
        expect(second.title).toBe('本週副本時段')
    })

    it('某一場的檔案壞掉時備份它，其他投票照常讀得到', async () => {
        const good = await store.createPoll(samplePoll({title: '正常的'}))
        const broken = await store.createPoll(samplePoll({title: '壞掉的'}))
        await fs.writeFile(path.join(store.pollsDir(), `${broken.id}.json`), '{ 這不是 JSON', 'utf8')

        const polls = await store.readPolls()
        //這就是一場一檔的好處：壞掉一場不會拖垮全部
        expect(Object.keys(polls)).toEqual([good.id])

        const files = await fs.readdir(store.pollsDir())
        expect(files.some((name) => name.includes('.broken-'))).toBe(true)
    })

    it('id 格式不合法時一律拒絕，避免被拿去組出任意路徑', async () => {
        expect(store.isValidPollId('p_abc123')).toBe(true)
        expect(store.isValidPollId('../../etc/passwd')).toBe(false)
        expect(store.isValidPollId('')).toBe(false)

        expect(await store.getPoll('../../etc/passwd')).toBeNull()
        expect(await store.deletePoll('../../etc/passwd')).toBe(false)
    })
})

describe('migrateLegacyStore', () => {
    it('把舊的單一 polls.json 拆成一場一檔，並保留原檔', async () => {
        const legacy = {
            polls: {
                p_old001: {id: 'p_old001', title: '舊投票 A', status: 'open', options: [], votes: {}},
                p_old002: {id: 'p_old002', title: '舊投票 B', status: 'pending', options: [], votes: {}},
            },
        }
        await fs.writeFile(path.join(tmpDir, 'polls.json'), JSON.stringify(legacy), 'utf8')

        expect(await store.migrateLegacyStore()).toBe(2)
        expect((await store.getPoll('p_old001')).title).toBe('舊投票 A')

        //原檔不刪只改名，拆錯了還救得回來
        const files = await fs.readdir(tmpDir)
        expect(files).toContain('polls.json.migrated')
        expect(files).not.toContain('polls.json')
    })

    it('沒有舊檔時回 0，不會拋錯', async () => {
        expect(await store.migrateLegacyStore()).toBe(0)
    })
})

describe('parseOptionsInput', () => {
    it('半形逗號分隔', () => {
        expect(store.parseOptionsInput('星期二,星期三,星期四')).toEqual([
            {key: 'o0', label: '星期二'},
            {key: 'o1', label: '星期三'},
            {key: 'o2', label: '星期四'},
        ])
    })

    it('全形逗號也吃得下(中文輸入法打出來的都是全形)', () => {
        expect(store.parseOptionsInput('紅，藍，綠')).toHaveLength(3)
    })

    it('去掉前後空白與空項目', () => {
        expect(store.parseOptionsInput(' 紅 , , 藍 ,')).toEqual([
            {key: 'o0', label: '紅'},
            {key: 'o1', label: '藍'},
        ])
    })

    it('重複的選項只留一個', () => {
        expect(store.parseOptionsInput('紅,藍,紅')).toHaveLength(2)
    })

    it('超過 25 個只留前 25 個', () => {
        const input = Array.from({length: 30}, (_, i) => `選項${i}`).join(',')
        expect(store.parseOptionsInput(input)).toHaveLength(store.MAX_OPTIONS)
    })

    it('空字串或未填回空陣列，不會爆掉', () => {
        expect(store.parseOptionsInput('')).toEqual([])
        expect(store.parseOptionsInput(null)).toEqual([])
    })

    it('只有逗號沒有內容時回空陣列', () => {
        //安排：使用者只打了逗號(常見的手殘輸入)
        const input = ',,,'

        //執行
        const result = store.parseOptionsInput(input)

        //斷言：不能生出三個空白選項，指令端才會擋下來要他重打
        expect(result).toEqual([])
    })
})

describe('listActivePolls', () => {
    it('open 與 pending 都要撈到(pending 是每週投票的下一輪)', async () => {
        const open = await store.createPoll(samplePoll({title: 'open'}))
        const pending = await store.createPoll(samplePoll({title: 'pending', status: 'pending'}))
        await store.createPoll(samplePoll({title: 'closed', status: 'closed'}))

        const active = await store.listActivePolls()
        expect(active.map((poll) => poll.id).sort()).toEqual([open.id, pending.id].sort())
    })
})

describe('makePollId', () => {
    it('長度夠短，塞得進 Discord 的 customId 上限', () => {
        expect(store.makePollId(1755400000000, 0.5).length).toBeLessThan(20)
    })

    it('同一毫秒內產生的 id 不會相同', () => {
        expect(store.makePollId(1755400000000, 0.1)).not.toBe(store.makePollId(1755400000000, 0.9))
    })
})

describe('一人多角色', () => {
    const poll = () => samplePoll({multiChar: true})

    it('normalizeEntries 把舊的一人一筆轉成陣列', () => {
        expect(store.normalizeEntries({options: ['o0'], identity: 'paladin'}))
            .toEqual([{entryId: 'e0', options: ['o0'], identity: 'paladin'}])
        expect(store.normalizeEntries(undefined)).toEqual([])
    })

    it('addEntry 依序給編號，不重用刪掉的編號', () => {
        const p = poll()
        expect(store.addEntry(p, 'u1')).toBe('e0')
        expect(store.addEntry(p, 'u1')).toBe('e1')

        store.removeEntry(p, 'u1', 'e0')
        //重用 e0 的話，還開著舊面板的人會改到不同的角色
        expect(store.addEntry(p, 'u1')).toBe('e2')
    })

    it('超過上限就不再新增', () => {
        const p = poll()
        for(let i = 0; i < store.MAX_ENTRIES_PER_USER; i += 1) store.addEntry(p, 'u1')
        expect(store.addEntry(p, 'u1')).toBeNull()
    })

    it('各角色的選擇互不影響', () => {
        const p = poll()
        store.applyVote(p, 'u1', {options: ['o0'], identity: 'paladin'}, 'e0')
        store.applyVote(p, 'u1', {options: ['o1'], identity: 'arch-mage'}, 'e1')

        expect(p.votes.u1).toEqual([
            {entryId: 'e0', options: ['o0'], identity: 'paladin'},
            {entryId: 'e1', options: ['o1'], identity: 'arch-mage'},
        ])
    })

    it('刪掉最後一個角色時整個人從名單移除', () => {
        const p = poll()
        store.applyVote(p, 'u1', {options: ['o0']}, 'e0')
        expect(store.removeEntry(p, 'u1', 'e0')).toBe(true)
        expect(p.votes.u1).toBeUndefined()
    })

    it('刪除不存在的角色回 false', () => {
        const p = poll()
        expect(store.removeEntry(p, 'u1', 'e9')).toBe(false)
    })

    it('tally 以角色為票數單位，另外給人數', () => {
        const p = poll()
        store.applyVote(p, 'u1', {options: ['o0'], identity: 'paladin'}, 'e0')
        store.applyVote(p, 'u1', {options: ['o0'], identity: 'arch-mage'}, 'e1')
        store.applyVote(p, 'u2', {options: ['o1'], identity: 'paladin'}, 'e0')

        const result = store.tally(p)
        expect(result.voterCount).toBe(2)      //兩個人
        expect(result.entryCount).toBe(3)      //三隻角色
        expect(result.options[0]).toMatchObject({key: 'o0', count: 2, userCount: 1})
        expect(result.identityTotals).toEqual({paladin: 2, 'arch-mage': 1})
    })

    it('百分比以角色數為分母', () => {
        const p = poll()
        store.applyVote(p, 'u1', {options: ['o0']}, 'e0')
        store.applyVote(p, 'u1', {options: ['o1']}, 'e1')

        const result = store.tally(p)
        expect(result.options[0].percent).toBe(50)
        expect(result.options[1].percent).toBe(50)
    })
})

describe('編輯某個角色不會動到其他角色', () => {
    it('剛新增、還沒選東西的角色不會被順手清掉', () => {
        //這是實際踩到的 bug：按了新增角色之後回頭改前一個角色，
        //那筆空的就消失了，切換選單跟著不見，看起來像不能修改其他角色
        const poll = samplePoll({multiChar: true})
        store.applyVote(poll, 'u1', {options: ['o0']}, 'e0')
        store.addEntry(poll, 'u1')

        store.applyVote(poll, 'u1', {options: ['o1']}, 'e0')

        expect(poll.votes.u1).toHaveLength(2)
        expect(poll.votes.u1[1]).toEqual({entryId: 'e1', options: [], identity: null})
    })

    it('清空其中一隻的選項，其他隻原封不動', () => {
        const poll = samplePoll({multiChar: true})
        store.applyVote(poll, 'u1', {options: ['o0']}, 'e0')
        store.applyVote(poll, 'u1', {options: ['o1']}, 'e1')

        store.applyVote(poll, 'u1', {options: []}, 'e1')

        expect(poll.votes.u1[0]).toEqual({entryId: 'e0', options: ['o0'], identity: null})
        expect(poll.votes.u1[1]).toEqual({entryId: 'e1', options: [], identity: null})
    })

    it('只有一筆而且清空時，仍然視為取消投票', () => {
        const poll = samplePoll()
        store.applyVote(poll, 'u1', {options: ['o0']}, 'e0')
        store.applyVote(poll, 'u1', {options: []}, 'e0')
        expect(poll.votes.u1).toBeUndefined()
    })

    it('空的角色不會被算進統計', () => {
        const poll = samplePoll({multiChar: true})
        store.applyVote(poll, 'u1', {options: ['o0']}, 'e0')
        store.addEntry(poll, 'u1')

        const result = store.tally(poll)
        expect(result.entryCount).toBe(1)
        expect(result.voterCount).toBe(1)
    })
})

describe('快速投票的資料形狀', () => {
    const quick = () => ({
        type: 'quick',
        title: '要打哪隻王',
        multi: false,
        multiChar: false,
        identityGroup: null,
        options: [
            {key: 'o0', label: '紅'},
            {key: 'o1', label: '藍'},
        ],
        votes: {},
    })

    it('單選：換一個顏色就是換票，不會累加', () => {
        const poll = quick()
        store.applyVote(poll, 'u1', {options: ['o0']}, 'e0')
        store.applyVote(poll, 'u1', {options: ['o1']}, 'e0')

        expect(poll.votes.u1).toEqual([{entryId: 'e0', options: ['o1'], identity: null}])
    })

    it('清空選項就是取消投票，分母跟著少一', () => {
        const poll = quick()
        store.applyVote(poll, 'u1', {options: ['o0']}, 'e0')
        store.applyVote(poll, 'u2', {options: ['o1']}, 'e0')
        store.applyVote(poll, 'u1', {options: []}, 'e0')

        const result = store.tally(poll)
        expect(result.voterCount).toBe(1)
        expect(result.options[1].percent).toBe(100)
    })

    it('百分比以投票人數為分母', () => {
        const poll = quick()
        store.applyVote(poll, 'u1', {options: ['o0']}, 'e0')
        store.applyVote(poll, 'u2', {options: ['o0']}, 'e0')
        store.applyVote(poll, 'u3', {options: ['o1']}, 'e0')

        const result = store.tally(poll)
        expect(result.options[0]).toMatchObject({count: 2, percent: 66.7})
        expect(result.options[1]).toMatchObject({count: 1, percent: 33.3})
    })
})
