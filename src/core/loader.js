import {Collection, REST, Routes} from 'discord.js'
import fg, { async } from 'fast-glob'      //讀取檔案用的套件
import {useAppStroe} from '@/store/app'

//送API請求給discord官方
const updateSlashCommands = async(commands) =>{
    const rest = new REST({version:10}).setToken(process.env.TOKEN)
    const result = await rest.put(
        //discord.js的function 目的是簡化API請求流程
        //也可以找不同的Function來用
        Routes.applicationGuildCommands(
            process.env.APPLICATION_ID,
            process.env.GUILD_ID,
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
    await updateSlashCommands(commands)
    appStroe.commandActionMap = actions

    console.log(appStroe.commandActionMap)
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