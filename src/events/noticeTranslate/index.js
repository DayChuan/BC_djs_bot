import {Events} from 'discord.js'
import config from '@/config'
import mc from '@/config/minecraft'
import {generateText} from '@/core/gemini'
import {shouldTranslate, buildTranslatePrompt, buildTranslationMessages} from '@/core/noticeTranslate'
import logger from '@/core/logger'

//手動公告頻道的中文公告 → 自動回覆日文譯文(U16)。
//判斷與訊息組裝都在 core/noticeTranslate.js(純函式、有測試)，這裡只接 Discord 物件。
//loader 對每個 events/**/index.js 各做一次 client.on()，跟 Message_listening 並存不會互相蓋掉。

export const event = {
    name: Events.MessageCreate,
}

//回覆時不解析任何提及：公告裡常有 @everyone，譯文不能再 tag 一次全體；
//repliedUser: false 是不要因為「回覆」而再 ping 發公告的人一次。
const ALLOWED_MENTIONS = {parse: [], repliedUser: false}

export const action = async(message) => {
    if(message.author.bot) return
    //⚠️ 上面這行必須是第一行(tests/noticeTranslate.test.js 會檢查)：
    //不擋的話機器人會翻自己貼出的譯文，再翻那則譯文……幾秒內灌爆頻道。

    try{
        const input = {bot: message.author.bot, channelId: message.channelId, content: message.content}
        if(!shouldTranslate(input, config.channels.manualNotice)) return

        const result = await generateText(buildTranslatePrompt(message.content), {
            models: mc.GEMINI_MODELS,
            timeoutMs: mc.GEMINI_TIMEOUT_MS,
            label: `Gemini[翻訳] ${message.id}`,
        })

        if(!result.text){
            //只有 all-failed(尖峰、逾時、額度)值得之後重試；金鑰類的錯誤重試一百次也一樣，
            //要人去修，所以記 ERROR。no-key 是該環境刻意沒設金鑰，gemini.js 已經記過 warn。
            //TODO(U16-5)：all-failed 排進佇列並在原訊息加 ⏳
            if(result.reason === 'all-failed'){
                logger.warn(`公告翻譯失敗(${result.quota ? '429 額度用完' : '模型都失敗'})：message=${message.id}`)
            }
            else if(result.reason !== 'no-key'){
                logger.error(`公告翻譯失敗，金鑰或請求有問題(${result.reason})，不會自動重試：message=${message.id}`)
            }
            return
        }

        const messages = buildTranslationMessages(result.text, result.model)
        for(const content of messages){
            await message.reply({content, allowedMentions: ALLOWED_MENTIONS})
        }
        logger.info(`公告翻譯：message=${message.id} 已回覆 ${messages.length} 則(${result.model})`)
    }
    catch(e){
        //最常見的是 50013(沒有發言權限)與 10008(原訊息在翻譯途中被刪掉)
        logger.error(`公告翻譯貼出失敗：channel=${message.channelId} message=${message.id}`, e)
    }
}
