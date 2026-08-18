import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {HISTORY_PAGE_SIZE} from '@/config/polls'
import {getArchived, listArchived} from '@/core/pollArchive'
import {buildHistoryList, buildResultMessage} from '@/core/pollRender'
import logger from '@/core/logger'

export const command = new SlashCommandBuilder()
    .setName('poll_history')
    .setDescription('查看過往的投票紀錄')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) => option
        .setName('id')
        .setDescription('投票 id，查看單場的完整結果'))
    .addStringOption((option) => option
        .setName('keyword')
        .setDescription('用標題關鍵字搜尋'))
    .addBooleanOption((option) => option
        .setName('public')
        .setDescription('把結果公開貼到這個頻道給大家看（需搭配 id）'))

export const action = async(ctx) => {
    if(!ctx.guild){
        await ctx.reply({content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral})
        return
    }

    const id = ctx.options.getString('id')
    const keyword = ctx.options.getString('keyword') || ''
    const isPublic = ctx.options.getBoolean('public') || false

    //公開貼出必須指定是哪一場。少了這道檢查，手滑就會把整份清單洗到頻道上。
    if(isPublic && !id){
        await ctx.reply({
            content: '要公開貼出結果的話請一併指定 `id`，先用不帶參數的 `/poll_history` 查出來。',
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    //查歷史要掃資料夾，超過三秒的機會不高但不是零
    await ctx.deferReply({flags: MessageFlags.Ephemeral})

    if(!id){
        const records = await listArchived({limit: HISTORY_PAGE_SIZE, keyword})
        await ctx.editReply(buildHistoryList(records, {keyword}))
        return
    }

    const record = await getArchived(id)
    if(!record){
        await ctx.editReply(
            `找不到 id 為 \`${id}\` 的歷史投票。` +
            `它可能還在進行中（用 \`/poll_peek\`），或已超過保留期限被清除。`
        )
        return
    }

    const payload = buildResultMessage(record)

    if(!isPublic){
        await ctx.editReply(payload)
        return
    }

    //公開版另外送一則正式訊息到頻道，指令本身的回覆維持 ephemeral。
    //直接把指令回覆改成公開的話，會連帶顯示「誰下了這個指令」，
    //而且沒辦法在貼出後再補說明。
    await ctx.channel.send({
        content: `📌 ${ctx.user} 分享了一場過往投票的結果`,
        ...payload,
    })

    logger.info(`公開分享歷史投票：${record.id}「${record.title}」by=${ctx.user.tag}`)
    await ctx.editReply(`已把「${record.title}」的結果貼到這個頻道。`)
}
