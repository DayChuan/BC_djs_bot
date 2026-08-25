import config from '@/config'
import {buildEmbed, pickDaily} from '@/core/japanese'
import {scheduleCron} from '@/core/scheduler'
import {registerRestore} from '@/core/state'
import logger from '@/core/logger'

//每天 09:00(台北)在日文頻道發一則分享。
//
//時區交給 node-cron 處理(scheduler.js 的 TIMEZONE 固定為 Asia/Taipei)，不要自己算時差。
//
//⚠️ 這支檔案要有人 import 才會被載入，排程也才登記得上：
//loader 只掃 src/commands/ 與 src/events/，不掃 src/jobs/。
//目前是靠 src/commands/jp/index.js 匯入 postDaily 連帶把它載進來(單元檔 U05 的地雷 2)。

export const JOB_KEY = 'japanese:daily'

//分 時 日 月 週
export const DAILY_CRON = '0 9 * * *'

//回傳發出去的那一筆，沒發成回 null(/jp post 用它決定要回什麼訊息)。
//錯誤一律往外拋給呼叫端的 try/catch：排程那端是 scheduler 的 runSafely，
//指令那端是 interactionCreate 的 try/catch，兩邊都接得住。
export const postDaily = async(client) => {
    const channelId = config.channels.japanese
    if(!channelId){
        logger.warn(`環境「${config.name}」沒有設定 channels.japanese，每日日文分享不會發送`)
        return null
    }

    const entry = await pickDaily()
    if(!entry){
        logger.warn('日文資料表是空的，這次不發送')
        return null
    }

    const channel = await client.channels.fetch(channelId)
    await channel.send({embeds: [buildEmbed(entry)]})
    logger.info(`每日日文分享已送出：${entry.id} ${entry.expression}`)
    return entry
}

//記憶體裡的排程在重啟時全部消失，所以每次開機都要重掛一次。
//登記制的好處是不必動 src/events/ready/index.js —— 那支檔案是各單元共用的，
//改它就會跟別條線撞在一起(見 state.js 的註解)。
const restore = async(client) => {
    scheduleCron(JOB_KEY, DAILY_CRON, () => postDaily(client))
}

registerRestore('japanese', restore)

export default {
    JOB_KEY,
    DAILY_CRON,
    postDaily,
}
