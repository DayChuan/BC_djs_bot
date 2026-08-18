import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as store from '@/core/pollStore'
import * as service from '@/core/pollService'
import * as drafts from '@/core/pollDraft'
import scheduler from '@/core/scheduler'

//個人投票面板的行為。草稿模型是重點：
//選選項只寫記憶體、按「投票」才寫檔。
let tmpDir = null

const makeClient = () => {
    const message = {id: 'msg-1', edit: vi.fn(async () => undefined)}
    const channel = {
        isTextBased: () => true,
        send: vi.fn(async () => message),
        messages: {fetch: vi.fn(async () => message)},
    }
    return {client: {channels: {fetch: vi.fn(async () => channel)}}, channel}
}

const draft = (overrides = {}) => ({
    type: 'standard',
    guildId: 'g1',
    channelId: 'c1',
    title: '本週副本時段',
    description: '',
    options: [
        {key: 'o0', label: '星期二'},
        {key: 'o1', label: '星期三'},
    ],
    multi: true,
    multiChar: false,
    identityGroup: null,
    weekly: null,
    createdBy: 'u0',
    openAt: null,
    closeAt: new Date(Date.now() + 3600000).toISOString(),
    votes: {},
    ...overrides,
})

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-panel-'))
    process.env.POLL_DATA_DIR = tmpDir
    store.resetCache()
    drafts.resetDrafts()
})

afterEach(async () => {
    scheduler.cancelAll()
    delete process.env.POLL_DATA_DIR
    store.resetCache()
    drafts.resetDrafts()
    await fs.rm(tmpDir, {recursive: true, force: true})
})

const interaction = (userId, values = []) => ({user: {id: userId}, values})

const act = (userId, values, kind, pollId, entryId = null) =>
    service.handlePollAction(interaction(userId, values), {kind, pollId, entryId})

const buttonsOf = (panel) => panel.components[panel.components.length - 1].components

describe('草稿模型', () => {
    it('選選項只寫草稿，不寫檔、也不重繪畫面', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft())

        //回 null 就是「畫面不用動」，省下一次 Discord 往返
        expect(await act('u1', ['o0'], 'opt', poll.id, 'e0')).toBeNull()

        const saved = await store.getPoll(poll.id)
        expect(saved.votes.u1).toBeUndefined()
        expect(drafts.hasDraft(poll.id, 'u1')).toBe(true)
    })

    it('按投票才真的寫進檔案', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft())

        await act('u1', ['o0'], 'opt', poll.id, 'e0')
        const panel = await act('u1', [], 'save', poll.id, 'e0')

        const saved = await store.getPoll(poll.id)
        expect(saved.votes.u1).toEqual([{entryId: 'e0', options: ['o0'], identity: null}])
        expect(panel.embeds[0].data.description).toContain('已送出')
    })

    it('送出後草稿清掉，按鈕文字變成修改', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft())

        await act('u1', ['o0'], 'opt', poll.id, 'e0')
        await act('u1', [], 'save', poll.id, 'e0')
        expect(drafts.hasDraft(poll.id, 'u1')).toBe(false)

        const panel = await act('u1', [], 'open', poll.id)
        expect(buttonsOf(panel)[0].data.label).toBe('修改')
    })

    it('沒有變更時按投票不會亂寫東西', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft())

        const panel = await act('u1', [], 'save', poll.id, 'e0')
        expect(panel.embeds[0].data.description).toContain('沒有需要送出的變更')
        expect((await store.getPoll(poll.id)).votes.u1).toBeUndefined()
    })

    it('身分與選項合起來算一筆草稿，一次送出', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft({identityGroup: 'maplestory'}))

        await act('u1', ['o0'], 'opt', poll.id, 'e0')
        await act('u1', ['paladin'], 'idt', poll.id, 'e0')
        await act('u1', [], 'save', poll.id, 'e0')

        const saved = await store.getPoll(poll.id)
        expect(saved.votes.u1).toEqual([{entryId: 'e0', options: ['o0'], identity: 'paladin'}])
    })

    it('從公開訊息來的操作要回面板（那邊沒有面板可以就地更新）', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft())

        const panel = await service.handlePollAction(
            interaction('u1', ['o0']),
            {kind: 'opt', pollId: poll.id, entryId: null},
            {fromPanel: false},
        )
        expect(panel).not.toBeNull()
        expect(panel.components).toBeTruthy()
    })
})

describe('一次投票就是一隻角色', () => {
    it('有未送出的變更時擋住新增角色', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft({multiChar: true}))

        await act('u1', ['o0'], 'opt', poll.id, 'e0')
        const panel = await act('u1', [], 'add', poll.id)

        expect(panel.embeds[0].data.description).toContain('請先按')
        expect((await store.getPoll(poll.id)).votes.u1).toBeUndefined()
    })

    it('有未送出的變更時擋住切換角色', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft({multiChar: true}))

        await act('u1', ['o0'], 'opt', poll.id, 'e0')
        await act('u1', [], 'save', poll.id, 'e0')
        await act('u1', [], 'add', poll.id)
        await act('u1', ['o1'], 'opt', poll.id, 'e1')

        const panel = await act('u1', ['e0'], 'sel', poll.id)
        expect(panel.embeds[0].data.description).toContain('請先按')
    })

    it('兩隻角色各自投一次，資料互不干擾', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft({
            multiChar: true,
            identityGroup: 'maplestory',
        }))

        await act('u1', ['o0'], 'opt', poll.id, 'e0')
        await act('u1', ['paladin'], 'idt', poll.id, 'e0')
        await act('u1', [], 'save', poll.id, 'e0')

        await act('u1', [], 'add', poll.id)
        await act('u1', ['o1'], 'opt', poll.id, 'e1')
        await act('u1', ['arch-mage'], 'idt', poll.id, 'e1')
        await act('u1', [], 'save', poll.id, 'e1')

        const saved = await store.getPoll(poll.id)
        expect(saved.votes.u1).toEqual([
            {entryId: 'e0', options: ['o0'], identity: 'paladin'},
            {entryId: 'e1', options: ['o1'], identity: 'arch-mage'},
        ])
    })

    it('送出後可以切換回前一隻角色', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft({multiChar: true}))

        await act('u1', ['o0'], 'opt', poll.id, 'e0')
        await act('u1', [], 'save', poll.id, 'e0')
        await act('u1', [], 'add', poll.id)
        await act('u1', ['o1'], 'opt', poll.id, 'e1')
        await act('u1', [], 'save', poll.id, 'e1')

        const panel = await act('u1', ['e0'], 'sel', poll.id)
        expect(panel.components[0].components[0].data.custom_id).toContain(':e0')
    })
})

describe('刪除', () => {
    it('立即生效，並丟掉未送出的草稿', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft())

        await act('u1', ['o0'], 'opt', poll.id, 'e0')
        await act('u1', [], 'save', poll.id, 'e0')
        await act('u1', ['o1'], 'opt', poll.id, 'e0')

        await act('u1', [], 'del', poll.id, 'e0')

        expect((await store.getPoll(poll.id)).votes.u1).toBeUndefined()
        expect(drafts.hasDraft(poll.id, 'u1')).toBe(false)
    })

    it('多隻角色時只刪指定的那一隻', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft({multiChar: true}))

        await act('u1', ['o0'], 'opt', poll.id, 'e0')
        await act('u1', [], 'save', poll.id, 'e0')
        await act('u1', [], 'add', poll.id)
        await act('u1', ['o1'], 'opt', poll.id, 'e1')
        await act('u1', [], 'save', poll.id, 'e1')

        await act('u1', [], 'del', poll.id, 'e0')

        const saved = await store.getPoll(poll.id)
        expect(saved.votes.u1).toEqual([{entryId: 'e1', options: ['o1'], identity: null}])
    })
})

describe('邊界', () => {
    it('沒帶角色編號時操作第一筆（相容改版前發出的舊訊息）', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft())

        await act('u1', ['o0'], 'opt', poll.id, null)
        await act('u1', [], 'save', poll.id, null)

        expect((await store.getPoll(poll.id)).votes.u1[0].entryId).toBe('e0')
    })

    it('投票已被清除時給明確訊息，不是丟例外', async () => {
        const reply = await act('u1', ['o0'], 'opt', 'p_nope')
        expect(reply.content).toContain('已經結束並清除')
    })

    it('已截止但尚未歸檔時擋下來', async () => {
        const {client} = makeClient()
        const poll = await service.createAndPublish(client, draft())
        await store.updatePoll(poll.id, (record) => {
            record.status = 'closed'
        })

        const reply = await act('u1', ['o0'], 'opt', poll.id)
        expect(reply.content).toContain('已經截止')
    })
})

describe('草稿本身', () => {
    it('超過保留時間的草稿會被丟掉', () => {
        const now = Date.now()
        drafts.setDraft('p_a', 'u1', {entryId: 'e0', options: ['o0'], identity: null}, now)

        expect(drafts.getDraft('p_a', 'u1', now + 1000)).toBeTruthy()
        expect(drafts.getDraft('p_a', 'u1', now + drafts.DRAFT_TTL_MS + 1)).toBeNull()
        expect(drafts.draftCount()).toBe(0)
    })

    it('不同投票、不同人的草稿互不影響', () => {
        drafts.setDraft('p_a', 'u1', {entryId: 'e0', options: ['o0'], identity: null})
        drafts.setDraft('p_a', 'u2', {entryId: 'e0', options: ['o1'], identity: null})
        drafts.setDraft('p_b', 'u1', {entryId: 'e0', options: ['o2'], identity: null})

        expect(drafts.getDraft('p_a', 'u1').options).toEqual(['o0'])
        expect(drafts.getDraft('p_a', 'u2').options).toEqual(['o1'])
        expect(drafts.getDraft('p_b', 'u1').options).toEqual(['o2'])
    })
})

describe('模組載入', () => {
    //2026-08-18 的實際事故：export default 擺在函式宣告之前，
    //模組載入時 const 還在 TDZ，直接 ReferenceError，
    //而且是在 loader 載入指令與事件的當下爆掉 —— 整組斜線指令都註冊不上。
    it('pollService 的 default export 每個成員在載入時都取得到', () => {
        for(const [name, value] of Object.entries(service.default)){
            expect(typeof value, name).toBe('function')
        }
    })
})
