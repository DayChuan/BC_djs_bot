// Require the necessary discord.js classes
import { Client, GatewayIntentBits, Partials} from 'discord.js'
import dotenv from 'dotenv'
import {loadCommands, loadEvents} from '@/core/loader'
import {appStore} from '@/store/app'
import logger from '@/core/logger'
//import { token } = require('./config.json');      // 官網範例檔案

///////////////////// 行程層級的錯誤攔截(Phase 1-A) /////////////////////
// unhandledRejection 維持「只記錄、不終止」：這類錯誤絕大多數是單一互動失敗
// (例如某次 Discord API 呼叫沒 await)，整個 bot 不該因此下線。
process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection(未處理的 Promise rejection)：', reason)
})

// uncaughtException 改為「記錄後 exit(1)」交給 pm2 重啟。
// 繼續跑是當初還沒有 supervisor 時的權宜之計 —— 例外已經逃出所有 try/catch，
// 此時行程的狀態是不確定的，留著只會讓 bot 停在半死不活、看起來還在線上的狀態。
// 兩個 jail 現在都由 pm2 管(docs/ENVIRONMENTS.md)，退出才是正確的處置。
process.on('uncaughtException', (error) => {
    logger.error('uncaughtException(未攔截的例外)，行程即將結束交由 pm2 重啟：', error)
    process.exit(1)
})

// 被訊號終止時要留下紀錄。
// 這是分辨 C 組(程式碼崩潰，有堆疊)與 E 組(環境終止)的關鍵：
// SSH 斷線 / terminal 關閉會送 SIGHUP，原本是無聲消失，現在會在 log 留下這一行。
for(const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']){
    process.on(signal, () => {
        logger.warn(`收到訊號 ${signal}，行程即將結束(不是程式碼崩潰)`)
        process.exit(0)
    })
}

process.on('exit', (code) => {
    logger.info(`行程結束，exit code = ${code}`)
})
///////////////////////////////////////////////////////////////////////

dotenv.config();

logger.info(`=== bot 啟動 === pid=${process.pid} node=${process.version} cwd=${process.cwd()}`)

// 一定要 await。原本沒有 await，loadCommands() 失敗時只會變成一則
// unhandledRejection，bot 照常連線、ready 也正常，但指令表是空的 ——
// 使用者按下任何指令都沒反應，畫面上完全看不出原因(2026-08-18 的事故)。
// 指令表建不起來的 bot 沒有存在意義，直接 exit(1) 讓 pm2 重啟。
try{
    await loadCommands()
}
catch(error){
    logger.error('loadCommands 失敗，指令表建不起來，行程結束：', error)
    process.exit(1)
}

// Create a new client instance
const client = new Client({
     intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
        //少了它，bot 完全看不到誰在語音頻道裡，
        ///horntail 的「語音頻道沒人就收面板」(U09-13)做不出來。
        //這不是特權 intent，不必去開發者後台開啟。
        GatewayIntentBits.GuildVoiceStates,
    ],
     partials: [
        Partials.Channel,
        Partials.Message,
        Partials.Reaction
     ],
});
appStore.client = client

///////////////////// client 層級的錯誤攔截(Phase 1-A) /////////////////////
// Client 繼承 EventEmitter，沒有 'error' 監聽器時 Node 會直接 throw(對應 C-06)。
client.on('error', (error) => {
    logger.error('client error：', error)
})
client.on('shardError', (error, shardId) => {
    logger.error(`shardError(shard ${shardId})：`, error)
})
client.on('shardDisconnect', (event, shardId) => {
    logger.warn(`shardDisconnect(shard ${shardId})：code=${event && event.code} reason=${event && event.reason}`)
})
client.on('shardReconnecting', (shardId) => {
    logger.warn(`shardReconnecting(shard ${shardId})`)
})
client.on('warn', (message) => {
    logger.warn('client warn：', message)
})
//////////////////////////////////////////////////////////////////////////

loadEvents()
// Log in to Discord with your client's token
client.login(process.env.TOKEN)
    .catch((error) => {
        logger.error('client.login 失敗：', error)
    })
