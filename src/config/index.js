import dotenv from 'dotenv'
import logger from '@/core/logger'
import production from '@/config/environments/production'
import test from '@/config/environments/test'

//ESM 的 import 會在 main.js 的敘述句之前就全部執行完，
//所以不能等 main.js 那句 dotenv.config()，這裡必須自己先呼叫一次，
//否則下面讀 process.env.BOT_ENV 會是 undefined，永遠落到預設環境。
//dotenv 預設不覆蓋已存在的環境變數，重複呼叫是安全的。
dotenv.config()

const ENVIRONMENTS = {production, test}

//預設值刻意設為 production：正式站就算忘了在 .env 加 BOT_ENV 也不會壞。
//測試環境的 .env 必須明確寫 BOT_ENV=test。
const DEFAULT_ENV = 'production'

const envName = String(process.env.BOT_ENV || DEFAULT_ENV).trim().toLowerCase()
const config = ENVIRONMENTS[envName]

if(!config){
    //這個錯要讓 bot 起不來。選錯環境卻默默跑下去，比直接掛掉更難查。
    throw new Error(
        `BOT_ENV=「${envName}」不是合法的環境，可用的值：${Object.keys(ENVIRONMENTS).join(' / ')}`
    )
}

//去掉 emoji 的變體選擇符(U+FE0F)。
//🏕️ 與 🏕 是同一個圖案的兩種寫法，訊息上實際存的是哪一種取決於送出的用戶端，
//不正規化就會比對不到(ISSUES.md 的 F-03)。
export const normalizeEmoji = (name) =>
    String(name === undefined || name === null ? '' : name).replace(/️/g, '')

const roleIdByEmoji = new Map(
    Object.entries(config.roles).map(([emoji, id]) => [normalizeEmoji(emoji), id])
)

//查不到、或還沒填 id，都回 null，呼叫端一律當作「這個 emoji 不對應任何身分組」
export const resolveRoleId = (emojiName) => {
    const id = roleIdByEmoji.get(normalizeEmoji(emojiName))
    return id ? id : null
}

//啟動檢查。只警告不中斷 —— 少填一個 id 不該讓整個 bot 起不來。
const validate = () => {
    logger.info(
        `=== 環境「${config.name}」=== application=${config.applicationId} ` +
        `guilds=${config.guildIds.join(',')} roleChannel=${config.channels.role}`
    )

    const missing = Object.entries(config.roles)
        .filter(([, id]) => !id)
        .map(([emoji]) => emoji)
    if(missing.length > 0){
        logger.warn(
            `環境「${config.name}」有 ${missing.length} 個 emoji 還沒填身分組 id，` +
            `這些 emoji 不會有作用：${missing.join(' ')}`
        )
    }

    //兩個環境的 emoji 清單應該一致，否則換環境就會少功能，而且是靜默的
    const keysOf = (env) => Object.keys(env.roles).map(normalizeEmoji).sort()
    const onlyIn = (a, b) => a.filter((key) => !b.includes(key))
    const onlyProd = onlyIn(keysOf(production), keysOf(test))
    const onlyTest = onlyIn(keysOf(test), keysOf(production))
    if(onlyProd.length > 0 || onlyTest.length > 0){
        logger.warn(
            `兩個環境的 emoji 清單不一致 —— ` +
            `只在 production：${onlyProd.join(' ') || '無'}；只在 test：${onlyTest.join(' ') || '無'}`
        )
    }
}

validate()

export default config
