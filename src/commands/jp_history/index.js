import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {buildHistoryEmbed, getHistory} from '@/core/japanese'

//複習用的清單。只列「大家一起看過的」——/jp 私下抽的不寫紀錄，所以不會出現在這裡。
//區間一律用台北時間切(計算在 japanese.js 的 rangeStart)。

export const command = new SlashCommandBuilder()
    .setName('jp_history')
    .setDescription('看過去發過的每日日文')
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .addStringOption((option) => option
        .setName('range')
        .setDescription('要看哪一段')
        .setRequired(true)
        .addChoices(
            {name: '今天', value: 'day'},
            {name: '本週', value: 'week'},
            {name: '本月', value: 'month'},
        ))

export const action = async(ctx) => {
    const range = ctx.options.getString('range')

    //讀 state.json 是檔案 I/O，先 defer 比較保險
    await ctx.deferReply({flags: MessageFlags.Ephemeral})
    const rows = await getHistory(range)
    await ctx.editReply({embeds: [buildHistoryEmbed(rows, range)]})
}
