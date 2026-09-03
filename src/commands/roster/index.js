import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {identityGroups, identityLabel} from '@/config/pollIdentities'
import {LINEUP_IDENTITY_GROUP, UNKNOWN_LEVEL} from '@/config/lineup'
import {listMembers, removeMember, setMember, setMemberLevel} from '@/core/roster'
import logger from '@/core/logger'

//出團名單的人員表維護。
//
//權限分兩級(2026-09-03 使用者確認)：
//  list / level         所有人 —— 一般成員只看得到、也只改得動**自己的**角色
//  edit / set / remove  管理員 —— 改別人的等級、新增、改角色名、刪除
//
//edit 與 set 的分工：edit 只動等級(角色名保持原樣)，是「幫大家更新等級」的日常操作；
//set 是整筆覆寫，用來新增或改角色名。日常維護用 edit 才不會不小心把角色名洗掉。
//
//本來想做成 /roster edit level 這種子指令**群組**，但 core/helpText.js 只認 type 1 的
//子指令，群組(type 2)會從 /help 裡靜靜消失，而 helpText.js 在 U11 的檔案領域外。

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
        .setDescription('修改自己角色的等級')
        .addStringOption(identityOption)
        .addIntegerOption(levelOption))
    .addSubcommand((sub) => sub
        .setName('edit')
        .setDescription('［管理員］修改其他人角色的等級')
        .addUserOption((option) => option
            .setName('user')
            .setDescription('要修改誰的角色')
            .setRequired(true))
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

//管理員限定的子指令。Discord 的預設權限是**整支指令**的門檻，
//沒辦法逐個子指令設，所以列在這裡由 action 自己擋。
const ADMIN_ONLY = new Set(['edit', 'set', 'remove'])

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
        content: '只有管理員可以新增、修改別人的資料或刪除人員。你可以用 `/roster level` 改自己角色的等級。',
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

//職業的下拉選單只能放固定選項，沒辦法「只列出你自己有的那幾隻」——
//那需要 autocomplete，而分派器目前沒有 isAutocomplete() 的處理(見 commands/vmute 的註解)。
//退而求其次：選錯的時候直接把他名下有哪幾隻列出來，效果一樣是「只看得到自己的」。
const ownedHint = (userId) => {
    const owned = listMembers(userId)
    if(owned.length === 0) return '你目前一隻角色都沒有登記。'
    return `你登記的是：${owned.map((item) => identityLabel(LINEUP_IDENTITY_GROUP, item.identity)).join('、')}`
}

//一般成員改自己的、管理員用 /roster edit 改別人的，共用同一段流程。
//兩者的差別只有「改誰」與訊息裡的稱呼，規則(只改等級、不新增)完全一樣。
const updateLevel = async (ctx, targetId, self) => {
    const identity = ctx.options.getString('identity')
    const level = ctx.options.getInteger('level')
    const label = identityLabel(LINEUP_IDENTITY_GROUP, identity)
    const who = self ? '你' : `<@${targetId}>`

    //只改已經存在的那一筆，查不到就不動作 —— 順手建一筆的話，
    //職業選錯就會多出一筆永遠對不到投票的孤兒資料，而且本人看不出來。
    const result = setMemberLevel(targetId, identity, level)

    if(!result.ok && result.reason === 'missing'){
        await ctx.reply({
            content: self
                ? `你沒有登記「${label}」這隻角色。${ownedHint(targetId)}\n要新增請找管理員用 \`/roster set\`。`
                : `<@${targetId}> 沒有登記「${label}」這隻角色。${ownedHint(targetId)}\n要新增請用 \`/roster set\`。`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: {parse: []},
        })
        return
    }
    if(!result.ok){
        await ctx.reply({content: '寫入失敗，請稍後再試或看紀錄檔。', flags: MessageFlags.Ephemeral})
        return
    }

    logger.info(`人員表：${ctx.user.tag} 把 ${targetId} 的 ${identity} 改成 ${level} 級`)
    await ctx.reply({
        content: `已把${who}的「${label}」更新為 ${level} 級。`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: {parse: []},
    })
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

    if(ADMIN_ONLY.has(sub) && !isAdmin(ctx)){
        await denyAdmin(ctx)
        return
    }

    if(sub === 'list') await handleList(ctx)
    else if(sub === 'level') await updateLevel(ctx, ctx.user.id, true)
    else if(sub === 'edit') await updateLevel(ctx, ctx.options.getUser('user').id, false)
    else if(sub === 'set') await handleSet(ctx)
    else if(sub === 'remove') await handleRemove(ctx)
}
