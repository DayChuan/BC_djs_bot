import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {buildPanelMessage} from '@/core/rolePanel'
import {getRoleIds} from '@/core/selfRoles'
import logger from '@/core/logger'

export const command = new SlashCommandBuilder()
    .setName('role_panel')
    .setDescription('在目前頻道發出身分組領取面板')
    //一般成員的指令清單裡不會出現這個指令
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)

export const action = async(ctx) => {
    if(!ctx.guild){
        await ctx.reply({content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral})
        return
    }

    const roleIds = getRoleIds()
    if(roleIds.length === 0){
        await ctx.reply({
            content: '目前清單是空的，先用 `/selfrole add` 加入身分組再發面板。',
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    //bot 只能操作「排在自己最高身分組之下」的身分組，否則 Discord 會回 50013。
    //這件事在發面板時就檢查完，不要等使用者點下去才發現。
    const me = await ctx.guild.members.fetchMe()
    const blocked = []
    for(const id of roleIds){
        const role = ctx.guild.roles.cache.get(id) || await ctx.guild.roles.fetch(id).catch(() => null)
        if(role && role.position >= me.roles.highest.position) blocked.push(role.name)
    }

    await ctx.channel.send(buildPanelMessage())
    logger.info(`發出身分組面板：guild=${ctx.guild.id} channel=${ctx.channel.id} by=${ctx.user.tag}`)

    const warning = blocked.length > 0
        ? `\n\n⚠️ 這些身分組排在我的身分組之上，我沒辦法給予或收回，請到伺服器設定把我的身分組往上移：${blocked.join('、')}`
        : ''

    await ctx.reply({content: `面板已發出。${warning}`, flags: MessageFlags.Ephemeral})
}
