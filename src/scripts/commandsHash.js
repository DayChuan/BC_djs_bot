import crypto from 'node:crypto'

/**
 * 指令部署內容的指紋。
 *
 * 刻意**不**只算指令本身，而是把「推到哪裡」也算進去：
 * 只算指令內容的話，日後在 config 新增一個伺服器時內容沒變、雜湊相同，
 * 部署腳本會判定「跳過」，那個新伺服器就永遠註冊不到指令。
 *
 * 這個檔案不 import discord.js，也不讀檔 —— 純函式，可以寫單元測試。
 * 呼叫端要自己先把 SlashCommandBuilder 轉成 toJSON() 的結果傳進來。
 */
export const commandsHash = ({applicationId, guildIds, commands}) => {
    const payload = JSON.stringify({
        applicationId,
        //guild 的順序不該影響結果，排序後再算。
        guildIds: [...guildIds].sort(),
        commands,
    })
    return crypto.createHash('sha256').update(payload).digest('hex')
}
