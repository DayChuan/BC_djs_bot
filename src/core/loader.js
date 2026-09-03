import {Collection} from 'discord.js'
import fg from 'fast-glob'      //讀取檔案用的套件
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {appStore} from '@/store/app'
import logger from '@/core/logger'

//專案根目錄。原本用相對路徑 './src/**' 掃檔，等於把「從哪個目錄啟動」
//當成隱含前提 —— 從別的位置啟動就靜默掃不到任何檔案，
//bot 照常上線但一個指令、一個事件都沒有(ISSUES.md M-05)。
//絕對路徑的寫法照抄 src/core/pollStore.js。
//fast-glob 即使在 Windows 上也只吃正斜線，所以要把分隔符換掉；
//編輯機是 Windows、執行環境是 FreeBSD，漏掉這步會在其中一邊掃不到檔。
//用 split(path.sep).join('/') 而不是正規表達式，是為了避開反斜線的跳脫 ——
//用腳本改檔時轉義被多吃一層、字串或 regex 沒有結束，2026-08-18 踩過(見 CLAUDE.md)。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    .split(path.sep)
    .join('/')

//讀寫資料夾檔案
//這裡目的是如果後續新增了command不用一直進這個檔案維護command數量與名稱跟discord請求
//直接看我有幾個資料夾檔案的檔名來調整即可(有用到不同的插件ex:fast-glob)
//
//這個函式是純資料來源：不碰 store、不碰 REST、不寫 log，
//所以部署腳本(src/scripts/deploy-commands.js)可以直接用它。
export const collectCommands = async() => {
    const files = await fg(`${ROOT}/src/commands/**/index.js`, {absolute: true})
    const commands = []
    const actions = new Collection()
    //指令檔可以另外匯出一個 autocomplete 函式，有匯出才登記。
    //Discord 的規定：autocomplete 必須在 3 秒內回應、最多回 25 筆。
    const autocompletes = new Collection()
    for(const file of files){
        const cmd = await import(file)
        commands.push(cmd.command)
        actions.set(cmd.command.name, cmd.action)
        if(typeof cmd.autocomplete === 'function') autocompletes.set(cmd.command.name, cmd.autocomplete)
    }
    return {commands, actions, autocompletes}
}

//建立「指令名稱 → 處理函式」的對照表，供 interactionCreate 分派用。
//
//這裡**不再向 Discord 註冊指令**。註冊已經拆成獨立的部署步驟(yarn deploy)，
//理由是 2026-08-18 的事故：指令檔有語法錯誤時 bot 照常連線、ready 也正常，
//只有指令表默默建不起來，錯誤被吞成一則 unhandledRejection，
//要等使用者發現指令消失才知道出事。拆開之後這種錯會在部署當下就爆出來。
//順帶把每次重啟都無條件打的 PUT applicationGuildCommands 一併省掉
//(正式站兩個伺服器 = 兩倍呼叫，crash loop 時還會反覆打同一個端點吃 429)。
export const loadCommands = async() => {
    const {commands, actions, autocompletes} = await collectCommands()
    appStore.commandActionMap = actions
    appStore.autocompleteMap = autocompletes
    //供 /help 列出指令清單用
    appStore.commandList = commands

    logger.info(`指令載入完成：${commands.length} 個指令（${autocompletes.size} 個帶 autocomplete）`)
}

export const loadEvents = async() => {
    const client = appStore.client
    const files = await fg(`${ROOT}/src/events/**/index.js`, {absolute: true})
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
