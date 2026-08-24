import {MessageFlags, SlashCommandBuilder} from 'discord.js'
import {appStore} from '@/store/app'
import {buildHelpText} from '@/core/helpText'
import logger from '@/core/logger'

//不設 setDefaultMemberPermissions：所有人都看得到 /help 本身，
//看得到什麼內容才依權限決定。
export const command = new SlashCommandBuilder()
    .setName('help')
    .setDescription('列出你目前可以使用的指令')

export const action = async(ctx) => {
    const commands = appStore.commandList

    //跟 interactionCreate 的開機競態同一個成因(ISSUES.md 的 C-04)：
    //loadCommands() 還沒跑完就有人下指令。
    if(!commands || commands.length === 0){
        logger.warn('/help 在指令表建立完成前被呼叫')
        await ctx.reply({content: '機器人還在啟動中，請幾秒後再試一次。', flags: MessageFlags.Ephemeral})
        return
    }

    //權限判斷交給 discord.js：它會自動處理「管理員視同擁有全部權限」。
    //私訊沒有 memberPermissions，這時只留沒有權限需求的指令。
    const permissions = ctx.memberPermissions
    const canUse = (bits) => {
        if(!permissions) return false
        try{
            return permissions.has(BigInt(bits))
        }
        catch(e){
            //位元字串理論上一定是數字，真的解析不了就當作看不到，不要整個指令壞掉
            logger.warn(`/help 無法解析權限位元 ${bits}：`, e)
            return false
        }
    }

    await ctx.reply({content: buildHelpText(commands, canUse), flags: MessageFlags.Ephemeral})
}
