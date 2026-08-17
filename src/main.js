// Require the necessary discord.js classes
import { Client, Events, GatewayIntentBits, Message, Partials} from 'discord.js'
import dotenv from 'dotenv'
import vueInit from '@/core/vue'
import {loadCommands, loadEvents} from '@/core/loader'
import {useAppStroe} from '@/store/app'
import logger from '@/core/logger'
//import { token } = require('./config.json');      // 官網範例檔案

///////////////////// 行程層級的錯誤攔截(Phase 1-A) /////////////////////
// 觀察期的策略：只記錄、不終止行程，先把錯誤種類收集完整。
// Phase 6-E 上了 pm2 之後，uncaughtException 會改為「記錄後 exit」交給 pm2 重啟。
process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection(未處理的 Promise rejection)：', reason)
})

process.on('uncaughtException', (error) => {
    logger.error('uncaughtException(未攔截的例外)：', error)
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

vueInit();
dotenv.config();

logger.info(`=== bot 啟動 === pid=${process.pid} node=${process.version} cwd=${process.cwd()}`)

loadCommands()

// Create a new client instance
const client = new Client({
     intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
    ],
     partials: [
        Partials.Channel,
        Partials.Message,
        Partials.Reaction
     ],
});
const appStore = useAppStroe()
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
