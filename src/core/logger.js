import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

//以檔案位置推導專案根目錄，不依賴當前工作目錄
//(避免 M-05 那種從別的目錄啟動就靜默失效的問題)
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const LOG_DIR = path.join(ROOT_DIR, 'logs')

const pad = (n, len = 2) => String(n).padStart(len, '0')

//檔名用本地日期：YYYY-MM-DD.log
const dateStamp = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

//行首時間戳：YYYY-MM-DD HH:mm:ss.SSS
const timeStamp = (d) =>
    `${dateStamp(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`

//把任意值轉成可讀字串，Error 要留下完整堆疊
const formatValue = (value) => {
    if(value instanceof Error){
        const lines = [value.stack || `${value.name}: ${value.message}`]
        //discord.js 的 DiscordAPIError 額外資訊，是判斷 50013 / 10008 / 429 的關鍵
        const extra = {}
        for(const key of ['code', 'status', 'method', 'url']){
            if(value[key] !== undefined) extra[key] = value[key]
        }
        if(Object.keys(extra).length > 0) lines.push(`  discord: ${JSON.stringify(extra)}`)
        if(value.cause instanceof Error) lines.push(`  cause: ${value.cause.stack || value.cause.message}`)
        return lines.join('\n')
    }
    if(typeof value === 'string') return value
    if(value === undefined) return 'undefined'
    try{
        return JSON.stringify(value)
    }
    catch{
        return String(value)
    }
}

//組出完整一行。獨立匯出，方便寫不依賴 discord.js 的單元測試
export const formatLine = (level, args, now = new Date()) =>
    `[${timeStamp(now)}] [${String(level).toUpperCase()}] ${args.map(formatValue).join(' ')}`

//logger 本身絕對不能拋錯，否則會變成新的崩潰來源(參考 ISSUES.md 的 C-03)
const write = (level, args) => {
    const now = new Date()
    const line = formatLine(level, args, now)

    if(level === 'error') console.error(line)
    else if(level === 'warn') console.warn(line)
    else console.log(line)

    try{
        fs.mkdirSync(LOG_DIR, {recursive: true})
        //同步寫入，行程被訊號終止時才不會漏掉最後一行
        fs.appendFileSync(path.join(LOG_DIR, `${dateStamp(now)}.log`), line + '\n', 'utf8')
    }
    catch(e){
        console.error(`[logger] 寫入 log 檔失敗(僅輸出 console)：${e && e.message}`)
    }
}

export const logger = {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    logDir: LOG_DIR,
}

export default logger
