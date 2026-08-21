import {PermissionFlagsBits} from 'discord.js'
import config from '@/config'
import {EDIT_MS, TICK_MS, TTS_DELETE_MS} from '@/config/horntail'
import logger from '@/core/logger'
import {buildPanelMessage, buildWarnMessage} from '@/core/timerRender'
import {
    anyRunning,
    createPanel,
    isExpired,
    isIdle,
    stopAll,
    tick,
    toggleTimer,
    touch,
} from '@/core/timerState'

//channelId -> {panel, message, lastEditAt, dirty, editing}
//一個頻道同時只有一個面板：兩個面板就是兩倍的編輯量，
//而且畫面上會出現兩份互相矛盾的倒數。
const panels = new Map()

//整個 bot 只有一個 tick 迴圈，管理所有頻道的面板。
//三個招式各自 setInterval 每秒編輯 = 每秒三次編輯，一分鐘就會開始吃 429。
let loop = null

//編輯失敗多半是被限流了，罰站一下再試，不要下一個 tick 就馬上重打。
const EDIT_PENALTY_MS = 10_000

const startLoop = () => {
    if(loop) return
    loop = setInterval(tickAll, TICK_MS)
}

//沒有任何面板時把迴圈收掉，不留一個永遠空轉的 interval。
const stopLoop = () => {
    if(!loop) return
    clearInterval(loop)
    loop = null
}

/**
 * 實際編輯面板訊息。
 *
 * 一次編輯把三個招式一起更新 —— 節流的分母是「面板」不是「招式」。
 * editing 旗標擋住重疊的編輯：上一次還沒回來就跳過這次，
 * 否則網路一慢就會堆出一串併發請求，正好是限流最討厭的形狀。
 *
 * 這裡一定要接住錯誤。未 await 的 Promise 若 reject，外層 try/catch 攔不到，
 * Node 會直接終止行程 —— 一次編輯失敗把整個 bot 帶走完全不划算。
 */
const flush = (entry, now) => {
    if(entry.editing) return

    entry.editing = true
    entry.lastEditAt = now
    entry.dirty = false

    entry.message.edit(buildPanelMessage(entry.panel, now))
        .catch((error) => {
            entry.lastEditAt = now + EDIT_PENALTY_MS
            entry.dirty = true
            logger.error(`[horntail] 編輯面板失敗 channel=${entry.panel.channelId}：${error.message}`)
        })
        .finally(() => {
            entry.editing = false
        })
}

/**
 * 語音提醒。發一則 TTS 訊息，TTS_DELETE_MS 之後自己刪掉。
 *
 * 三個招式循環下來每分鐘好幾則，不刪就是洗版。
 * 刪除失敗一律吞掉只記 log —— 訊息可能已經被人手動刪了，
 * 而這段程式在計時的路徑上，不能因為清垃圾失敗就把計時器打斷。
 */
const sendWarn = (entry, timer) => {
    entry.message.channel.send(buildWarnMessage(timer))
        .then((sent) => {
            setTimeout(() => {
                sent.delete().catch((error) => {
                    logger.warn(`[horntail] 刪除提醒訊息失敗(略過)：${error.message}`)
                })
            }, TTS_DELETE_MS)
        })
        .catch((error) => {
            logger.warn(`[horntail] 發送提醒失敗 channel=${entry.panel.channelId}：${error.message}`)
        })
}

const tickPanel = (entry, now) => {
    //總時限到、或太久沒人碰，就收掉。
    //少了這一段，打完王大家關掉 Discord，面板會每 2 秒編輯一次直到 bot 重啟。
    //
    //閒置只在「三個招式都停著」時才算 —— 計時器還在跑就是有人在用，
    //不能因為連續 30 分鐘沒按按鈕就把打到一半的面板收掉。
    //真的被遺忘的跑著的面板由兩小時總時限收尾。
    const idle = !anyRunning(entry.panel) && isIdle(entry.panel, now)
    if(isExpired(entry.panel, now) || idle){
        const reason = isExpired(entry.panel, now) ? '已達兩小時總時限' : '30 分鐘無人操作'
        logger.info(`[horntail] 自動收面板 channel=${entry.panel.channelId}：${reason}`)
        closePanel(entry.panel.channelId).catch((error) => {
            logger.error(`[horntail] 自動收面板失敗：${error.message}`)
        })
        return
    }

    //warned / rolled 由狀態機算，這裡只決定要不要發出去。
    const {warned} = tick(entry.panel, now)
    for(const key of warned) sendWarn(entry, entry.panel.timers[key])

    //都停著而且畫面已經是最新的，就完全不要碰 API。
    //面板開著沒人用的時候，這個分支讓編輯次數降到零。
    if(!anyRunning(entry.panel) && !entry.dirty) return
    if(now - entry.lastEditAt < EDIT_MS) return

    flush(entry, now)
}

const tickAll = () => {
    const now = Date.now()
    for(const entry of [...panels.values()]) tickPanel(entry, now)
    if(panels.size === 0) stopLoop()
}

export const getPanel = (channelId) => panels.get(channelId)?.panel ?? null

export const hasPanel = (channelId) => panels.has(channelId)

/**
 * 收掉一個面板：停掉所有計時器、把訊息改成「已結束」並移除按鈕。
 *
 * 訊息可能已經被人手動刪掉，編輯失敗只記 log —— 收尾失敗不該往外丟。
 */
export const closePanel = async (channelId) => {
    const entry = panels.get(channelId)
    if(!entry) return false

    panels.delete(channelId)
    stopAll(entry.panel)
    if(panels.size === 0) stopLoop()

    try{
        await entry.message.edit(buildPanelMessage(entry.panel, Date.now(), {ended: true}))
    }
    catch(error){
        logger.warn(`[horntail] 收面板時編輯訊息失敗 channel=${channelId}：${error.message}`)
    }

    return true
}

/**
 * 建立面板。同一個頻道已經有面板的話，先把舊的收掉。
 *
 * 面板用 channel.send() 發，不用 interaction 的回覆 ——
 * 指令的回覆是 webhook 訊息，壽命 15 分鐘，之後就編輯不了了，而面板要活兩小時。
 */
export const openPanel = async (channel) => {
    await closePanel(channel.id)

    const now = Date.now()
    const panel = createPanel(channel.id, now)
    const message = await channel.send(buildPanelMessage(panel, now))

    panel.messageId = message.id
    panels.set(channel.id, {panel, message, lastEditAt: now, dirty: false, editing: false})
    startLoop()

    logger.info(`[horntail] 面板建立 channel=${channel.id} message=${message.id}`)
    return panel
}

/**
 * 按鈕：切換某個招式。在跑就停、沒跑就從初始秒數重新開始。
 *
 * 這裡不編輯訊息，只把 dirty 立起來讓下一次 tick 一起處理 ——
 * 每個互動各自編輯一次，等於把限流的分母乘上人數。
 * 回 false 代表記憶體裡沒有這個面板（bot 重啟過），呼叫端要回「面板已失效」。
 */
export const toggleSkill = (channelId, skillKey, now = Date.now()) => {
    const entry = panels.get(channelId)
    if(!entry) return false

    const timer = toggleTimer(entry.panel, skillKey, now)
    if(!timer) return false

    touch(entry.panel, now)
    entry.dirty = true
    return true
}

//按鈕：全部停止。只停計時器，面板留著，可以再按開始。
export const stopAllSkills = (channelId, now = Date.now()) => {
    const entry = panels.get(channelId)
    if(!entry) return false

    stopAll(entry.panel)
    touch(entry.panel, now)
    entry.dirty = true
    return true
}

/**
 * GM 身分組檢查。指令與**每一次**按鈕互動都要各檢查一次 ——
 * 面板是公開訊息，那三顆按鈕任何人都看得到，按下去就是一次 interaction。
 *
 * setDefaultMemberPermissions() 只吃權限位元、不吃身分組，所以擋不了這個，
 * 一定要寫在 handler 裡。
 *
 * 沒設定 permissionRoles.gm 時 fail closed：退回「只有管理員能用」，
 * 不是「所有人都能用」。少了這一行，任何一個環境忘了填 id 就會全開。
 */
export const isGmMember = (member) => {
    if(!member) return false

    const gmRoleId = config.permissionRoles && config.permissionRoles.gm
    if(!gmRoleId) return Boolean(member.permissions && member.permissions.has(PermissionFlagsBits.Administrator))

    return Boolean(member.roles && member.roles.cache && member.roles.cache.has(gmRoleId))
}

export default {
    getPanel,
    hasPanel,
    isGmMember,
    openPanel,
    closePanel,
    toggleSkill,
    stopAllSkills,
}
