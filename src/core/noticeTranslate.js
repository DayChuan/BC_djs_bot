import config from '@/config'
import mc from '@/config/minecraft'
import {generateText} from '@/core/gemini'
import {splitMessage} from '@/core/minecraftFeed'
import {enqueue, registerKind, isRetryable, jobId, notifyKeyFailure} from '@/core/geminiQueue'
import logger from '@/core/logger'

//公告自動翻日文(U16)：判斷要不要翻、提示詞、訊息組裝，以及翻譯流程與佇列處理器。
//
//這裡刻意不 import discord.js：Discord 物件(message、client)一律從外面傳進來，
//測試才能用假物件跑整條流程(測試 jail 碰到 discord.js 就會卡住)。
//事件監聽(src/events/noticeTranslate/)只負責擋 bot 並呼叫 translateMessage()。

export const KIND = 'translate'

//翻譯失敗、排進佇列時加在原公告上的反應，補上或放棄時拿掉
export const PENDING_REACTION = '⏳'

//要不要翻這則訊息。
//⚠️ bot 一定要擋：機器人貼出的譯文也是同頻道的新訊息，不擋就會翻自己的翻譯，
//幾秒內灌爆頻道並撞上 Discord rate limit。這是這個功能唯一會造成實質損害的風險。
//noticeChannelId 沒設定(該環境沒有公告頻道)時一律不翻。
//只有圖片／貼圖的訊息 content 是空字串，不翻(單元檔「不做的事」)。
export const shouldTranslate = ({bot, channelId, content} = {}, noticeChannelId) => {
    if(bot) return false
    if(!noticeChannelId || channelId !== noticeChannelId) return false
    return String(content || '').trim().length > 0
}

//提及字串(<@123>、<#123>、<@&123>、:emoji:)一旦被翻掉就變成純文字，
//點不開也 tag 不到人，所以要求原樣保留。
export const buildTranslatePrompt = (text) =>
    '以下は Discord サーバーのお知らせ（中国語）です。日本語に翻訳してください：\n' +
    '- 訳文だけを出力し、前置き・説明・中国語の原文は書かない\n' +
    '- 改行と箇条書きの構造は原文のまま保つ\n' +
    '- <@123>、<#123>、<@&123>、:emoji: の形式のメンションや絵文字、URL は翻訳せず、そのまま残す\n\n' +
    `---\n${String(text || '').trim()}`

//第一行是 Discord 的小字(subtext)標註，讓人知道這是 AI 翻的、哪個模型翻的。
//late = 佇列稍後補上的(原訊息當下翻譯失敗)，標註要說清楚，不然看起來像重複貼。
export const buildCredit = (model, {late = false} = {}) => {
    const by = model ? `Gemini ${model}` : 'Gemini'
    return late ? `-# ⏳ 後から追加された AI 翻訳（${by}）` : `-# 🤖 AI 翻訳（${by}）`
}

//譯文 → 訊息陣列。譯文可能超過 2000 字(Discord 超長會整則被退回)，一律過 splitMessage。
export const buildTranslationMessages = (text, model, {late = false} = {}) =>
    splitMessage(`${buildCredit(model, {late})}\n\n${String(text || '').trim()}`)

//管理員通知上的「項目」：公告開頭幾個字，看得出是哪一則
export const buildJobLabel = (text, max = 30) => {
    const head = String(text || '').replace(/\s+/g, ' ').trim()
    //不寫成巢狀樣板字串：moduleLayout.test.js 的括號掃描不認得 ${} 裡的反引號
    const short = head.length > max ? head.slice(0, max) + '…' : head
    return `公告翻譯：${short}`
}

/////////////////////////// 翻譯流程(用傳進來的 Discord 物件) ///////////////////////////

//回覆時不解析任何提及：公告裡常有 @everyone，譯文不能再 tag 一次全體；
//repliedUser: false 是不要因為「回覆」而再 ping 發公告的人一次。
const ALLOWED_MENTIONS = {parse: [], repliedUser: false}

//原公告或頻道已經不在了：10003 Unknown Channel、10008 Unknown Message
const GONE_CODES = [10003, 10008]

const translate = (text, label) => generateText(buildTranslatePrompt(text), {
    models: mc.GEMINI_MODELS,
    timeoutMs: mc.GEMINI_TIMEOUT_MS,
    label,
})

//每段都用 reply，被切成多則時每一則都連得回原公告
const replyAll = async(message, messages) => {
    for(const content of messages){
        await message.reply({content, allowedMentions: ALLOWED_MENTIONS})
    }
}

//拿掉機器人自己加的 ⏳。失敗不影響結果(譯文已經貼出去了)，只記 log。
const removePending = async(client, message) => {
    try{
        const reaction = message.reactions && message.reactions.cache && message.reactions.cache.get(PENDING_REACTION)
        if(reaction) await reaction.users.remove(client.user.id)
    }
    catch(e){
        logger.warn(`公告翻譯：拿掉 ${PENDING_REACTION} 失敗(已略過)：message=${message.id}：${e && e.message}`)
    }
}

//收到一則訊息時的完整流程。回傳結果分類(給測試與 log 用)，Discord 的錯誤往外拋給事件檔記錄。
//⚠️ bot 擋線在 shouldTranslate 裡也有，但事件檔的第一行仍然要自己擋(見事件檔)。
export const translateMessage = async(message) => {
    const input = {bot: message.author && message.author.bot, channelId: message.channelId, content: message.content}
    if(!shouldTranslate(input, config.channels.manualNotice)) return 'skipped'

    const result = await translate(message.content, `Gemini[翻訳] ${message.id}`)

    if(result.text){
        const messages = buildTranslationMessages(result.text, result.model)
        await replyAll(message, messages)
        logger.info(`公告翻譯：message=${message.id} 已回覆 ${messages.length} 則(${result.model})`)
        return 'translated'
    }

    if(!isRetryable(result)){
        //金鑰或請求有問題，重試一百次也一樣，要人去修：不排佇列，直接通知管理員(使用者 2026-11-06 決定)。
        //no-key 是該環境刻意沒設金鑰，gemini.js 已經記過 warn，不通知。
        await notifyKeyFailure(message.client, {label: buildJobLabel(message.content), url: message.url}, result)
        return 'failed'
    }

    const queued = await enqueue(message.client, {
        id: jobId(KIND, message.id),
        kind: KIND,
        channelId: message.channelId,
        messageId: message.id,
        url: message.url,
        label: buildJobLabel(message.content),
        payload: {text: message.content},
    }, result)
    //⏳ 讓人知道「在處理，還沒好」
    if(queued) await message.react(PENDING_REACTION)
    return queued ? 'queued' : 'failed'
}

const fetchMessage = async(client, job) => {
    const channel = await client.channels.fetch(job.channelId)
    return await channel.messages.fetch(job.messageId)
}

//佇列重跑：翻的是當初排入時的文字(不處理訊息編輯，單元檔「不做的事」)
const runJob = async(client, job) => {
    let message
    try{
        message = await fetchMessage(client, job)
    }
    catch(e){
        if(GONE_CODES.includes(e && e.code)) return {drop: '原公告或頻道已被刪除'}
        throw e
    }

    const result = await translate(job.payload && job.payload.text, `Gemini[翻訳] ${job.messageId} 第 ${job.attempts + 1} 次`)
    if(!result.text) return {ok: false, result}

    await replyAll(message, buildTranslationMessages(result.text, result.model, {late: true}))
    await removePending(client, message)
    return {ok: true}
}

//放棄時也拿掉 ⏳，不然它會永遠掛在那裡，看起來像還在處理
const onGiveUp = async(client, job) => {
    await removePending(client, await fetchMessage(client, job))
}

registerKind(KIND, {run: runJob, onGiveUp})

export default {
    KIND,
    PENDING_REACTION,
    shouldTranslate,
    buildTranslatePrompt,
    buildCredit,
    buildTranslationMessages,
    buildJobLabel,
    translateMessage,
}
