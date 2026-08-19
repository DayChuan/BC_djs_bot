import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from 'discord.js'
import logger from '@/core/logger'
import {HISTORY_PAGE_SIZE} from '@/config/polls'
import {getPoll, listActivePolls, updatePoll} from '@/core/pollStore'
import {deleteArchived, getArchived, listArchived} from '@/core/pollArchive'
import {buildResultMessage} from '@/core/pollRender'
import {
    formatTaipeiDateTime,
    nextWeeklyDate,
    parseTaipeiDateTime,
    parseTimeOfDay,
    parseWeekday,
} from '@/core/scheduler'

//管理面板自己的 customId 命名空間，跟投票面板的 poll: 分開，
//避免哪天新增動作時兩邊撞名而互相攔截。
export const ADMIN_PREFIX = 'padm:'

const COLOR = 0x5865F2

//Discord 選單最多 25 個選項
const MAX_SELECT_OPTIONS = 25

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

export const adminId = (action, pollId) =>
    `${ADMIN_PREFIX}${action}${pollId ? `:${pollId}` : ''}`

export const parseAdminCustomId = (raw) => {
    const text = String(raw || '')
    if(!text.startsWith(ADMIN_PREFIX)) return null

    const [, action, pollId] = text.split(':')
    if(!action) return null

    return {action, pollId: pollId || null}
}

/////////////////////////// 蒐集清單 ///////////////////////////

//三類投票合成一份清單：進行中、排程中(每週投票的下一輪)、已結束。
//管理員不必知道 id，選單直接顯示標題與時間。
export const collectAdminItems = async () => {
    const active = await listActivePolls()
    const archived = await listArchived({limit: HISTORY_PAGE_SIZE})

    const items = [
        ...active
            .filter((poll) => poll.status === 'open')
            .map((poll) => ({kind: 'open', poll})),
        ...active
            .filter((poll) => poll.status === 'pending')
            .map((poll) => ({kind: 'pending', poll})),
        ...archived.map((poll) => ({kind: 'archived', poll})),
    ]

    return items
}

const kindLabel = (item) => {
    if(item.kind === 'open') return '🟢 進行中'
    if(item.kind === 'pending') return '🕒 排程中'
    return item.poll.status === 'cancelled' ? '🚫 已取消' : '📦 已結束'
}

const itemTiming = (item) => {
    if(item.kind === 'open') return `截止 ${formatTaipeiDateTime(item.poll.closeAt)}`
    if(item.kind === 'pending') return `發起 ${formatTaipeiDateTime(item.poll.openAt)}`
    return item.poll.closeAt ? `結算 ${formatTaipeiDateTime(item.poll.closeAt)}` : '時間不明'
}

const weeklyText = (weekly) => (weekly
    ? `每週 ${WEEKDAY_NAMES[weekly.openDay]} ${weekly.openTime} 發起、` +
      `${WEEKDAY_NAMES[weekly.closeDay]} ${weekly.closeTime} 結算`
    : '不重複')

/////////////////////////// 列表畫面 ///////////////////////////

//模板管理是另一個模組的地盤(customId 前綴 ptpl:)，這裡只放一顆入口按鈕。
//列表有沒有投票都要掛，因為「一場投票都還沒開」正是最需要先去建模板的時候。
const templateEntryRow = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ptpl:home')
        .setLabel('📋 模板管理').setStyle(ButtonStyle.Secondary)
)

export const buildAdminList = (items, {notice = ''} = {}) => {
    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('🛠️ 投票管理')

    if(items.length === 0){
        embed.setDescription([
            notice,
            '目前沒有任何投票（進行中、排程中、已結束都沒有）。',
        ].filter(Boolean).join('\n\n'))
        return {embeds: [embed], components: [templateEntryRow()]}
    }

    const shown = items.slice(0, MAX_SELECT_OPTIONS)
    const lines = shown.map((item) => `${kindLabel(item)}　**${item.poll.title}**　${itemTiming(item)}`)

    if(items.length > shown.length){
        lines.push(`
（還有 ${items.length - shown.length} 場較舊的沒有顯示）`)
    }

    embed.setDescription([notice, '選一場來管理：', lines.join('\n')].filter(Boolean).join('\n\n'))

    const select = new StringSelectMenuBuilder()
        .setCustomId(adminId('pick'))
        .setPlaceholder('選擇要管理的投票')
        .addOptions(shown.map((item) => ({
            label: `${item.poll.title}`.slice(0, 100),
            description: `${kindLabel(item)}　${itemTiming(item)}`.slice(0, 100),
            value: item.poll.id,
        })))

    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(select), templateEntryRow()],
    }
}

/////////////////////////// 單場詳情 ///////////////////////////

export const buildAdminDetail = (item, {notice = ''} = {}) => {
    const poll = item.poll

    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`🛠️ ${poll.title}`)
        .setDescription([notice, poll.description || '（沒有說明）'].filter(Boolean).join('\n\n'))
        .addFields(
            {name: '狀態', value: kindLabel(item), inline: true},
            {name: '時間', value: itemTiming(item), inline: true},
            {name: '重複', value: weeklyText(poll.weekly), inline: true},
            {name: '一人多角色', value: poll.multiChar && poll.identityGroup ? '開啟' : '關閉', inline: true},
            {name: '中途查看', value: poll.peek === false ? '僅管理員' : '所有人', inline: true},
            {name: '選項', value: poll.options.map((option) => option.label).join('、') || '—'},
            {name: 'id', value: `\`${poll.id}\``, inline: true},
        )

    const buttons = []

    if(item.kind === 'open'){
        buttons.push(
            new ButtonBuilder().setCustomId(adminId('peek', poll.id))
                .setLabel('查看目前結果').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(adminId('edit', poll.id))
                .setLabel('編輯').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(adminId('close', poll.id))
                .setLabel('提早結算').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(adminId('cancel', poll.id))
                .setLabel('取消投票').setStyle(ButtonStyle.Danger),
        )
    }
    else if(item.kind === 'pending'){
        buttons.push(
            new ButtonBuilder().setCustomId(adminId('publish', poll.id))
                .setLabel('立即發布').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(adminId('edit', poll.id))
                .setLabel('編輯排程').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(adminId('cancel', poll.id))
                .setLabel('刪除排程').setStyle(ButtonStyle.Danger),
        )
    }
    else{
        buttons.push(
            new ButtonBuilder().setCustomId(adminId('view', poll.id))
                .setLabel('查看完整結果').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(adminId('share', poll.id))
                .setLabel('公開分享到頻道').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(adminId('purge', poll.id))
                .setLabel('刪除紀錄').setStyle(ButtonStyle.Danger),
        )
    }

    const rows = [new ActionRowBuilder().addComponents(...buttons)]
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(adminId('back'))
            .setLabel('◀ 回列表').setStyle(ButtonStyle.Secondary)
    ))

    return {embeds: [embed], components: rows}
}

/////////////////////////// 編輯視窗 ///////////////////////////

//Modal 只放得下五個輸入框，所以每週的「星期 + 時間」合併成一格。
//選項不給編輯：已投的票是綁在選項編號上的，改了會讓現有的票對不上。
export const buildEditModal = (poll) => {
    const modal = new ModalBuilder()
        .setCustomId(adminId('save', poll.id))
        .setTitle('編輯投票（選項無法修改）')

    const field = (id, label, value, {required = false, placeholder = ''} = {}) => {
        const input = new TextInputBuilder()
            .setCustomId(id)
            .setLabel(label.slice(0, 45))
            .setStyle(TextInputStyle.Short)
            .setRequired(required)
        if(value) input.setValue(String(value).slice(0, 100))
        if(placeholder) input.setPlaceholder(placeholder.slice(0, 100))
        return new ActionRowBuilder().addComponents(input)
    }

    modal.addComponents(
        field('title', '標題', poll.title, {required: true}),
        field('description', '說明（可留空）', poll.description),
        field('closeAt', '截止時間 YYYY-MM-DD HH:mm', formatTaipeiDateTime(poll.closeAt), {
            placeholder: '台北時間，排程中的投票留空即可',
        }),
        field('weeklyOpen', '每週發起：星期,時間', poll.weekly
            ? `${poll.weekly.openDay},${poll.weekly.openTime}`
            : '', {placeholder: '例如 0,20:00（0=星期日）。留空代表不重複'}),
        field('weeklyClose', '每週結算：星期,時間', poll.weekly
            ? `${poll.weekly.closeDay},${poll.weekly.closeTime}`
            : '', {placeholder: '例如 2,22:00'}),
    )

    return modal
}

//把 Modal 送回來的內容驗成一個 patch。純函式，可以單獨測。
//回傳 {patch} 或 {error}。
export const parseEditFields = (poll, fields) => {
    const title = String(fields.title || '').trim()
    if(!title) return {error: '標題不能空白。'}

    const patch = {title, description: String(fields.description || '').trim()}

    const closeText = String(fields.closeAt || '').trim()
    if(closeText){
        const date = parseTaipeiDateTime(closeText)
        if(!date) return {error: `截止時間格式要是 \`YYYY-MM-DD HH:mm\`，收到「${closeText}」。`}
        patch.closeAt = date.toISOString()
    }

    const openText = String(fields.weeklyOpen || '').trim()
    const closeWeeklyText = String(fields.weeklyClose || '').trim()

    if(!openText && !closeWeeklyText){
        patch.weekly = null
        return {patch}
    }
    if(!openText || !closeWeeklyText){
        return {error: '每週發起與每週結算要嘛都填、要嘛都留空。'}
    }

    const parsePair = (text) => {
        const [dayPart, timePart] = String(text).split(/[,，]/)
        try{
            return {day: parseWeekday((dayPart || '').trim()), time: parseTimeOfDay(timePart || '')}
        }
        catch(e){
            return {error: e.message}
        }
    }

    const open = parsePair(openText)
    if(open.error) return {error: `每週發起：${open.error}`}
    const close = parsePair(closeWeeklyText)
    if(close.error) return {error: `每週結算：${close.error}`}

    const pad = (value) => String(value).padStart(2, '0')
    patch.weekly = {
        openDay: open.day,
        openTime: `${pad(open.time.hour)}:${pad(open.time.minute)}`,
        closeDay: close.day,
        closeTime: `${pad(close.time.hour)}:${pad(close.time.minute)}`,
    }

    //排程中的投票沒有截止時間，改完排程後要重算，否則發布時會抓到舊的
    if(poll.status === 'pending' && !patch.closeAt){
        patch.openAt = nextWeeklyDate(patch.weekly.openDay, patch.weekly.openTime).toISOString()
    }

    return {patch}
}

/////////////////////////// 套用編輯 ///////////////////////////

//寫回檔案並回傳更新後的投票。呼叫端負責重掛排程與更新頻道訊息。
export const applyEdit = async (pollId, patch) => updatePoll(pollId, (poll) => {
    Object.assign(poll, patch)
})

//依 id 找出這是哪一類的投票。找不到回 null。
export const findAdminItem = async (pollId) => {
    const poll = await getPoll(pollId)
    if(poll) return {kind: poll.status === 'pending' ? 'pending' : 'open', poll}

    const record = await getArchived(pollId)
    if(record) return {kind: 'archived', poll: record}

    return null
}

export const buildResultView = (item) => {
    const live = item.kind === 'open'
    return buildResultMessage(item.poll, {live})
}

export const purgeRecord = async (pollId, by) => {
    const removed = await deleteArchived(pollId)
    if(removed) logger.info(`管理員刪除歷史投票：${pollId} by=${by}`)
    return removed
}

export default {
    ADMIN_PREFIX,
    adminId,
    parseAdminCustomId,
    collectAdminItems,
    buildAdminList,
    buildAdminDetail,
    buildEditModal,
    parseEditFields,
    applyEdit,
    findAdminItem,
    buildResultView,
    purgeRecord,
}
