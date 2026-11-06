import {Events} from 'discord.js'
import {translateMessage} from '@/core/noticeTranslate'
import logger from '@/core/logger'

//手動公告頻道的中文公告 → 自動回覆日文譯文(U16)。
//判斷、翻譯、失敗排佇列都在 core/noticeTranslate.js(不碰 discord.js、有測試)，這裡只接事件。
//loader 對每個 events/**/index.js 各做一次 client.on()，跟 Message_listening 並存不會互相蓋掉。

export const event = {
    name: Events.MessageCreate,
}

export const action = async(message) => {
    if(message.author.bot) return
    //⚠️ 上面這行必須是第一行(tests/noticeTranslate.test.js 會檢查)：
    //不擋的話機器人會翻自己貼出的譯文，再翻那則譯文……幾秒內灌爆頻道。

    try{
        await translateMessage(message)
    }
    catch(e){
        //最常見的是 50013(沒有發言或加反應權限)與 10008(原訊息在翻譯途中被刪掉)
        logger.error(`公告翻譯失敗：channel=${message.channelId} message=${message.id}`, e)
    }
}
