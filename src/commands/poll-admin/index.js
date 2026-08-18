import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {buildAdminList, collectAdminItems} from '@/core/pollAdmin'

export const command = new SlashCommandBuilder()
    .setName('poll_admin')
    .setDescription('投票管理：查看與操作進行中、排程中、已結束的投票')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

export const action = async(ctx) => {
    if(!ctx.guild){
        await ctx.reply({content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral})
        return
    }

    //要掃資料夾，超過三秒的機會不高但不是零
    await ctx.deferReply({flags: MessageFlags.Ephemeral})
    await ctx.editReply(buildAdminList(await collectAdminItems()))
}
