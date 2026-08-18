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
    'save',     //個人面板的「投票 / 修改」：把草稿寫進檔案
    'add',      //個人面板的「新增角色」
    'del',      //個人面板的「刪除這個角色」
    'sel',      //個人面板的角色切換選單
    'q',        //快速投票的顏色按鈕(第四段放的是選項 key，不是角色 id)
    'qend',     //快速投票的「結束投票」
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

//一人多角色需要身分表才有意義：沒有身分可以區分的話，
//面板上只會是一堆「第 N 筆」，結算名單也無從分組。
//建立時已經擋掉了，這裡是為了保護改版前留下的舊資料。
export const canMultiChar = (poll) => Boolean(poll.multiChar && poll.identityGroup)

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
    if(canMultiChar(poll)){
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
            .setLabel(canMultiChar(poll) ? '投票 / 管理我的角色' : '投票 / 修改')
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
export const buildMemberPanel = (poll, userId, activeEntryId = null, {draft = null, notice = ''} = {}) => {
    const entries = getEntries(poll, userId)
    const list = entries.length > 0 ? entries : [{entryId: 'e0', options: [], identity: null}]

    const activeIndex = Math.max(0, list.findIndex((entry) => entry.entryId === activeEntryId))
    const saved = list[activeIndex]

    //有草稿時，畫面上要顯示的是草稿的內容而不是檔案裡的內容
    const isDraft = Boolean(draft && draft.entryId === saved.entryId)
    const active = isDraft
        ? {entryId: saved.entryId, options: draft.options, identity: draft.identity}
        : saved

    //這隻角色在檔案裡已經有登記了嗎？決定按鈕要寫「投票」還是「修改」
    const alreadySaved = entries.some((entry) =>
        entry.entryId === saved.entryId && (entry.options.length > 0 || entry.identity))

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
        notice,
        canMultiChar(poll)
            ? `一次登記一隻角色，選好後按下方按鈕送出。目前有 ${list.length} 隻。`
            : '選好後按下方按鈕送出，截止前可以隨時回來改。',
        isDraft ? '⚠️ 有尚未送出的變更，離開前記得按下方按鈕。' : '',
        summary.join('\n'),
    ].filter(Boolean).join('\n\n'))

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
            .setPlaceholder(isDraft ? '請先送出或清除目前的變更' : '切換要編輯的角色')
            .setDisabled(isDraft)
            .addOptions(list.map((entry, index) => ({
                label: clamp(entryTitle(poll, entry, index), 100),
                value: entry.entryId,
                default: entry.entryId === active.entryId,
            })))
        components.push(new ActionRowBuilder().addComponents(switcher))
    }

    //送出鈕排第一個：它是這個面板的主要動作。
    //選項與身分的選擇只存在草稿裡，按下去才會寫進檔案。
    const buttons = [
        new ButtonBuilder()
            .setCustomId(customId('save', poll.id, active.entryId))
            .setLabel(alreadySaved ? '修改' : '投票')
            .setStyle(ButtonStyle.Primary),
    ]

    //一律給刪除鈕，即使只剩一隻角色。
    //少了它，想撤銷登記只能把選項一個一個點掉，很難用。
    //它也是「有未送出變更」時的逃生口：不想送出就用它清掉。
    buttons.push(new ButtonBuilder()
        .setCustomId(customId('del', poll.id, active.entryId))
        .setLabel(list.length > 1 ? '刪除這隻角色' : '清除我的登記')
        .setStyle(ButtonStyle.Danger))

    if(canMultiChar(poll)){
        buttons.push(new ButtonBuilder()
            .setCustomId(customId('add', poll.id))
            .setLabel('新增角色')
            .setStyle(ButtonStyle.Success)
            //有未送出的變更時擋住：一次投票就是一隻角色，
            //沒送出就換角色會讓人搞不清楚剛剛那些選擇跑去哪了
            .setDisabled(isDraft || list.length >= MAX_ENTRIES_PER_USER))
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
    const counts = canMultiChar(poll)
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
            .map(([value, count]) => `${identityLabel(poll.identityGroup, value)}　${count} ${canMultiChar(poll) ? "隻" : "人"}`)
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

/////////////////////////// 快速投票 ///////////////////////////

//Discord 的按鈕只有這四種內建配色，沒有黃色。
//二選一＝紅藍、三選一＝紅藍灰、四選一＝紅藍灰綠。
//不掛 emoji，顏色本身就是選項。
export const QUICK_COLORS = [
    {key: 'o0', label: '紅', style: ButtonStyle.Danger},
    {key: 'o1', label: '藍', style: ButtonStyle.Primary},
    {key: 'o2', label: '灰', style: ButtonStyle.Secondary},
    {key: 'o3', label: '綠', style: ButtonStyle.Success},
]

export const QUICK_MIN_CHOICES = 2
export const QUICK_MAX_CHOICES = QUICK_COLORS.length

//依選項數取出要用的顏色
export const quickOptions = (count) => QUICK_COLORS
    .slice(0, Math.max(QUICK_MIN_CHOICES, Math.min(QUICK_MAX_CHOICES, Number(count) || 0)))
    .map(({key, label}) => ({key, label}))

const styleOf = (key) => {
    const found = QUICK_COLORS.find((color) => color.key === key)
    return found ? found.style : ButtonStyle.Secondary
}

//快速投票的訊息。跟一般投票不同，它是公開即時更新的 ——
//語音頻道現場要一眼看到目前比數，藏起來就失去意義了。
export const buildQuickMessage = (poll, {closed = false} = {}) => {
    const result = tally(poll)

    const lines = poll.options.map((option) => {
        const stat = result.options.find((item) => item.key === option.key)
        const count = stat ? stat.count : 0
        const percent = stat ? stat.percent : 0
        return `**${option.label}**　${percentBar(percent)}　${count} 票（${percent}%）`
    })

    const embed = new EmbedBuilder()
        .setColor(closed ? COLOR_CLOSED : COLOR_OPEN)
        .setTitle(`${closed ? '📊' : '⚡'} ${clamp(poll.title, MAX_FIELD_NAME)}${closed ? '（已結束）' : ''}`)
        .setDescription(lines.join('\n'))
        .setFooter({
            text: closed
                ? `共 ${result.voterCount} 人投票`
                : `目前 ${result.voterCount} 人投票 · 再按一次同一個顏色可以取消`,
        })

    if(closed){
        const ranked = [...result.options].sort((a, b) => b.count - a.count)
        const top = ranked[0]
        if(top && top.count > 0){
            const tied = ranked.filter((option) => option.count === top.count)
            embed.addFields({
                name: '結果',
                value: tied.length > 1
                    ? `平手：${tied.map((option) => option.label).join('、')}　各 ${top.count} 票`
                    : `**${top.label}** 勝出　${top.count} 票（${top.percent}%）`,
            })
        }
        return {embeds: [embed], components: []}
    }

    const colorRow = new ActionRowBuilder().addComponents(
        poll.options.map((option) => new ButtonBuilder()
            .setCustomId(customId('q', poll.id, option.key))
            .setLabel(option.label)
            .setStyle(styleOf(option.key)))
    )

    const endRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(customId('qend', poll.id))
            .setLabel('結束投票')
            .setStyle(ButtonStyle.Secondary)
    )

    return {embeds: [embed], components: [colorRow, endRow]}
}
