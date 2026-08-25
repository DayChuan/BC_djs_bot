//闇黑龍王計時器的純狀態機。
//
//這個檔案不碰 discord.js、不做任何 I/O、也不呼叫 Date.now() ——
//時間一律由呼叫端傳 now 進來。理由有兩個：
//  1. 單元測試才能用假時間戳直接推進，不用真的等 60 秒。
//  2. 倒數一律用「結束時間 - now」重算，不累加 tick 次數。
//     setInterval 在有負載時會漂移，累加法打完一場王可能差好幾秒。
//
//發 TTS、編輯訊息、收面板都由 timerService 決定，這裡只回報「發生了什麼」。

import {SKILLS, WARN_SECONDS, PANEL_MAX_MS, PANEL_IDLE_MS} from '@/config/horntail'

//建立一個頻道的面板狀態。三個招式都是停著的，剩餘秒數等於各自的初始值。
export const createPanel = (channelId, now) => ({
    channelId,
    messageId: null,          //面板訊息發出後由 service 填回來
    createdAt: now,
    expiresAt: now + PANEL_MAX_MS,
    lastActionAt: now,        //閒置判斷用，每次有人按按鈕就更新
    timers: Object.fromEntries(SKILLS.map((skill) => [skill.key, {
        key: skill.key,
        label: skill.label,
        voice: skill.voice,       //TTS 唸的短名
        emoji: skill.emoji,       //招式的顏色
        seconds: skill.seconds,
        running: false,
        endsAt: null,
        warned: false,        //這一輪的 5 秒提醒發過了沒
        rounds: 0,
    }])),
})

export const getTimer = (panel, key) => panel.timers[key] ?? null

export const anyRunning = (panel) => Object.values(panel.timers).some((timer) => timer.running)

//剩餘秒數。沒在跑的時候回初始秒數（面板上顯示的是「按下去會從幾秒開始」）。
export const remainingSeconds = (timer, now) => {
    if(!timer.running || timer.endsAt === null) return timer.seconds
    return Math.max(0, Math.ceil((timer.endsAt - now) / 1000))
}

export const startTimer = (panel, key, now) => {
    const timer = getTimer(panel, key)
    if(!timer) return null

    timer.running = true
    timer.endsAt = now + (timer.seconds * 1000)
    timer.warned = false
    timer.rounds = 0
    return timer
}

export const stopTimer = (panel, key) => {
    const timer = getTimer(panel, key)
    if(!timer) return null

    timer.running = false
    timer.endsAt = null
    timer.warned = false
    return timer
}

/**
 * 按鈕的語意（2026-08-24 改）：**按一下開始，再按一下從頭重新計時**。
 *
 * 原本是「在跑就停」，但實際打王時遇到延遲或遊戲本身 delay，
 * 使用者要的是「重新計時」——舊語意得先按一次停、再按一次開，
 * 而每一次按鈕都要等一輪 Discord 互動往返，現場根本來不及。
 *
 * 要停下來改用面板上的「全部停止」。
 */
export const pressTimer = (panel, key, now) => startTimer(panel, key, now)

export const stopAll = (panel) => {
    for(const key of Object.keys(panel.timers)) stopTimer(panel, key)
    return panel
}

//有人按了按鈕。閒置 30 分鐘自動收面板是靠這個時間戳判斷的。
export const touch = (panel, now) => {
    panel.lastActionAt = now
    return panel
}

/**
 * 推進一個 tick。純計算，不做任何 I/O。
 *
 * 回傳 {warned, rolled}，兩個都是招式 key 的陣列：
 *   warned —— 這次 tick 剛好跨進「剩 5 秒」，service 要發 TTS。同一輪只會出現一次。
 *   rolled —— 這次 tick 歸零並自動進入下一輪。
 */
export const tick = (panel, now) => {
    const warned = []
    const rolled = []

    for(const timer of Object.values(panel.timers)){
        if(!timer.running || timer.endsAt === null) continue

        if(now >= timer.endsAt){
            const duration = timer.seconds * 1000
            //疊加而不是 now + duration，這樣每一輪的相位不會被 tick 的誤差推著跑。
            //但真的落後超過一整輪（例如行程卡住了）就重新對時，不要一次補跳好幾輪。
            const next = timer.endsAt + duration
            timer.endsAt = next <= now ? now + duration : next
            timer.warned = false
            timer.rounds += 1
            rolled.push(timer.key)
        }

        const remaining = remainingSeconds(timer, now)
        if(!timer.warned && remaining > 0 && remaining <= WARN_SECONDS){
            timer.warned = true
            warned.push(timer.key)
        }
    }

    return {warned, rolled}
}

//總時限：兩小時
export const isExpired = (panel, now) => now >= panel.expiresAt

//閒置：連續 30 分鐘沒有人按過任何按鈕
export const isIdle = (panel, now) => (now - panel.lastActionAt) >= PANEL_IDLE_MS

//90 → "1:30"、5 → "0:05"
export const formatRemaining = (seconds) => {
    const total = Math.max(0, Math.floor(seconds))
    const minutes = Math.floor(total / 60)
    return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

export default {
    createPanel,
    getTimer,
    anyRunning,
    remainingSeconds,
    startTimer,
    stopTimer,
    pressTimer,
    stopAll,
    touch,
    tick,
    isExpired,
    isIdle,
    formatRemaining,
}
