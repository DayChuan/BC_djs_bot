import {REST, Routes} from 'discord.js'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import config from '@/config'
import {collectCommands} from '@/core/loader'
import {commandsHash} from '@/scripts/commandsHash'

/**
 * 把斜線指令註冊到 Discord。獨立於 bot 啟動流程之外，用 `yarn deploy` 執行。
 *
 * 為什麼要獨立：2026-08-18 有個指令檔語法錯誤，bot 照常連線、ready 也正常，
 * 只有指令表默默建不起來。註冊變成一個會回傳 exit code 的步驟之後，
 * 這種錯誤在部署當下就會爆出來，不必等使用者發現指令消失。
 *
 * 用法：
 *   yarn deploy            內容與上次相同就跳過，不發 REST
 *   yarn deploy --force    無視雜湊強制推送(懷疑 Discord 端與雜湊檔不一致時用)
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HASH_FILE = path.join(ROOT, '.commands-hash.json')
const force = process.argv.includes('--force')

//雜湊檔不進版控，是「這台機器上次成功推了什麼」的本地紀錄。
//讀失敗(不存在、壞掉)一律當成沒有紀錄，直接重推。
const readPreviousHash = () => {
    try{
        return JSON.parse(fs.readFileSync(HASH_FILE, 'utf8')).hash
    }
    catch{
        return null
    }
}

const main = async() => {
    const {commands} = await collectCommands()
    const payload = commands.map((command) => command.toJSON())
    const hash = commandsHash({
        applicationId: config.applicationId,
        guildIds: config.guildIds,
        commands: payload,
    })

    console.log(`指令 ${payload.length} 個：${payload.map((c) => c.name).join('、')}`)
    console.log(`目標伺服器 ${config.guildIds.length} 個：${config.guildIds.join('、')}`)

    if(!force && hash === readPreviousHash()){
        console.log('內容未變、跳過註冊(要強制推送請加 --force)')
        return
    }

    const rest = new REST({version: 10}).setToken(process.env.TOKEN)
    for(const guildId of config.guildIds){
        await rest.put(
            Routes.applicationGuildCommands(config.applicationId, guildId),
            {body: payload},
        )
        console.log(`已註冊 guild=${guildId}`)
    }

    //全部成功才寫回雜湊。中途失敗會直接 throw 到 main() 外面，
    //雜湊維持舊值，下次執行仍然會重推 —— 不會出現「失敗卻被記成已完成」。
    fs.writeFileSync(HASH_FILE, `${JSON.stringify({hash}, null, 2)}\n`, 'utf8')
    console.log('註冊完成')
}

//vite-node 不會自己結束，兩條路都要明確 exit。
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('指令部署失敗：', error)
        process.exit(1)
    })
