import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import * as notice from '@/core/noticeTranslate'
import * as queue from '@/core/geminiQueue'
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

const CHANNEL = '1568104599863435264'

describe('shouldTranslate', () => {
    const base = {bot: false, channelId: CHANNEL, content: '明天晚上八點維修'}

    it('公告頻道裡的一般成員中文訊息 → 翻', () => {
        expect(notice.shouldTranslate(base, CHANNEL)).toBe(true)
    })

    it('機器人的訊息一律不翻(否則會翻自己的翻譯，無限迴圈)', () => {
        expect(notice.shouldTranslate({...base, bot: true}, CHANNEL)).toBe(false)
    })

    it('其他頻道不翻', () => {
        expect(notice.shouldTranslate({...base, channelId: '123'}, CHANNEL)).toBe(false)
    })

    it('環境沒有設定公告頻道 → 不翻', () => {
        expect(notice.shouldTranslate(base, undefined)).toBe(false)
        expect(notice.shouldTranslate({...base, channelId: undefined}, undefined)).toBe(false)
    })

    it.each([
        ['空字串(只有圖片)', ''],
        ['只有空白與換行', '  \n\t '],
        ['undefined', undefined],
    ])('%s → 不翻', (label, content) => {
        expect(notice.shouldTranslate({...base, content}, CHANNEL)).toBe(false)
    })
})

//事件檔有 import discord.js，不能 import 進來測(測試 jail 會卡住)，所以只讀原始碼文字。
//守的是「action 的第一個敘述就是 bot 擋線」：有人在前面插了會 await 或會送訊息的東西，
//機器人就可能翻自己的譯文，無限迴圈灌爆頻道。
describe('事件檔的 bot 擋線', () => {
    it('action 的第一個敘述是 if(message.author.bot) return', () => {
        const file = fileURLToPath(new URL('../src/events/noticeTranslate/index.js', import.meta.url))
        const source = fs.readFileSync(file, 'utf8')
        const start = source.indexOf('export const action')
        expect(start).toBeGreaterThanOrEqual(0)
        const body = source.slice(source.indexOf('{', start) + 1)
        const firstLine = body.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
        expect(firstLine).toBe('if(message.author.bot) return')
    })
})

describe('buildTranslatePrompt', () => {
    it('包含原文，並要求只輸出日文譯文', () => {
        const prompt = notice.buildTranslatePrompt('  明天晚上八點維修  ')
        expect(prompt).toContain('日本語に翻訳')
        expect(prompt).toContain('訳文だけを出力')
        expect(prompt.endsWith('---\n明天晚上八點維修')).toBe(true)
    })

    it('要求保留換行、條列與提及字串', () => {
        const prompt = notice.buildTranslatePrompt('x')
        expect(prompt).toContain('改行と箇条書き')
        for(const mention of ['<@123>', '<#123>', '<@&123>', ':emoji:']) expect(prompt).toContain(mention)
    })
})

describe('buildTranslationMessages', () => {
    it('第一行是 subtext 的 AI 標註，空一行接譯文', () => {
        expect(notice.buildTranslationMessages('明日の夜8時にメンテナンス', 'gemini-3.5-flash'))
            .toEqual(['-# 🤖 AI 翻訳（Gemini gemini-3.5-flash）\n\n明日の夜8時にメンテナンス'])
    })

    it('稍後補上的版本標註不同，看得出不是重複貼', () => {
        const [first] = notice.buildTranslationMessages('訳文', 'gemini-3.5-flash', {late: true})
        expect(first.startsWith('-# ⏳')).toBe(true)
        expect(first).toContain('gemini-3.5-flash')
    })

    it('沒有模型名稱時不印出 null', () => {
        expect(notice.buildCredit(null)).toBe('-# 🤖 AI 翻訳（Gemini）')
    })

    it('超過 2000 字要切成多則，每則都不超過上限，標註只在第一則', () => {
        const text = Array.from({length: 200}, (_, i) => `${i}行目のお知らせです。`.padEnd(30, 'あ')).join('\n')
        const messages = notice.buildTranslationMessages(text, 'gemini-3.5-flash')
        expect(messages.length).toBeGreaterThan(1)
        for(const message of messages) expect(message.length).toBeLessThanOrEqual(2000)
        expect(messages[0].startsWith('-# 🤖')).toBe(true)
        expect(messages.slice(1).some((message) => message.includes('AI 翻訳'))).toBe(false)
    })
})

describe('buildJobLabel', () => {
    it('取公告開頭，換行壓成空白，太長加省略號', () => {
        expect(notice.buildJobLabel('明天\n維修')).toBe('公告翻譯：明天 維修')
        expect(notice.buildJobLabel('あ'.repeat(50), 30)).toBe('公告翻譯：' + 'あ'.repeat(30) + '…')
    })
})

/////////////////////////// 整段流程(假的 message、client、fetch) ///////////////////////////

//不碰 discord.js：message 只需要 reply / react / reactions.cache，client 只需要 channels.fetch 與 user.id
const makeMessage = ({content = '明天晚上八點維修', channelId = config.channels.manualNotice, gone = false} = {}) => {
    const message = {
        id: 'm1',
        channelId,
        content,
        url: 'https://discord.com/channels/g/c/m1',
        author: {bot: false},
        replies: [],
        reacted: [],
        unreacted: [],
        //client 在其他頻道(管理員頻道)送出的訊息
        sent: [],
        reply: async(options) => {
            message.replies.push(options)
            return {}
        },
        react: async(emoji) => {
            message.reacted.push(emoji)
        },
    }
    message.reactions = {cache: new Map([[notice.PENDING_REACTION, {users: {remove: async(id) => {
        message.unreacted.push(id)
    }}}]])}
    message.client = {
        user: {id: 'bot'},
        channels: {
            fetch: async(id) => {
                if(gone) throw Object.assign(new Error('Unknown Message'), {code: 10008})
                return {
                    messages: {fetch: async() => message},
                    send: async({content}) => {
                        message.sent.push({channel: id, content})
                        return {}
                    },
                }
            },
        },
    }
    return message
}

//Gemini 一律回 status；回傳呼叫次數的計數器
const stubGemini = (status) => {
    const calls = {count: 0}
    vi.stubGlobal('fetch', vi.fn(async() => {
        calls.count += 1
        const body = status === 200
            ? {candidates: [{content: {parts: [{text: '明日の夜8時にメンテナンス'}]}}]}
            : {error: {code: status}}
        return {ok: status === 200, status, json: async() => body, text: async() => JSON.stringify(body)}
    }))
    return calls
}

//讓佇列裡的工作全部到期
const makeAllDue = () => state.updateState(queue.SECTION, (current) => {
    current.jobs = current.jobs.map((job) => ({...job, nextAt: 0}))
})

describe('translateMessage', () => {
    let tmpDir = null

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-notice-'))
        process.env.STATE_DATA_DIR = tmpDir
        process.env.GEMINI_API_KEY = 'test-key'
        state.resetQueue()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        delete process.env.GEMINI_API_KEY
        delete process.env.STATE_DATA_DIR
        fs.rmSync(tmpDir, {recursive: true, force: true})
    })

    it('成功 → 回覆譯文，不解析提及、不 ping 發公告的人，不進佇列', async() => {
        stubGemini(200)
        const message = makeMessage()
        expect(await notice.translateMessage(message)).toBe('translated')

        expect(message.replies).toHaveLength(1)
        expect(message.replies[0].content.startsWith('-# 🤖 AI 翻訳')).toBe(true)
        expect(message.replies[0].content).toContain('明日の夜8時にメンテナンス')
        expect(message.replies[0].allowedMentions).toEqual({parse: [], repliedUser: false})
        expect(await queue.getJobs()).toEqual([])
    })

    it('其他頻道 → 不呼叫 Gemini', async() => {
        const calls = stubGemini(200)
        expect(await notice.translateMessage(makeMessage({channelId: '123'}))).toBe('skipped')
        expect(calls.count).toBe(0)
    })

    it('整條鏈失敗(503) → 排進佇列並在原訊息加 ⏳', async() => {
        stubGemini(503)
        const message = makeMessage()
        expect(await notice.translateMessage(message)).toBe('queued')

        expect(message.replies).toEqual([])
        expect(message.reacted).toEqual([notice.PENDING_REACTION])
        const [job] = await queue.getJobs()
        expect(job).toMatchObject({
            id: 'translate:m1', kind: 'translate', channelId: config.channels.manualNotice, messageId: 'm1',
            url: message.url, payload: {text: '明天晚上八點維修'}, attempts: 1,
        })
    })

    it('金鑰錯誤(400) → 不排佇列、不加 ⏳，直接通知管理員(使用者決定)', async() => {
        stubGemini(400)
        const message = makeMessage()
        expect(await notice.translateMessage(message)).toBe('failed')
        expect(message.reacted).toEqual([])
        expect(await queue.getJobs()).toEqual([])

        expect(message.sent).toHaveLength(1)
        expect(message.sent[0].channel).toBe(config.channels.admin)
        expect(message.sent[0].content).toContain('金鑰或請求有問題')
        expect(message.sent[0].content).toContain('公告翻譯：明天晚上八點維修')
        expect(message.sent[0].content).toContain(message.url)
    })

    it('沒設金鑰(no-key) → 不通知', async() => {
        delete process.env.GEMINI_API_KEY
        const calls = stubGemini(200)
        const message = makeMessage()
        expect(await notice.translateMessage(message)).toBe('failed')
        expect(calls.count).toBe(0)
        expect(message.sent).toEqual([])
    })

    it('佇列補上 → 回覆標明是稍後補上的譯文，拿掉 ⏳，移出佇列', async() => {
        stubGemini(503)
        const message = makeMessage()
        await notice.translateMessage(message)
        await makeAllDue()

        stubGemini(200)
        expect((await queue.runQueue(message.client)).done).toBe(1)
        expect(message.replies).toHaveLength(1)
        expect(message.replies[0].content.startsWith('-# ⏳')).toBe(true)
        expect(message.replies[0].allowedMentions).toEqual({parse: [], repliedUser: false})
        expect(message.unreacted).toEqual(['bot'])
        expect(await queue.getJobs()).toEqual([])
    })

    it('原公告已被刪除 → 移出佇列，不再呼叫 Gemini', async() => {
        stubGemini(503)
        await notice.translateMessage(makeMessage())
        await makeAllDue()

        const calls = stubGemini(200)
        expect((await queue.runQueue(makeMessage({gone: true}).client)).dropped).toBe(1)
        expect(calls.count).toBe(0)
        expect(await queue.getJobs()).toEqual([])
    })
})
