import {Collection, REST, Routes} from 'discord.js'
import fg, { async } from 'fast-glob'      //讀取檔案用的套件
import {useAppStroe} from '@/store/app'
import config from '@/config'
import logger from '@/core/logger'

//送API請求給discord官方
const updateSlashCommands = async(commands, GUILD_ID) =>{
    const rest = new REST({version:10}).setToken(process.env.TOKEN)
    const result = await rest.put(
        //discord.js的function 目的是簡化API請求流程
        //也可以找不同的Function來用
        Routes.applicationGuildCommands(
            config.applicationId,
            GUILD_ID
        ),
        {
            body: commands,
        },
    )
    // console.log(result)
}


//讀寫資料夾檔案
//這裡目的是如果後續新增了command不用一直進這個檔案維護command數量與名稱跟discord請求
//直接看我有幾個資料夾檔案的檔名來調整即可(有用到不同的插件ex:fast-glob)
export const loadCommands = async() => {
    const appStroe = useAppStroe()
    const files = await fg('./src/commands/**/index.js')
    const commands = []
    const actions = new Collection()
    for(const file of files){
        const cmd = await import(file)
        commands.push(cmd.command)
        actions.set(cmd.command.name, cmd.action)
    }
    //對照表要在打 REST **之前**就建好。
    //原本順序是相反的，於是任何一個 guildId 註冊失敗(例如填錯 id、bot 不在該伺服器、
    //吃到 429)，整個 loadCommands() 就會 reject，commandActionMap 永遠不會被設定 ——
    //結果是 bot 連線正常、Discord 上的指令也還在，但按下去全部沒反應。
    //而且 main.js 沒有 await 這個函式，錯誤只會變成一則 unhandledRejection。
    //已經在 2026-08-18 用另一種方式踩過一次(commit 6400626)，不要再來一次。
    appStroe.commandActionMap = actions
    //供 /help 列出指令清單用
    appStroe.commandList = commands

    // 2023_1129 突然想到一次註冊多個伺服器
    // 2026_0817 伺服器清單改由 src/config/environments/<環境>.js 提供
    //一個伺服器註冊失敗不影響其他伺服器，也不影響已經註冊上去的指令。
    for(const guildId of config.guildIds){
        try{
            await updateSlashCommands(commands, guildId)
        }
        catch(e){
            logger.error(
                `指令註冊失敗 guild=${guildId}(其他伺服器不受影響，` +
                `該伺服器維持上一次註冊的內容)：`, e
            )
        }
    }

    logger.info(`指令載入完成：${commands.length} 個指令，${config.guildIds.length} 個伺服器`)
}

export const loadEvents = async() => {
    const appStroe = useAppStroe()
    const client = appStroe.client
    const files = await fg('./src/events/**/index.js')
    for(const file of files){
        const eventFile = await import(file)

        if(eventFile.event.once){
            client.once(
                eventFile.event.name,
                eventFile.action
            )
        }
        else{
            client.on(
                eventFile.event.name,
                eventFile.action
            )
        }
    }
}