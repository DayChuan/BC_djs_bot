import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
//這個 import 同時做兩件事：拿到 runCheck，以及**讓 minecraftFeed.js 被載入**。
//排程是靠模組載入時的 registerRestore() 登記的，而 loader 只掃 commands/ 與 events/ ——
//沒有人 import 它的話，每 30 分鐘的檢查永遠掛不上，而且 log 上不會有任何錯誤(U14)。
import {formatReport, parseUrlList, runCheck} from '@/core/minecraftFeed'

export const command = new SlashCommandBuilder()
    .setName('mc_check')
    .setDescription('立刻檢查一次 Minecraft Java 版更新（管理員）')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) => option
        .setName('網址')
        .setDescription('指定文章網址補發，多篇用空白分隔並照順序發；留空則照 RSS 檢查')
        .setRequired(false))

export const action = async(ctx) => {
    //setDefaultMemberPermissions 只是預設值，伺服器端可以改掉，所以這裡再擋一次
    if(!ctx.memberPermissions?.has(PermissionFlagsBits.Administrator)){
        await ctx.reply({content: '只有管理員可以使用這個指令。', flags: MessageFlags.Ephemeral})
        return
    }

    const {links, rejected} = parseUrlList(ctx.options.getString('網址'))
    //有一個不合法就整批不做：照順序補發時少掉中間一篇，結果會跟預期不一樣
    if(rejected.length > 0){
        await ctx.reply({
            content: `這些不是 minecraft.net 的文章網址，整批沒有執行：\n${rejected.join('\n')}`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    //要抓 RSS、抓文章頁、呼叫 Gemini，可能要好幾分鐘(互動的期限是 15 分鐘)
    await ctx.deferReply({flags: MessageFlags.Ephemeral})
    await ctx.editReply(formatReport(await runCheck(ctx.client, `/mc_check ${ctx.user.tag}`, links)))
}
