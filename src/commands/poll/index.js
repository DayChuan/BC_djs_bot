import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {identityChoices} from '@/config/pollIdentities'
import {MAX_OPTIONS, parseOptionsInput} from '@/core/pollStore'
import {nextWeeklyDate, parseTimeOfDay} from '@/core/scheduler'
import {createAndPublish} from '@/core/pollService'
import logger from '@/core/logger'

const WEEKDAYS = [
    {name: '星期日', value: 0},
    {name: '星期一', value: 1},
    {name: '星期二', value: 2},
    {name: '星期三', value: 3},
    {name: '星期四', value: 4},
    {name: '星期五', value: 5},
    {name: '星期六', value: 6},
]

const DEFAULT_HOURS = 24
const MAX_HOURS = 24 * 30

export const command = new SlashCommandBuilder()
    .setName('poll')
    .setDescription('在目前頻道發起一場投票')
    //開放給所有能發言的成員(2026-08-19 調整，原本限 ManageMessages)。
    //發起投票本身不會改動別人的東西，結算與管理才是管理員的事。
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .addStringOption((option) => option
        .setName('title')
        .setDescription('投票名稱')
        .setRequired(true)
        .setMaxLength(200))
    .addStringOption((option) => option
        .setName('options')
        .setDescription(`選項，用逗號分隔，例如：星期二,星期三,星期四（最多 ${MAX_OPTIONS} 個）`)
        .setRequired(true))
    .addStringOption((option) => option
        .setName('description')
        .setDescription('投票內容說明')
        .setMaxLength(1000))
    .addBooleanOption((option) => option
        .setName('multi')
        .setDescription('是否可以複選（預設否）'))
    .addStringOption((option) => option
        .setName('identity')
        .setDescription('是否附身分選單，選了投票者要一併選擇自己的身分')
        .addChoices(...identityChoices()))
    .addBooleanOption((option) => option
        .setName('multi_char')
        .setDescription('是否允許一人登記多個角色（例如同時報名黑騎士與主教）'))
    .addBooleanOption((option) => option
        .setName('peek')
        .setDescription('是否開放所有人中途查看結果（預設是；設否則只有管理員能用 /poll_peek）'))
    .addIntegerOption((option) => option
        .setName('hours')
        .setDescription(`幾小時後截止（預設 ${DEFAULT_HOURS} 小時，每週重複時此項無效）`)
        .setMinValue(1)
        .setMaxValue(MAX_HOURS))
    .addBooleanOption((option) => option
        .setName('weekly')
        .setDescription('是否每週重複（開啟後必須填下面四個時間參數）'))
    .addIntegerOption((option) => option
        .setName('open_day')
        .setDescription('每週重複：星期幾發起')
        .addChoices(...WEEKDAYS))
    .addStringOption((option) => option
        .setName('open_time')
        .setDescription('每週重複：發起時間，格式 HH:mm（台北時間）'))
    .addIntegerOption((option) => option
        .setName('close_day')
        .setDescription('每週重複：星期幾結算')
        .addChoices(...WEEKDAYS))
    .addStringOption((option) => option
        .setName('close_time')
        .setDescription('每週重複：結算時間，格式 HH:mm（台北時間）'))

const reject = async (ctx, content) => {
    await ctx.reply({content, flags: MessageFlags.Ephemeral})
}

export const action = async(ctx) => {
    if(!ctx.guild){
        await reject(ctx, '這個指令只能在伺服器裡使用。')
        return
    }

    const options = parseOptionsInput(ctx.options.getString('options'))
    if(options.length < 2){
        await reject(
            ctx,
            '至少要有兩個選項。請用逗號分隔，例如：`星期二,星期三,星期四`\n' +
            '（選項本身不能含逗號；重複的選項會自動去除）'
        )
        return
    }

    const weekly = ctx.options.getBoolean('weekly') || false
    let weeklyConfig = null
    let closeAt = null

    if(weekly){
        const openDay = ctx.options.getInteger('open_day')
        const openTime = ctx.options.getString('open_time')
        const closeDay = ctx.options.getInteger('close_day')
        const closeTime = ctx.options.getString('close_time')

        if(openDay === null || !openTime || closeDay === null || !closeTime){
            await reject(ctx, '開啟每週重複時，`open_day`、`open_time`、`close_day`、`close_time` 四個都要填。')
            return
        }

        //時間格式錯的話 parseTimeOfDay 會拋錯。在這裡先擋下來，
        //使用者才知道是自己打錯，而不是看到一句「執行時發生錯誤」。
        try{
            parseTimeOfDay(openTime)
            parseTimeOfDay(closeTime)
        }
        catch(e){
            await reject(ctx, `時間格式要是 \`HH:mm\`（例如 \`20:00\`）。${e.message}`)
            return
        }

        weeklyConfig = {openDay, openTime, closeDay, closeTime}
        //第一場立刻發出，截止時間是下一個結算時間點
        closeAt = nextWeeklyDate(closeDay, closeTime).toISOString()
    }
    else{
        const hours = ctx.options.getInteger('hours') || DEFAULT_HOURS
        closeAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
    }

    //一人多角色的意義是「同一個人用不同身分報名」，沒有身分表就沒有意義：
    //面板會出現一堆分不出誰是誰的「第 N 筆」，結算名單也無從分組。
    //所以直接擋在建立階段，而不是預設關掉 —— 讓下指令的人當場知道。
    const multiChar = ctx.options.getBoolean('multi_char') || false
    if(multiChar && !ctx.options.getString('identity')){
        await reject(
            ctx,
            '要開啟「一人多角色」必須同時選擇 `identity`（身分群組）。\n' +
            '沒有身分可以區分的話，同一個人的多筆登記在結算名單上分不出誰是誰。'
        )
        return
    }

    //沒填就是允許查看。getBoolean 沒填時回 null，不能直接當 false 用。
    const peekOption = ctx.options.getBoolean('peek')
    const peek = peekOption === null ? true : peekOption

    //先回覆再發投票。發訊息與寫檔可能超過 Discord 的三秒限制，
    //拖到逾時的話 interaction 會直接失效。
    await ctx.deferReply({flags: MessageFlags.Ephemeral})

    const poll = await createAndPublish(ctx.client, {
        type: 'standard',
        guildId: ctx.guild.id,
        channelId: ctx.channel.id,
        title: ctx.options.getString('title'),
        description: ctx.options.getString('description') || '',
        options,
        multi: ctx.options.getBoolean('multi') || false,
        identityGroup: ctx.options.getString('identity') || null,
        multiChar,
        peek,
        weekly: weeklyConfig,
        createdBy: ctx.user.id,
        openAt: null,
        closeAt,
        votes: {},
    })

    if(!poll){
        await ctx.editReply('投票建立失敗，我沒辦法在這個頻道發言。請檢查我的權限後再試一次。')
        return
    }

    logger.info(`建立投票：${poll.id}「${poll.title}」by=${ctx.user.tag} 選項數=${options.length}`)

    const lines = [`投票已發出，共 ${options.length} 個選項。`]
    lines.push(`截止時間：<t:${Math.floor(new Date(closeAt).getTime() / 1000)}:F>`)
    if(weekly){
        lines.push(
            `每週重複：${WEEKDAYS[weeklyConfig.openDay].name} ${weeklyConfig.openTime} 發起、` +
            `${WEEKDAYS[weeklyConfig.closeDay].name} ${weeklyConfig.closeTime} 結算（台北時間）。`
        )
    }
    if(multiChar){
        lines.push('已開啟一人多角色：投票者可以在面板上按「新增角色」登記第二隻以後的角色。')
    }
    lines.push(peek
        ? '所有人都可以按投票訊息上的按鈕查看目前結果（只有自己看得到）。'
        : '中途結果不公開，只有管理員能用 `/poll_peek` 查看。')
    lines.push('要提早結束可以用 `/poll_close`。結算後結果會貼在這個頻道。')

    await ctx.editReply(lines.join('\n'))
}
