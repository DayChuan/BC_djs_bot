import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as feed from '@/core/minecraftFeed'
import * as state from '@/core/state'
import config from '@/config'
import production from '@/config/environments/production'
import testEnv from '@/config/environments/test'

//真正的 logger 會開檔與串流，在測試 jail 裡會讓 vitest 卡住跑不完(同 japanese.test.js)
vi.mock('@/core/logger', () => ({
    default: {
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    },
}))

//照 2026-11-04 實測的形狀：沒有 guid、沒有 <link>，連結在 <a10:link href>，pubDate 結尾是 Z
const item = (title, slug, pubDate) =>
    `<item><title>${title}</title><description>${title}</description>` +
    `<pubDate>${pubDate}</pubDate>` +
    `<a10:link href="https://www.minecraft.net/en-us/article/${slug}" /></item>`

const FEED_XML =
    '<?xml version="1.0" encoding="utf-16"?>' +
    '<rss xmlns:a10="http://www.w3.org/2005/Atom" version="2.0"><channel>' +
    '<title>Minecraft</title><link>https://www.minecraft.net/en-us/rss</link><description>Minecraft</description>' +
    item('Creator Pages arrive on the Marketplace', 'creator-pages', 'Tue, 03 Nov 2026 18:00:03 Z') +
    item('Minecraft Preview 26.70.23 Changelog', 'minecraft-preview-26-70-23', 'Tue, 03 Nov 2026 14:20:00 Z') +
    item('Minecraft 26.4 Snapshot 7', 'minecraft-26-4-snapshot-7', 'Tue, 03 Nov 2026 14:00:00 Z') +
    item('Minecraft: Bedrock Edition 26.60 Changelog', 'bedrock-26-60', 'Tue, 27 Oct 2026 15:13:00 Z') +
    item('Minecraft 26.4 Snapshot 6', 'minecraft-26-4-snapshot-6', 'Tue, 27 Oct 2026 14:00:00 Z') +
    '</channel></rss>'

const SNAPSHOT_7 = 'https://www.minecraft.net/en-us/article/minecraft-26-4-snapshot-7'
const SNAPSHOT_6 = 'https://www.minecraft.net/en-us/article/minecraft-26-4-snapshot-6'

//照實際文章頁的結構縮小：內文區塊之後還有分享列與頁尾的文章列表(同樣的 class)
const ARTICLE_HTML = `<html><head>
<title>Minecraft 26.4 Snapshot 7 | Minecraft</title>
<meta property="og:title" content="Minecraft 26.4 Snapshot 7">
</head><body>
<div class="MC_articleHeroA_category">News</div>
<div class="article-section"><div class="article-text">
    <div class="MC_articleGridA_sectionRef"></div>
    <div class="MC_Link_Style_RichText">
        <p>Minecraft 26.4 Snapshot 7 is here! Let&#39;s get to &#34;mining&#34;!</p>
<h2>New Features</h2>
<ul><li>Added Calcite Blockset</li><li>Added the Polished Calcite Block Set<ul><li>Polished Calcite can be crafted</li></ul>
</li></ul>
<h3>Technical Changes</h3>
<pre>/give @s calcite
/tp 0 64 0</pre>
<p>Report bugs at <a href="https://bugs.mojang.com/">bugs.mojang.com</a>.</p>
    </div>
</div></div>
<div class="MC_AEM_Wrapper aem-GridColumn">
    <section class=" " data-mc-ref="mc_social_socialShareA"><div>Share</div></section>
</div>
<div class="MC_imageGridA_subheading MC_Link_Style_RichText">FOOTER LIST</div>
</body></html>`

let tmpDir = null

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mc-'))
    process.env.STATE_DATA_DIR = tmpDir
    state.resetQueue()
})

afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.STATE_DATA_DIR
    fs.rmSync(tmpDir, {recursive: true, force: true})
})

describe('環境設定', () => {
    it('兩個環境都有兩個 Minecraft 頻道，而且不是同一個', () => {
        for(const env of [production, testEnv]){
            expect(env.channels.minecraftNotice).toMatch(/^\d+$/)
            expect(env.channels.minecraftContent).toMatch(/^\d+$/)
            expect(env.channels.minecraftNotice).not.toBe(env.channels.minecraftContent)
        }
    })
})

describe('decodeBytes', () => {
    it('UTF-16LE(無 BOM)與 UTF-8 解出同一段字串', () => {
        const le = feed.decodeBytes(new Uint8Array(Buffer.from(FEED_XML, 'utf16le')))
        const utf8 = feed.decodeBytes(new Uint8Array(Buffer.from(FEED_XML, 'utf8')))
        expect(le.encoding).toBe('utf-16le')
        expect(utf8.encoding).toBe('utf-8')
        expect(le.text).toBe(FEED_XML)
        expect(utf8.text).toBe(FEED_XML)
    })

    it('有 BOM 的 UTF-16LE 去掉 BOM', () => {
        const bytes = new Uint8Array([0xFF, 0xFE, ...Buffer.from('<a/>', 'utf16le')])
        expect(feed.decodeBytes(bytes).text).toBe('<a/>')
    })

    it('UTF-16BE 也解得出來', () => {
        const le = Buffer.from('<rss>', 'utf16le')
        const be = Buffer.alloc(le.length)
        for(let i = 0; i < le.length; i += 2){
            be[i] = le[i + 1]
            be[i + 1] = le[i]
        }
        expect(feed.decodeBytes(new Uint8Array(be))).toMatchObject({text: '<rss>', encoding: 'utf-16be'})
    })

    it('空的回空字串', () => {
        expect(feed.decodeBytes(new Uint8Array()).text).toBe('')
    })
})

describe('parseFeed', () => {
    it('解析出 title / link / pubDate，連結來自 a10:link', () => {
        const items = feed.parseFeed(FEED_XML)
        expect(items).toHaveLength(5)
        expect(items[2]).toMatchObject({
            title: 'Minecraft 26.4 Snapshot 7',
            link: SNAPSHOT_7,
            pubDate: 'Tue, 03 Nov 2026 14:00:00 Z',
        })
    })

    it('結尾是 Z 的 pubDate 解析成正確的 UTC 時間', () => {
        expect(feed.parseDate('Tue, 03 Nov 2026 18:00:03 Z')).toBe(Date.UTC(2026, 10, 3, 18, 0, 3))
        expect(feed.parseDate('Tue, 03 Nov 2026 18:00:03 GMT')).toBe(Date.UTC(2026, 10, 3, 18, 0, 3))
        expect(feed.parseDate('not a date')).toBeNaN()
    })

    it('標題是數字樣式時仍然是字串', () => {
        const items = feed.parseFeed(`<rss><channel>${item('26.4', 'x', 'Tue, 03 Nov 2026 18:00:03 Z')}</channel></rss>`)
        expect(items[0].title).toBe('26.4')
    })

    it.each([
        ['空字串', ''],
        ['不是 XML', 'hello world'],
        ['HTML 錯誤頁', '<html><body>503 Service Unavailable</body></html>'],
        ['半截 XML', '<rss><channel><item><title>abc'],
        ['undefined', undefined],
    ])('%s → 回空陣列，不丟例外', (label, input) => {
        expect(feed.parseFeed(input)).toEqual([])
    })
})

describe('標題過濾', () => {
    it.each(['Minecraft 26.4 Snapshot 7', 'minecraft snapshot', 'SNAPSHOT 1', 'Minecraft Java Edition 1.21.4'])(
        '%s → 收錄',
        (title) => expect(feed.matchesTitle(title)).toBe(true),
    )

    it.each([
        'Creator Pages arrive on the Marketplace',
        'Minecraft Preview 26.70.23 Changelog',
        'Minecraft: Bedrock Edition 26.60 Changelog',
        'Everything you can test from the upcoming game drop',
        //同時含收錄字與排除字 → 排除優先
        'Bedrock Edition Snapshot 1',
    ])('%s → 過濾掉', (title) => expect(feed.matchesTitle(title)).toBe(false))

    it('filterItems 分成收錄與過濾掉兩堆', () => {
        const {kept, dropped} = feed.filterItems(feed.parseFeed(FEED_XML))
        expect(kept.map((x) => x.title)).toEqual(['Minecraft 26.4 Snapshot 7', 'Minecraft 26.4 Snapshot 6'])
        expect(dropped).toHaveLength(3)
    })
})

describe('planPosts', () => {
    const kept = () => feed.filterItems(feed.parseFeed(FEED_XML)).kept

    it('首次執行(沒有 initialized)→ 一則都不發，但回傳要記住的網址', () => {
        const plan = feed.planPosts(kept(), {})
        expect(plan.firstRun).toBe(true)
        expect(plan.toPost).toEqual([])
        expect(plan.remember).toEqual([SNAPSHOT_7, SNAPSHOT_6])
    })

    it('initialized 但 seen 是空的 → 不是首次，全部要發', () => {
        const plan = feed.planPosts(kept(), {initialized: true, seen: []})
        expect(plan.firstRun).toBe(false)
        expect(plan.toPost).toHaveLength(2)
    })

    it('只回沒看過的', () => {
        const plan = feed.planPosts(kept(), {initialized: true, seen: [SNAPSHOT_6]})
        expect(plan.toPost.map((x) => x.link)).toEqual([SNAPSHOT_7])
    })

    it('多則待發依 pubDate 由舊到新(feed 裡是新的在前)', () => {
        const plan = feed.planPosts(kept(), {initialized: true, seen: []})
        expect(plan.toPost.map((x) => x.link)).toEqual([SNAPSHOT_6, SNAPSHOT_7])
    })

    it('日期壞掉的排到最後', () => {
        const items = [{link: 'a', time: NaN}, {link: 'b', time: 2}, {link: 'c', time: 1}]
        expect(feed.planPosts(items, {initialized: true}).toPost.map((x) => x.link)).toEqual(['c', 'b', 'a'])
    })
})

describe('addSeen', () => {
    it('超過上限 → 留最新的 N 筆，最舊的丟掉', () => {
        expect(feed.addSeen(['a', 'b', 'c'], ['d', 'e'], 3)).toEqual(['c', 'd', 'e'])
    })

    it('已經在裡面的不重複加', () => {
        expect(feed.addSeen(['a', 'b'], ['b', 'c'], 10)).toEqual(['a', 'b', 'c'])
    })

    it('seen 不是陣列時當成空的', () => {
        expect(feed.addSeen(undefined, ['a'], 10)).toEqual(['a'])
    })
})

describe('文章頁 → 純文字', () => {
    it('只取 article-text 後的第一個內文區塊，不混入分享列與頁尾列表', () => {
        const body = feed.extractArticleBody(ARTICLE_HTML)
        expect(body).toContain('Snapshot 7 is here')
        expect(body).not.toContain('FOOTER LIST')
        expect(body).not.toContain('Share')
        expect(body).not.toContain('News')
    })

    it('找不到內文區塊 → 空字串', () => {
        expect(feed.extractArticleBody('<html><body>改版了</body></html>')).toBe('')
        expect(feed.extractArticleBody('')).toBe('')
    })

    it('標題、巢狀清單、實體、程式碼區塊', () => {
        const text = feed.htmlToText(feed.extractArticleBody(ARTICLE_HTML))
        expect(text).toContain('Let\'s get to "mining"!')
        expect(text).toContain('## New Features')
        expect(text).toContain('### Technical Changes')
        expect(text).toContain('\n- Added Calcite Blockset')
        expect(text).toContain('\n- Added the Polished Calcite Block Set')
        expect(text).toContain('\n  - Polished Calcite can be crafted')
        expect(text).toContain('```\n/give @s calcite\n/tp 0 64 0\n```')
        expect(text).toContain('Report bugs at bugs.mojang.com.')
        expect(text).not.toMatch(/<[a-z/]/i)
        expect(text).not.toMatch(/\n{3,}/)
    })

    it('雙重跳脫的實體只解一層', () => {
        expect(feed.decodeEntities('creator&amp;#39;s')).toBe('creator&#39;s')
        expect(feed.decodeEntities('a &lt;b&gt; &#x41; &unknown;')).toBe('a <b> A &unknown;')
    })
})

describe('splitMessage', () => {
    const lines = (count, width) => Array.from({length: count}, (_, i) => `${i}`.padEnd(width, 'x')).join('\n')

    it('短的不切', () => {
        expect(feed.splitMessage('hello', 2000)).toEqual(['hello'])
    })

    it('每段都不超過上限，接起來內容沒有少', () => {
        const text = lines(300, 40)
        const chunks = feed.splitMessage(text, 2000)
        expect(chunks.length).toBeGreaterThan(1)
        for(const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000)
        expect(chunks.join('\n')).toBe(text)
    })

    it('優先在換行處切(每段都以完整的一行結尾)', () => {
        const chunks = feed.splitMessage(lines(300, 40), 2000)
        for(const chunk of chunks) expect(chunk.split('\n').every((line) => line.length === 40)).toBe(true)
    })

    it('沒有換行時在句點切', () => {
        const text = Array.from({length: 100}, (_, i) => `Sentence number ${i} is here.`).join(' ')
        const chunks = feed.splitMessage(text, 500)
        for(const chunk of chunks.slice(0, -1)) expect(chunk.endsWith('.')).toBe(true)
        expect(chunks.join(' ')).toBe(text)
    })

    it('什麼都找不到才硬切', () => {
        const chunks = feed.splitMessage('a'.repeat(5000), 2000)
        for(const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000)
        expect(chunks.join('')).toBe('a'.repeat(5000))
    })

    it('切在程式碼區塊中間時，兩段各自補上 ```', () => {
        const text = '```\n' + lines(100, 40) + '\n```'
        const chunks = feed.splitMessage(text, 2000)
        expect(chunks.length).toBeGreaterThan(1)
        for(const chunk of chunks){
            expect(chunk.length).toBeLessThanOrEqual(2000)
            expect((chunk.split('```').length - 1) % 2).toBe(0)
        }
    })
})

describe('訊息組裝', () => {
    it('討論串名稱超過 100 字元要截斷', () => {
        expect(feed.buildThreadName('a'.repeat(150))).toHaveLength(100)
        expect(feed.buildThreadName('Minecraft 26.4 Snapshot 7')).toBe('Minecraft 26.4 Snapshot 7')
    })

    it('摘要提示詞包含標題與內文，中日各自的語言', () => {
        const zh = feed.buildSummaryPrompt('zh', 'Snapshot 7', 'BODY TEXT')
        const ja = feed.buildSummaryPrompt('ja', 'Snapshot 7', 'BODY TEXT')
        expect(zh).toContain('繁體中文')
        expect(ja).toContain('日本語')
        for(const prompt of [zh, ja]){
            expect(prompt).toContain('Snapshot 7')
            expect(prompt).toContain('BODY TEXT')
        }
    })

    it('日文摘要要求只用日文正式名稱，不附英文原名；中文維持附英文', () => {
        expect(feed.buildSummaryPrompt('ja', 'Snapshot 7', 'BODY')).toContain('英語の原名を括弧で添えない')
        expect(feed.buildSummaryPrompt('zh', 'Snapshot 7', 'BODY')).toContain('括號附上英文原名')
    })

    it('摘要失敗的語言換成一行失敗說明', () => {
        expect(feed.buildSummaryMessages('ja', null)[0]).toContain('要約を生成できませんでした')
        expect(feed.buildSummaryMessages('zh', '- 新增方解石')[0]).toBe('**【中文摘要】**\n- 新增方解石')
    })

    it('日文摘要前面有分界線，中文沒有', () => {
        expect(feed.buildSummaryMessages('ja', '- 追加')[0].startsWith('━')).toBe(true)
        expect(feed.buildSummaryMessages('zh', '- 新增')[0].startsWith('━')).toBe(false)
    })

    it('分界線只畫在日文第一則，被切開的後續訊息不重複畫', () => {
        const messages = feed.buildSummaryMessages('ja', 'あ'.repeat(5000), 2000)
        expect(messages.length).toBeGreaterThan(1)
        expect(messages.slice(1).some((text) => text.startsWith('━'))).toBe(false)
    })

    it('文章標題優先取 og:title，退而求其次用 <title> 並去掉站名', () => {
        const og = '<meta property="og:title" content="Minecraft 26.4 Snapshot 7">'
        expect(feed.extractArticleTitle(`<title>X | Minecraft</title>${og}`)).toBe('Minecraft 26.4 Snapshot 7')
        expect(feed.extractArticleTitle('<title>Minecraft 26.4 Snapshot 5 | Minecraft</title>'))
            .toBe('Minecraft 26.4 Snapshot 5')
        expect(feed.extractArticleTitle('<html></html>')).toBe('')
    })

    it('補發網址：空白與逗號都能分隔，去重，且只收 minecraft.net 的文章頁', () => {
        const base = 'https://www.minecraft.net/en-us/article/minecraft-26-4-snapshot-'
        const {links, rejected} = feed.parseUrlList(`${base}5 ${base}6,${base}5`)
        expect(links).toEqual([`${base}5`, `${base}6`])
        expect(rejected).toEqual([])
    })

    it('補發網址：站外網址與文章頁以外的路徑都要被擋下來', () => {
        const {links, rejected} = feed.parseUrlList(
            'https://evil.example.com/a https://www.minecraft.net/en-us/article/'
        )
        expect(links).toEqual([])
        expect(rejected).toHaveLength(2)
    })

    it('退回原文：最多 8 則，超過時最後一則附原文連結，每則不超過 2000', () => {
        const body = Array.from({length: 1000}, (_, i) => `- line ${i} `.padEnd(60, 'x')).join('\n')
        const messages = feed.buildFallbackMessages(body, SNAPSHOT_7, 8, 2000)
        expect(messages).toHaveLength(8)
        expect(messages[0]).toMatch(/^（AI 摘要無法產生/)
        expect(messages[7]).toContain(`完整內容見原文：${SNAPSHOT_7}`)
        for(const message of messages) expect(message.length).toBeLessThanOrEqual(2000)
    })

    it('退回原文：短的不加省略說明', () => {
        const messages = feed.buildFallbackMessages('short body', SNAPSHOT_7)
        expect(messages).toHaveLength(1)
        expect(messages[0]).not.toContain('以下省略')
    })
})

/////////////////////////// 整段流程(假的 client 與 fetch) ///////////////////////////

//不碰 discord.js：client 只需要 channels.fetch，頻道只需要 send 與 threads.create
const makeClient = ({missing = []} = {}) => {
    const sent = []
    const threads = []
    const channel = (id) => ({
        id,
        url: `https://discord.com/channels/g/${id}`,
        send: async({content}) => {
            sent.push({channel: id, content})
            return {url: `https://discord.com/channels/g/${id}/m${sent.length}`}
        },
        threads: {
            create: async({name}) => {
                const thread = channel(`thread-${threads.length + 1}`)
                thread.delete = async() => undefined
                threads.push(name)
                return thread
            },
        },
    })
    return {
        sent,
        threads,
        channels: {
            fetch: async(id) => {
                if(missing.includes(id)) throw new Error('Unknown Channel')
                return channel(id)
            },
        },
    }
}

const response = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async() => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    json: async() => JSON.parse(Buffer.from(body).toString('utf8')),
    text: async() => Buffer.from(body).toString('utf8'),
})

//minecraft.net 是用 curl 抓的，不是 Node 的 fetch(見 src/config/minecraft.js)，
//所以 RSS 與文章頁一定要攔 execFile。
//
//⚠️ 2026-11-05 的教訓：curl 那次改版只換了程式沒換測試，stubGlobal('fetch') 攔不到 curl，
//結果整組 runCheck 測試偷偷連上真的 minecraft.net，靠線上內容「碰巧」通過了兩天，
//直到 snapshot 6 掉出線上 feed 才爆出來。攔不到的網路呼叫不會報錯，只會讓測試說謊。
const curl = vi.hoisted(() => ({handler: null}))

vi.mock('node:child_process', () => ({
    execFile: (file, args, options, callback) => {
        const url = args[args.length - 1]
        if(!curl.handler) return callback(new Error(`沒有設定 curl handler：${url}`), Buffer.alloc(0), '')
        curl.handler(url, callback)
    },
}))

//RSS 用 UTF-16LE 回(跟實際一樣)，文章頁回 HTML，Gemini 依 geminiStatus 回應。
//回傳的 calls 兩種管道都記，讓「不該呼叫 Gemini」這類斷言照舊成立。
const stubNetwork = ({geminiStatus = 200, curlFails = false} = {}) => {
    const calls = []

    curl.handler = (url, callback) => {
        calls.push(url)
        if(curlFails) return callback(new Error('network down'), Buffer.alloc(0), '')
        if(url.includes('/feeds/')) return callback(null, Buffer.from(FEED_XML, 'utf16le'), '')
        if(url.includes('/article/')) return callback(null, Buffer.from(ARTICLE_HTML, 'utf8'), '')
        callback(new Error(`unexpected curl ${url}`), Buffer.alloc(0), '')
    }

    vi.stubGlobal('fetch', vi.fn(async(url) => {
        calls.push(url)
        if(url.includes('generativelanguage')){
            const json = geminiStatus === 200
                ? {candidates: [{content: {parts: [{text: '- 摘要內容', thoughtSignature: 'xxx'}]}}]}
                : {error: {code: geminiStatus}}
            return response(Buffer.from(JSON.stringify(json), 'utf8'), geminiStatus)
        }
        throw new Error(`unexpected fetch ${url}`)
    }))
    return calls
}

describe('runCheck', () => {
    beforeEach(() => {
        process.env.GEMINI_API_KEY = 'test-key'
    })

    afterEach(() => {
        delete process.env.GEMINI_API_KEY
        //忘了 stubNetwork 的測試要當場炸掉，不要沿用上一條的 handler 安靜地跑過去
        curl.handler = null
    })

    it('首次執行：什麼都不發，只記住收錄的網址', async() => {
        stubNetwork()
        const client = makeClient()
        const report = await feed.runCheck(client, 'test')

        expect(client.sent).toEqual([])
        expect(report.message).toContain('首次執行')
        expect(await state.getState(feed.SECTION)).toEqual({initialized: true, seen: [SNAPSHOT_7, SNAPSHOT_6]})
    })

    it('seen 少了一篇 → 補發那一篇：開討論串、貼標題與兩種摘要、貼通知', async() => {
        await state.setState(feed.SECTION, {initialized: true, seen: [SNAPSHOT_6]})
        stubNetwork()
        const client = makeClient()
        const report = await feed.runCheck(client, 'test')

        expect(report.posted).toEqual(['Minecraft 26.4 Snapshot 7'])
        expect(client.threads).toEqual(['Minecraft 26.4 Snapshot 7'])

        const inThread = client.sent.filter((m) => m.channel === 'thread-1').map((m) => m.content)
        expect(inThread[0]).toContain(SNAPSHOT_7)
        expect(inThread[1]).toContain('【中文摘要】')
        expect(inThread[2]).toContain('【日本語要約】')
        expect(inThread.join('\n')).not.toContain('xxx')

        const notice = client.sent.find((m) => m.channel !== 'thread-1')
        expect(notice.content).toContain('thread-1')

        expect((await state.getState(feed.SECTION)).seen).toEqual([SNAPSHOT_6, SNAPSHOT_7])
    })

    it('Gemini 全部失敗 → 退回貼原文，這篇仍然算處理完', async() => {
        await state.setState(feed.SECTION, {initialized: true, seen: [SNAPSHOT_6]})
        stubNetwork({geminiStatus: 503})
        const client = makeClient()
        const report = await feed.runCheck(client, 'test')

        expect(report.posted).toHaveLength(1)
        const inThread = client.sent.filter((m) => m.channel === 'thread-1').map((m) => m.content)
        expect(inThread[1]).toContain('AI 摘要無法產生')
        expect(inThread.join('\n')).toContain('Added Calcite Blockset')
        expect((await state.getState(feed.SECTION)).seen).toContain(SNAPSHOT_7)
    })

    it('更新內容頻道不存在 → 不崩潰、seen 沒有被寫入', async() => {
        await state.setState(feed.SECTION, {initialized: true, seen: [SNAPSHOT_6]})
        stubNetwork()
        //jail 的 .env 會決定是哪個環境，所以從 config 拿，不寫死 id
        const client = makeClient({missing: [config.channels.minecraftContent]})
        const report = await feed.runCheck(client, 'test')

        expect(report.failed).toEqual(['Minecraft 26.4 Snapshot 7'])
        expect(client.sent).toEqual([])
        expect((await state.getState(feed.SECTION)).seen).toEqual([SNAPSHOT_6])
    })

    it('RSS 抓取失敗 → seen 不動', async() => {
        await state.setState(feed.SECTION, {initialized: true, seen: [SNAPSHOT_6]})
        stubNetwork({curlFails: true})
        const report = await feed.runCheck(makeClient(), 'test')

        expect(report.message).toContain('RSS 抓取失敗')
        expect(await state.getState(feed.SECTION)).toEqual({initialized: true, seen: [SNAPSHOT_6]})
    })

    it('指定網址補發：跳過 RSS、照給的順序發、標題取自文章頁、寫進 seen', async() => {
        await state.setState(feed.SECTION, {initialized: true, seen: []})
        const calls = stubNetwork()
        const client = makeClient()
        const report = await feed.runCheck(client, 'test', [SNAPSHOT_6, SNAPSHOT_7])

        //完全不碰 feed
        expect(calls.some((url) => url.includes('/feeds/'))).toBe(false)
        //標題是文章頁的 og:title，不是從網址猜的
        expect(report.posted).toEqual(['Minecraft 26.4 Snapshot 7', 'Minecraft 26.4 Snapshot 7'])
        expect((await state.getState(feed.SECTION)).seen).toEqual([SNAPSHOT_6, SNAPSHOT_7])
    })

    it('補發時某一篇抓不到 → 只有那篇不寫 seen，其他照發', async() => {
        await state.setState(feed.SECTION, {initialized: true, seen: []})
        stubNetwork()
        const good = curl.handler
        curl.handler = (url, callback) => (url === SNAPSHOT_6
            ? callback(new Error('404'), Buffer.alloc(0), '')
            : good(url, callback))

        const report = await feed.runCheck(makeClient(), 'test', [SNAPSHOT_6, SNAPSHOT_7])

        expect(report.failed).toEqual([SNAPSHOT_6])
        expect((await state.getState(feed.SECTION)).seen).toEqual([SNAPSHOT_7])
    })

    it('已經全部看過 → 沒有新文章，也不呼叫 Gemini', async() => {
        await state.setState(feed.SECTION, {initialized: true, seen: [SNAPSHOT_6, SNAPSHOT_7]})
        const calls = stubNetwork()
        const report = await feed.runCheck(makeClient(), 'test')

        expect(report.message).toBe('沒有新文章。')
        expect(calls.some((url) => url.includes('generativelanguage'))).toBe(false)
    })

    it('formatReport 列出數字與標題', () => {
        const text = feed.formatReport({
            message: '發出 1 篇', fetched: 5, kept: 2, dropped: 3, fresh: 1, posted: ['Snapshot 7'], failed: [],
        })
        expect(text).toContain('抓到 5 篇')
        expect(text).toContain('✅ Snapshot 7')
    })
})
