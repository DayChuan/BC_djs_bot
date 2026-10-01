import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as state from '@/core/state'
import * as voiceRoom from '@/core/voiceRoom'
import {ROOM_NAME_SUFFIX, ROOM_NAME_MAX_LENGTH, ROOM_NAME_FALLBACK} from '@/config/voiceRoom'

//跟 vmute.test.js 同一套：真的 logger 會開檔與串流，在測試 jail 裡會讓 vitest 卡住跑不完。
vi.mock('@/core/logger', () => ({
    default: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}))

//不載入真的 config/index.js(它會讀 .env、依 BOT_ENV 選環境)，大廳 id 在這裡固定。
vi.mock('@/config', () => ({
    default: {
        voiceLobbies: {g1: 'lobby1', g2: 'lobby2'},
    },
}))

//這個檔案只測 src/core/voiceRoom.js(它不 import discord.js)。
//guild / channel 一律用普通物件假造，實際的 Discord 行為在測試伺服器實機驗收。

const GUILD = 'g1'
const LOBBIES = ['lobby1', 'lobby2']
const record = (extra = {}) => ({guildId: GUILD, ownerId: 'u1', createdAt: '2026-10-01T00:00:00.000Z', ...extra})

let tmpDir = null

beforeEach(async() => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-voiceroom-'))
    process.env.STATE_DATA_DIR = tmpDir
    state.resetQueue()
})

afterEach(async() => {
    delete process.env.STATE_DATA_DIR
    state.resetQueue()
    await fs.rm(tmpDir, {recursive: true, force: true})
})

describe('buildRoomName', () => {
    it('房名是 displayName + 後綴', () => {
        expect(voiceRoom.buildRoomName('小明')).toBe(`小明${ROOM_NAME_SUFFIX}`)
    })

    it('displayName 超長時截斷，總長 ≤ 上限，後綴保留', () => {
        const name = voiceRoom.buildRoomName('a'.repeat(300))
        expect(name.length).toBeLessThanOrEqual(ROOM_NAME_MAX_LENGTH)
        expect(name.endsWith(ROOM_NAME_SUFFIX)).toBe(true)
    })

    it('不會把 emoji 切成半個字元', () => {
        const name = voiceRoom.buildRoomName('😀'.repeat(100))
        expect(name.length).toBeLessThanOrEqual(ROOM_NAME_MAX_LENGTH)
        //沒有落單的代理字元
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(name)).toBe(false)
    })

    it('displayName 是空的或全空白時用預設名稱', () => {
        expect(voiceRoom.buildRoomName('   ')).toBe(`${ROOM_NAME_FALLBACK}${ROOM_NAME_SUFFIX}`)
        expect(voiceRoom.buildRoomName(undefined)).toBe(`${ROOM_NAME_FALLBACK}${ROOM_NAME_SUFFIX}`)
    })
})

describe('decideCleanup', () => {
    const base = {record: record(), guildId: GUILD, channelId: 'room1', lobbyIds: LOBBIES, exists: true, isVoice: true, memberCount: 0}

    it('不在紀錄裡 → 不可刪(就算空著)', () => {
        expect(voiceRoom.decideCleanup({...base, record: null})).toEqual({action: 'keep', reason: 'not-tracked'})
    })

    it('大廳本身即使空著、即使出現在紀錄裡也不刪頻道', () => {
        const result = voiceRoom.decideCleanup({...base, channelId: 'lobby1'})
        expect(result.action).not.toBe('delete')
        expect(result).toEqual({action: 'forget', reason: 'is-lobby'})
    })

    it('別的伺服器的大廳也受保護(guildId 傳錯也不會失守)', () => {
        expect(voiceRoom.decideCleanup({...base, channelId: 'lobby2'}).action).not.toBe('delete')
    })

    it('紀錄裡、頻道存在、人數 0 → 可刪', () => {
        expect(voiceRoom.decideCleanup(base)).toEqual({action: 'delete', reason: 'empty'})
    })

    it('紀錄裡、人數 > 0 → 不可刪', () => {
        expect(voiceRoom.decideCleanup({...base, memberCount: 2})).toEqual({action: 'keep', reason: 'occupied'})
    })

    it('頻道已不存在 → 只清紀錄', () => {
        expect(voiceRoom.decideCleanup({...base, exists: false})).toEqual({action: 'forget', reason: 'gone'})
    })

    it('型別不是語音 → 不刪頻道', () => {
        expect(voiceRoom.decideCleanup({...base, isVoice: false})).toEqual({action: 'forget', reason: 'not-voice'})
    })

    it('紀錄的伺服器對不上 → 不動', () => {
        expect(voiceRoom.decideCleanup({...base, guildId: 'other'}).action).toBe('keep')
    })

    it('輸入不合法一律不刪', () => {
        for(const bad of [
            {memberCount: undefined},
            {memberCount: NaN},
            {memberCount: -1},
            {memberCount: '0'},
            {exists: undefined},
            {isVoice: undefined},
            {channelId: undefined},
            {lobbyIds: undefined},
        ]){
            expect(voiceRoom.decideCleanup({...base, ...bad}).action).toBe('keep')
        }
        expect(voiceRoom.decideCleanup().action).toBe('keep')
    })
})

describe('decideJoin', () => {
    const NOW = 1_000_000

    it('已有房間 → 搬回去，優先於 cooldown', () => {
        expect(voiceRoom.decideJoin({existingRoomId: 'room1', lastCreatedAt: NOW, now: NOW}).action).toBe('move-existing')
    })

    it('cooldown 內再次觸發 → 不建立第二間', () => {
        expect(voiceRoom.decideJoin({lastCreatedAt: NOW - 5000, now: NOW, cooldownSeconds: 10}))
            .toEqual({action: 'skip', reason: 'cooldown'})
    })

    it('超過 cooldown → 建立', () => {
        expect(voiceRoom.decideJoin({lastCreatedAt: NOW - 10000, now: NOW, cooldownSeconds: 10}).action).toBe('create')
    })

    it('從沒建立過 → 建立', () => {
        expect(voiceRoom.decideJoin({now: NOW}).action).toBe('create')
        expect(voiceRoom.decideJoin({lastCreatedAt: null, now: NOW}).action).toBe('create')
    })
})

describe('findRoomByOwner', () => {
    it('只找同一個伺服器、同一個人的房間', () => {
        const records = {
            room1: record({ownerId: 'u1'}),
            room2: record({ownerId: 'u2'}),
            room3: record({guildId: 'g2', ownerId: 'u3'}),
        }
        expect(voiceRoom.findRoomByOwner(records, GUILD, 'u2')).toBe('room2')
        expect(voiceRoom.findRoomByOwner(records, GUILD, 'u3')).toBe(null)
        expect(voiceRoom.findRoomByOwner({}, GUILD, 'u1')).toBe(null)
    })
})

//cleanupRoom 是唯一會刪頻道的地方。這裡用假造的 guild 確認三道防線真的擋住了 delete()。
describe('cleanupRoom', () => {
    const makeChannel = (id, {type = voiceRoom.GUILD_VOICE, members = 0} = {}) => ({
        id,
        name: id,
        type,
        members: {size: members},
        delete: vi.fn(async() => undefined),
    })

    const makeGuild = (channels) => ({
        id: GUILD,
        channels: {
            fetch: vi.fn(async(id) => {
                if(channels[id]) return channels[id]
                throw Object.assign(new Error('Unknown Channel'), {code: 10003})
            }),
        },
    })

    it('伺服器原有的靜態語音頻道(不在紀錄、空的)→ 不刪', async() => {
        const statics = makeChannel('static1')
        const guild = makeGuild({static1: statics})
        expect(await voiceRoom.cleanupRoom(guild, 'static1', 'leave')).toBe('keep')
        expect(statics.delete).not.toHaveBeenCalled()
    })

    it('大廳就算被寫進紀錄也不刪，紀錄清掉', async() => {
        const lobby = makeChannel('lobby1')
        await state.setState(voiceRoom.SECTION, {lobby1: record()})
        expect(await voiceRoom.cleanupRoom(makeGuild({lobby1: lobby}), 'lobby1', 'sweep')).toBe('forget')
        expect(lobby.delete).not.toHaveBeenCalled()
        expect(await voiceRoom.readRooms()).toEqual({})
    })

    it('紀錄裡但不是語音頻道 → 不刪', async() => {
        const text = makeChannel('room1', {type: 0})
        await state.setState(voiceRoom.SECTION, {room1: record()})
        await voiceRoom.cleanupRoom(makeGuild({room1: text}), 'room1', 'sweep')
        expect(text.delete).not.toHaveBeenCalled()
    })

    it('紀錄裡、空的 → 刪頻道與紀錄', async() => {
        const room = makeChannel('room1')
        await state.setState(voiceRoom.SECTION, {room1: record()})
        expect(await voiceRoom.cleanupRoom(makeGuild({room1: room}), 'room1', 'leave')).toBe('delete')
        expect(room.delete).toHaveBeenCalledTimes(1)
        expect(await voiceRoom.readRooms()).toEqual({})
    })

    it('紀錄裡、還有人 → 不刪，紀錄保留', async() => {
        const room = makeChannel('room1', {members: 1})
        await state.setState(voiceRoom.SECTION, {room1: record()})
        await voiceRoom.cleanupRoom(makeGuild({room1: room}), 'room1', 'leave')
        expect(room.delete).not.toHaveBeenCalled()
        expect(Object.keys(await voiceRoom.readRooms())).toEqual(['room1'])
    })

    it('房主自己先刪掉(10003)→ 只清紀錄，不報錯', async() => {
        await state.setState(voiceRoom.SECTION, {room1: record()})
        expect(await voiceRoom.cleanupRoom(makeGuild({}), 'room1', 'leave')).toBe('forget')
        expect(await voiceRoom.readRooms()).toEqual({})
    })

    it('暫時抓不到頻道(非 10003)→ 紀錄保留', async() => {
        await state.setState(voiceRoom.SECTION, {room1: record()})
        const guild = {id: GUILD, channels: {fetch: vi.fn(async() => { throw new Error('network') })}}
        expect(await voiceRoom.cleanupRoom(guild, 'room1', 'sweep')).toBe('keep')
        expect(Object.keys(await voiceRoom.readRooms())).toEqual(['room1'])
    })

    it('刪除時才發現已不存在(10003)→ 紀錄清掉', async() => {
        const room = makeChannel('room1')
        room.delete = vi.fn(async() => { throw Object.assign(new Error('Unknown Channel'), {code: 10003}) })
        await state.setState(voiceRoom.SECTION, {room1: record()})
        await voiceRoom.cleanupRoom(makeGuild({room1: room}), 'room1', 'leave')
        expect(await voiceRoom.readRooms()).toEqual({})
    })

    it('刪除失敗(其他錯誤)→ 紀錄保留待下次清理', async() => {
        const room = makeChannel('room1')
        room.delete = vi.fn(async() => { throw Object.assign(new Error('Missing Permissions'), {code: 50013}) })
        await state.setState(voiceRoom.SECTION, {room1: record()})
        expect(await voiceRoom.cleanupRoom(makeGuild({room1: room}), 'room1', 'leave')).toBe('keep')
        expect(Object.keys(await voiceRoom.readRooms())).toEqual(['room1'])
    })
})
