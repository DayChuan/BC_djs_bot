import {ApplicationCommandType, ContextMenuCommandBuilder, PermissionFlagsBits} from 'discord.js'
import {QUICK_MUTE_SECONDS} from '@/core/vmute'
import {runMute} from '@/core/vmuteInteraction'

//右鍵成員 → 應用程式 →「靜音 60 秒」。
//
//為什麼秒數寫死：**右鍵指令不能帶任何參數**，這是 Discord 的限制。
//要選秒數就得點完再跳一個選單，那就失去「右鍵一下就解決」的意義 ——
//現場要的是快，其他長度用 /vmute。
//
//setName() 的字串會原封不動顯示在右鍵選單上(上限 32 字元)，
//所以直接取人看得懂的名字，不要用 vmute-quick 這種代號。
//
//對照表是用指令名當 key，所以這支跟斜線指令走的是同一條分派路徑；
//interactionCreate 只多認一個 isUserContextMenuCommand()。

export const command = new ContextMenuCommandBuilder()
    .setName(`靜音 ${QUICK_MUTE_SECONDS} 秒`)
    .setType(ApplicationCommandType.User)
    //跟 /vmute 一樣只開給有「靜音成員」權限的人，沒權限的人右鍵看不到這一項
    .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers)

export const action = async(ctx) => {
    //右鍵指令的對象在 targetMember，不是 options
    await runMute(ctx, {
        target: ctx.targetMember,
        seconds: QUICK_MUTE_SECONDS,
        reason: '右鍵選單快速靜音',
        source: '右鍵選單',
    })
}
