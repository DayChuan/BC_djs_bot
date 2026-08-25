import {MessageFlags, SlashCommandBuilder} from 'discord.js'
import {
    CLEAR_TOKEN,
    buildEmbed,
    buildFindEmbed,
    countEntries,
    editEntry,
    find,
    importText,
    isTeacherMember,
    removeNote,
} from '@/core/japanese'
import logger from '@/core/logger'

//日文資料表的維護。四個子指令併成一支，照 /poll_admin 的慣例。
//
//權限：setDefaultMemberPermissions(0) 讓它預設只有管理員在選單裡看得到
//(同 /horntail)，再由管理員到「伺服器設定 → 整合」把老師身分組加白名單。
//**Discord 端的設定擋不住直接打 API，所以每個子指令執行前都要自己再驗一次。**
//這裡刻意不放行管理員(2026-08-25 使用者指示)，跟 timerService.isGmMember 相反。

//斜線指令的字串選項上限。用它而不是 Modal：Modal 的段落欄位只有 4000 字，
//而且 Modal 送出的路由寫死在 src/events/interactionCreate/index.js，那不在本單元的檔案領域。
const IMPORT_MAX = 6000

export const command = new SlashCommandBuilder()
    .setName('jp_admin')
    .setDescription('維護每日日文的資料表（限老師）')
    .setDefaultMemberPermissions(0)
    .addSubcommand((sub) => sub
        .setName('find')
        .setDescription('搜尋資料表，取得編號')
        .addStringOption((option) => option
            .setName('keyword')
            .setDescription('表現、讀音或意思裡的關鍵字')
            .setRequired(true)
            .setMaxLength(100)))
    .addSubcommand((sub) => sub
        .setName('edit')
        .setDescription('修正某一筆的內容')
        .addStringOption((option) => option
            .setName('id')
            .setDescription('編號，例如 j_0012')
            .setRequired(true)
            .setMaxLength(20))
        .addStringOption((option) => option
            .setName('field')
            .setDescription('要改哪個欄位')
            .setRequired(true)
            .addChoices(
                {name: '表現', value: 'expression'},
                {name: '読み方', value: 'reading'},
                {name: '意思', value: 'meaning'},
                {name: 'JLPT 等級', value: 'level'},
                {name: '補充說明', value: 'note'},
            ))
        .addStringOption((option) => option
            .setName('value')
            .setDescription(`新的內容（讀音／等級／補充填 ${CLEAR_TOKEN} 代表清空）`)
            .setRequired(true)
            .setMaxLength(500)))
    .addSubcommand((sub) => sub
        .setName('import')
        .setDescription('貼 JSON 新增資料（可以是一筆或一個陣列）')
        .addStringOption((option) => option
            .setName('data')
            .setDescription('JSON 純文字，必填 type / expression / meaning')
            .setRequired(true)
            .setMaxLength(IMPORT_MAX)))
    .addSubcommand((sub) => sub
        .setName('note_remove')
        .setDescription('刪掉某一筆的第幾則筆記')
        .addStringOption((option) => option
            .setName('id')
            .setDescription('編號，例如 j_0012')
            .setRequired(true)
            .setMaxLength(20))
        .addIntegerOption((option) => option
            .setName('index')
            .setDescription('第幾則（就是筆記前面的號碼）')
            .setRequired(true)
            .setMinValue(1)))

const handleFind = async(ctx) => {
    const keyword = ctx.options.getString('keyword')
    const {matched, total} = find(keyword)
    await ctx.reply({
        embeds: [buildFindEmbed(matched, total, keyword)],
        flags: MessageFlags.Ephemeral,
    })
}

const handleEdit = async(ctx) => {
    const result = editEntry(
        ctx.options.getString('id'),
        ctx.options.getString('field'),
        ctx.options.getString('value'),
    )

    if(!result.ok){
        await ctx.reply({content: result.error, flags: MessageFlags.Ephemeral})
        return
    }

    logger.info(
        `日文資料修正：${result.entry.id} ${ctx.options.getString('field')} ` +
        `「${result.before}」→「${result.entry[ctx.options.getString('field')]}」by ${ctx.user.tag}`
    )
    await ctx.reply({
        content: `已更新 ${result.entry.id}。`,
        embeds: [buildEmbed(result.entry)],
        flags: MessageFlags.Ephemeral,
    })
}

const handleImport = async(ctx) => {
    const result = importText(ctx.options.getString('data'))

    if(!result.ok){
        //整批擋下，檔案完全沒有被動過
        await ctx.reply({
            content: `匯入失敗，這次沒有寫入任何資料：\n${result.error}`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    const renamed = result.added
        .filter((item) => item.renamedFrom !== undefined && item.renamedFrom !== '')
        .map((item) => `${item.renamedFrom} → ${item.entry.id}`)
    const lines = result.added.map((item) => `\`${item.entry.id}\`　${item.entry.expression}`)

    logger.info(`日文資料匯入：${result.added.length} 筆 by ${ctx.user.tag}`)
    await ctx.reply({
        content: [
            `匯入成功 ${result.added.length} 筆，資料表現在共 ${countEntries()} 筆。`,
            ...lines,
            renamed.length > 0 ? `\n序號重複已自動改號：${renamed.join('、')}` : '',
        ].filter(Boolean).join('\n').slice(0, 1900),
        flags: MessageFlags.Ephemeral,
    })
}

const handleNoteRemove = async(ctx) => {
    const result = removeNote(ctx.options.getString('id'), ctx.options.getInteger('index'))

    if(!result.ok){
        await ctx.reply({content: result.error, flags: MessageFlags.Ephemeral})
        return
    }

    logger.info(`日文筆記刪除：${result.entry.id} 第 ${ctx.options.getInteger('index')} 則 by ${ctx.user.tag}`)
    await ctx.reply({
        content: `已刪除 ${result.entry.id} 的第 ${ctx.options.getInteger('index')} 則筆記` +
            `（原內容：${result.removed.text}）。`,
        flags: MessageFlags.Ephemeral,
    })
}

const HANDLERS = {
    find: handleFind,
    edit: handleEdit,
    import: handleImport,
    note_remove: handleNoteRemove,
}

export const action = async(ctx) => {
    //Discord 端的可見性設定不等於權限：直接打 API 一樣進得來，所以這裡自己驗
    if(!ctx.guild || !isTeacherMember(ctx.member)){
        await ctx.reply({
            content: '只有老師身分組可以維護日文資料表。',
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    const handler = HANDLERS[ctx.options.getSubcommand()]
    if(!handler){
        await ctx.reply({content: '未知的子指令。', flags: MessageFlags.Ephemeral})
        return
    }

    await handler(ctx)
}
