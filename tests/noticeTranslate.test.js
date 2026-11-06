import {describe, it, expect, vi} from 'vitest'
import * as notice from '@/core/noticeTranslate'

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
