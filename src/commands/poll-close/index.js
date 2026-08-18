import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {closePoll, resolveCommandPoll} from '@/core/pollService'
import logger from '@/core/logger'

export const command = new SlashCommandBuilder()
    .setName('poll_close')
    .setDescription('提早結算一場進行中的投票')
    //限管理員。沒有這個權限的人在指令清單裡根本看不到它，
    //比「看得到但點了說沒權限」乾淨。
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) => option
        .setName('id')
        .setDescription('投票 id（這個頻道只有一場進行中的投票時可以不填）'))

export const action = async(ctx) => {
    if(!ctx.guild){
        await ctx.reply({content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral})
        return
    }

    const {poll, error} = await resolveCommandPoll(ctx.channel.id, ctx.options.getString('id'))
    if(error){
        await ctx.reply({content: error, flags: MessageFlags.Ephemeral})
        return
    }
    if(poll.status !== 'open'){
        await ctx.reply({
            content: `這場投票的狀態是 \`${poll.status}\`，不是進行中，無法結算。`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    //結算要編輯原訊息又要貼結果，超過三秒的機會不低
    await ctx.deferReply({flags: MessageFlags.Ephemeral})

    //走的是跟排程完全同一條路徑：貼結果、清除元件、每週投票排下一輪、刪掉該筆。
    //差別只在觸發者是人而不是時間到。
    await closePoll(ctx.client, poll.id)

    logger.info(`手動結算投票：${poll.id}「${poll.title}」by=${ctx.user.tag}`)
    await ctx.editReply(`已提早結算「${poll.title}」，結果已貼在這個頻道。`)
}
