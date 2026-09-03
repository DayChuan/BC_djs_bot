import {describe, it, expect, beforeEach, afterAll} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRosterStore} from '@/core/roster'
import {rosterKey} from '@/config/lineup'

/**
 * 人員表的讀寫。
 *
 * 一律用 createRosterStore(暫存檔) 而不是模組層的單例 ——
 * 單例綁的是專案真正的 data/roster.json，測試寫進去會把實際的等級資料洗掉。
 */

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-test-'))
let seq = 0

//每個案例一個全新的檔案路徑，彼此不互相汙染(store 內部有 cache)
const newStore = (content = null) => {
    seq += 1
    const file = path.join(TMP_ROOT, `roster-${seq}.json`)
    if(content !== null) fs.writeFileSync(file, content, 'utf8')
    return createRosterStore(file)
}

const readFile = (store) => JSON.parse(fs.readFileSync(store.filePath, 'utf8'))

afterAll(() => {
    fs.rmSync(TMP_ROOT, {recursive: true, force: true})
})

describe('key 是 Discord ID ＋ 職業', () => {
    it('同一個人的兩隻角色是兩筆，互不覆蓋', () => {
        const store = newStore()
        store.set('u1', 'shadower', 168, 'DayChuan')
        store.set('u1', 'cannon', 150, '短拳')

        expect(store.get('u1', 'shadower').level).toBe(168)
        expect(store.get('u1', 'cannon').level).toBe(150)
        expect(Object.keys(store.getMembers())).toEqual([
            rosterKey('u1', 'shadower'),
            rosterKey('u1', 'cannon'),
        ])
    })

    it('同一隻角色由多人共用時，每個人各存一筆，誰投票都查得到', () => {
        const store = newStore()
        for(const id of ['u1', 'u2', 'u3']) store.set(id, 'cannon', 150, '短拳')

        for(const id of ['u1', 'u2', 'u3']){
            expect(store.get(id, 'cannon')).toMatchObject({level: 150, name: '短拳'})
        }
    })

    it('查不到就回 null，不丟例外', () => {
        const store = newStore()
        expect(store.get('nobody', 'paladin')).toBeNull()
    })
})

describe('讀寫與持久化', () => {
    it('寫進去的內容真的落到檔案上，格式是 version / members', () => {
        const store = newStore()
        store.set('u1', 'paladin', 171, '不是黑騎士')

        const raw = readFile(store)
        expect(raw.version).toBe(1)
        expect(raw.updatedAt).toBeTruthy()
        expect(raw.members[rosterKey('u1', 'paladin')]).toMatchObject({level: 171, name: '不是黑騎士'})
    })

    it('讀得回既有的檔案', () => {
        const store = newStore(JSON.stringify({
            version: 1,
            members: {'u1:ice': {level: 164, name: 'ZZ'}},
        }))

        expect(store.get('u1', 'ice')).toMatchObject({level: 164, name: 'ZZ'})
    })

    it('getMembers 回的是副本，改它不會動到內部資料', () => {
        const store = newStore()
        store.set('u1', 'ice', 164, 'ZZ')

        const members = store.getMembers()
        delete members[rosterKey('u1', 'ice')]

        expect(store.get('u1', 'ice')).not.toBeNull()
    })
})

describe('壞掉的檔案不能讓 bot 起不來', () => {
    it('檔案不存在 → 空表，而且不建檔(沒有 seed 可推)', () => {
        const store = newStore()
        expect(store.getMembers()).toEqual({})
        expect(fs.existsSync(store.filePath)).toBe(false)
    })

    it('內容不是合法 JSON → 空表，而且**不覆蓋原檔**(壞檔留著才救得回來)', () => {
        const store = newStore('{ 這不是 JSON')
        expect(store.getMembers()).toEqual({})
        expect(fs.readFileSync(store.filePath, 'utf8')).toBe('{ 這不是 JSON')
    })

    it('是 JSON 但結構不對 → 空表，不丟例外', () => {
        const store = newStore(JSON.stringify({version: 1, members: null, junk: [1, 2, 3]}))
        expect(store.getMembers()).toEqual({})
    })

    it('舊的扁平格式(沒有 members 外層)照樣讀得進來', () => {
        const store = newStore(JSON.stringify({
            'u1:bowmaster': {level: 173, name: 'forever0w0'},
        }))

        expect(store.get('u1', 'bowmaster')).toMatchObject({level: 173, name: 'forever0w0'})
    })
})

describe('setLevel：一般成員只能改自己已登記的等級', () => {
    it('改得動既有的那一筆，角色名不受影響', () => {
        const store = newStore()
        store.set('u1', 'ice', 160, 'Mia')

        expect(store.setLevel('u1', 'ice', 165)).toEqual({ok: true})
        expect(store.get('u1', 'ice')).toMatchObject({level: 165, name: 'Mia'})
    })

    it('查不到的角色回 missing，**不會順手建一筆**', () => {
        const store = newStore()

        expect(store.setLevel('u1', 'ice', 165)).toEqual({ok: false, reason: 'missing'})
        expect(store.getMembers()).toEqual({})
    })
})

describe('remove', () => {
    it('刪掉指定的那一隻，同一個人的其他角色留著', () => {
        const store = newStore()
        store.set('u1', 'shadower', 168, 'DayChuan')
        store.set('u1', 'cannon', 150, '短拳')

        expect(store.remove('u1', 'cannon')).toEqual({ok: true})
        expect(store.get('u1', 'cannon')).toBeNull()
        expect(store.get('u1', 'shadower')).not.toBeNull()
    })

    it('刪不存在的回 missing', () => {
        const store = newStore()
        expect(store.remove('u1', 'cannon')).toEqual({ok: false, reason: 'missing'})
    })
})

describe('list', () => {
    it('等級由高到低', () => {
        const store = newStore()
        store.set('u1', 'cannon', 150, '短拳')
        store.set('u2', 'bowmaster', 173, 'forever0w0')
        store.set('u3', 'ice', 164, 'ZZ')

        expect(store.list().map((item) => item.name)).toEqual(['forever0w0', 'ZZ', '短拳'])
    })

    it('帶 userId 就只列那個人的角色', () => {
        const store = newStore()
        store.set('u1', 'shadower', 168, 'DayChuan')
        store.set('u1', 'cannon', 150, '短拳')
        store.set('u2', 'ice', 164, 'ZZ')

        expect(store.list('u1').map((item) => item.identity)).toEqual(['shadower', 'cannon'])
    })

    it('拆得出 key 裡的 userId 與 identity(職業 value 含連字號也不會拆錯)', () => {
        const store = newStore()
        store.set('424765737744334858', 'dark-knight', 169, '不是聖騎士')

        expect(store.list()[0]).toMatchObject({
            userId: '424765737744334858',
            identity: 'dark-knight',
        })
    })
})
