import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as state from '@/core/state'
import * as vmute from '@/core/vmute'

//跟 state.test.js 同一套：真的 logger 會開檔與串流，在測試 jail 裡會讓 vitest
//卡住跑不完(沒有錯誤訊息，就是不結束)。
vi.mock('@/core/logger', () => ({
    default: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}))

//這個檔案只測 src/core/vmute.js。指令檔(src/commands/vmute)會 import discord.js，
//測試碰到就卡住，所以指令與畫面一律在測試伺服器實機驗收。

const GUILD = 'g1'
const USER = 'u1'

let tmpDir = null

beforeEach(async() => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-vmute-'))
    process.env.STATE_DATA_DIR = tmpDir
    state.resetQueue()
})

afterEach(async() => {
    delete process.env.STATE_DATA_DIR
    state.resetQueue()
    await fs.rm(tmpDir, {recursive: true, force: true})
})

const entryAt = (untilMs, extra = {}) => ({
    guildId: GUILD,
    userId: USER,
    until: new Date(untilMs).toISOString(),
    ...extra,
})

//假的 member/client。這裡不需要 discord.js，只要長得像它就好。
const fakeMember = (channelId) => ({
    id: USER,
    guild: {id: GUILD},
    user: {tag: 'tester#0001', bot: false},
    voice: {
        channelId,
        setMute: vi.fn(async() => undefined),
    },
})

const fakeClient = (member) => ({
    guilds: {
        cache: {get: () => ({members: {fetch: async() => member}})},
    },
})

describe('parseSeconds', () => {
    it('六個級距都通過', () => {
        for(const seconds of vmute.ALLOWED_SECONDS){
            expect(vmute.parseSeconds(seconds)).toBe(seconds)
        }
    })

    //Discord 端的 addChoices 擋得住手動輸入，但直接打 API 繞得過去，
    //所以伺服器端一定要再驗一次。
    it('不在級距內、非整數、非數字一律回 null', () => {
        for(const bad of [59, 61, 900, 600.5, 0, -60, 'abc', null, undefined, {}]){
            expect(vmute.parseSeconds(bad)).toBeNull()
        }
    })
})

describe('muteKey', () => {
    it('帶 vmute: 前綴，因為 scheduler 的 key 是全域共用的', () => {
        expect(vmute.muteKey(GUILD, USER)).toBe('vmute:g1:u1')
    })

    it('不同伺服器的同一個人不會撞 key', () => {
        expect(vmute.muteKey('g1', USER)).not.toBe(vmute.muteKey('g2', USER))
    })
})

describe('remainMs / isExpired', () => {
    const now = Date.UTC(2026, 7, 25, 12, 0, 0)

    it('未到期回剩餘毫秒', () => {
        expect(vmute.remainMs(entryAt(now + 60000), now)).toBe(60000)
        expect(vmute.isExpired(entryAt(now + 60000), now)).toBe(false)
    })

    it('剛好到期算已過期', () => {
        expect(vmute.remainMs(entryAt(now), now)).toBe(0)
        expect(vmute.isExpired(entryAt(now), now)).toBe(true)
    })

    it('已過期回 0，不回負數', () => {
        expect(vmute.remainMs(entryAt(now - 60000), now)).toBe(0)
        expect(vmute.isExpired(entryAt(now - 60000), now)).toBe(true)
    })

    //算不出時間的紀錄留著會變成永遠不會到期的殭屍，一律當成已到期收掉。
    it('時間壞掉或缺 until 一律當成已到期', () => {
        expect(vmute.isExpired({guildId: GUILD, userId: USER}, now)).toBe(true)
        expect(vmute.isExpired({until: 'not-a-date'}, now)).toBe(true)
        expect(vmute.isExpired(null, now)).toBe(true)
    })
})

describe('shouldUnmuteOnJoin', () => {
    //伺服器靜音掛在成員身上不是掛在頻道上，換頻道也還是靜音的，
    //所以只比對 guild 不比對頻道 —— 比對頻道的話，離開後改進別的頻道就永遠對不上。
    it('同一個伺服器的 pending 紀錄要解除，不管他進哪個頻道', () => {
        expect(vmute.shouldUnmuteOnJoin(entryAt(0, {pending: true}), GUILD)).toBe(true)
    })

    it('不同伺服器不處理', () => {
        expect(vmute.shouldUnmuteOnJoin(entryAt(0, {pending: true}), 'g2')).toBe(false)
    })

    it('不是 pending 的紀錄不處理(靜音還在進行中)', () => {
        expect(vmute.shouldUnmuteOnJoin(entryAt(Date.now() + 60000), GUILD)).toBe(false)
        expect(vmute.shouldUnmuteOnJoin(null, GUILD)).toBe(false)
    })
})

describe('canUnmute', () => {
    //測試期全開。之後要收權限只改這個函式，指令檔不必動。
    it('目前一律放行', () => {
        expect(vmute.canUnmute({}, {}).ok).toBe(true)
    })
})

describe('unmute', () => {
    it('人在語音：解除成功，紀錄清掉', async() => {
        const key = vmute.muteKey(GUILD, USER)
        const member = fakeMember('voice-1')
        await state.updateState(vmute.SECTION, (current) => {
            current[key] = entryAt(Date.now() + 60000)
            return current
        })

        const result = await vmute.unmute(fakeClient(member), entryAt(Date.now() + 60000))

        expect(result.status).toBe('done')
        expect(member.voice.setMute).toHaveBeenCalledWith(false, expect.any(String))
        expect(await vmute.readEntry(GUILD, USER)).toBeNull()
    })

    //這是最重要的一條：人離開語音時解不掉，紀錄不能消失，
    //否則他身上的伺服器靜音就永遠留著、再也沒有人記得要解除。
    it('人不在語音：不呼叫 setMute，紀錄留著並標記 pending', async() => {
        const member = fakeMember(null)

        const result = await vmute.unmute(fakeClient(member), entryAt(Date.now() - 1000))

        expect(result.status).toBe('pending')
        expect(member.voice.setMute).not.toHaveBeenCalled()
        expect(await vmute.readEntry(GUILD, USER)).toMatchObject({pending: true})
    })

    it('抓不到成員：紀錄照樣留著，不會把待解除的靜音弄丟', async() => {
        const client = {guilds: {cache: {get: () => {
            throw new Error('unknown guild')
        }}}}

        const result = await vmute.unmute(client, entryAt(Date.now() - 1000))

        expect(result.status).toBe('pending')
        expect(await vmute.readEntry(GUILD, USER)).toMatchObject({pending: true})
    })

    it('權限不足(50013)：回 failed，紀錄留著等補權限後再解', async() => {
        const member = fakeMember('voice-1')
        member.voice.setMute = vi.fn(async() => {
            const error = new Error('Missing Permissions')
            error.code = 50013
            throw error
        })

        const result = await vmute.unmute(fakeClient(member), entryAt(Date.now() - 1000))

        expect(result.status).toBe('failed')
        expect(await vmute.readEntry(GUILD, USER)).toMatchObject({pending: true})
    })
})

describe('handleVoiceJoin', () => {
    it('有 pending 紀錄時解除並清掉', async() => {
        const key = vmute.muteKey(GUILD, USER)
        const member = fakeMember('voice-9')
        await state.updateState(vmute.SECTION, (current) => {
            current[key] = entryAt(Date.now() - 1000, {pending: true})
            return current
        })

        const done = await vmute.handleVoiceJoin(fakeClient(member), GUILD, USER)

        expect(done).toBe(true)
        expect(member.voice.setMute).toHaveBeenCalledWith(false, expect.any(String))
        expect(await vmute.readEntry(GUILD, USER)).toBeNull()
    })

    it('沒有紀錄時什麼都不做', async() => {
        const member = fakeMember('voice-9')

        expect(await vmute.handleVoiceJoin(fakeClient(member), GUILD, USER)).toBe(false)
        expect(member.voice.setMute).not.toHaveBeenCalled()
    })

    //靜音還沒到期的人自己換頻道，不能因此被解除。
    it('紀錄還在進行中(未 pending)時不解除', async() => {
        const key = vmute.muteKey(GUILD, USER)
        const member = fakeMember('voice-9')
        await state.updateState(vmute.SECTION, (current) => {
            current[key] = entryAt(Date.now() + 60000)
            return current
        })

        expect(await vmute.handleVoiceJoin(fakeClient(member), GUILD, USER)).toBe(false)
        expect(member.voice.setMute).not.toHaveBeenCalled()
    })
})
