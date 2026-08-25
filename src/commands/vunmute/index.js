import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {canUnmute, readEntry, unmute} from '@/core/vmute'
import logger from '@/core/logger'

//伺服器靜音會跟著人走：被靜音的人換到別的語音頻道、離開再回來，都還是靜音的，
//所以必須有一支「在到期之前手動解除」的指令。
//
//測試期依使用者要求開放給所有人(setDefaultMemberPermissions 用 SendMessages，
//等於人人看得到)。之後要收權限時改 core/vmute.js 的 canUnmute()，不用動這個檔。

export const command = new SlashCommandBuilder()
    .setName('vunmute')
    .setDescription('解除語音靜音。不指定對象就是解除自己')
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .addUserOption((option) => option
        .setName('user')
        .setDescription('要解除的對象，不填就是解除自己'))

export const action = async(ctx) => {
    if(!ctx.guild){
        await ctx.reply({content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral})
        return
    }

    const target = ctx.options.getMember('user') || ctx.member
    if(!target){
        await ctx.reply({
            content: '找不到這位成員，他可能已經不在這個伺服器了。',
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    const allowed = canUnmute(ctx.member, target)
    if(!allowed.ok){
        await ctx.reply({
            content: allowed.reason || '你沒有解除靜音的權限。',
            flags: MessageFlags.Ephemeral,
        })
        return
    }

    await ctx.deferReply({flags: MessageFlags.Ephemeral})

    //沒有我們自己的紀錄也照樣執行 —— 被人工右鍵靜音的成員也要能用這支解掉，
    //那是「解除靜音」本來就該有的行為。
    const entry = await readEntry(ctx.guild.id, target.id) || {
        guildId: ctx.guild.id,
        userId: target.id,
    }

    const result = await unmute(ctx.client, entry, `由 ${ctx.user.tag} 手動解除`)
    logger.info(`vunmute：${target.user.tag} by=${ctx.user.tag} 結果=${result.status}`)

    if(result.status === 'done'){
        await ctx.editReply(`已解除 ${target.user.tag} 的語音靜音。`)
        return
    }
    if(result.status === 'failed'){
        await ctx.editReply('我沒辦法解除這個人：我的身分組位階低於他，或我缺少「靜音成員」權限。')
        return
    }
    //pending：人不在語音頻道，Discord 不讓我們改他的語音狀態，
    //紀錄留著並標記 pending，等他下次進語音時由 voiceStateUpdate 補解除。
    await ctx.editReply(
        `${target.user.tag} 目前不在語音頻道，現在解不掉。` +
        '我已經記下來，他下次進語音時會自動解除。'
    )
}
