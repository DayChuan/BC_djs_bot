import {Events, MessageFlags} from 'discord.js'
import {useAppStroe} from '@/store/app'
import logger from '@/core/logger'
import {PANEL_BUTTON_ID, PANEL_SELECT_ID, buildMemberPanel} from '@/core/rolePanel'
import {syncRoles} from '@/core/roleGrant'
import {getRoleIds} from '@/core/selfRoles'
import {parsePollCustomId} from '@/core/pollRender'
import {
    checkQuickEnd,
    closePoll,
    handleAdminAction,
    handleAdminEditSubmit,
    handlePollAction as pollAction,
    handleQuickVote,
    peekPoll,
} from '@/core/pollService'
import {buildEditModal, findAdminItem, parseAdminCustomId} from '@/core/pollAdmin'

export const event = {
    name: Events.InteractionCreate
}

//依 interaction 當下的狀態選對回覆方式：
//初次回應只能有一次，已經 defer 或回覆過還呼叫 reply() 會拋 InteractionAlreadyReplied。
//而這個函式是在 catch 裡被呼叫的，外面沒有人接手，所以它自己也要包 try/catch，
//絕對不能再往外拋(ISSUES.md 的 C-03 就是錯誤處理自己爆炸)。
const safeRespond = async(interaction, content) => {
    try{
        const payload = {content, flags: MessageFlags.Ephemeral}
        if(interaction.deferred || interaction.replied) await interaction.followUp(payload)
        else await interaction.reply(payload)
    }
    catch(e){
        logger.error('回覆 interaction 失敗(只記錄，不再往外拋)：', e)
    }
}

const handleChatInputCommand = async(interaction) => {
    const appStroe = useAppStroe()
    const map = appStroe.commandActionMap

    //開機競態：loadCommands() 還沒把 map 填好就有人下指令(ISSUES.md 的 C-04)。
    //原本會對 null 呼叫 .get() 然後終止行程。
    if(!map){
        logger.warn(`指令 ${interaction.commandName} 在指令表建立完成前被呼叫`)
        await safeRespond(interaction, '機器人還在啟動中，請幾秒後再試一次。')
        return
    }

    //指令曾經註冊過、之後資料夾被移除時，Discord 端仍保留該指令(ISSUES.md 的 C-05)。
    //原本會變成 action is not a function 然後終止行程。
    const action = map.get(interaction.commandName)
    if(typeof action !== 'function'){
        logger.warn(`收到未知的指令：${interaction.commandName}`)
        await safeRespond(interaction, '這個指令已經失效了，請通知管理員。')
        return
    }

    await action(interaction)
}

//點下面板按鈕：用 ephemeral 顯示個人化的身分組面板。
//先 defer 是因為後面要抓成員與身分組，不一定來得及在 3 秒內完成。
const handlePanelOpen = async(interaction) => {
    await interaction.deferReply({flags: MessageFlags.Ephemeral})
    const member = await interaction.guild.members.fetch(interaction.user.id)
    await interaction.editReply(await buildMemberPanel(interaction.guild, member))
}

//送出選單：把身分組對齊勾選結果，然後就地更新那則 ephemeral 訊息
const handlePanelSelect = async(interaction) => {
    await interaction.deferUpdate()

    const member = await interaction.guild.members.fetch(interaction.user.id)
    const {added, removed} = await syncRoles(member, interaction.values, getRoleIds())

    const toRoles = (ids) => ids
        .map((id) => interaction.guild.roles.cache.get(id))
        .filter(Boolean)

    if(added.length > 0 || removed.length > 0){
        logger.info(
            `面板調整身分組：user=${interaction.user.tag} ` +
            `加入=[${toRoles(added).map((role) => role.name).join(',')}] ` +
            `退出=[${toRoles(removed).map((role) => role.name).join(',')}]`
        )
    }

    //改完一定要 force 重抓，否則快取還是舊的，畫面上的勾選狀態不會更新
    const fresh = await interaction.guild.members.fetch({user: interaction.user.id, force: true})
    await interaction.editReply(
        await buildMemberPanel(interaction.guild, fresh, {
            added: toRoles(added),
            removed: toRoles(removed),
        })
    )
}

//投票面板上的所有操作。回覆一律 ephemeral：投了什麼只有自己看得到。
//公開訊息刻意不顯示即時票數 —— 一來會有從眾效應，
//二來每投一票就要編輯一次訊息，人多時很容易撞到速率限制。
//
//來源有兩種，回應方式不同：
//  ・面板本身(ephemeral 訊息) → 就地更新那則面板
//  ・公開訊息上的按鈕，或改版前發出的舊投票選單 → 開一則新的 ephemeral 面板
const handlePollAction = async(interaction, parsed) => {
    const fromPanel = Boolean(interaction.message && interaction.message.flags
        && interaction.message.flags.has(MessageFlags.Ephemeral))

    if(fromPanel) await interaction.deferUpdate()
    else await interaction.deferReply({flags: MessageFlags.Ephemeral})

    //回 null 代表「只更新草稿、畫面不用動」。
    //選項每點一下就重繪面板的話，使用者每一下都要等一次 Discord 往返。
    const payload = await pollAction(interaction, parsed, {fromPanel})
    if(payload) await interaction.editReply(payload)
}

//管理面板。所有動作都在同一則 ephemeral 訊息上就地更新，
//管理員不會被一堆新訊息洗版，也不必記任何 id。
const handleAdmin = async(interaction, parsed) => {
    //開 Modal 必須直接對 interaction 呼叫，不能先 defer，所以要單獨處理
    if(parsed.action === 'edit'){
        const item = await findAdminItem(parsed.pollId)
        if(!item){
            await interaction.reply({content: '那場投票已經不存在了。', flags: MessageFlags.Ephemeral})
            return
        }
        await interaction.showModal(buildEditModal(item.poll))
        return
    }

    await interaction.deferUpdate()
    await interaction.editReply(await handleAdminAction(interaction, parsed))
}

//快速投票：訊息本身就是公開即時更新的，所以直接就地改那則訊息，
//不像一般投票要另開個人面板。
const handleQuick = async(interaction, parsed) => {
    if(parsed.kind === 'qend'){
        //權限要在 defer 之前檢查完 —— deferUpdate 之後就不能再用
        //ephemeral 回覆拒絕了，只能默默什麼都不做。
        const error = await checkQuickEnd(interaction, parsed.pollId)
        if(error){
            await interaction.reply({content: error, flags: MessageFlags.Ephemeral})
            return
        }

        await interaction.deferUpdate()
        //closePoll 會把原訊息換成最終結果，這裡不必再 editReply
        await closePoll(interaction.client, parsed.pollId)
        return
    }

    await interaction.deferUpdate()
    const payload = await handleQuickVote(interaction, parsed)
    if(payload) await interaction.editReply(payload)
}

//「查看目前結果」按鈕。只有開放中途查看的投票才會掛這顆按鈕，
//所以這裡不必再檢查權限；回覆同樣是 ephemeral，不會洗版也不會影響其他人。
const handlePollPeek = async(interaction, parsed) => {
    await interaction.deferReply({flags: MessageFlags.Ephemeral})
    await interaction.editReply(await peekPoll(parsed.pollId))
}

export const action = async(interaction) => {
    try{
        if(interaction.isChatInputCommand()){
            await handleChatInputCommand(interaction)
            return
        }
        if(interaction.isButton() && interaction.customId === PANEL_BUTTON_ID){
            await handlePanelOpen(interaction)
            return
        }
        //編輯視窗送出。Modal 沒有原本那則面板可以更新，所以另開一則 ephemeral 回覆。
        if(interaction.isModalSubmit()){
            const parsed = parseAdminCustomId(interaction.customId)
            if(parsed && parsed.action === 'save'){
                await interaction.deferReply({flags: MessageFlags.Ephemeral})
                const fields = Object.fromEntries(
                    ['title', 'description', 'closeAt', 'weeklyOpen', 'weeklyClose']
                        .map((id) => [id, interaction.fields.getTextInputValue(id)])
                )
                await interaction.editReply(await handleAdminEditSubmit(interaction, parsed.pollId, fields))
                return
            }
        }
        if(interaction.isButton() || interaction.isStringSelectMenu()){
            const admin = parseAdminCustomId(interaction.customId)
            if(admin){
                await handleAdmin(interaction, admin)
                return
            }
        }
        if(interaction.isButton()){
            const parsed = parsePollCustomId(interaction.customId)
            if(parsed){
                if(parsed.kind === 'q' || parsed.kind === 'qend') await handleQuick(interaction, parsed)
                else if(parsed.kind === 'peek') await handlePollPeek(interaction, parsed)
                else await handlePollAction(interaction, parsed)
                return
            }
        }
        if(interaction.isStringSelectMenu() && interaction.customId === PANEL_SELECT_ID){
            await handlePanelSelect(interaction)
            return
        }
        if(interaction.isStringSelectMenu()){
            const parsed = parsePollCustomId(interaction.customId)
            if(parsed){
                await handlePollAction(interaction, parsed)
                return
            }
        }
        //其他類型的 interaction 目前不處理
    }
    catch(e){
        //原本整個檔案沒有 try/catch，任何錯誤都會終止行程
        logger.error(
            `處理 interaction 失敗：` +
            `command=${interaction.commandName || '-'} customId=${interaction.customId || '-'}`,
            e
        )
        await safeRespond(interaction, '執行時發生錯誤，管理員已收到紀錄。')
    }
}
