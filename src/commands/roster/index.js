import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {identityGroups, identityLabel} from '@/config/pollIdentities'
import {LINEUP_IDENTITY_GROUP, UNKNOWN_LEVEL} from '@/config/lineup'
import {listMembers, removeMember, setMember, setMemberLevel} from '@/core/roster'
import logger from '@/core/logger'

//出團名單的人員表維護。
//
//權限分兩級(2026-09-03 使用者確認)：
//  list / level  所有人 —— 一般成員只看得到、也只改得動**自己的**角色
//  set / remove  管理員 —— 新增、改角色名、刪除
//
//setDefaultMemberPermissions 是**整支指令**的門檻，沒辦法逐個子指令設，
//所以這裡開到 SendMessages，管理員限定的兩個子指令在 action 裡自己擋。

const MIN_LEVEL = 1
const MAX_LEVEL = 300
const MAX_NAME = 20

//Discord 單則訊息上限 2000。超過就截斷並說明，硬塞會被整包退回，
//結果是「什麼都看不到」，比少列幾筆嚴重得多。
const MAX_CONTENT = 1900

const identityOption = (option) => option
    .setName('identity')
    .setDescription('職業')
    .setRequired(true)
    .addChoices(...identityGroups[LINEUP_IDENTITY_GROUP].options
        .map((item) => ({name: item.label, value: item.value})))

const levelOption = (option) => option
    .setName('level')
    .setDescription('角色等級')
    .setRequired(true)
    .setMinValue(MIN_LEVEL)
    .setMaxValue(MAX_LEVEL)

export const command = new SlashCommandBuilder()
    .setName('roster')
    .setDescription('出團名單的人員表：登記角色的等級與名稱')
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .addSubcommand((sub) => sub
        .setName('list')
        .setDescription('查看已登記的角色（一般成員只看得到自己的）'))
    .addSubcommand((sub) => sub
        .setName('level')
        .setDescription('修改自己已登記角色的等級')
        .addStringOption(identityOption)
        .addIntegerOption(levelOption))
    .addSubcommand((sub) => sub
        .setName('set')
        .setDescription('［管理員］新增或修改任何人的角色')
        .addUserOption((option) => option
            .setName('user')
            .setDescription('這隻角色的擁有者')
            .setRequired(true))
        .addStringOption(identityOption)
        .addIntegerOption(levelOption)
        .addStringOption((option) => option
            .setName('name')
            .setDescription('角色名稱')
            .setRequired(true)
            .setMaxLength(MAX_NAME)))
    .addSubcommand((sub) => sub
        .setName('remove')
        .setDescription('［管理員］刪除某個人的某隻角色')
        .addUserOption((option) => option
            .setName('user')
            .setDescription('這隻角色的擁有者')
            .setRequired(true))
        .addStringOption(identityOption))

const isAdmin = (ctx) => Boolean(ctx.memberPermissions?.has(PermissionFlagsBits.Administrator))

const formatRow = (item) => {
    const level = item.level === null ? UNKNOWN_LEVEL : item.level
    const name = item.name || '（未填角色名）'
    return `<@${item.userId}>　${level}${identityLabel(LINEUP_IDENTITY_GROUP, item.identity)}（${name}）`
}

const clampLines = (lines, empty) => {
    if(lines.length === 0) return empty

    const kept = []
    let length = 0
    for(const line of lines){
        if(length + line.length + 1 > MAX_CONTENT){
            kept.push(`…還有 ${lines.length - kept.length} 筆沒列出來（訊息長度上限）`)
            break
        }
        kept.push(line)
        length += line.length + 1
    }
    return kept.join('\n')
}

//一般成員不必知道自己被擋在哪，但管理員會想知道，所以訊息寫清楚是權限問題
const denyAdmin = async (ctx) => {
    await ctx.reply({
        content: '只有管理員可以新增、修改角色名或刪除人員。你可以用 `/roster level` 改自己角色的等級。',
        flags: MessageFlags.Ephemeral,
    })
}

const handleList = async (ctx) => {
    const admin = isAdmin(ctx)
    const items = listMembers(admin ? null : ctx.user.id)

    const header = admin
        ? `人員表共 ${items.length} 筆（管理員視角）`
        : `你登記了 ${items.length} 隻角色`
    const empty = admin
        ? '人員表是空的。用 `/roster set` 新增。'
        : '你還沒有登記任何角色，請找管理員用 `/roster set` 幫你新增。'

    await ctx.reply({
        content: items.length === 0 ? empty : `${header}\n${clampLines(items.map(formatRow), empty)}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: {parse: []},
    })
}

const handleLevel = async (ctx) => {
    const identity = ctx.options.getString('identity')
    const level = ctx.options.getInteger('level')
    const label = identityLabel(LINEUP_IDENTITY_GROUP, identity)

    //只改自己的，而且只改已經存在的那一筆。查不到就請他找管理員 ——
    //讓一般成員自己新增的話，職業選錯就會多出一筆永遠對不到投票的孤兒資料。
    const result = setMemberLevel(ctx.user.id, identity, level)

    if(!result.ok && result.reason === 'missing'){
        await ctx.reply({
            content: `你沒有登記「${label}」這隻角色，請找管理員用 \`/roster set\` 新增。`,
            flags: MessageFlags.Ephemeral,
        })
        return
    }
    if(!result.ok){
        await ctx.reply({content: '寫入失敗，請稍後再試或找管理員看紀錄檔。', flags: MessageFlags.Ephemeral})
        return
    }

    logger.info(`人員表：${ctx.user.tag} 把自己的 ${identity} 改成 ${level} 級`)
    await ctx.reply({content: `已把你的「${label}」更新為 ${level} 級。`, flags: MessageFlags.Ephemeral})
}

const handleSet = async (ctx) => {
    const user = ctx.options.getUser('user')
    const identity = ctx.options.getString('identity')
    const level = ctx.options.getInteger('level')
    const name = ctx.options.getString('name')
    const label = identityLabel(LINEUP_IDENTITY_GROUP, identity)

    const result = setMember(user.id, identity, level, name)
    if(!result.ok){
        await ctx.reply({content: '寫入失敗，請看紀錄檔。', flags: MessageFlags.Ephemeral})
        return
    }

    logger.info(`人員表：${ctx.user.tag} 設定 ${user.tag} 的 ${identity} 為 ${level} 級「${name}」`)
    await ctx.reply({
        content: `已登記 <@${user.id}> 的「${label}」：${level} 級（${name}）。`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: {parse: []},
    })
}

const handleRemove = async (ctx) => {
    const user = ctx.options.getUser('user')
    const identity = ctx.options.getString('identity')
    const label = identityLabel(LINEUP_IDENTITY_GROUP, identity)

    const result = removeMember(user.id, identity)
    if(!result.ok && result.reason === 'missing'){
        await ctx.reply({
            content: `<@${user.id}> 沒有登記「${label}」這隻角色。`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: {parse: []},
        })
        return
    }
    if(!result.ok){
        await ctx.reply({content: '寫入失敗，請看紀錄檔。', flags: MessageFlags.Ephemeral})
        return
    }

    logger.info(`人員表：${ctx.user.tag} 刪除 ${user.tag} 的 ${identity}`)
    await ctx.reply({
        content: `已刪除 <@${user.id}> 的「${label}」。`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: {parse: []},
    })
}

export const action = async(ctx) => {
    if(!ctx.guild){
        await ctx.reply({content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral})
        return
    }

    const sub = ctx.options.getSubcommand()

    if((sub === 'set' || sub === 'remove') && !isAdmin(ctx)){
        await denyAdmin(ctx)
        return
    }

    if(sub === 'list') await handleList(ctx)
    else if(sub === 'level') await handleLevel(ctx)
    else if(sub === 'set') await handleSet(ctx)
    else if(sub === 'remove') await handleRemove(ctx)
}
