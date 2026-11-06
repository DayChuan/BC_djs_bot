import {describe, it, expect, afterEach, vi} from 'vitest'
import * as gemini from '@/core/gemini'

//真正的 logger 會開檔與串流，在測試 jail 裡會讓 vitest 卡住跑不完(同 japanese.test.js)
vi.mock('@/core/logger', () => ({
    default: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}))

//不打真的 API：fetch 一律換成假的
afterEach(() => {
    vi.unstubAllGlobals()
})

//2026-11-04 在測試 jail 實測 gemini-3.5-flash 的回應形狀(thoughtSignature 截短)
const REAL_RESPONSE = {
    candidates: [{
        content: {
            parts: [{text: '你好！很高興認識你。', thoughtSignature: 'EpUQCpIQAWkUfRMAy1tEPpau'}],
            role: 'model',
        },
        finishReason: 'STOP',
    }],
}

const reply = (status, json) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async() => json,
    text: async() => JSON.stringify(json),
})

describe('classifyStatus', () => {
    it.each([503, 429, 404, 500])('%s → 換下一個模型', (status) => {
        expect(gemini.classifyStatus(status)).toBe('next')
    })

    it.each([401, 403, 400])('%s → 不再嘗試(key 的問題，換模型也一樣)', (status) => {
        expect(gemini.classifyStatus(status)).toBe('abort')
    })
})

describe('extractText', () => {
    it('實際的回應 → 只取 text，不含 thoughtSignature', () => {
        expect(gemini.extractText(REAL_RESPONSE)).toBe('你好！很高興認識你。')
    })

    it('thought: true 的片段(思考過程)略過，多個 text 接起來', () => {
        const json = {candidates: [{content: {parts: [
            {text: '我先想想', thought: true},
            {text: '第一段'},
            {text: '第二段'},
        ]}}]}
        expect(gemini.extractText(json)).toBe('第一段第二段')
    })

    it.each([
        ['沒有 candidates(被安全過濾擋下)', {promptFeedback: {blockReason: 'SAFETY'}}],
        ['candidates 是空的', {candidates: []}],
        ['parts 不是陣列', {candidates: [{content: {parts: 'x'}}]}],
        ['只有空白', {candidates: [{content: {parts: [{text: '   '}]}}]}],
        ['null', null],
        ['字串', 'oops'],
    ])('%s → null，不丟例外', (label, json) => {
        expect(gemini.extractText(json)).toBeNull()
    })
})

describe('generateText', () => {
    const MODELS = ['model-a', 'model-b', 'model-c']

    const stubFetch = (handler) => {
        const calls = []
        vi.stubGlobal('fetch', vi.fn(async(url, options) => {
            calls.push({url, options})
            return handler(url)
        }))
        return calls
    }

    it('沒有 key → 不呼叫 API', async() => {
        const calls = stubFetch(() => reply(200, REAL_RESPONSE))
        const result = await gemini.generateText('hi', {models: MODELS, apiKey: ''})
        expect(result).toMatchObject({text: null, reason: 'no-key'})
        expect(calls).toHaveLength(0)
    })

    it('第一個模型成功就不往下試；key 放在標頭不放網址', async() => {
        const calls = stubFetch(() => reply(200, REAL_RESPONSE))
        const result = await gemini.generateText('hi', {models: MODELS, apiKey: 'k'})
        expect(result).toEqual({text: '你好！很高興認識你。', model: 'model-a'})
        expect(calls).toHaveLength(1)
        expect(calls[0].url).toContain('/model-a:generateContent')
        expect(calls[0].url).not.toContain('k=')
        expect(calls[0].options.headers['x-goog-api-key']).toBe('k')
    })

    it('503 → 換下一個模型', async() => {
        const calls = stubFetch((url) => (url.includes('model-a') ? reply(503, {}) : reply(200, REAL_RESPONSE)))
        const result = await gemini.generateText('hi', {models: MODELS, apiKey: 'k'})
        expect(result.model).toBe('model-b')
        expect(calls).toHaveLength(2)
    })

    it('404、429 與逾時都換下一個模型', async() => {
        stubFetch((url) => {
            if(url.includes('model-a')) return reply(404, {})
            if(url.includes('model-b')) {
                const error = new Error('timeout')
                error.name = 'TimeoutError'
                throw error
            }
            return reply(200, REAL_RESPONSE)
        })
        const result = await gemini.generateText('hi', {models: MODELS, apiKey: 'k'})
        expect(result.model).toBe('model-c')
    })

    it('有模型回 429 → 回報 quota，呼叫端才知道不能短間隔重試', async() => {
        stubFetch((url) => (url.includes('model-a') ? reply(429, {}) : reply(503, {})))
        const result = await gemini.generateText('hi', {models: MODELS, apiKey: 'k'})
        expect(result).toMatchObject({text: null, reason: 'all-failed', quota: true})
    })

    it('全部是 503 → quota 是 false，這種可以重試', async() => {
        stubFetch(() => reply(503, {}))
        const result = await gemini.generateText('hi', {models: MODELS, apiKey: 'k'})
        expect(result).toMatchObject({reason: 'all-failed', quota: false})
    })

    it('403 → 直接放棄，不試其他模型', async() => {
        const calls = stubFetch(() => reply(403, {}))
        const result = await gemini.generateText('hi', {models: MODELS, apiKey: 'k'})
        expect(result).toMatchObject({text: null, reason: 'http-403'})
        expect(calls).toHaveLength(1)
    })

    it('200 但沒有文字 → 換下一個模型', async() => {
        stubFetch((url) => (url.includes('model-a') ? reply(200, {candidates: []}) : reply(200, REAL_RESPONSE)))
        const result = await gemini.generateText('hi', {models: MODELS, apiKey: 'k'})
        expect(result.model).toBe('model-b')
    })

    it('全部失敗 → text 是 null，不丟例外', async() => {
        stubFetch(() => reply(503, {}))
        const result = await gemini.generateText('hi', {models: MODELS, apiKey: 'k'})
        expect(result).toMatchObject({text: null, reason: 'all-failed'})
    })
})
