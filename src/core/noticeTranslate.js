import {splitMessage} from '@/core/minecraftFeed'

//公告自動翻日文(U16)的純函式：判斷要不要翻、提示詞、訊息組裝。
//
//這裡刻意不 import discord.js，也不碰 Discord 物件：
//測試 jail 碰到 discord.js 就會卡住，所以能測的部分全部收在這支檔案，
//事件監聽(src/events/noticeTranslate/)只負責把 message 拆成這裡吃的欄位。

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

export default {
    shouldTranslate,
    buildTranslatePrompt,
    buildCredit,
    buildTranslationMessages,
}
