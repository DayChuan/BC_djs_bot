import cron from 'node-cron'
import logger from '@/core/logger'

//排程一律用台北時間。伺服器時區改變時，投票的發起與截止時間不該跟著跑掉。
export const TIMEZONE = 'Asia/Taipei'

//setTimeout 的延遲是 32 位元有號整數，超過就會「立刻觸發」而不是報錯 ——
//排到一個月後的截止時間會在下一個 tick 就結算掉。所以要分段等待。
export const MAX_TIMEOUT = 2147483647

//key -> {type, cancel}。同一個 key 重複註冊會先取消舊的，
//避免 bot 重連或重複載入時同一場投票被掛上兩份排程、結算兩次。
const jobs = new Map()

///////////////////////// 純函式(可單獨做單元測試) /////////////////////////

//一次最多能等多久。剩餘時間超過上限就先等上限，醒來再算一次。
export const chunkDelay = (remainMs) => {
    if(!Number.isFinite(remainMs) || remainMs <= 0) return 0
    return Math.min(remainMs, MAX_TIMEOUT)
}

//把「星期幾 + HH:mm」轉成 cron 運算式。weekday: 0=星期日 ... 6=星期六
export const weeklyCron = (weekday, time) => {
    const day = Number(weekday)
    if(!Number.isInteger(day) || day < 0 || day > 6){
        throw new Error(`weekday 必須是 0~6，收到：${weekday}`)
    }

    const matched = /^(\d{1,2}):(\d{2})$/.exec(String(time).trim())
    if(!matched) throw new Error(`時間格式必須是 HH:mm，收到：${time}`)

    const hour = Number(matched[1])
    const minute = Number(matched[2])
    if(hour > 23 || minute > 59) throw new Error(`時間超出範圍：${time}`)

    return `${minute} ${hour} * * ${day}`
}

/////////////////////////////// 排程註冊 ///////////////////////////////

//任務絕對不能把錯誤往外拋。排程器裡的未處理 rejection 沒有人接得到，
//會直接終止整個行程(CLAUDE.md 技術重點的第一條)。
const runSafely = async (key, task) => {
    try{
        await task()
    }
    catch(e){
        logger.error(`排程任務「${key}」執行失敗(已攔截，bot 繼續運行)：`, e)
    }
}

export const cancel = (key) => {
    const job = jobs.get(key)
    if(!job) return false
    job.cancel()
    jobs.delete(key)
    return true
}

export const cancelAll = () => {
    for(const key of [...jobs.keys()]) cancel(key)
}

export const has = (key) => jobs.has(key)

export const keys = () => [...jobs.keys()]

//重複性排程(每週投票用)
export const scheduleCron = (key, expression, task) => {
    if(!cron.validate(expression)){
        throw new Error(`不合法的 cron 運算式：${expression}`)
    }

    cancel(key)

    const job = cron.schedule(expression, () => runSafely(key, task), {timezone: TIMEZONE})
    jobs.set(key, {type: 'cron', expression, cancel: () => job.stop()})
    logger.info(`排程已註冊：${key} cron=「${expression}」tz=${TIMEZONE}`)
    return key
}

//一次性排程(投票截止用)。已經過期的時間會立刻執行 ——
//bot 停機期間錯過的截止時間，開機還原時就是靠這個補結算。
export const scheduleAt = (key, when, task) => {
    const target = when instanceof Date ? when.getTime() : new Date(when).getTime()
    if(!Number.isFinite(target)) throw new Error(`不合法的時間：${when}`)

    cancel(key)

    let timer = null
    const tick = () => {
        const remain = target - Date.now()
        if(remain <= 0){
            jobs.delete(key)
            runSafely(key, task)
            return
        }
        timer = setTimeout(tick, chunkDelay(remain))
        //排程不該讓 Node 為了等它而不肯結束
        if(typeof timer.unref === 'function') timer.unref()
    }

    jobs.set(key, {
        type: 'at',
        at: new Date(target).toISOString(),
        cancel: () => {
            if(timer) clearTimeout(timer)
        },
    })

    tick()
    logger.info(`排程已註冊：${key} at=${new Date(target).toISOString()}`)
    return key
}

export default {
    TIMEZONE,
    scheduleCron,
    scheduleAt,
    cancel,
    cancelAll,
    has,
    keys,
    weeklyCron,
    chunkDelay,
}
