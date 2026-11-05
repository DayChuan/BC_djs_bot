import {execFile} from 'node:child_process'
import fs from 'node:fs'
import {XMLParser} from 'fast-xml-parser'
import config from '@/config'
import mc from '@/config/minecraft'
import {generateText} from '@/core/gemini'
import {scheduleCron} from '@/core/scheduler'
import {getState, updateState, registerRestore} from '@/core/state'
import logger from '@/core/logger'

//Minecraft Java 版更新通知(U14)。
//
//這裡刻意不 import discord.js：開討論串要的頻道類型直接寫數值(PUBLIC_THREAD)，
//這樣測試檔才能 import 這支檔案測純函式(測試 jail 碰到 discord.js 就會卡住)。
//
//⚠️ 這支檔案要有人 import 才會被載入，排程也才登記得上：
//loader 只掃 src/commands/ 與 src/events/。目前靠 src/commands/mc_check/index.js 匯入。
//
//feed 的實際形狀(2026-11-04 實測，詳見單元檔「14-0 結論」)：
//UTF-16LE 無 BOM、沒有 guid 也沒有 <link>(連結在 <a10:link href>)、
//description 只有摘要、pubDate 結尾是「 Z」。

export const SECTION = 'minecraft'

export const JOB_KEY = 'minecraft:feed'

//discord.js 的 ChannelType.PublicThread
const PUBLIC_THREAD = 11

/////////////////////////// 純函式：解碼與解析 ///////////////////////////

//依開頭的 bytes 判斷編碼。feed 宣告 utf-16 卻沒有 BOM，res.text() 會一律當 UTF-8 解，
//解出夾著 NUL 的亂碼，之後解析「安靜地」拿到 0 篇 —— 所以一定要自己看 bytes。
//判斷依據一併回傳，讓呼叫端記進 log。
export const decodeBytes = (input) => {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || [])
    if(bytes.length === 0) return {text: '', encoding: 'empty', reason: '沒有內容'}

    const [b0, b1, b2] = bytes

    if(b0 === 0xFF && b1 === 0xFE){
        return {text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', reason: 'BOM FF FE'}
    }
    if(b0 === 0xFE && b1 === 0xFF){
        return {text: decodeUtf16be(bytes.subarray(2)), encoding: 'utf-16be', reason: 'BOM FE FF'}
    }
    if(b0 === 0xEF && b1 === 0xBB && b2 === 0xBF){
        return {text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', reason: 'BOM EF BB BF'}
    }
    if(bytes.length >= 2 && b0 !== 0 && b1 === 0){
        return {text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le', reason: '無 BOM，第 2 個 byte 是 00'}
    }
    if(bytes.length >= 2 && b0 === 0 && b1 !== 0){
        return {text: decodeUtf16be(bytes), encoding: 'utf-16be', reason: '無 BOM，第 1 個 byte 是 00'}
    }
    return {text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8', reason: '無 BOM，前兩個 byte 都不是 00'}
}

//Node 的 utf-16be 解碼要完整 ICU，jail 裡的 Node 不一定有，所以自己對調 byte 再用 le 解
const decodeUtf16be = (bytes) => {
    const swapped = new Uint8Array(bytes.length - (bytes.length % 2))
    for(let i = 0; i < swapped.length; i += 2){
        swapped[i] = bytes[i + 1]
        swapped[i + 1] = bytes[i]
    }
    return new TextDecoder('utf-16le').decode(swapped)
}

//HTML／XML 實體。一次掃過：先換 &amp; 再換其他的話，&amp;#39; 會被解兩層。
const NAMED_ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '}

export const decodeEntities = (text) => String(text === undefined || text === null ? '' : text)
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name) => {
        if(name[0] === '#'){
            const code = name[1] === 'x' || name[1] === 'X'
                ? parseInt(name.slice(2), 16)
                : parseInt(name.slice(1), 10)
            return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole
        }
        const value = NAMED_ENTITIES[name.toLowerCase()]
        return value === undefined ? whole : value
    })

//「Tue, 03 Nov 2026 18:00:03 Z」：結尾的 Z 不是 RFC 822 的寫法，換成 GMT 再解析。
//解析不了回 NaN，排序時排到最後(不讓一篇日期壞掉的文章卡住其他篇)。
export const parseDate = (raw) => {
    const text = String(raw === undefined || raw === null ? '' : raw).trim().replace(/\s+Z$/, ' GMT')
    const time = Date.parse(text)
    return Number.isFinite(time) ? time : NaN
}

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    //標題是「26.4」這種字樣時不要被轉成數字
    parseTagValue: false,
    isArray: (name) => name === 'item',
})

const firstOf = (value) => (Array.isArray(value) ? value[0] : value)

const textOf = (value) => {
    const one = firstOf(value)
    if(one === undefined || one === null) return ''
    if(typeof one === 'object') return String(one['#text'] || '')
    return String(one)
}

const linkOf = (item) => {
    //這個 feed 的連結在 <a10:link href="...">；一般 RSS 的 <link> 當備援
    const atom = firstOf(item['a10:link'])
    if(atom && typeof atom === 'object' && atom['@_href']) return String(atom['@_href']).trim()
    return textOf(item.link).trim()
}

//回 [{title, link, pubDate, time}]。壞掉、空字串、不是 XML 一律回 []，不丟例外。
export const parseFeed = (xml) => {
    try{
        if(!xml || typeof xml !== 'string') return []
        const doc = xmlParser.parse(xml)
        const items = doc?.rss?.channel?.item
        if(!Array.isArray(items)) return []

        return items
            .map((item) => ({
                title: decodeEntities(textOf(item.title)).trim(),
                link: linkOf(item),
                pubDate: textOf(item.pubDate).trim(),
            }))
            .filter((item) => item.title && item.link)
            .map((item) => ({...item, time: parseDate(item.pubDate)}))
    }
    catch{
        return []
    }
}

/////////////////////////// 純函式：過濾與比對 ///////////////////////////

//排除優先：同時含收錄字與排除字的標題一律不收
export const matchesTitle = (title, include = mc.INCLUDE_KEYWORDS, exclude = mc.EXCLUDE_KEYWORDS) => {
    const lower = String(title || '').toLowerCase()
    if(exclude.some((word) => lower.includes(word.toLowerCase()))) return false
    return include.some((word) => lower.includes(word.toLowerCase()))
}

export const filterItems = (items, include, exclude) => {
    const kept = []
    const dropped = []
    for(const item of items) (matchesTitle(item.title, include, exclude) ? kept : dropped).push(item)
    return {kept, dropped}
}

const byTimeAsc = (a, b) => {
    const ta = Number.isFinite(a.time) ? a.time : Infinity
    const tb = Number.isFinite(b.time) ? b.time : Infinity
    return ta - tb
}

//算出這次要發哪些。
//首次執行看 initialized 旗標而不是「seen 是空的」：第一次剛好沒有 Java 文章時 seen 會是空的，
//用 seen 判斷的話之後每一輪都會被當成首次，真的來了新文章也不會發。
export const planPosts = (kept, state = {}) => {
    if(!state.initialized){
        return {firstRun: true, toPost: [], remember: kept.map((item) => item.link)}
    }
    const seen = new Set(Array.isArray(state.seen) ? state.seen : [])
    const toPost = kept.filter((item) => !seen.has(item.link)).sort(byTimeAsc)
    return {firstRun: false, toPost, remember: []}
}

//由舊到新排列，超過上限就從最舊的丟。已經在裡面的不重複加。
export const addSeen = (seen, links, limit = mc.SEEN_LIMIT) => {
    const list = Array.isArray(seen) ? [...seen] : []
    for(const link of links){
        if(link && !list.includes(link)) list.push(link)
    }
    return list.length > limit ? list.slice(list.length - limit) : list
}

/////////////////////////// 純函式：文章頁 → 純文字 ///////////////////////////

//內文在 class="article-text" 之後的第一個 MC_Link_Style_RichText，
//到分享列(mc_social_socialShareA)為止。MC_Link_Style_RichText 頁尾的文章列表也有兩個，
//所以一定要從 article-text 之後找。找不到就回空字串，呼叫端當作失敗。
export const extractArticleBody = (html) => {
    const source = String(html || '')
    const anchor = source.indexOf('class="article-text"')
    if(anchor < 0) return ''
    const box = source.indexOf('MC_Link_Style_RichText', anchor)
    if(box < 0) return ''
    const start = source.indexOf('>', box)
    const share = source.indexOf('mc_social_socialShareA', start)
    if(start < 0 || share < 0) return ''
    //切在分享列那個標籤的開頭，不要切在標籤中間
    const end = source.lastIndexOf('<', share)
    return end > start ? source.slice(start + 1, end) : ''
}

const stripTags = (html) => String(html).replace(/<[^>]*>/g, '')

//轉成 Discord 能讀的純文字：標題轉 ##、清單依巢狀層級縮排、實體解碼。
//原始 HTML 裡的換行只是排版用的空白，要先壓成空格，再由標籤決定哪裡換行；
//只有 <pre> 裡的換行是真的，先抽出來最後再放回去。
export const htmlToText = (html) => {
    const blocks = []
    let text = String(html || '')
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (whole, inner) => {
            blocks.push(decodeEntities(stripTags(inner)).replace(/^\n+|\s+$/g, ''))
            return `\u0000${blocks.length - 1}\u0000`
        })
        .replace(/\s+/g, ' ')

    text = text
        .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (whole, inner) => '`' + stripTags(inner) + '`')
        .replace(/<h([2-5])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (whole, level, inner) => {
            const title = stripTags(inner).trim()
            if(!title) return ''
            if(level === '2') return `\n\n## ${title}\n`
            if(level === '3') return `\n\n### ${title}\n`
            return `\n\n**${title}**\n`
        })
        .replace(/<br\s*\/?>/gi, '\n')

    let depth = 0
    text = text.replace(/<(\/?)(ul|ol|li)\b[^>]*>/gi, (whole, closing, tag) => {
        const name = tag.toLowerCase()
        if(name === 'li') return closing ? '' : `\n${'  '.repeat(Math.max(depth - 1, 0))}- `
        if(closing){
            depth = Math.max(depth - 1, 0)
            return depth === 0 ? '\n\n' : ''
        }
        depth += 1
        return depth === 1 ? '\n' : ''
    })

    text = text.replace(/<\/(p|div|blockquote)>/gi, '\n\n')
    text = decodeEntities(stripTags(text))

    text = text
        .split('\n')
        .map((line) => {
            const trimmed = line.replace(/\s+$/, '')
            //清單的縮排要留著，其他行的前導空白是壓縮空白留下的
            return /^\s*- /.test(trimmed) ? trimmed.replace(/^(\s*- )\s+/, '$1') : trimmed.trimStart()
        })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()

    return text.replace(/\u0000(\d+)\u0000/g, (whole, index) => '\n```\n' + blocks[Number(index)] + '\n```\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

/////////////////////////// 純函式：切段與訊息 ///////////////////////////

const FENCE = '```'

//切出來的那一段的 ``` 是奇數個，代表切在程式碼區塊中間
const opensFence = (chunk) => (chunk.split(FENCE).length - 1) % 2 === 1

//優先在換行處切，其次在句點，都找不到才硬切。
//「找得到」的門檻是半段以後：切在太前面會出現很短的一則。
//切在程式碼區塊中間時，這段補上收尾、下一段補上開頭，所以每段預留 8 個字元。
export const splitMessage = (text, max = mc.MESSAGE_MAX) => {
    const limit = Math.max(max - 8, 20)
    const chunks = []
    let rest = String(text || '').trim()
    let carryFence = false

    while(rest.length > 0){
        if(carryFence) rest = `${FENCE}\n${rest}`

        let piece
        if(rest.length <= limit){
            piece = rest
            rest = ''
        }
        else{
            const window = rest.slice(0, limit)
            let cut = window.lastIndexOf('\n')
            if(cut < limit / 2){
                cut = Math.max(
                    ...['。', '！', '？', '. ', '! ', '? '].map((mark) => {
                        const at = window.lastIndexOf(mark)
                        return at < 0 ? -1 : at + mark.trimEnd().length
                    }),
                )
            }
            if(cut < limit / 2) cut = limit
            piece = rest.slice(0, cut)
            rest = rest.slice(cut).trim()
        }

        piece = piece.trim()
        carryFence = opensFence(piece)
        if(carryFence) piece = `${piece}\n${FENCE}`
        if(piece) chunks.push(piece)
    }

    return chunks
}

export const buildThreadName = (title, max = mc.THREAD_NAME_MAX) => {
    const name = String(title || '').trim() || 'Minecraft 更新'
    return name.length > max ? `${name.slice(0, max - 1)}…` : name
}

const SUMMARY_LANGS = {
    zh: {
        heading: '**【中文摘要】**',
        failed: '（中文摘要產生失敗，請看原文）',
        prompt: (title, body, max) =>
            `以下是 Minecraft Java 版官方更新文章「${title}」的內容。請用繁體中文（台灣用語）整理重點摘要：\n` +
            '- 條列式，先列最重要的新內容與改動\n' +
            '- 方塊、生物、物品等名稱在中文後面用括號附上英文原名\n' +
            `- 總長不超過 ${max} 字\n` +
            '- 只輸出摘要本身，不要開場白或結語\n\n' +
            `---\n${body}`,
    },
    ja: {
        heading: '**【日本語要約】**',
        failed: '（日本語の要約を生成できませんでした。原文をご覧ください）',
        prompt: (title, body, max) =>
            `以下は Minecraft Java 版の公式アップデート記事「${title}」の本文です。日本語で要点をまとめてください：\n` +
            '- 箇条書きで、最も重要な新要素と変更点から順に\n' +
            '- ブロック・モブ・アイテムなどの名前は日本語の後に括弧で英語の原名を付ける\n' +
            `- 全体で ${max} 文字以内\n` +
            '- 要約だけを出力し、前置きや締めの言葉は書かない\n\n' +
            `---\n${body}`,
    },
}

export const LANGS = Object.keys(SUMMARY_LANGS)

export const buildSummaryPrompt = (lang, title, body, max = mc.SUMMARY_MAX_CHARS) =>
    SUMMARY_LANGS[lang].prompt(title, body, max)

//一種語言的摘要 → 訊息陣列。摘要失敗(text 是 null)就是一行失敗說明。
export const buildSummaryMessages = (lang, text, max = mc.MESSAGE_MAX) => {
    const {heading, failed} = SUMMARY_LANGS[lang]
    return splitMessage(`${heading}\n${text || failed}`, max)
}

//討論串的第一則：標題與原文連結
export const buildHeaderMessage = (item) => `**${item.title}**\n原文：${item.link}`

//摘要全部失敗時退回貼原文，最多 maxMessages 則，超過的部分請大家看原文
export const buildFallbackMessages = (body, link, maxMessages = mc.FALLBACK_MAX_MESSAGES, max = mc.MESSAGE_MAX) => {
    const prefix = '（AI 摘要無法產生，以下為原文）\n'
    const notice = `\n\n（以下省略，完整內容見原文：${link}）`
    //預留前後綴的長度，加上去之後仍然不超過上限
    const chunks = splitMessage(body, max - prefix.length - notice.length)
    if(chunks.length === 0) return []

    const kept = chunks.slice(0, maxMessages)
    kept[0] = prefix + kept[0]
    if(chunks.length > maxMessages) kept[kept.length - 1] += notice
    return kept
}

export const buildNotice = (item, threadUrl) =>
    `🆕 **${item.title}**\n原文：${item.link}` + (threadUrl ? `\n討論串：${threadUrl}` : '')

//給 /mc_check 看的結果。編排成一則短訊息，不超過上限。
export const formatReport = (report) => {
    if(!report) return '沒有結果。'
    const lines = [`**Minecraft 更新檢查**：${report.message}`]
    if(Number.isInteger(report.fetched)){
        lines.push(`抓到 ${report.fetched} 篇｜收錄 ${report.kept} 篇｜過濾掉 ${report.dropped} 篇｜新的 ${report.fresh} 篇`)
    }
    for(const title of report.posted || []) lines.push(`✅ ${title}`)
    for(const title of report.failed || []) lines.push(`⚠️ ${title}`)
    const text = lines.join('\n')
    return text.length > mc.MESSAGE_MAX ? `${text.slice(0, mc.MESSAGE_MAX - 1)}…` : text
}

/////////////////////////// 抓取 ///////////////////////////

/**
 * 用 curl 抓，不用 Node 的 fetch。
 *
 * 2026-11-05 在測試 jail 實測，同一台機器、同一個 UA、同一個網址：
 *   curl -A "Mozilla/5.0"            → 200
 *   node fetch 同一個 UA              → 403（feed 與文章頁都是）
 *   node fetch ＋ 完整瀏覽器 header   → 403
 * 可重現，不是暫時性的。minecraft.net 前面的 Akamai 看的是 TLS 與請求指紋，
 * 那是 header 改不掉的東西，而 undici 跟 curl 的指紋天差地遠。
 *
 * 幾個參數的理由：
 *   encoding: 'buffer'  feed 是 UTF-16LE，當字串收會在這一步就毀掉
 *   -f                  HTTP 錯誤時讓 curl 以非零結束，才接得到
 *   -S                  錯誤訊息留在 stderr，寫得進 log
 *   -L                  跟著轉址
 *   --max-time          curl 自己的逾時；execFile 的 timeout 再包一層，
 *                       防的是 curl 卡在別的地方（例如 DNS）完全不回來
 */
const fetchBytes = (url) => new Promise((resolve, reject) => {
    execFile(
        mc.CURL_PATH,
        ['-sSfL', '-A', mc.USER_AGENT, '--max-time', String(Math.ceil(mc.FETCH_TIMEOUT_MS / 1000)), url],
        {encoding: 'buffer', timeout: mc.FETCH_TIMEOUT_MS + 5000, maxBuffer: 32 * 1024 * 1024},
        (error, stdout, stderr) => {
            if(error){
                const detail = String(stderr || '').trim() || error.message
                //curl 的 22 是「HTTP 回了 400 以上」，訊息裡會帶狀態碼
                reject(new Error(`curl 失敗(exit ${error.code ?? '?'})：${detail}`))
                return
            }
            resolve(new Uint8Array(stdout))
        },
    )
})

//失敗回 null，不往外拋
const fetchFeed = async() => {
    try{
        const bytes = await fetchBytes(mc.FEED_URL)
        const {text, encoding, reason} = decodeBytes(bytes)
        logger.info(`Minecraft feed：${bytes.length} bytes，判斷為 ${encoding}(${reason})`)
        return text
    }
    catch(e){
        logger.warn(`Minecraft feed 抓取失敗，這次不處理：${e && e.message}`)
        return null
    }
}

const fetchArticleText = async(link) => {
    try{
        const {text: html} = decodeBytes(await fetchBytes(link))
        const body = extractArticleBody(html)
        if(!body){
            logger.warn(`Minecraft 文章頁找不到內文區塊(網站可能改版)：${link}`)
            return ''
        }
        return htmlToText(body)
    }
    catch(e){
        logger.warn(`Minecraft 文章頁抓取失敗：${link}：${e && e.message}`)
        return ''
    }
}

/////////////////////////// 貼文 ///////////////////////////

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fetchChannel = async(client, id, label) => {
    try{
        const channel = await client.channels.fetch(id)
        if(channel) return channel
    }
    catch(e){
        logger.warn(`Minecraft：${label} ${id} 取得失敗：${e && e.message}`)
        return null
    }
    logger.warn(`Minecraft：${label} ${id} 不存在`)
    return null
}

//只送純文字，不解析任何提及(文章或摘要裡出現 @everyone 也不能真的 tag 到人)
const sendText = (target, content) => target.send({content, allowedMentions: {parse: []}})

//兩種語言各自呼叫、各自判斷；都失敗或沒有 key → 退回貼原文
const buildContentMessages = async(item, body) => {
    const results = {}
    for(const lang of LANGS){
        results[lang] = await generateText(buildSummaryPrompt(lang, item.title, body), {
            models: mc.GEMINI_MODELS,
            timeoutMs: mc.GEMINI_TIMEOUT_MS,
            label: `Gemini[${lang}] ${item.title}`,
        })
    }

    const succeeded = LANGS.filter((lang) => results[lang].text)
    if(succeeded.length === 0){
        logger.warn(`Minecraft：「${item.title}」兩種摘要都失敗，退回貼原文(最多 ${mc.FALLBACK_MAX_MESSAGES} 則)`)
        return buildFallbackMessages(body, item.link)
    }

    logger.info(
        `Minecraft：「${item.title}」摘要 ` +
        LANGS.map((lang) => `${lang}=${results[lang].model || '失敗'}`).join(' ')
    )
    return LANGS.flatMap((lang) => buildSummaryMessages(lang, results[lang].text))
}

//回傳 {ok, url}。ok = 內容至少貼出了第一則(標題那則)，這篇就算處理完、可以寫 seen。
const postArticle = async(client, item) => {
    const body = await fetchArticleText(item.link)
    if(!body) return {ok: false}

    const parent = await fetchChannel(client, config.channels.minecraftContent, '更新內容頻道')
    if(!parent) return {ok: false}

    const messages = [buildHeaderMessage(item), ...await buildContentMessages(item, body)]

    let target = parent
    let thread = null

    //設定的「更新內容頻道」本身就是一個討論串時，直接貼進去，不要再開新的
    //(討論串裡也開不出討論串)。2026-11-05 使用者確認這是刻意的設定：
    //更新量是一個月幾篇，全部累積在同一串比每次開一條新的好找，
    //也不會讓頻道側邊欄長出一排討論串。
    if(parent.isThread && parent.isThread()){
        logger.info(`Minecraft：更新內容目標本身是討論串 ${parent.id}，直接貼進去`)
    }
    else if(typeof (parent.threads && parent.threads.create) === 'function'){
        try{
            thread = await parent.threads.create({
                name: buildThreadName(item.title),
                //上限 7 天
                autoArchiveDuration: 10080,
                type: PUBLIC_THREAD,
                reason: `Minecraft 更新：${item.title}`,
            })
            //刻意不鎖定：這個功能的目的就是讓大家在串裡討論(同 pollService.openPollThread)
            target = thread
        }
        catch(e){
            logger.warn(`Minecraft：討論串開不出來，改貼在更新內容頻道：${e && e.message}`)
        }
    }
    else{
        logger.warn(`Minecraft：更新內容頻道 ${parent.id} 不支援討論串，改直接貼在頻道裡`)
    }


    let first = null
    try{
        first = await sendText(target, messages[0])
    }
    catch(e){
        logger.warn(`Minecraft：「${item.title}」第一則貼不出去，這篇不算處理完：${e && e.message}`)
        //留著空的討論串的話，下一輪重試會再開一個
        if(thread) await thread.delete().catch(() => undefined)
        return {ok: false}
    }

    for(const content of messages.slice(1)){
        try{
            await sendText(target, content)
        }
        catch(e){
            //第一則已經出去了，這篇算處理完；重來的話會重複開討論串
            logger.warn(`Minecraft：「${item.title}」有一則貼不出去(已略過)：${e && e.message}`)
        }
    }

    logger.info(`Minecraft：「${item.title}」已貼出 ${messages.length} 則到 ${thread ? '討論串' : '更新內容頻道'}`)
    return {ok: true, url: thread ? thread.url : first.url}
}

//通知失敗只記 log：內容已經搬過去了，不能因為通知失敗重搬一次
const postNotice = async(client, item, url) => {
    const id = config.channels.minecraftNotice
    if(!id){
        logger.warn(`環境「${config.name}」沒有設定 channels.minecraftNotice，不發通知`)
        return
    }
    const channel = await fetchChannel(client, id, '通知頻道')
    if(!channel) return
    try{
        await sendText(channel, buildNotice(item, url))
    }
    catch(e){
        logger.warn(`Minecraft：「${item.title}」通知貼不出去(內容已貼，不重發)：${e && e.message}`)
    }
}

/////////////////////////// 一次檢查 ///////////////////////////

//排程與 /mc_check 同時觸發的話，同一篇會被貼兩次
let running = false

//回傳 report 給 /mc_check 顯示。不往外拋錯(排程那端也有 runSafely，但這裡自己先接住)。
export const runCheck = async(client, trigger = 'cron') => {
    if(running){
        logger.warn(`Minecraft 檢查(${trigger})：上一次還沒跑完，這次略過`)
        return {message: '上一次檢查還沒跑完，這次略過。'}
    }
    running = true
    try{
        return await check(client, trigger)
    }
    catch(e){
        logger.error(`Minecraft 檢查(${trigger})失敗：`, e)
        return {message: '檢查時發生錯誤，請看 log。'}
    }
    finally{
        running = false
    }
}

const check = async(client, trigger) => {
    if(!config.channels.minecraftContent){
        logger.warn(`環境「${config.name}」沒有設定 channels.minecraftContent，Minecraft 更新通知不啟用`)
        return {message: '沒有設定更新內容頻道，功能未啟用。'}
    }

    const xml = await fetchFeed()
    if(xml === null) return {message: 'RSS 抓取失敗，請看 log。'}

    const items = parseFeed(xml)
    if(items.length === 0){
        logger.warn('Minecraft feed 解析出 0 篇(格式可能變了)，這次不處理')
        return {message: 'RSS 解析出 0 篇，請看 log。'}
    }

    const {kept, dropped} = filterItems(items)
    logger.info(
        `Minecraft 檢查(${trigger})：抓到 ${items.length} 篇，收錄 ${kept.length} 篇，過濾掉 ${dropped.length} 篇` +
        (dropped.length ? `：${dropped.map((item) => item.title).join('｜')}` : '')
    )

    const state = await getState(SECTION)
    const plan = planPosts(kept, state)
    const counts = {fetched: items.length, kept: kept.length, dropped: dropped.length}

    if(plan.firstRun){
        await updateState(SECTION, (current) => {
            current.initialized = true
            current.seen = addSeen(current.seen, plan.remember)
        })
        logger.info(`Minecraft：首次執行，記住 ${plan.remember.length} 篇，不發送`)
        return {...counts, fresh: 0, message: `首次執行，記住 ${plan.remember.length} 篇，不發送。`}
    }

    logger.info(
        `Minecraft：扣掉看過的剩 ${plan.toPost.length} 篇` +
        (plan.toPost.length ? `：${plan.toPost.map((item) => item.title).join('｜')}` : '')
    )

    const posted = []
    const failed = []
    for(const [index, item] of plan.toPost.entries()){
        if(index > 0) await sleep(mc.POST_INTERVAL_MS)

        const result = await postArticle(client, item)
        if(!result.ok){
            //不寫 seen：寫了的話這篇就永遠不會補發
            failed.push(item.title)
            continue
        }

        //一篇寫一次，後面某篇失敗不會連累前面已經貼出去的
        await updateState(SECTION, (current) => {
            current.initialized = true
            current.seen = addSeen(current.seen, [item.link])
        })
        posted.push(item.title)
        await postNotice(client, item, result.url)
    }

    const message = plan.toPost.length === 0
        ? '沒有新文章。'
        : `發出 ${posted.length} 篇，失敗 ${failed.length} 篇(失敗的下一輪會重試)。`
    return {...counts, fresh: plan.toPost.length, posted, failed, message}
}

//記憶體裡的排程在重啟時全部消失，所以每次開機都要重掛(同 dailyJapanese.js)
const restore = async(client) => {
    //開機就檢查 curl 在不在。不檢查的話要等第一次排程才發現，
    //而那時只會看到一行「抓取失敗」，不會知道是工具不見了。
    if(!fs.existsSync(mc.CURL_PATH)){
        logger.error(
            `Minecraft 更新通知：找不到 ${mc.CURL_PATH}，抓取一定會失敗。` +
            '這個功能用 curl 而不是 Node 的 fetch，理由見 src/config/minecraft.js'
        )
    }

    scheduleCron(JOB_KEY, mc.CHECK_CRON, () => runCheck(client, 'cron'))
}

registerRestore(SECTION, restore)

export default {
    SECTION,
    JOB_KEY,
    decodeBytes,
    decodeEntities,
    parseDate,
    parseFeed,
    matchesTitle,
    filterItems,
    planPosts,
    addSeen,
    extractArticleBody,
    htmlToText,
    splitMessage,
    buildThreadName,
    buildSummaryPrompt,
    buildSummaryMessages,
    buildHeaderMessage,
    buildFallbackMessages,
    buildNotice,
    formatReport,
    runCheck,
}
