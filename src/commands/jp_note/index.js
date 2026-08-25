import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {addNote, buildEmbed} from '@/core/japanese'
import logger from '@/core/logger'

//所有人都能加筆記。每一則記下 userId 與時間，顯示時掛 <@userId>，
//Discord 會自己渲染成名字 —— 不必存名字快照，改暱稱也不會對不上。
//
//筆記存在 entry 的 notes 陣列，跟建表用的 note 欄位是兩回事(單元檔 U05)。

export const command = new SlashCommandBuilder()
    .setName('jp_note')
    .setDescription('對某一則日文分享加註筆記')
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .addStringOption((option) => option
        .setName('id')
        .setDescription('分享訊息下方的編號，例如 j_0012')
        .setRequired(true)
        .setMaxLength(20))
    .addStringOption((option) => option
        .setName('text')
        .setDescription('筆記內容')
        .setRequired(true)
        .setMaxLength(300))

export const action = async(ctx) => {
    const id = ctx.options.getString('id')
    const result = addNote(id, ctx.user.id, ctx.options.getString('text'))

    if(!result.ok){
        await ctx.reply({content: result.error, flags: MessageFlags.Ephemeral})
        return
    }

    logger.info(`日文筆記新增：${result.entry.id} by ${ctx.user.tag}`)

    //回整則 embed，加完馬上看得到自己那一行排在哪
    await ctx.reply({
        content: `已加入 ${result.entry.id} 的第 ${result.index} 則筆記。`,
        embeds: [buildEmbed(result.entry)],
        flags: MessageFlags.Ephemeral,
    })
}
