import {Events, ActivityType} from "discord.js"
import {restorePolls} from '@/core/pollService'
import {migrateLegacyStore} from '@/core/pollStore'
import {purgeExpired, purgeThreads} from '@/core/pollArchive'
import {runRestores} from '@/core/state'
import logger from '@/core/logger'

export const event = {
    name: Events.ClientReady,
    once: true,
    type: ActivityType.Playing
}

//每個步驟各自包 try/catch：其中一項失敗不該讓後面的都不做，
//也不能往外拋 —— 事件處理器的 rejection 沒人接得到，會終止整個行程。
const safely = async(label, task) => {
    try{
        await task()
    }
    catch(e){
        logger.error(`開機工作「${label}」失敗(已攔截，bot 繼續運行)：`, e)
    }
}

export const action = async(c) => {
    c.user.setActivity('Node.js')
    logger.info(`Ready! Logged in as ${c.user.tag}`)

    //1. 舊格式(所有投票塞在單一個 polls.json)自動拆成一場一檔。
    //   必須排在還原之前，否則舊資料裡進行中的投票會被漏掉。
    await safely('舊投票資料遷移', () => migrateLegacyStore())

    //2. 記憶體裡的排程在重啟時全部消失，但檔案還在。
    //   少了這一步，重啟過的投票就永遠等不到結算。
    await safely('還原投票排程', () => restorePolls(c))

    //3. 刪掉結算滿 30 天的投票討論串（U12）。
    //   要排在 purgeExpired() 之前：歸檔紀錄一旦被清掉，就再也不知道
    //   哪些頻道是我們自己開的討論串，那些串會永遠留在伺服器上。
    await safely('清除過期的投票討論串', () => purgeThreads(c))

    //4. 清掉超過保留期限的歷史投票。這種清理不需要即時，開機跑一次就夠。
    await safely('清除過期的歷史投票', () => purgeExpired())

    //5. data/state.json 裡的跨重啟狀態，由各功能自己用 registerRestore 登記怎麼重掛。
    //   這裡不知道有哪些功能 —— 沒有人登記時就是安靜跑完什麼都不做。
    await safely('還原跨重啟狀態', () => runRestores(c))
}
