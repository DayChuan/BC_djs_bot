import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {MAX_ROLES, addRole, getRoles, removeRole} from '@/core/selfRoles'
import logger from '@/core/logger'

//維護「可自助領取的身分組」清單。
//清單存在 data/selfRoles.json，不進版控，改完立即生效、不需要重啟。
export const command = new SlashCommandBuilder()
    .setName('selfrole')
    .setDescription('管理可自助領取的身分組清單')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(sub =>
        sub
            .setName('add')
            .setDescription('把一個身分組加入可領取清單')
            .addRoleOption(option =>
                option.setName('role').setDescription('要開放領取的身分組').setRequired(true)
            )
    )
    .addSubcommand(sub =>
        sub
            .setName('remove')
            .setDescription('把一個身分組移出可領取清單')
            .addRoleOption(option =>
                option.setName('role').setDescription('要移除的身分組').setRequired(true)
            )
    )
    .addSubcommand(sub =>
        sub.setName('list').setDescription('列出目前的可領取清單')
    )

const REASON_TEXT = {
    already: '這個身分組已經在清單裡了。',
    full: `清單已經有 ${MAX_ROLES} 個身分組，這是 Discord 下拉選單的上限，請先移除一些。`,
    missing: '這個身分組不在清單裡。',
    io: '寫入設定檔失敗，請看 log。',
}

const handleAdd = async(ctx) => {
    const role = ctx.options.getRole('role')

    //@everyone 不能當身分組發放，bot 管理的身分組也不該開放給使用者自取
    if(role.id === ctx.guild.id){
        return '不能把 @everyone 加入清單。'
    }
    if(role.managed){
        return `「${role.name}」是由外部整合(bot 或訂閱)管理的身分組，沒辦法手動給予。`
    }

    const me = await ctx.guild.members.fetchMe()
    if(role.position >= me.roles.highest.position){
        return `「${role.name}」排在我的身分組之上，我沒辦法給予或收回。請先到伺服器設定把我的身分組往上移，再加一次。`
    }

    const result = addRole(role.id, role.name)
    if(!result.ok) return REASON_TEXT[result.reason]

    logger.info(`身分組清單新增：${role.name}(${role.id}) by=${ctx.user.tag}`)
    return `已把「${role.name}」加入可領取清單。`
}

const handleRemove = async(ctx) => {
    const role = ctx.options.getRole('role')
    const result = removeRole(role.id)
    if(!result.ok) return REASON_TEXT[result.reason]

    logger.info(`身分組清單移除：${role.name}(${role.id}) by=${ctx.user.tag}`)
    return `已把「${role.name}」移出可領取清單。已經領過的人不會被收回身分組。`
}

const handleList = async(ctx) => {
    const roles = getRoles()
    if(roles.length === 0) return '目前清單是空的，用 `/selfrole add` 新增。'

    const lines = roles.map((entry, index) => {
        const role = ctx.guild.roles.cache.get(entry.id)
        //清單裡有但伺服器上找不到，代表身分組被刪掉了
        return role
            ? `${index + 1}. ${role.name}`
            : `${index + 1}. ⚠️ ${entry.name || '(未命名)'} — 已從伺服器刪除，建議移除`
    })

    return `目前可領取的身分組（${roles.length}/${MAX_ROLES}）：\n${lines.join('\n')}`
}

export const action = async(ctx) => {
    if(!ctx.guild){
        await ctx.reply({content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral})
        return
    }

    const sub = ctx.options.getSubcommand()
    const handlers = {add: handleAdd, remove: handleRemove, list: handleList}
    const handler = handlers[sub]

    const content = handler
        ? await handler(ctx)
        : `未知的子指令：${sub}`

    await ctx.reply({content, flags: MessageFlags.Ephemeral})
}
