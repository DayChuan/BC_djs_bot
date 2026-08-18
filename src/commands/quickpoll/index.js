import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {QUICK_MAX_CHOICES, QUICK_MIN_CHOICES, quickOptions} from '@/core/pollRender'
import {createAndPublish} from '@/core/pollService'
import logger from '@/core/logger'

const DEFAULT_MINUTES = 30
const MAX_MINUTES = 24 * 60

export const command = new SlashCommandBuilder()
    .setName('quickpoll')
    .setDescription('在目前頻道發起顏色快速投票，即時顯示占比')
    //語音頻道現場用的，不限管理員；但要有發言權限才看得到
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .addStringOption((option) => option
        .setName('question')
        .setDescription('要問什麼')
        .setRequired(true)
        .setMaxLength(200))
    .addIntegerOption((option) => option
        .setName('choices')
        .setDescription('幾選一：2=紅藍、3=紅藍灰、4=紅藍灰綠')
        .setRequired(true)
        .addChoices(
            {name: '二選一（紅／藍）', value: 2},
            {name: '三選一（紅／藍／灰）', value: 3},
            {name: '四選一（紅／藍／灰／綠）', value: 4},
        ))
    .addIntegerOption((option) => option
        .setName('minutes')
        .setDescription(`幾分鐘後自動結束（預設 ${DEFAULT_MINUTES} 分鐘）`)
        .setMinValue(1)
        .setMaxValue(MAX_MINUTES))

export const action = async(ctx) => {
    if(!ctx.guild){
        await ctx.reply({content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral})
        return
    }

    const choices = ctx.options.getInteger('choices')
    if(choices < QUICK_MIN_CHOICES || choices > QUICK_MAX_CHOICES){
        await ctx.reply({
            content: `只能是 ${QUICK_MIN_CHOICES} 到 ${QUICK_MAX_CHOICES} 選一。`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    const minutes = ctx.options.getInteger('minutes') || DEFAULT_MINUTES

    await ctx.deferReply({flags: MessageFlags.Ephemeral})

    //一定要有自動結束時間。少了它，沒人按「結束投票」的話這筆會一直留在
    //進行中的清單裡，而語音頻道的快速投票通常沒有人會記得回來收尾。
    const poll = await createAndPublish(ctx.client, {
        type: 'quick',
        guildId: ctx.guild.id,
        channelId: ctx.channel.id,
        title: ctx.options.getString('question'),
        description: '',
        options: quickOptions(choices),
        multi: false,
        multiChar: false,
        identityGroup: null,
        peek: true,
        weekly: null,
        createdBy: ctx.user.id,
        openAt: null,
        closeAt: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
        votes: {},
    })

    if(!poll){
        await ctx.editReply('發起失敗，我沒辦法在這個頻道發言。請檢查我的權限後再試一次。')
        return
    }

    logger.info(`建立快速投票：${poll.id}「${poll.title}」by=${ctx.user.tag} ${choices} 選一 ${minutes} 分鐘`)
    await ctx.editReply(
        `已發起 ${choices} 選一的快速投票，${minutes} 分鐘後自動結束。\n` +
        '你或管理員可以隨時按「結束投票」提早收尾。'
    )
}
