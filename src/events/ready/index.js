import {Events, ActivityType} from "discord.js"
import {restorePolls} from '@/core/pollService'
import logger from '@/core/logger'

export const event = {
    name: Events.ClientReady,
    once: true,
    type: ActivityType.Playing
}

export const action = async(c) => {
    c.user.setActivity('Node.js')
    logger.info(`Ready! Logged in as ${c.user.tag}`)

    //記憶體裡的排程在重啟時全部消失，但 polls.json 還在。
    //少了這一步，重啟過的投票就永遠等不到結算。
    //這裡失敗只記錄不往外拋 —— 事件處理器的 rejection 沒人接得到，會終止整個行程。
    try{
        await restorePolls(c)
    }
    catch(e){
        logger.error('還原投票排程失敗：', e)
    }
}
