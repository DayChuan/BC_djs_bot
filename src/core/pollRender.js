import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder,
} from 'discord.js'
import {getIdentityGroup, identityLabel} from '@/config/pollIdentities'
import {getEntries, MAX_ENTRIES_PER_USER, tally} from '@/core/pollStore'

//customId 的格式是 poll:<動作>:<投票id>[:<角色id>]。
//id 帶在裡面，bot 重啟後頻道裡那則舊訊息照樣點得動 ——
//不需要在記憶體裡保留任何「這則訊息是哪場投票」的對照。
//Discord 的 customId 上限 100 字元，這裡最長約 30 字，離上限很遠。
export const POLL_PREFIX = 'poll:'

export const POLL_KINDS = new Set([
    'open',     //公開訊息上的「投票 / 修改」按鈕
    'peek',     //公開訊息上的「查看目前結果」按鈕
    'opt',      //個人面板的選項選單
    'idt',      //個人面板的身分選單
    'add',      //個人面板的「新增角色」
    'del',      //個人面板的「刪除這個角色」
    'sel',      //個人面板的角色切換選單
])

export const customId = (kind, pollId, entryId) =>
    `${POLL_PREFIX}${kind}:${pollId}${entryId ? `:${entryId}` : ''}`

//舊版的常數留著，改版前發出的投票訊息仍然指向這些前綴
export const POLL_OPTION_PREFIX = `${POLL_PREFIX}opt:`
export const POLL_IDENTITY_PREFIX = `${POLL_PREFIX}idt:`
export const POLL_PEEK_PREFIX = `${POLL_PREFIX}peek:`

const COLOR_OPEN = 0x5865F2
const COLOR_CLOSED = 0x57F287

//Discord 的欄位長度限制
const MAX_FIELD_NAME = 256
const MAX_FIELD_VALUE = 1024
const MAX_FIELDS = 25

//解析元件送回來的 customId。不是投票的就回 null，讓分派器交給別的處理器。
//entryId 可以是 null —— 改版前發出的投票訊息不帶角色編號，
//那種情況一律視為操作第一筆，舊訊息才不會突然點不動。
export const parsePollCustomId = (raw) => {
    const text = String(raw || '')
    if(!text.startsWith(POLL_PREFIX)) return null

    const [, kind, pollId, entryId] = text.split(':')
    if(!kind || !pollId) return null
    if(!POLL_KINDS.has(kind)) return null

    return {kind, pollId, entryId: entryId || null}
}

//建立投票時沒指定 peek 就是允許中途查看。
//用「不等於 false」而不是「等於 true」來判斷，舊資料沒有這個欄位時才會走到預設值。
export const canPeek = (poll) => poll.peek !== false

//超過長度就截斷並補刪節號。硬塞會被 Discord 整包退回，
//結果是「結算時什麼都貼不出來」，比少列幾個人嚴重得多。
const clamp = (text, max) => {
    const value = String(text || '')
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

//Discord 的時間戳記。由用戶端依各自時區顯示，不必煩惱看的人在哪個國家。
const timestamp = (iso, style = 'f') => `<t:${Math.floor(new Date(iso).getTime() / 1000)}:${style}>`

//10 格的長條。快速投票要一眼看出占比，純數字不夠直觀。
export const percentBar = (percent, width = 10) => {
    const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width)
    return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

/////////////////////////// 進行中的投票訊息 ///////////////////////////

//頻道裡常駐的那則訊息。對所有人都一樣，所以不能顯示任何個人狀態 ——
//選單搬進個人面板的另一個理由：一則訊息最多五列元件，
//多角色投票光是選單就會爆掉。
export const buildPollMessage = (poll) => {
    const lines = []
    if(poll.description) lines.push(poll.description)
    lines.push(poll.multi ? '**可以複選。**' : '**只能選一項。**')

    const group = getIdentityGroup(poll.identityGroup)
    if(group) lines.push(`投票時要一併選擇你的${group.label}身分。`)
    if(poll.multiChar){
        lines.push(`**一個人可以登記多個角色**（上限 ${MAX_ENTRIES_PER_USER} 個），在面板上按「新增角色」。`)
    }

    lines.push(`截止時間：${timestamp(poll.closeAt)}（${timestamp(poll.closeAt, 'R')}）`)
    lines.push(canPeek(poll)
        ? '按下方按鈕投票，內容只有你自己看得到，截止前可以隨時改。'
        : '按下方按鈕投票，內容只有你自己看得到，截止前可以隨時改。這場投票的中途結果不公開。')

    const embed = new EmbedBuilder()
        .setColor(COLOR_OPEN)
        .setTitle(`🗳️ ${clamp(poll.title, MAX_FIELD_NAME)}`)
        .setDescription(lines.join('\n\n'))
        .setFooter({text: '結果會在截止後公布在這個頻道'})

    const buttons = [
        new ButtonBuilder()
            .setCustomId(customId('open', poll.id))
            .setLabel(poll.multiChar ? '投票 / 管理我的角色' : '投票 / 修改')
            .setStyle(ButtonStyle.Primary),
    ]

    //允許中途查看時才掛按鈕。不允許的話按鈕根本不存在，
    //比「掛上去但點了說沒權限」乾淨 —— 管理員仍可用 /poll_peek 查看。
    if(canPeek(poll)){
        buttons.push(new ButtonBuilder()
            .setCustomId(customId('peek', poll.id))
            .setLabel('查看目前結果')
            .setStyle(ButtonStyle.Secondary))
    }

    return {embeds: [embed], components: [new ActionRowBuilder().addComponents(...buttons)]}
}

/////////////////////////// 個人投票面板 ///////////////////////////

const entryTitle = (poll, entry, index) => {
    const identity = entry.identity ? identityLabel(poll.identityGroup, entry.identity) : '未選身分'
    return poll.identityGroup ? `角色 ${index + 1}：${identity}` : `第 ${index + 1} 筆`
}

//按下「投票 / 修改」後只有本人看得到的面板。
//因為是 ephemeral，選單可以帶 default 勾選 —— 使用者看得到自己目前的狀態。
//activeEntryId 是「目前正在編輯哪一個角色」，一次只編輯一個，
//這樣元件數量就跟角色數脫鉤，登記幾個角色都不會超過五列的限制。
export const buildMemberPanel = (poll, userId, activeEntryId = null) => {
    const entries = getEntries(poll, userId)
    const list = entries.length > 0 ? entries : [{entryId: 'e0', options: [], identity: null}]

    const activeIndex = Math.max(0, list.findIndex((entry) => entry.entryId === activeEntryId))
    const active = list[activeIndex]

    const labelOf = (key) => {
        const option = poll.options.find((item) => item.key === key)
        return option ? option.label : key
    }

    const embed = new EmbedBuilder()
        .setColor(COLOR_OPEN)
        .setTitle(`🗳️ ${clamp(poll.title, MAX_FIELD_NAME)}`)

    //把目前所有角色的登記狀況列出來，正在編輯的那個標上箭頭
    const summary = list.map((entry, index) => {
        const mark = entry.entryId === active.entryId ? '▶' : '　'
        const picked = entry.options.length > 0
            ? entry.options.map(labelOf).join('、')
            : '尚未選擇'
        return `${mark} **${entryTitle(poll, entry, index)}**　${picked}`
    })

    embed.setDescription([
        poll.multiChar
            ? `你可以登記多個角色，一次編輯一個。目前有 ${list.length} 個。`
            : '選好後直接關掉就行，截止前可以隨時回來改。',
        summary.join('\n'),
    ].join('\n\n'))

    const optionSelect = new StringSelectMenuBuilder()
        .setCustomId(customId('opt', poll.id, active.entryId))
        .setPlaceholder(poll.multi ? '選擇你要的選項(可複選)' : '選擇一個選項')
        //最小 0 是為了讓人能取消投票。設 1 的話選了就再也拿不掉。
        .setMinValues(0)
        .setMaxValues(poll.multi ? poll.options.length : 1)
        .addOptions(poll.options.map((option) => ({
            label: clamp(option.label, 100),
            value: option.key,
            default: active.options.includes(option.key),
        })))

    const components = [new ActionRowBuilder().addComponents(optionSelect)]

    const group = getIdentityGroup(poll.identityGroup)
    if(group && group.options.length > 0){
        const identitySelect = new StringSelectMenuBuilder()
            .setCustomId(customId('idt', poll.id, active.entryId))
            .setPlaceholder(group.placeholder || `選擇你的${group.label}身分`)
            .setMinValues(0)
            .setMaxValues(1)
            .addOptions(group.options.map((option) => ({
                label: clamp(option.label, 100),
                value: option.value,
                default: active.identity === option.value,
            })))
        components.push(new ActionRowBuilder().addComponents(identitySelect))
    }

    //兩個以上角色時才需要切換選單
    if(list.length > 1){
        const switcher = new StringSelectMenuBuilder()
            .setCustomId(customId('sel', poll.id))
            .setPlaceholder('切換要編輯的角色')
            .addOptions(list.map((entry, index) => ({
                label: clamp(entryTitle(poll, entry, index), 100),
                value: entry.entryId,
                default: entry.entryId === active.entryId,
            })))
        components.push(new ActionRowBuilder().addComponents(switcher))
    }

    const buttons = []

    if(poll.multiChar){
        buttons.push(new ButtonBuilder()
            .setCustomId(customId('add', poll.id))
            .setLabel('新增角色')
            .setStyle(ButtonStyle.Success)
            .setDisabled(list.length >= MAX_ENTRIES_PER_USER))
    }

    //一律給刪除鈕，即使只剩一個角色。
    //少了它，想撤銷登記只能把選項一個一個點掉，很難用。
    //只有一筆時它的語意就是「取消我的登記」，文字也跟著換。
    buttons.push(new ButtonBuilder()
        .setCustomId(customId('del', poll.id, active.entryId))
        .setLabel(list.length > 1 ? '刪除這個角色' : '清除我的登記')
        .setStyle(ButtonStyle.Danger))

    //角色多的時候，選單之外再給左右鍵。
    //選單要展開才看得到內容，來回切換時按鈕快得多。
    if(list.length > 1){
        const step = (offset) => list[(activeIndex + offset + list.length) % list.length].entryId
        buttons.push(
            new ButtonBuilder()
                .setCustomId(customId('sel', poll.id, step(-1)))
                .setLabel('◀ 上一個')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(customId('sel', poll.id, step(1)))
                .setLabel('下一個 ▶')
                .setStyle(ButtonStyle.Secondary),
        )
    }

    components.push(new ActionRowBuilder().addComponents(...buttons))

    return {embeds: [embed], components}
}
///////////////////////////// 結算報表 /////////////////////////////

//把某個選項的投票者列成一行行文字。有身分的按身分分組，沒有的就直接列。
//一人多角色時，同一個人會在不同身分底下各出現一次 —— 這是刻意的，
//揪團要看的是「哪幾隻角色會到」，不是「哪幾個人會到」。
const formatVoters = (poll, option) => {
    if(!poll.identityGroup){
        //沒有身分可以區分，同一人重複列只會讓人以為壞了，所以去重
        const unique = [...new Set(option.entries.map((entry) => entry.userId))]
        return unique.map((id) => `<@${id}>`).join(' ') || '—'
    }

    const groups = new Map()
    for(const entry of option.entries){
        const key = entry.identity || null
        if(!groups.has(key)) groups.set(key, [])
        groups.get(key).push(entry.userId)
    }

    return [...groups.entries()]
        .map(([identity, userIds]) => {
            const name = identity ? identityLabel(poll.identityGroup, identity) : '未選身分'
            return `**${name}**（${userIds.length}）　${userIds.map((id) => `<@${id}>`).join(' ')}`
        })
        .join('\n') || '—'
}

//live = true 是「投票還沒結束、中途查看」的版本。
//內容與最終結算完全相同，只有標題與註記不一樣 —— 共用同一份程式碼，
//才不會出現「中途看到的」跟「最後公布的」算法不一致這種問題。
export const buildResultMessage = (poll, {live = false} = {}) => {
    const result = tally(poll)

    //一人多角色的投票要同時給「幾個人」與「幾隻角色」，只給其中一個都會誤導
    const counts = poll.multiChar
        ? `${result.voterCount} 人 / ${result.entryCount} 個角色`
        : `${result.voterCount} 人`

    const embed = new EmbedBuilder()
        .setColor(live ? COLOR_OPEN : COLOR_CLOSED)
        .setTitle(`📊 ${live ? '目前結果' : '投票結果'}：${clamp(poll.title, 200)}`)
        .setFooter({
            text: live
                ? `目前 ${counts}投票 · 尚未截止，數字還會變動`
                : `共 ${counts}投票`,
        })

    //結算版標上截止時間；即時版標「現在」，避免看起來像是舊資料
    if(!live) embed.setTimestamp(new Date(poll.closeAt))
    else embed.setTimestamp(new Date())

    if(result.voterCount === 0){
        embed.setDescription(live ? '目前還沒有人投票。' : '截止前沒有任何人投票。')
        return {embeds: [embed]}
    }

    const header = []
    if(poll.description) header.push(poll.description)
    //由高到低排，最上面那個就是結論
    const ranked = [...result.options].sort((a, b) => b.count - a.count)
    const top = ranked[0]
    if(top.count > 0){
        const tied = ranked.filter((option) => option.count === top.count)
        header.push(tied.length > 1
            ? `最高票（並列）：**${tied.map((option) => option.label).join('、')}**　各 ${top.count} 票`
            : `最高票：**${top.label}**　${top.count} 票（${top.percent}%）`)
    }
    embed.setDescription(header.join('\n\n'))

    for(const option of ranked.slice(0, MAX_FIELDS)){
        embed.addFields({
            name: clamp(`${option.label}　${option.count} 票（${option.percent}%）`, MAX_FIELD_NAME),
            value: clamp(formatVoters(poll, option), MAX_FIELD_VALUE),
        })
    }

    //身分總覽只在有身分選單時才有意義
    if(poll.identityGroup && Object.keys(result.identityTotals).length > 0){
        const summary = Object.entries(result.identityTotals)
            .sort((a, b) => b[1] - a[1])
            .map(([value, count]) => `${identityLabel(poll.identityGroup, value)}　${count} ${poll.multiChar ? "隻" : "人"}`)
            .join('\n')
        embed.addFields({name: '身分統計', value: clamp(summary, MAX_FIELD_VALUE)})
    }

    return {embeds: [embed]}
}

//截止後把原本那則訊息改成這個樣子：拿掉所有選單，避免有人繼續點。
export const buildClosedMessage = (poll) => {
    const embed = new EmbedBuilder()
        .setColor(COLOR_CLOSED)
        .setTitle(`🗳️ ${clamp(poll.title, MAX_FIELD_NAME)}（已截止）`)
        .setDescription(`這場投票已於 ${timestamp(poll.closeAt)} 結束，結果公布在下方訊息。`)

    return {embeds: [embed], components: []}
}

/////////////////////////////// 歷史查詢 ///////////////////////////////

//歷史清單。只給概要，細節要另外用 id 查 —— 一次塞太多會超過 embed 上限。
export const buildHistoryList = (records, {keyword = ''} = {}) => {
    const embed = new EmbedBuilder()
        .setColor(COLOR_CLOSED)
        .setTitle('📚 過往投票紀錄')

    if(records.length === 0){
        embed.setDescription(keyword
            ? `找不到標題含「${keyword}」的歷史投票。`
            : '目前沒有任何歷史投票。')
        return {embeds: [embed]}
    }

    embed.setDescription([
        keyword ? `標題含「${keyword}」的結果，由新到舊：` : '由新到舊：',
        '用 `/poll_history id:<id>` 看單場完整結果。',
    ].join('\n'))

    for(const record of records){
        //歸檔時存了結果快照，這裡直接用，不必重算
        const result = record.result || {voterCount: 0, entryCount: 0}
        const counts = record.multiChar
            ? `${result.voterCount} 人 / ${result.entryCount} 個角色`
            : `${result.voterCount} 人`

        embed.addFields({
            name: clamp(record.title || '(無標題)', MAX_FIELD_NAME),
            value: [
                `\`${record.id}\``,
                record.closeAt ? `結算於 ${timestamp(record.closeAt)}` : '結算時間不明',
                `${counts}投票`,
            ].join('　·　'),
        })
    }

    return {embeds: [embed]}
}
