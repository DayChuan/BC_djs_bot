import {MessageFlags, SlashCommandBuilder} from 'discord.js'
import logger from '@/core/logger'
import {PANEL_DENY_TEXT, PANEL_VOICE_ONLY_TEXT} from '@/core/timerRender'
import {isGmMember, openPanel} from '@/core/timerService'

export const command = new SlashCommandBuilder()
    .setName('horntail')
    .setDescription('在語音頻道的聊天室開一個暗黑龍王計時器面板（限 GM）')
    //0 = 預設只有伺服器管理員看得到這個指令(09-12)。
    //default_member_permissions 只吃權限位元、不吃身分組，沒辦法寫成「GM 才看得到」，
    //所以要讓 GM 也看得到，必須由伺服器端手動加覆寫：
    //  伺服器設定 → 整合 → 這個 bot → 指令 → horntail → 加上 GM 身分組
    //程式端只能做到「預設不給看」，剩下那一半在 Discord 的設定畫面裡，改程式改不到。
    //
    //真正的權限檢查一律在 action 與按鈕的 handler 裡(isGmMember)，
    //這裡的設定只影響「看不看得到」，擋不了直接送出的 interaction。
    .setDefaultMemberPermissions(0)

export const action = async(ctx) => {
    if(!ctx.guild){
        await ctx.reply({content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral})
        return
    }

    if(!isGmMember(ctx.member)){
        await ctx.reply({content: PANEL_DENY_TEXT, flags: MessageFlags.Ephemeral})
        return
    }

    //只能開在語音頻道的聊天室。isVoiceBased() 對語音／舞台頻道為真 ——
    //語音頻道內建的文字聊天，頻道本身就是那個語音頻道。
    //面板是打王現場用的，開在一般文字頻道的話，人在語音、眼睛在別的頻道，
    //TTS 提醒等於不存在(它是由「正在看該頻道的人」的用戶端朗讀的)。
    if(!ctx.channel || typeof ctx.channel.isVoiceBased !== 'function' || !ctx.channel.isVoiceBased()){
        await ctx.reply({content: PANEL_VOICE_ONLY_TEXT, flags: MessageFlags.Ephemeral})
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
        + '**用完請按面板上的「結束面板」收起來**；「全部停止」只是把計時器停下、面板留著。\n'
        + '沒人收的話，兩小時後自動結束，計時器全停著超過 30 分鐘也會自動收起。'
    )
}
