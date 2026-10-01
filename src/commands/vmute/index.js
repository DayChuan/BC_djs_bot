import {PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {parseSeconds} from '@/core/vmute'
import {runMute} from '@/core/vmuteInteraction'

//階段一：只有具「靜音成員」權限的人看得到這個指令。
//階段二要加的一般成員投票靜音，權限判斷會移到 handler 裡(見單元檔 U04)。

export const command = new SlashCommandBuilder()
    .setName('vmute')
    .setDescription('把同一個語音頻道裡的成員暫時靜音，時間到自動解除')
    .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers)
    .addUserOption((option) => option
        .setName('user')
        .setDescription('要靜音的對象，必須跟你在同一個語音頻道')
        .setRequired(true))
    //用 addChoices 而不是 autocomplete：宣告式，寫完就結束。
    //自訂秒數要另外接 isAutocomplete()、自己過濾建議、自己驗證亂打的數字，
    //等階段二之後真的有需求再說(單元檔的設計筆記)。
    .addIntegerOption((option) => option
        .setName('seconds')
        .setDescription('靜音多久')
        .setRequired(true)
        .addChoices(
            {name: '1 分鐘', value: 60},
            {name: '2 分鐘', value: 120},
            {name: '3 分鐘', value: 180},
            {name: '4 分鐘', value: 240},
            {name: '5 分鐘', value: 300},
            {name: '10 分鐘', value: 600},
        ))
    .addStringOption((option) => option
        .setName('reason')
        .setDescription('原因，會寫進 audit log')
        .setMaxLength(200))

export const action = async(ctx) => {
    //檢查、靜音、回覆、錯誤處理全部在 core/vmuteInteraction.js，
    //跟右鍵選單「靜音 60 秒」共用同一份。這裡只負責把參數取出來。
    await runMute(ctx, {
        target: ctx.options.getMember('user'),
        seconds: parseSeconds(ctx.options.getInteger('seconds')),
        reason: ctx.options.getString('reason'),
        source: '/vmute',
    })
}
