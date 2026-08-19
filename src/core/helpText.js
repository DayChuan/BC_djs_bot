//組出 /help 的內容。刻意不 import discord.js：
//一來這裡只是字串處理，二來測試 jail 只要碰到 discord.js 就跑不完
//(見 tests/moduleLayout.test.js 的說明)。

//ApplicationCommandOptionType.Subcommand。不 import discord.js 就得寫死，
//這是 Discord API 的公開常數，不會變。
const SUBCOMMAND_TYPE = 1

//Discord 單則訊息上限 2000 字，留一點餘裕給結尾提示
const MAX_LENGTH = 1900

//把 SlashCommandBuilder 轉成純資料，後面的過濾與排版就都不必認得 discord.js。
//default_member_permissions 是字串型態的位元遮罩(例如 '8')，沒設定時是 null/undefined，
//代表所有人都看得到。
export const toHelpEntry = (command) => {
    const json = typeof command.toJSON === 'function' ? command.toJSON() : command
    const options = json.options || []

    return {
        name: json.name,
        description: json.description || '',
        permissions: json.default_member_permissions || null,
        subcommands: options
            .filter((option) => option.type === SUBCOMMAND_TYPE)
            .map((option) => ({name: option.name, description: option.description || ''})),
    }
}

//canUse 由呼叫端提供：拿到權限位元字串，回答這位成員有沒有這個權限。
//權限判斷交給 discord.js 的 PermissionsBitField 做，這裡只負責問。
export const filterUsable = (entries, canUse) =>
    entries.filter((entry) => !entry.permissions || canUse(entry.permissions))

const renderGroup = (title, entries) => {
    if(entries.length === 0) return []

    const lines = [`**${title}**`]
    for(const entry of entries){
        lines.push(`\`/${entry.name}\` — ${entry.description}`)
        //有子指令的(例如 /selfrole)光看主描述不知道能做什麼，一併列出來
        for(const sub of entry.subcommands){
            lines.push(`　└ \`${sub.name}\` — ${sub.description}`)
        }
    }
    return lines
}

export const buildHelpText = (commands, canUse) => {
    const entries = filterUsable(commands.map(toHelpEntry), canUse)
        .sort((a, b) => a.name.localeCompare(b.name))

    if(entries.length === 0) return '你目前沒有可以使用的指令。'

    const lines = [
        `你可以使用的指令（共 ${entries.length} 個）：`,
        '',
        ...renderGroup('一般指令', entries.filter((entry) => !entry.permissions)),
    ]

    const managed = entries.filter((entry) => entry.permissions)
    if(managed.length > 0){
        if(lines.length > 2) lines.push('')
        lines.push(...renderGroup('管理指令（依你目前的權限顯示）', managed))
    }

    //指令變多時不要整則訊息被 Discord 退回，寧可截斷並說清楚
    const text = lines.join('\n')
    if(text.length <= MAX_LENGTH) return text

    const kept = []
    let used = 0
    for(const line of lines){
        if(used + line.length + 1 > MAX_LENGTH) break
        kept.push(line)
        used += line.length + 1
    }
    return `${kept.join('\n')}\n…（指令太多，後面省略）`
}
