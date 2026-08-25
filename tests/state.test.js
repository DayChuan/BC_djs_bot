import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as state from '@/core/state'

//把 logger 換成假的。真正的 logger 會開檔與串流，在測試 jail 裡會讓 vitest
//卡住跑不完 —— 症狀跟 fileParallelism 那個坑一樣：沒有錯誤訊息，就是不結束。
vi.mock('@/core/logger', () => ({
    default: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}))

//state.js 的檔案路徑是「用到時才解析」的，所以這裡不需要重新載入模組，
//只要在每個案例前換掉環境變數並清掉模組層級的狀態就好。
//(用 vi.resetModules() + 動態 import 會把整串相依模組反覆重載，在測試 jail 裡會卡死。)
let tmpDir = null

beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-state-'))
    process.env.STATE_DATA_DIR = tmpDir
    state.resetQueue()
    state.clearRestores()
})

afterEach(async () => {
    delete process.env.STATE_DATA_DIR
    state.resetQueue()
    state.clearRestores()
    await fs.rm(tmpDir, {recursive: true, force: true})
})

const stateFile = () => path.join(tmpDir, 'state.json')

const listBackups = async () =>
    (await fs.readdir(tmpDir)).filter((name) => name.includes('.broken-'))

describe('讀寫', () => {
    it('寫入後讀得回來', async () => {
        await state.setState('vmute', {'123': 1700000000000})

        expect(await state.getState('vmute')).toEqual({'123': 1700000000000})
    })

    it('讀不存在的 section 回空物件', async () => {
        //檔案根本還沒建立
        expect(await state.getState('japanese')).toEqual({})

        //檔案在、但沒有這一段
        await state.setState('vmute', {a: 1})
        expect(await state.getState('japanese')).toEqual({})
    })

    it('回傳的是副本，改它不會影響檔案', async () => {
        await state.setState('vmute', {a: 1})

        const first = await state.getState('vmute')
        first.a = 999

        expect(await state.getState('vmute')).toEqual({a: 1})
    })

    it('updateState 的 mutator 回傳 undefined 時視為就地改動', async () => {
        await state.setState('japanese', {sent: ['a']})
        await state.updateState('japanese', (current) => {
            current.sent.push('b')
        })

        expect(await state.getState('japanese')).toEqual({sent: ['a', 'b']})
    })
})

describe('併發', () => {
    //這一條是佇列存在的理由：少了它，十個「讀→改→寫」會讀到同一個舊值，
    //最後只留下一次遞增。
    it('同一 section 併發 10 次遞增，結果為 10', async () => {
        await state.setState('counter', {n: 0})

        await Promise.all(
            Array.from({length: 10}, () =>
                state.updateState('counter', (current) => ({n: current.n + 1})),
            ),
        )

        expect(await state.getState('counter')).toEqual({n: 10})
    })

    //所有 section 住在同一個檔案裡、每次寫入都要重寫整份，
    //所以「不同 section 互不影響」靠的是同一條佇列，不是分開的佇列。
    it('不同 section 併發寫入互不影響', async () => {
        await Promise.all([
            state.setState('vmute', {a: 1}),
            state.setState('japanese', {b: 2}),
            state.updateState('counter', () => ({n: 3})),
        ])

        expect(await state.getState('vmute')).toEqual({a: 1})
        expect(await state.getState('japanese')).toEqual({b: 2})
        expect(await state.getState('counter')).toEqual({n: 3})
    })

    it('其中一次寫入失敗不會讓後續的操作跟著失敗', async () => {
        await state.setState('counter', {n: 0})

        const failed = state.updateState('counter', () => {
            throw new Error('mutator 爆了')
        })
        await expect(failed).rejects.toThrow('mutator 爆了')

        //佇列本身吞掉了錯誤，所以後面這一次仍然跑得完
        await state.updateState('counter', (current) => ({n: current.n + 1}))
        expect(await state.getState('counter')).toEqual({n: 1})
    })
})

describe('壞檔處理', () => {
    it('內容壞掉時回空物件並留下備份，不靜默覆蓋', async () => {
        const broken = '{"vmute": {'
        await fs.writeFile(stateFile(), broken, 'utf8')

        expect(await state.getState('vmute')).toEqual({})

        const backups = await listBackups()
        expect(backups).toHaveLength(1)
        //備份必須是原封不動的那份，否則「保留現場」只是空話
        expect(await fs.readFile(path.join(tmpDir, backups[0]), 'utf8')).toBe(broken)
    })

    it('壞檔備份之後仍然可以繼續寫入', async () => {
        await fs.writeFile(stateFile(), 'not json at all', 'utf8')

        await state.setState('vmute', {a: 1})

        expect(await state.getState('vmute')).toEqual({a: 1})
        expect(await listBackups()).toHaveLength(1)
    })
})

describe('開機還原的登記表', () => {
    it('登記的項目都會被跑到，並收到傳入的參數', async () => {
        const calls = []
        state.registerRestore('vmute', (client) => calls.push(['vmute', client]))
        state.registerRestore('japanese', (client) => calls.push(['japanese', client]))

        await state.runRestores('client')

        expect(state.restoreNames()).toEqual(['vmute', 'japanese'])
        expect(calls).toEqual([['vmute', 'client'], ['japanese', 'client']])
    })

    //一個功能還原失敗不該連累其他功能，也不該把例外丟回 ready 事件。
    it('單項拋例外時其餘項目照跑，且不往外拋', async () => {
        const done = []
        state.registerRestore('壞掉的', () => {
            throw new Error('還原失敗')
        })
        state.registerRestore('好的', () => done.push('好的'))

        await expect(state.runRestores()).resolves.toBeUndefined()
        expect(done).toEqual(['好的'])
    })

    it('不是函式就當場拒絕，不要等到開機才爆', () => {
        expect(() => state.registerRestore('壞的', 'not a function')).toThrow(TypeError)
    })
})
