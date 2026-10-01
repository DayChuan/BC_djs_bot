import {MessageFlags} from 'discord.js'
import {checkMuteRequest, mute} from '@/core/vmute'
import {formatTaipeiDateTime} from '@/core/scheduler'
import logger from '@/core/logger'

//`/vmute` 與右鍵選單「靜音 60 秒」共用的那一段：
//檢查 → 靜音 → 回覆 → 錯誤處理。
//
//兩支指令只差「秒數與對象從哪裡來」：
//  /vmute        從 options 取 user / seconds / reason
//  右鍵選單      對象是 ctx.targetMember，秒數固定(右鍵指令不能帶參數)
//把共同的部分抽在這裡，之後要改邊界條件或錯誤訊息只有一個地方。
//
//判斷本身在 core/vmute.js 的 checkMuteRequest()(純函式、有單元測試)，
//這個檔只負責跟 interaction 往來，所以它 import discord.js、不寫測試。

export const runMute = async(ctx, {target, seconds, reason = null, source}) => {
    if(!ctx.guild){
        await ctx.reply({content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral})
        return false
    }

    const check = checkMuteRequest({
        seconds,
        actorChannelId: ctx.member && ctx.member.voice && ctx.member.voice.channelId,
        target,
        guildOwnerId: ctx.guild.ownerId,
    })
    if(!check.ok){
        await ctx.reply({content: check.message, flags: MessageFlags.Ephemeral})
        return false
    }

    //發訊息與寫檔可能超過 Discord 的三秒限制，拖到逾時 interaction 會直接失效
    await ctx.deferReply({flags: MessageFlags.Ephemeral})

    try{
        //已經在靜音中的人再下一次，是覆蓋成新的到期時間，不是疊加。
        const entry = await mute(target, {seconds, reason, by: ctx.user.id})
        logger.info(
            `vmute 靜音(${source})：${target.user.tag} ${seconds} 秒 by=${ctx.user.tag} ` +
            `until=${entry.until} reason=${reason || '(未填)'}`
        )
        await ctx.editReply(
            `已將 ${target.user.tag} 靜音 ${seconds} 秒，` +
            `${formatTaipeiDateTime(entry.until)} 自動解除。`
        )
        return true
    }
    catch(e){
        //50013：bot 的身分組低於對方，或缺少「靜音成員」權限。
        //這是最常見的失敗，要給看得懂的訊息，不能讓行程掛掉。
        if(e && e.code === 50013){
            logger.error(`vmute 靜音失敗(權限不足，${source})：${target.user.tag}`, e)
            await ctx.editReply('我沒辦法靜音這個人：我的身分組位階低於他，或我缺少「靜音成員」權限。')
            return false
        }
        logger.error(`vmute 靜音失敗(${source})：${target.user.tag}`, e)
        await ctx.editReply('靜音失敗，請稍後再試一次。詳細原因已寫進 log。')
        return false
    }
}

export default {runMute}
