import {PermissionFlagsBits} from 'discord.js'
import config from '@/config'
import {EDIT_MS, TICK_MS, TTS_DELETE_MS, VOICE_EMPTY_MS} from '@/config/horntail'
import logger from '@/core/logger'
import {buildPanelMessage, buildWarnMessage} from '@/core/timerRender'
import {
    anyRunning,
    createPanel,
    isExpired,
    isIdle,
    stopAll,
    tick,
    pressTimer,
    touch,
} from '@/core/timerState'

//channelId -> {panel, message, lastEditAt, dirty, editing, emptySince}
//一個頻道同時只有一個面板：兩個面板就是兩倍的編輯量，
//而且畫面上會出現兩份互相矛盾的倒數。
const panels = new Map()

//整個 bot 只有一個 tick 迴圈，管理所有頻道的面板。
//三個招式各自 setInterval 每秒編輯 = 每秒三次編輯，一分鐘就會開始吃 429。
let loop = null

//編輯失敗多半是被限流了，罰站一下再試，不要下一個 tick 就馬上重打。
const EDIT_PENALTY_MS = 10_000

//一次編輯超過這個時間就記一筆 WARN。
//正常情況下 message.edit() 大約幾百毫秒；超過 EDIT_MS(2 秒)就代表
//下一個 tick 會因為 editing 還在而跳過，畫面更新間隔直接變成 4 秒、6 秒。
const SLOW_EDIT_MS = 2000

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

    //editing 旗標會把「單次編輯很慢」轉成「畫面更新變慢」而不是塞爆佇列 ——
    //這是刻意的，但也代表變慢的時候 log 上完全看不出來(它不是錯誤，只是等比較久)。
    //所以要量：一次編輯超過 SLOW_EDIT_MS 就記一筆，
    //否則「更新從 2 秒變成 6 秒」這種問題永遠只能用猜的。
    const startedAt = Date.now()

    entry.message.edit(buildPanelMessage(entry.panel, now))
        .then(() => {
            const cost = Date.now() - startedAt
            if(cost < SLOW_EDIT_MS) return

            entry.slowEdits += 1
            logger.warn(
                `[horntail] 編輯偏慢 channel=${entry.panel.channelId} ` +
                `耗時=${cost}ms 累計=${entry.slowEdits} 次`
            )
        })
        .catch((error) => {
            entry.lastEditAt = now + EDIT_PENALTY_MS
            entry.dirty = true
            logger.error(
                `[horntail] 編輯面板失敗 channel=${entry.panel.channelId} ` +
                `耗時=${Date.now() - startedAt}ms：${error.message}`
            )
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

/**
 * 面板所在的語音頻道已經空了多久（毫秒）。有人在就回 0 並清掉計時起點。
 *
 * 面板一定開在語音頻道的聊天室（09-14），所以要監看的就是面板自己的頻道，
 * 不必另外記要綁哪一個。
 *
 * `channel.members` 是即時算出來的（靠 GuildVoiceStates intent），
 * 少了那個 intent 這裡永遠是 0 人，面板會在寬限時間到就被誤收 ——
 * 所以 `src/main.js` 的 intent 是這一段的硬前提。
 *
 * 改版前建立的面板可能不在語音頻道，那種一律回 0（維持原本的兩個收面板條件）。
 */
const voiceEmptyFor = (entry, now) => {
    const channel = entry.message.channel
    const isVoice = channel && typeof channel.isVoiceBased === 'function' && channel.isVoiceBased()
    if(!isVoice || !channel.members){
        entry.emptySince = null
        return 0
    }

    //bot 自己不算人。只有 bot 留在頻道裡的話，那就是沒人。
    const humans = channel.members.filter((member) => !member.user.bot).size
    if(humans > 0){
        entry.emptySince = null
        return 0
    }

    if(entry.emptySince === null) entry.emptySince = now
    return now - entry.emptySince
}

const tickPanel = (entry, now) => {
    //總時限到、或太久沒人碰，就收掉。
    //少了這一段，打完王大家關掉 Discord，面板會每 2 秒編輯一次直到 bot 重啟。
    //
    //閒置只在「三個招式都停著」時才算 —— 計時器還在跑就是有人在用，
    //不能因為連續 30 分鐘沒按按鈕就把打到一半的面板收掉。
    //真的被遺忘的跑著的面板由兩小時總時限收尾。
    //語音頻道沒人就收，跟計時器有沒有在跑無關 —— 人都走光了，倒數給誰看。
    //這是唯一一個「跑著也會收」的條件。
    const idle = !anyRunning(entry.panel) && isIdle(entry.panel, now)
    const voiceEmpty = voiceEmptyFor(entry, now) >= VOICE_EMPTY_MS && entry.emptySince !== null
    if(isExpired(entry.panel, now) || idle || voiceEmpty){
        const reason = isExpired(entry.panel, now) ? '已達兩小時總時限'
            : idle ? '30 分鐘無人操作'
                : '語音頻道沒人'
        closePanel(entry.panel.channelId, reason).catch((error) => {
            logger.error(`[horntail] 自動收面板失敗：${error.message}`)
        })
        return
    }

    //warned / rolled 由狀態機算，這裡只決定要不要發出去。
    const {warned, rolled} = tick(entry.panel, now)
    for(const key of warned) sendWarn(entry, entry.panel.timers[key])

    //歸零進下一輪 = endsAt 換了，畫面上的時間戳要跟著換，所以要重畫一次。
    if(rolled.length > 0) entry.dirty = true

    //2026-08-24：倒數改由用戶端自己算之後，「還在跑」不再是編輯的理由 ——
    //只有狀態真的變了（有人按按鈕、或某一輪歸零）才需要重畫。
    //編輯次數因此從每分鐘 30 次降到約 4 次，網路不穩時也不再卡住畫面。
    if(!entry.dirty) return
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
export const closePanel = async (channelId, reason = '未註明') => {
    const entry = panels.get(channelId)
    if(!entry) return false

    panels.delete(channelId)
    stopAll(entry.panel)
    if(panels.size === 0) stopLoop()

    //每一次收面板都留紀錄。少了它，log 裡只看得到「面板建立」，
    //查「那個面板到底有沒有收掉」時完全沒有依據。
    logger.info(
        `[horntail] 面板收起 channel=${channelId}：${reason}` +
        (entry.slowEdits > 0 ? `（期間偏慢的編輯 ${entry.slowEdits} 次）` : '')
    )

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
    await closePanel(channel.id, '被新面板取代')

    const now = Date.now()
    const panel = createPanel(channel.id, now)
    const message = await channel.send(buildPanelMessage(panel, now))

    panel.messageId = message.id
    panels.set(channel.id, {
        panel, message,
        lastEditAt: now, dirty: false, editing: false,
        emptySince: null, slowEdits: 0,
    })
    startLoop()

    logger.info(`[horntail] 面板建立 channel=${channel.id} message=${message.id}`)
    return panel
}

/**
 * 按鈕：按下某個招式。沒在跑就開始，正在跑就**從頭重新計時**（2026-08-24 改）。
 *
 * 這裡不編輯訊息，只把 dirty 立起來讓下一次 tick 一起處理 ——
 * 每個互動各自編輯一次，等於把限流的分母乘上人數。
 * 回 false 代表記憶體裡沒有這個面板（bot 重啟過），呼叫端要回「面板已失效」。
 */
export const pressSkill = (channelId, skillKey, now = Date.now()) => {
    const entry = panels.get(channelId)
    if(!entry) return false

    const timer = pressTimer(entry.panel, skillKey, now)
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
 * 操作權限檢查：**GM 身分組 或 伺服器管理員**。
 * 指令與**每一次**按鈕互動都要各檢查一次 ——
 * 面板是公開訊息，那幾顆按鈕任何人都看得到，按下去就是一次 interaction。
 *
 * setDefaultMemberPermissions() 只吃權限位元、不吃身分組，所以擋不了這個，
 * 一定要寫在 handler 裡。
 *
 * 管理員一律放行（09-11）：原本只認 GM 身分組，結果沒掛 GM 的管理員自己用不了，
 * 而管理員本來就能改身分組，擋他等於只是多繞一圈。
 *
 * 沒設定 permissionRoles.gm 時 fail closed：退回「只有管理員能用」，
 * 不是「所有人都能用」。少了這個預設，任何一個環境忘了填 id 就會全開。
 *
 * permissionRoles.gm 是 { 伺服器id: 身分組id } 對照表（U07）：身分組 id 綁死在單一伺服器，
 * 同一個 bot 進到第二個伺服器時，拿 A 伺服器的 id 去 B 查一定查不到，所以要用
 * member.guild.id 分流。查不到該伺服器 = 只有管理員能用，fail closed 的語意不變，
 * 新伺服器在填 id 之前管理員仍然可以用。
 */
export const isGmMember = (member) => {
    if(!member) return false

    if(member.permissions && member.permissions.has(PermissionFlagsBits.Administrator)) return true

    const gm = config.permissionRoles && config.permissionRoles.gm
    if(!gm) return false

    //舊格式相容：gm 還是單一字串時沿用舊語意（不分伺服器都認）。
    //現行兩個環境檔都已改成對照表，這條只保護「有環境檔還沒跟著改」的情況。
    const gmRoleId = typeof gm === 'string' ? gm : gm[member.guild && member.guild.id]
    if(!gmRoleId) return false

    return Boolean(member.roles && member.roles.cache && member.roles.cache.has(gmRoleId))
}

export default {
    getPanel,
    hasPanel,
    isGmMember,
    openPanel,
    closePanel,
    pressSkill,
    stopAllSkills,
}
