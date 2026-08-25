import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {ALLOWED_SECONDS, mute, parseSeconds} from '@/core/vmute'
import {formatTaipeiDateTime} from '@/core/scheduler'
import logger from '@/core/logger'

//階段一：只有具「靜音成員」權限的人看得到這個指令。
//階段二要加的一般成員投票靜音，權限判斷會移到 handler 裡(見單元檔 U04)。

export const command = new SlashCommandBuilder()
    .setName('vmute')
    .setDescription('把同一個語音頻道裡的成員暫時靜音，時間到自動解除')
    .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers)
    .addUserOption((option) => option
        .setName('user')
        .setDescription('要靜音的對象，必須跟你在同一個語音頻道')
        .setRequired(true))
    //用 addChoices 而不是 autocomplete：宣告式，寫完就結束。
    //自訂秒數要另外接 isAutocomplete()、自己過濾建議、自己驗證亂打的數字，
    //等階段二之後真的有需求再說(單元檔的設計筆記)。
    .addIntegerOption((option) => option
        .setName('seconds')
        .setDescription('靜音多久')
        .setRequired(true)
        .addChoices(
            {name: '1 分鐘', value: 60},
            {name: '2 分鐘', value: 120},
            {name: '3 分鐘', value: 180},
            {name: '4 分鐘', value: 240},
            {name: '5 分鐘', value: 300},
            {name: '10 分鐘', value: 600},
        ))
    .addStringOption((option) => option
        .setName('reason')
        .setDescription('原因，會寫進 audit log')
        .setMaxLength(200))

const deny = async(ctx, content) => {
    await ctx.reply({content, flags: MessageFlags.Ephemeral})
}

export const action = async(ctx) => {
    if(!ctx.guild){
        await deny(ctx, '這個指令只能在伺服器裡使用。')
        return
    }

    //每一項邊界都要有明確回覆。靜默失敗的指令在現場等於壞掉。
    const seconds = parseSeconds(ctx.options.getInteger('seconds'))
    if(!seconds){
        await deny(ctx, `時間只能是 ${ALLOWED_SECONDS.join('、')} 秒其中一個。`)
        return
    }

    const channelId = ctx.member.voice && ctx.member.voice.channelId
    if(!channelId){
        await deny(ctx, '你要先待在語音頻道裡才能使用這個指令。')
        return
    }

    const target = ctx.options.getMember('user')
    if(!target){
        await deny(ctx, '找不到這位成員，他可能已經不在這個伺服器了。')
        return
    }
    if(target.user.bot){
        await deny(ctx, '不能靜音機器人。')
        return
    }
    if(target.id === ctx.guild.ownerId){
        await deny(ctx, '不能靜音伺服器擁有者。')
        return
    }
    if(!target.voice || target.voice.channelId !== channelId){
        await deny(ctx, '對方不在你的語音頻道裡，只能靜音同一個頻道的人。')
        return
    }

    const reason = ctx.options.getString('reason')
    await ctx.deferReply({flags: MessageFlags.Ephemeral})

    try{
        //已經在靜音中的人再下一次，是覆蓋成新的到期時間，不是疊加。
        const entry = await mute(target, {seconds, reason, by: ctx.user.id})
        logger.info(
            `vmute 靜音：${target.user.tag} ${seconds} 秒 by=${ctx.user.tag} ` +
            `until=${entry.until} reason=${reason || '(未填)'}`
        )
        await ctx.editReply(
            `已將 ${target.user.tag} 靜音 ${seconds} 秒，` +
            `${formatTaipeiDateTime(entry.until)} 自動解除。`
        )
    }
    catch(e){
        //50013：bot 的身分組低於對方，或缺少「靜音成員」權限。
        //這是最常見的失敗，要給看得懂的訊息，不能讓行程掛掉。
        if(e && e.code === 50013){
            logger.error(`vmute 靜音失敗(權限不足)：${target.user.tag}`, e)
            await ctx.editReply('我沒辦法靜音這個人：我的身分組位階低於他，或我缺少「靜音成員」權限。')
            return
        }
        logger.error(`vmute 靜音失敗：${target.user.tag}`, e)
        await ctx.editReply('靜音失敗，請稍後再試一次。詳細原因已寫進 log。')
    }
}
