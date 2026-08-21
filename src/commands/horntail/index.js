import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import logger from '@/core/logger'
import {PANEL_DENY_TEXT} from '@/core/timerRender'
import {isGmMember, openPanel} from '@/core/timerService'

export const command = new SlashCommandBuilder()
    .setName('horntail')
    .setDescription('在目前頻道開一個暗黑龍王計時器面板（限 GM）')
    //setDefaultMemberPermissions() 只吃權限位元、不吃身分組，
    //所以真正的 GM 檢查在下面的 action 裡，這裡只是先擋掉不能發言的人。
    //已知的小瑕疵：/help 是讀 default_member_permissions 過濾的，
    //看不到身分組條件，所以這個指令會列給所有人看。非 GM 點下去會被拒絕。
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)

export const action = async(ctx) => {
    if(!ctx.guild){
        await ctx.reply({content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral})
        return
    }

    if(!isGmMember(ctx.member)){
        await ctx.reply({content: PANEL_DENY_TEXT, flags: MessageFlags.Ephemeral})
        return
    }

    await ctx.deferReply({flags: MessageFlags.Ephemeral})

    //面板本身是 channel.send() 發的公開訊息，不是這則回覆 ——
    //指令的回覆是 webhook 訊息，壽命只有 15 分鐘，而面板要活兩小時。
    try{
        await openPanel(ctx.channel)
    }
    catch(e){
        logger.error(`建立暗黑龍王面板失敗 channel=${ctx.channel.id}：`, e)
        await ctx.editReply('開不起來，我沒辦法在這個頻道發言。請檢查我的權限後再試一次。')
        return
    }

    logger.info(`建立暗黑龍王面板：channel=${ctx.channel.id} by=${ctx.user.tag}`)
    await ctx.editReply(
        '面板已建立。按一次開始倒數、再按一次停止，歸零後會自動接下一輪。\n'
        + '語音提醒是 Discord 的文字轉語音，**要在個人設定裡開啟「文字轉語音」才聽得到**。\n'
        + '面板兩小時後自動結束，30 分鐘沒人操作也會自動收起。'
    )
}
