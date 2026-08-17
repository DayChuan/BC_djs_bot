import config, {resolveRoleId} from '@/config'
import logger from '@/core/logger'

const VERB = {add: '給予', remove: '收回'}

//送訊息到管理頻道。
//這個函式本身絕對不能拋錯，否則錯誤處理會變成新的崩潰來源(ISSUES.md 的 C-03)：
//原本的寫法是 channels.cache.get(id).send(...)，頻道沒被快取時會對 undefined 呼叫 send，
//而那時已經在 catch 裡面，沒有人接手，整個行程就結束了。
export const notifyAdmin = async(guild, text) => {
    try{
        if(!guild) return
        const channel = await guild.channels.fetch(config.channels.admin)
        if(!channel || typeof channel.send !== 'function') return
        await channel.send(text)
    }
    catch(e){
        logger.error('通知管理頻道失敗(只記錄，不再往外拋)：', e)
    }
}

//真正動作的那一段。獨立出來是為了讓之後的下拉選單介面共用同一段邏輯，
//兩種介面對身分組的處理方式才會一致。
export const applyRole = async(guild, userId, roleId, mode) => {
    //成員可能不在快取裡，一律用 fetch(ISSUES.md 的 F-02)
    const member = await guild.members.fetch(userId)

    //直接把 id 字串交給 add/remove，不必先從 roles.cache 取物件，少一層快取依賴。
    //這裡的 await 是必要的：未 await 的 Promise 若 reject，外層 try/catch 攔不到，
    //會直接終止行程(ISSUES.md 的 C-02)
    if(mode === 'add') await member.roles.add(roleId)
    else await member.roles.remove(roleId)

    return member
}

//產生 MessageReactionAdd / MessageReactionRemove 的處理函式。
//兩者的流程完全相同，只差最後是 add 還是 remove。
export const createRoleReactionHandler = (mode) => {
    const verb = VERB[mode]

    return async(reaction, user) => {
        try{
            if(user.bot) return

            //bot 重啟後，對未快取的舊訊息收到的是 partial 物件，此時 message.guild 是 null。
            //不先 fetch 就會被下面的判斷擋掉，身分組靜默失效、也不報錯(ISSUES.md 的 F-01)。
            //身分組公告訊息幾乎必然是舊訊息，所以這條路徑是常態而非例外。
            if(reaction.partial) await reaction.fetch()
            if(reaction.message.partial) await reaction.message.fetch()

            const message = reaction.message
            if(!message.guild) return
            if(message.channelId !== config.channels.role) return

            const roleId = resolveRoleId(reaction.emoji.name)
            if(!roleId) return      //不在對照表裡的 emoji，正常情況，不必記錄

            await applyRole(message.guild, user.id, roleId, mode)
            logger.info(
                `${verb}身分組成功：user=${user.tag || user.id} ` +
                `emoji=${reaction.emoji.name} role=${roleId}`
            )
        }
        catch(e){
            const emoji = reaction && reaction.emoji ? reaction.emoji.name : '(未知)'
            const guild = reaction && reaction.message ? reaction.message.guild : null

            logger.error(`${verb}身分組失敗：user=${user && user.id} emoji=${emoji}`, e)
            await notifyAdmin(
                guild,
                `身分組${verb}失敗：<@${user && user.id}> emoji=${emoji}\n${e && e.message}`
            )
        }
    }
}
