import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {peekPoll, resolveCommandPoll} from '@/core/pollService'

export const command = new SlashCommandBuilder()
    .setName('poll_peek')
    .setDescription('查看進行中投票的目前結果（含投票者名單與職業）')
    //限管理員。建立投票時把 peek 設為否的場次，只有這個指令看得到結果。
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

    await ctx.deferReply({flags: MessageFlags.Ephemeral})

    //byAdmin 讓這個指令略過 peek 設定 —— 指令本身已經限管理員了
    await ctx.editReply(await peekPoll(poll.id, {byAdmin: true}))
}
