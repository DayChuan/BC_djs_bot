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
import {identityGroups} from '@/config/pollIdentities'
import {
    MAX_TEMPLATES,
    applyDates,
    deleteTemplate,
    endDateOf,
    formatWeeklyText,
    getTemplate,
    listTemplates,
    parseTemplateFields,
    saveTemplate,
} from '@/core/pollTemplate'

//模板管理自己的 customId 命名空間。跟投票的 poll: 與管理面板的 padm: 都分開，
//三邊各自解析各自的，不會因為哪天新增動作而互相攔截。
export const TEMPLATE_PREFIX = 'ptpl:'

//Modal 的欄位。事件層要用同一份名單把值取出來，所以定義在這裡而不是散在兩處。
export const TEMPLATE_MODAL_FIELDS = ['name', 'options', 'startDate', 'identity', 'weekly']

const COLOR = 0x57F287

const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

export const templateId = (action, id, extra) =>
    `${TEMPLATE_PREFIX}${action}${id ? `:${id}` : ''}${extra ? `:${extra}` : ''}`

export const parseTemplateCustomId = (raw) => {
    const text = String(raw || '')
    if(!text.startsWith(TEMPLATE_PREFIX)) return null

    const [, action, id, extra] = text.split(':')
    if(!action) return null

    return {action, id: id || null, extra: extra || null}
}

/////////////////////////// 顯示用的小工具 ///////////////////////////

const weeklyLabel = (weekly) => (weekly
    ? `每週 ${WEEKDAY_NAMES[weekly.openDay]} ${weekly.openTime} 發起、` +
      `${WEEKDAY_NAMES[weekly.closeDay]} ${weekly.closeTime} 結算`
    : '不重複')

const identityLabelOf = (key) => {
    if(!key) return '不附身分選單'
    const group = identityGroups[key]
    return group ? `${group.label}（${key}）` : `${key}（找不到這個群組）`
}

const dateRangeLabel = (template) => {
    if(!template.startDate) return '不套用日期'
    const end = endDateOf(template.startDate, template.options.length)
    return `${template.startDate} ～ ${end}`
}

//讓管理員直接看到「套用之後的選項長什麼樣子」，
//不必自己在腦中把日期一個一個對上去。
const optionPreview = (template) => {
    const dated = template.startDate ? applyDates(template.options, template.startDate) : null
    const labels = dated ? dated.map((option) => option.label) : template.options
    return labels.join('、') || '—'
}

/////////////////////////// 模板列表 ///////////////////////////

export const buildTemplateList = (templates, {notice = ''} = {}) => {
    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('📋 投票模板')

    const rows = []

    if(templates.length === 0){
        embed.setDescription([
            notice,
            '目前沒有任何模板。\n\n模板可以把固定不變的選項、身分表與每週排程存起來，' +
            '之後用 `/poll` 的 `template` 欄位套用，每次就只要改標題與說明。',
        ].filter(Boolean).join('\n\n'))
    }
    else{
        const shown = templates.slice(0, MAX_TEMPLATES)
        const lines = shown.map((template) =>
            `**${template.name}**　${template.options.length} 個選項　${dateRangeLabel(template)}`)

        if(templates.length > shown.length){
            lines.push(`\n（還有 ${templates.length - shown.length} 個沒有顯示，Discord 選單上限 ${MAX_TEMPLATES} 個）`)
        }

        embed.setDescription([notice, '選一個來查看或修改：', lines.join('\n')].filter(Boolean).join('\n\n'))

        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(templateId('pick'))
                .setPlaceholder('選擇要管理的模板')
                .addOptions(shown.map((template) => ({
                    label: String(template.name).slice(0, 100),
                    description: `${template.options.length} 個選項　${dateRangeLabel(template)}`.slice(0, 100),
                    value: template.id,
                })))
        ))
    }

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(templateId('new'))
            .setLabel('➕ 新增模板').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('padm:back')
            .setLabel('◀ 回投票管理').setStyle(ButtonStyle.Secondary),
    ))

    return {embeds: [embed], components: rows}
}

/////////////////////////// 模板詳情 ///////////////////////////

export const buildTemplateDetail = (template, {notice = ''} = {}) => {
    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`📋 ${template.name}`)
        .setDescription(notice || '套用這個模板時，下面這些值會自動帶進 `/poll`。')
        .addFields(
            {name: '選項（套用後）', value: optionPreview(template)},
            {name: '日期', value: dateRangeLabel(template), inline: true},
            {name: '重複', value: weeklyLabel(template.weekly), inline: true},
            {name: '身分表', value: identityLabelOf(template.identityGroup), inline: true},
            {name: '複選', value: template.multi ? '開啟' : '關閉', inline: true},
            {name: '一人多角色', value: template.multiChar ? '開啟' : '關閉', inline: true},
            {name: '中途查看', value: template.peek === false ? '僅管理員' : '所有人', inline: true},
        )

    if(template.startDate){
        embed.addFields({
            name: '日期怎麼往前推',
            value: '排程發起下一輪時，起日會自動 +7 天並重算選項上的日期。' +
                '模板本身的起日不會被改動。',
        })
    }

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(templateId('edit', template.id))
                    .setLabel('編輯').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(templateId('del', template.id))
                    .setLabel('刪除').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(templateId('home'))
                    .setLabel('◀ 回模板列表').setStyle(ButtonStyle.Secondary),
            ),
            //三個開關不放進 Modal —— Modal 只有五格，已經被名稱、選項、起日、
            //身分表、每週設定佔滿了。開關用按鈕直接切，也比在文字框裡打 true/false 好用。
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(templateId('tgl', template.id, 'multi'))
                    .setLabel(`複選：${template.multi ? '開' : '關'}`).setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(templateId('tgl', template.id, 'multiChar'))
                    .setLabel(`一人多角色：${template.multiChar ? '開' : '關'}`).setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(templateId('tgl', template.id, 'peek'))
                    .setLabel(`中途查看：${template.peek === false ? '僅管理員' : '所有人'}`)
                    .setStyle(ButtonStyle.Secondary),
            ),
        ],
    }
}

/////////////////////////// 編輯視窗 ///////////////////////////

export const buildTemplateModal = (template = null) => {
    const modal = new ModalBuilder()
        .setCustomId(template ? templateId('save', template.id) : templateId('save'))
        .setTitle(template ? '編輯模板' : '新增模板')

    const field = (id, label, value, {required = false, placeholder = '', long = false} = {}) => {
        const input = new TextInputBuilder()
            .setCustomId(id)
            .setLabel(label.slice(0, 45))
            .setStyle(long ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(required)
        if(value) input.setValue(String(value).slice(0, 1000))
        if(placeholder) input.setPlaceholder(placeholder.slice(0, 100))
        return new ActionRowBuilder().addComponents(input)
    }

    modal.addComponents(
        field('name', '模板名稱', template ? template.name : '', {
            required: true,
            placeholder: '例如：楓之谷週常。這個名稱會出現在 /poll 的下拉選單',
        }),
        field('options', '選項（逗號分隔）', template ? template.options.join(',') : '', {
            required: true,
            long: true,
            placeholder: '星期二,星期三,星期四,星期五,星期六,星期日,星期一',
        }),
        field('startDate', '起日 YYYY-MM-DD（留空=不套用日期）', template ? template.startDate : '', {
            placeholder: '例如 2026-08-18。迄日由選項數自動推算',
        }),
        field('identity', '身分表（留空=不附身分選單）', template ? template.identityGroup : '', {
            placeholder: Object.keys(identityGroups).join(' / '),
        }),
        field('weekly', '每週：發起星期,時間 / 結算星期,時間', formatWeeklyText(template && template.weekly), {
            placeholder: '例如 2,10:00 / 1,22:00（0=星期日）。留空代表不重複',
        }),
    )

    return modal
}

/////////////////////////// 動作分派 ///////////////////////////

const home = async (notice) => buildTemplateList(await listTemplates(), {notice})

const detailOf = async (id, notice) => {
    const template = await getTemplate(id)
    if(!template) return home('那個模板已經不存在了。')
    return buildTemplateDetail(template, {notice})
}

//回傳可以直接丟給 editReply() 的內容。
//'new' 與 'edit' 不在這裡處理 —— 開 Modal 必須直接對 interaction 呼叫 showModal()，
//不能先 defer，所以跟投票管理一樣由事件層處理。
export const handleTemplateAction = async (interaction, {action, id, extra}) => {
    const by = interaction.user.tag

    if(action === 'home') return home()
    if(action === 'pick') return detailOf(interaction.values[0])

    if(!id) return home()

    if(action === 'del'){
        const template = await getTemplate(id)
        if(!template) return home('那個模板已經不存在了。')

        //刪掉就沒了，先問一次。誤觸的成本是整份模板要重打一遍。
        return {
            embeds: [new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle(`🗑️ 刪除模板「${template.name}」？`)
                .setDescription('已經用這個模板建立的投票不受影響，只是之後不能再套用它。')],
            components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(templateId('delok', id))
                    .setLabel('確定刪除').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId(templateId('pickone', id))
                    .setLabel('取消').setStyle(ButtonStyle.Secondary),
            )],
        }
    }

    if(action === 'delok'){
        const template = await getTemplate(id)
        if(!template) return home('那個模板已經不存在了。')

        await deleteTemplate(id)
        logger.info(`投票模板已刪除：${id}「${template.name}」by=${by}`)
        return home(`已刪除模板「${template.name}」。`)
    }

    if(action === 'pickone') return detailOf(id)

    if(action === 'tgl'){
        const template = await getTemplate(id)
        if(!template) return home('那個模板已經不存在了。')

        if(extra === 'multi') template.multi = !template.multi
        else if(extra === 'peek') template.peek = template.peek === false
        else if(extra === 'multiChar'){
            //沒有身分表就開不了一人多角色(同 /poll 的規則)。
            //讓它開起來的話，套用模板時會在建立階段才被擋下來。
            if(!template.identityGroup && !template.multiChar){
                return buildTemplateDetail(template, {
                    notice: '⚠️ 要開啟「一人多角色」必須先設定身分表，否則結算名單分不出誰是誰。',
                })
            }
            template.multiChar = !template.multiChar
        }

        await saveTemplate(template)
        return buildTemplateDetail(template, {notice: '已更新。'})
    }

    return home()
}

//Modal 送出後的處理。驗證失敗時回錯誤訊息，不寫入任何東西。
//id 為 null 代表新增。
export const handleTemplateSubmit = async (interaction, id, fields) => {
    const existing = id ? await getTemplate(id) : null
    if(id && !existing) return home('那個模板已經不存在了。')

    const {template, error} = parseTemplateFields(fields, existing)
    if(error){
        //驗證失敗時把畫面留在原地，並且不套用任何一項修改 ——
        //只寫入其中幾格會讓模板變成半新半舊，比整批退回更難收拾。
        if(existing) return buildTemplateDetail(existing, {notice: `⚠️ ${error}　沒有做任何修改。`})
        return home(`⚠️ ${error}　模板沒有建立。`)
    }

    await saveTemplate(template)
    logger.info(`投票模板已${existing ? '更新' : '建立'}：${template.id}「${template.name}」by=${interaction.user.tag}`)

    return buildTemplateDetail(template, {notice: existing ? '已更新。' : '模板已建立。'})
}

export default {
    TEMPLATE_PREFIX,
    TEMPLATE_MODAL_FIELDS,
    templateId,
    parseTemplateCustomId,
    buildTemplateList,
    buildTemplateDetail,
    buildTemplateModal,
    handleTemplateAction,
    handleTemplateSubmit,
}
