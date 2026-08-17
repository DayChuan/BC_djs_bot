import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder,
} from 'discord.js'
import {getRoles, refreshNames} from '@/core/selfRoles'
import logger from '@/core/logger'

//這兩個 id 是固定字串，所以 bot 重啟後頻道裡那則面板訊息照樣能用，
//不需要重發，也不需要保存任何狀態。
export const PANEL_BUTTON_ID = 'role-panel-open'
export const PANEL_SELECT_ID = 'role-panel-select'

const COLOR = 0x5865F2

//頻道裡常駐的那則訊息。對所有人都一樣，所以不能顯示個人狀態，
//只放一顆按鈕，個人化的內容等按下去之後用 ephemeral 呈現。
export const buildPanelMessage = () => {
    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('🎭 身分組領取')
        .setDescription('點下方按鈕來查看與管理你的身分組。\n你的操作只有你自己看得到，不會洗版。')

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(PANEL_BUTTON_ID)
            .setLabel('管理我的身分組')
            .setStyle(ButtonStyle.Primary)
    )

    return {embeds: [embed], components: [row]}
}

//把清單裡的 id 轉成伺服器上的實際身分組物件。
//查不到的(身分組被刪掉)會被排除，並回報給呼叫端。
const resolveRoles = async(guild) => {
    const entries = getRoles()
    const found = []
    const missing = []

    for(const entry of entries){
        const role = guild.roles.cache.get(entry.id) || await guild.roles.fetch(entry.id).catch(() => null)
        if(role) found.push(role)
        else missing.push(entry)
    }

    if(missing.length > 0){
        logger.warn(
            `身分組清單裡有 ${missing.length} 個 id 在伺服器上不存在，面板已略過：` +
            missing.map((entry) => `${entry.name || '(未命名)'}(${entry.id})`).join(' / ')
        )
    }

    //順手把名稱快照更新成實際名稱
    refreshNames(new Map(found.map((role) => [role.id, role.name])))

    return found
}

//按下按鈕之後，只給該使用者看的個人面板。
//因為是 ephemeral，選單可以帶 default 勾選 —— 使用者看得到自己目前的狀態。
export const buildMemberPanel = async(guild, member, changes) => {
    const roles = await resolveRoles(guild)

    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('你的身分組')

    if(roles.length === 0){
        embed.setDescription(
            '目前沒有開放自助領取的身分組。\n管理員可以用 `/selfrole add` 新增。'
        )
        return {embeds: [embed], components: []}
    }

    //✅ 已擁有 / ⬜ 未擁有，讓使用者一眼看到現況
    embed.setDescription(
        roles
            .map((role) => `${member.roles.cache.has(role.id) ? '✅' : '⬜'} ${role.name}`)
            .join('\n')
    )

    //剛做完變更的話，把這次動了什麼列在下面
    if(changes){
        const lines = []
        if(changes.added.length > 0){
            lines.push(`✅ 已加入：${changes.added.map((role) => role.name).join('、')}`)
        }
        if(changes.removed.length > 0){
            lines.push(`➖ 已退出：${changes.removed.map((role) => role.name).join('、')}`)
        }
        embed.addFields({
            name: '這次的變更',
            value: lines.length > 0 ? lines.join('\n') : '沒有任何變更',
        })
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId(PANEL_SELECT_ID)
        .setPlaceholder('勾選你要的身分組(取消勾選就是退出)')
        .setMinValues(0)                    //可以全部取消
        .setMaxValues(roles.length)         //可以全選
        .addOptions(
            roles.map((role) => ({
                label: role.name.slice(0, 100),     //Discord 限制 100 字
                value: role.id,
                default: member.roles.cache.has(role.id),   //預先勾選目前已有的
            }))
        )

    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(select)],
    }
}
