import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {buildEmbed, isTeacherMember, pickRandom} from '@/core/japanese'
//這個 import 同時做兩件事：拿到 postDaily，以及**讓 dailyJapanese.js 被載入**。
//排程是靠模組載入時的 registerRestore() 登記的，而 loader 只掃 commands/ 與 events/，
//不掃 jobs/ —— 沒有人 import 它的話，每日排程永遠掛不上(單元檔 U05 的地雷 2)。
import {postDaily} from '@/jobs/dailyJapanese'

export const command = new SlashCommandBuilder()
    .setName('jp')
    .setDescription('抽一則日文分享來複習')
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    //post 是老師用的「立刻跑一次今天的分享」，走的是跟每天 09:00 完全同一條路徑，
    //所以驗收時不必去改 cron 運算式再重啟(單元檔 U05 的驗收步驟)。
    .addBooleanOption((option) => option
        .setName('post')
        .setDescription('立刻在日文頻道發一則並記錄（限老師）'))

export const action = async(ctx) => {
    if(ctx.options.getBoolean('post')){
        //權限對照表是 {伺服器id: 身分組id}，私訊沒有 guild 就沒得查
        if(!ctx.guild || !isTeacherMember(ctx.member)){
            await ctx.reply({
                content: '只有老師身分組可以直接發布每日分享。',
                flags: MessageFlags.Ephemeral,
            })
            return
        }

        //抓頻道與送訊息都要打 Discord API，不一定來得及在 3 秒內回應
        await ctx.deferReply({flags: MessageFlags.Ephemeral})
        const posted = await postDaily(ctx.client)
        await ctx.editReply(posted
            ? `已發送 ${posted.id}　${posted.expression}`
            : '沒有發送成功，請看 log（可能是頻道 id 沒設定或資料表是空的）。')
        return
    }

    const entry = pickRandom()
    if(!entry){
        await ctx.reply({content: '資料表目前是空的。', flags: MessageFlags.Ephemeral})
        return
    }

    //私下抽的不寫紀錄，不影響每日輪替，也不會進 /jp_history
    await ctx.reply({embeds: [buildEmbed(entry)], flags: MessageFlags.Ephemeral})
}
