import {MessageFlags, PermissionFlagsBits, SlashCommandBuilder} from 'discord.js'
import {MAX_ROLES, addRole, getDefaultEmoji, getRoles, removeRole, setEmoji} from '@/core/selfRoles'
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
            .addStringOption(option =>
                option.setName('emoji').setDescription('面板上顯示的圖示(可留空)').setRequired(false)
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
        sub
            .setName('emoji')
            .setDescription('設定或清除身分組在面板上顯示的圖示')
            .addRoleOption(option =>
                option.setName('role').setDescription('要設定的身分組').setRequired(true)
            )
            .addStringOption(option =>
                option.setName('emoji').setDescription('留空表示清除圖示').setRequired(false)
            )
    )
    .addSubcommand(sub =>
        sub.setName('list').setDescription('列出目前的可領取清單')
    )

const REASON_TEXT = {
    already: '這個身分組已經在清單裡了。要改圖示請用 `/selfrole emoji`。',
    full: `清單已經有 ${MAX_ROLES} 個身分組，這是 Discord 下拉選單的上限，請先移除一些。`,
    missing: '這個身分組不在清單裡。',
    io: '寫入設定檔失敗，請看 log。',
}

//只接受自訂表情(<:name:id>)或單純的圖示字元，避免有人把一整串文字塞進去，
//那會讓 Discord 在建立選單時直接回錯。
const normalizeEmojiInput = (raw) => {
    const text = String(raw || '').trim()
    if(!text) return {ok: true, value: ''}

    if(/^<a?:[\w-]+:\d+>$/.test(text)) return {ok: true, value: text}

    //內建 emoji 不會包含 ASCII 英數字，長度也很短
    if(!/[\w\s]/.test(text) && text.length <= 8) return {ok: true, value: text}

    return {ok: false}
}

//被拒絕的情況也要留下紀錄，否則使用者回報「加不進去」時完全無從查起
const reject = (ctx, sub, role, message) => {
    logger.warn(
        `/selfrole ${sub} 被拒絕：by=${ctx.user.tag} ` +
        `role=${role ? `${role.name}(${role.id})` : '-'} 原因=${message}`
    )
    return message
}

const checkRoleUsable = async(ctx, role) => {
    //@everyone 的 id 等於伺服器 id，不能當身分組發放
    if(role.id === ctx.guild.id) return '不能把 @everyone 加入清單。'
    if(role.managed) return `「${role.name}」是由外部整合(bot 或訂閱)管理的身分組，沒辦法手動給予。`

    //bot 只能操作排在自己最高身分組之下的身分組，否則 Discord 回 50013
    const me = await ctx.guild.members.fetchMe()
    if(role.position >= me.roles.highest.position){
        return `「${role.name}」排在我的身分組之上，我沒辦法給予或收回。請先到伺服器設定把我的身分組往上移，再試一次。`
    }

    return null
}

const handleAdd = async(ctx) => {
    const role = ctx.options.getRole('role')

    const problem = await checkRoleUsable(ctx, role)
    if(problem) return reject(ctx, 'add', role, problem)

    const input = normalizeEmojiInput(ctx.options.getString('emoji'))
    if(!input.ok){
        return reject(ctx, 'add', role, '圖示格式不正確，請貼一個 emoji 或伺服器自訂表情。')
    }

    //沒指定圖示時，沿用環境檔對照表裡原本的那個。
    //否則「移除後再加回來」會把原本的圖示弄丟。
    const emoji = input.value || getDefaultEmoji(role.id)

    const result = addRole(role.id, role.name, emoji)
    if(!result.ok) return reject(ctx, 'add', role, REASON_TEXT[result.reason])

    logger.info(`身分組清單新增：${role.name}(${role.id}) emoji=${emoji || '無'} by=${ctx.user.tag}`)
    return `已把 ${emoji ? `${emoji} ` : ''}「${role.name}」加入可領取清單。`
}

const handleRemove = async(ctx) => {
    const role = ctx.options.getRole('role')
    const result = removeRole(role.id)
    if(!result.ok) return reject(ctx, 'remove', role, REASON_TEXT[result.reason])

    logger.info(`身分組清單移除：${role.name}(${role.id}) by=${ctx.user.tag}`)
    return `已把「${role.name}」移出可領取清單。已經領過的人不會被收回身分組。`
}

const handleEmoji = async(ctx) => {
    const role = ctx.options.getRole('role')

    const emoji = normalizeEmojiInput(ctx.options.getString('emoji'))
    if(!emoji.ok){
        return reject(ctx, 'emoji', role, '圖示格式不正確，請貼一個 emoji 或伺服器自訂表情。')
    }

    const result = setEmoji(role.id, emoji.value)
    if(!result.ok) return reject(ctx, 'emoji', role, REASON_TEXT[result.reason])

    logger.info(`身分組圖示設定：${role.name}(${role.id}) emoji=${emoji.value || '清除'} by=${ctx.user.tag}`)
    return emoji.value
        ? `已把「${role.name}」的圖示設定為 ${emoji.value}。`
        : `已清除「${role.name}」的圖示。`
}

const handleList = async(ctx) => {
    const roles = getRoles()
    if(roles.length === 0) return '目前清單是空的，用 `/selfrole add` 新增。'

    const lines = []
    for(const [index, entry] of roles.entries()){
        //只查快取的話，快取沒命中就會被誤判成「已刪除」。
        //跟面板一樣，查不到再向 API 要一次，真的取不到才當作被刪掉。
        const role = ctx.guild.roles.cache.get(entry.id)
            || await ctx.guild.roles.fetch(entry.id).catch(() => null)
        const icon = entry.emoji ? `${entry.emoji} ` : ''

        lines.push(role
            ? `${index + 1}. ${icon}${role.name}`
            : `${index + 1}. ⚠️ ${icon}${entry.name || '(未命名)'} — 已從伺服器刪除，建議移除`)
    }

    return `目前可領取的身分組（${roles.length}/${MAX_ROLES}）：\n${lines.join('\n')}`
}

export const action = async(ctx) => {
    if(!ctx.guild){
        await ctx.reply({content: '這個指令只能在伺服器裡使用。', flags: MessageFlags.Ephemeral})
        return
    }

    const sub = ctx.options.getSubcommand()
    const handlers = {add: handleAdd, remove: handleRemove, emoji: handleEmoji, list: handleList}
    const handler = handlers[sub]

    const content = handler
        ? await handler(ctx)
        : `未知的子指令：${sub}`

    await ctx.reply({content, flags: MessageFlags.Ephemeral})
}
