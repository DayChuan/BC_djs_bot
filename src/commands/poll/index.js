import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {identityChoices} from '@/config/pollIdentities'
import {MAX_OPTIONS, parseOptionsInput} from '@/core/pollStore'
import {nextWeeklyDate, parseTimeOfDay} from '@/core/scheduler'
import {createAndPublish} from '@/core/pollService'
import {
    buildPollOptions,
    endDateOf,
    getTemplate,
    parseDateOnly,
    templateChoices,
} from '@/core/pollTemplate'
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

//模板清單在模組載入時讀一次，跟 identityChoices() 一樣變成靜態 choices。
//loader 用的是 await import()，所以這裡的 top-level await 是安全的。
//代價：新增或改名模板要等 bot 重啟才會出現在下拉選單裡(模板的內容則是
//建立投票的當下才讀檔，改完立刻生效)。
const TEMPLATE_CHOICES = await templateChoices()

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

//一個模板都沒有時就不掛這個欄位 —— 沒有 choices 的 string option 會變成
//自由輸入框，使用者打什麼都對不到模板，那不如讓它不要出現。
//掛在 title 之後、options 之前：必填的選項一定要排在選填的前面，
//所以它沒辦法排到 title 上面，但至少是使用者填完標題後看到的第一個欄位。
if(TEMPLATE_CHOICES.length > 0){
    command.addStringOption((option) => option
        .setName('template')
        .setDescription('套用投票模板，選項與設定會自動帶入（用 /poll_admin 維護）')
        .addChoices(...TEMPLATE_CHOICES))
}

command
    .addStringOption((option) => option
        .setName('options')
        .setDescription(`選項，用逗號分隔，例如：星期二,星期三（最多 ${MAX_OPTIONS} 個；套用模板時可留空）`))
    .addStringOption((option) => option
        .setName('date_start')
        .setDescription('選項要標日期時的起日，格式 YYYY-MM-DD（迄日由選項數推算）'))
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
        .setDescription('是否開放所有人中途查看結果（預設是；設否則只有管理員能用 /poll_admin）'))
    .addBooleanOption((option) => option
        .setName('thread')
        .setDescription('是否開在鎖定的討論串裡，避免被聊天洗掉（按鈕與面板不受鎖定影響）'))
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

    //模板只提供預設值。指令上明確填了的一律優先 ——
    //套模板之後還想改其中一項，不該被逼著去改模板本身。
    const templateKey = TEMPLATE_CHOICES.length > 0 ? ctx.options.getString('template') : null
    let template = null

    if(templateKey){
        template = await getTemplate(templateKey)
        if(!template){
            await reject(ctx, '找不到這個模板，它可能剛剛被刪掉了。請改填 `options`，或請管理員確認 `/poll_admin` 裡的模板。')
            return
        }
    }

    const typedOptions = ctx.options.getString('options')
    const bases = (typedOptions
        ? parseOptionsInput(typedOptions).map((option) => option.label)
        : (template ? template.options : [])
    ).slice(0, MAX_OPTIONS)

    if(bases.length < 2){
        await reject(
            ctx,
            template
                ? `模板「${template.name}」的選項不足兩個，請用 \`/poll_admin\` 修正它，或直接填 \`options\`。`
                : '至少要有兩個選項。請用逗號分隔，例如：`星期二,星期三,星期四`\n' +
                  '（選項本身不能含逗號；重複的選項會自動去除。也可以改用 `template` 套用模板）'
        )
        return
    }

    //日期：指令上給了就用指令的，否則看模板有沒有設定要套。
    const dateText = ctx.options.getString('date_start')
    let dateStart = null

    if(dateText){
        if(parseDateOnly(dateText) === null){
            await reject(ctx, `\`date_start\` 格式要是 \`YYYY-MM-DD\`（例如 \`2026-08-18\`），收到「${dateText}」。`)
            return
        }
        dateStart = dateText
    }
    else if(template && template.applyDate){
        dateStart = template.startDate
    }

    const options = buildPollOptions(bases, dateStart)

    //模板的設定一律用「指令沒填才採用」的規則。
    //getBoolean 沒填時回 null，不能直接當 false 用。
    const fromTemplate = (value, key, fallback) => {
        if(value !== null && value !== undefined) return value
        if(template && template[key] !== null && template[key] !== undefined) return template[key]
        return fallback
    }

    const weeklyFlag = ctx.options.getBoolean('weekly')
    let weeklyConfig = null

    if(weeklyFlag === true){
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
    }
    else if(weeklyFlag === null && template && template.weekly){
        //模板帶了每週設定就沿用。明確填 weekly:false 的人是想只發這一次，
        //所以只有「完全沒填」才吃模板。
        weeklyConfig = template.weekly
    }

    //第一場立刻發出，截止時間是下一個結算時間點
    const closeAt = weeklyConfig
        ? nextWeeklyDate(weeklyConfig.closeDay, weeklyConfig.closeTime).toISOString()
        : new Date(Date.now() + (ctx.options.getInteger('hours') || DEFAULT_HOURS) * 60 * 60 * 1000).toISOString()

    const multi = Boolean(fromTemplate(ctx.options.getBoolean('multi'), 'multi', false))
    const identityGroup = ctx.options.getString('identity')
        || (template && template.identityGroup)
        || null
    const multiChar = Boolean(fromTemplate(ctx.options.getBoolean('multi_char'), 'multiChar', false))
    const peek = Boolean(fromTemplate(ctx.options.getBoolean('peek'), 'peek', true))
    const thread = Boolean(fromTemplate(ctx.options.getBoolean('thread'), 'thread', false))

    //建串要用的是「頻道」，不是討論串 —— 討論串裡不能再開討論串。
    //有人會在討論串裡下 /poll，此時取它的母頻道，否則每一場都會退回而開不了串。
    const parentChannelId = (ctx.channel.isThread && ctx.channel.isThread())
        ? ctx.channel.parentId
        : ctx.channel.id

    //一人多角色的意義是「同一個人用不同身分報名」，沒有身分表就沒有意義：
    //面板會出現一堆分不出誰是誰的「第 N 筆」，結算名單也無從分組。
    //所以直接擋在建立階段，而不是預設關掉 —— 讓下指令的人當場知道。
    if(multiChar && !identityGroup){
        await reject(
            ctx,
            '要開啟「一人多角色」必須同時選擇 `identity`（身分群組）。\n' +
            '沒有身分可以區分的話，同一個人的多筆登記在結算名單上分不出誰是誰。'
        )
        return
    }

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
        //每週投票排下一輪時要靠它把日期往前推。null 代表這場不標日期。
        dateStart,
        multi,
        identityGroup,
        multiChar,
        peek,
        thread,
        //每週續辦時 channelId 已經是上一輪的討論串，所以母頻道要另外存
        parentChannelId,
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

    logger.info(
        `建立投票：${poll.id}「${poll.title}」by=${ctx.user.tag} 選項數=${options.length} ` +
        `模板=${template ? template.name : '無'} 起日=${dateStart || '無'} ` +
        `討論串=${thread ? '開' : '關'}`
    )

    const lines = [`投票已發出，共 ${options.length} 個選項。`]
    if(template) lines.push(`已套用模板「${template.name}」。`)
    if(dateStart){
        lines.push(`選項日期：${dateStart} ～ ${endDateOf(bases, dateStart)}` +
            (weeklyConfig ? '（下一輪會自動 +7 天）。' : '。'))
    }
    lines.push(`截止時間：<t:${Math.floor(new Date(closeAt).getTime() / 1000)}:F>`)
    if(weeklyConfig){
        lines.push(
            `每週重複：${WEEKDAYS[weeklyConfig.openDay].name} ${weeklyConfig.openTime} 發起、` +
            `${WEEKDAYS[weeklyConfig.closeDay].name} ${weeklyConfig.closeTime} 結算（台北時間）。`
        )
    }
    if(multiChar){
        lines.push('已開啟一人多角色：投票者可以在面板上按「新增角色」登記第二隻以後的角色。')
    }
    //開串成功與否直接寫在回覆裡。權限不足時的行為是「退回母頻道」而不是報錯，
    //不講的話發起人只會覺得這個參數沒作用，還得去翻 log 才知道原因。
    if(thread){
        lines.push(poll.channelId === parentChannelId
            ? '⚠️ 討論串建立失敗（我可能缺「建立公開討論串」權限），投票已直接發在本頻道。'
            : `投票開在討論串 <#${poll.channelId}> 裡：一般成員在裡面不能發言，但投票與面板都正常。`)
    }
    lines.push(peek
        ? '所有人都可以按投票訊息上的按鈕查看目前結果（只有自己看得到）。'
        : '中途結果不公開，只有管理員能用 `/poll_admin` 查看。')
    lines.push('要提早結束可以用 `/poll_admin` 選這場再按「提早結算」。結算後結果會貼在投票所在的頻道。')

    await ctx.editReply(lines.join('\n'))
}
