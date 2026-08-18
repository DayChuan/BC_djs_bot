import {ActionRowBuilder, EmbedBuilder, StringSelectMenuBuilder} from 'discord.js'
import {getIdentityGroup, identityLabel} from '@/config/pollIdentities'
import {tally} from '@/core/pollStore'

//customId 帶著投票 id，bot 重啟後頻道裡那則舊訊息照樣點得動 ——
//不需要在記憶體裡保留任何「這則訊息是哪場投票」的對照。
//Discord 的 customId 上限是 100 字元，前綴 9 字 + id 13 字，離上限還很遠。
export const POLL_OPTION_PREFIX = 'poll:opt:'
export const POLL_IDENTITY_PREFIX = 'poll:idt:'

const COLOR_OPEN = 0x5865F2
const COLOR_CLOSED = 0x57F287

//Discord 的欄位長度限制
const MAX_FIELD_NAME = 256
const MAX_FIELD_VALUE = 1024
const MAX_FIELDS = 25

//解析選單送回來的 customId。不是投票的就回 null，讓分派器交給別的處理器。
export const parsePollCustomId = (customId) => {
    const text = String(customId || '')
    if(text.startsWith(POLL_OPTION_PREFIX)){
        return {kind: 'option', pollId: text.slice(POLL_OPTION_PREFIX.length)}
    }
    if(text.startsWith(POLL_IDENTITY_PREFIX)){
        return {kind: 'identity', pollId: text.slice(POLL_IDENTITY_PREFIX.length)}
    }
    return null
}

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

export const buildPollMessage = (poll) => {
    const lines = []
    if(poll.description) lines.push(poll.description)
    lines.push(poll.multi ? '**可以複選。**' : '**只能選一項。**')
    if(poll.identityGroup){
        const group = getIdentityGroup(poll.identityGroup)
        if(group) lines.push(`投票後請一併從第二個選單選擇你的${group.label}身分。`)
    }
    lines.push(`截止時間：${timestamp(poll.closeAt)}（${timestamp(poll.closeAt, 'R')}）`)
    lines.push('選好後可以隨時改，以截止前最後一次為準。')

    const embed = new EmbedBuilder()
        .setColor(COLOR_OPEN)
        .setTitle(`🗳️ ${clamp(poll.title, MAX_FIELD_NAME)}`)
        .setDescription(lines.join('\n\n'))
        .setFooter({text: '結果會在截止後公布在這個頻道'})

    const optionSelect = new StringSelectMenuBuilder()
        .setCustomId(`${POLL_OPTION_PREFIX}${poll.id}`)
        .setPlaceholder(poll.multi ? '選擇你要的選項(可複選)' : '選擇一個選項')
        //最小 0 是為了讓人能取消投票。設 1 的話選了就再也拿不掉。
        .setMinValues(0)
        .setMaxValues(poll.multi ? poll.options.length : 1)
        .addOptions(poll.options.map((option) => ({
            label: clamp(option.label, 100),
            value: option.key,
        })))

    const components = [new ActionRowBuilder().addComponents(optionSelect)]

    const group = getIdentityGroup(poll.identityGroup)
    if(group && group.options.length > 0){
        const identitySelect = new StringSelectMenuBuilder()
            .setCustomId(`${POLL_IDENTITY_PREFIX}${poll.id}`)
            .setPlaceholder(group.placeholder || `選擇你的${group.label}身分`)
            .setMinValues(0)
            .setMaxValues(1)
            .addOptions(group.options.map((option) => ({
                label: clamp(option.label, 100),
                value: option.value,
            })))
        components.push(new ActionRowBuilder().addComponents(identitySelect))
    }

    return {embeds: [embed], components}
}

//投完之後只給本人看的確認訊息。
//順便把目前的統計附上去 —— 公開訊息不即時顯示票數(會有從眾效應，
//而且每票都要編輯訊息，很容易撞到速率限制)，但個人回覆裡給就沒有這些問題。
export const buildBallotReply = (poll, userId) => {
    const vote = (poll.votes || {})[userId]
    const labelOf = (key) => {
        const option = poll.options.find((item) => item.key === key)
        return option ? option.label : key
    }

    const lines = []
    if(!vote || vote.options.length === 0) lines.push('已取消你的投票（沒有選擇任何選項）。')
    else lines.push(`已登記：**${vote.options.map(labelOf).join('、')}**`)

    if(poll.identityGroup){
        lines.push(vote && vote.identity
            ? `身分：**${identityLabel(poll.identityGroup, vote.identity)}**`
            : '身分：尚未選擇')
    }

    const result = tally(poll)
    lines.push('')
    lines.push(`目前 ${result.voterCount} 人投票：`)
    lines.push(result.options.map((option) => `　${option.label}　${option.count} 票`).join('\n'))

    return lines.join('\n')
}

///////////////////////////// 結算報表 /////////////////////////////

//把某個選項的投票者列成一行行文字。有身分的按身分分組，沒有的就直接列。
const formatVoters = (poll, option) => {
    const votes = poll.votes || {}

    if(!poll.identityGroup){
        return option.userIds.map((id) => `<@${id}>`).join(' ') || '—'
    }

    const groups = new Map()
    for(const userId of option.userIds){
        const key = votes[userId].identity || null
        if(!groups.has(key)) groups.set(key, [])
        groups.get(key).push(userId)
    }

    return [...groups.entries()]
        .map(([identity, userIds]) => {
            const name = identity ? identityLabel(poll.identityGroup, identity) : '未選身分'
            return `**${name}**（${userIds.length}）　${userIds.map((id) => `<@${id}>`).join(' ')}`
        })
        .join('\n') || '—'
}

export const buildResultMessage = (poll) => {
    const result = tally(poll)

    const embed = new EmbedBuilder()
        .setColor(COLOR_CLOSED)
        .setTitle(`📊 投票結果：${clamp(poll.title, 200)}`)
        .setFooter({text: `共 ${result.voterCount} 人投票`})
        .setTimestamp(new Date(poll.closeAt))

    if(result.voterCount === 0){
        embed.setDescription('截止前沒有任何人投票。')
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
            .map(([value, count]) => `${identityLabel(poll.identityGroup, value)}　${count} 人`)
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
