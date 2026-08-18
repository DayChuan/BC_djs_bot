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

//台北固定 UTC+8，沒有日光節約時間，所以偏移量可以寫死。
//不用系統時區來算：jail 的時區設定被改掉時，投票的截止時間會跟著整個偏移，
//而且是沒有任何錯誤訊息的那種偏移。
export const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

export const parseWeekday = (weekday) => {
    const day = Number(weekday)
    if(!Number.isInteger(day) || day < 0 || day > 6){
        throw new Error(`weekday 必須是 0~6，收到：${weekday}`)
    }
    return day
}

export const parseTimeOfDay = (time) => {
    const matched = /^(\d{1,2}):(\d{2})$/.exec(String(time).trim())
    if(!matched) throw new Error(`時間格式必須是 HH:mm，收到：${time}`)

    const hour = Number(matched[1])
    const minute = Number(matched[2])
    if(hour > 23 || minute > 59) throw new Error(`時間超出範圍：${time}`)

    return {hour, minute}
}

//把「星期幾 + HH:mm」轉成 cron 運算式。weekday: 0=星期日 ... 6=星期六
export const weeklyCron = (weekday, time) => {
    const day = parseWeekday(weekday)
    const {hour, minute} = parseTimeOfDay(time)
    return `${minute} ${hour} * * ${day}`
}

//算出「下一個 星期X HH:mm(台北時間)」是什麼時候，回傳 Date。
//剛好等於 from 的那一刻算已經過去，往後推一週 —— 否則結算完馬上又排到同一個時間點，
//會變成無窮迴圈。
export const nextWeeklyDate = (weekday, time, from = new Date()) => {
    const day = parseWeekday(weekday)
    const {hour, minute} = parseTimeOfDay(time)

    const fromMs = from instanceof Date ? from.getTime() : new Date(from).getTime()
    if(!Number.isFinite(fromMs)) throw new Error(`不合法的起算時間：${from}`)

    //先把時間平移到台北，之後一律用 UTC 系列的 getter 讀，
    //讀出來的就是台北的年月日與星期，過程中完全不碰系統時區。
    const local = new Date(fromMs + TAIPEI_OFFSET_MS)
    const deltaDays = (day - local.getUTCDay() + 7) % 7

    const localTarget = Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate(),
        hour,
        minute,
    ) + deltaDays * DAY_MS

    //平移回真正的 UTC 時間軸
    let target = localTarget - TAIPEI_OFFSET_MS
    if(target <= fromMs) target += 7 * DAY_MS

    return new Date(target)
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
    nextWeeklyDate,
    chunkDelay,
}

//把「YYYY-MM-DD HH:mm(台北時間)」轉成 Date。給管理面板的編輯視窗用。
//不合法時回 null 而不是拋錯 —— 這是使用者手打的內容，錯了要給提示不是崩潰。
export const parseTaipeiDateTime = (text) => {
    const matched = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
    if(!matched) return null

    const [, year, month, day, hour, minute] = matched.map(Number)
    if(month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null

    //先當成台北的當地時間組出來，再平移回真正的 UTC 時間軸
    const local = Date.UTC(year, month - 1, day, hour, minute)
    const target = new Date(local - TAIPEI_OFFSET_MS)

    //Date.UTC 會把 2 月 31 日自動進位成 3 月 3 日，這種要擋掉
    const check = new Date(local)
    if(check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null

    return target
}

//反向：把 ISO 時間顯示成台北的「YYYY-MM-DD HH:mm」，填進編輯視窗的預設值
export const formatTaipeiDateTime = (iso) => {
    const time = new Date(iso).getTime()
    if(!Number.isFinite(time)) return ''

    const local = new Date(time + TAIPEI_OFFSET_MS)
    const pad = (n) => String(n).padStart(2, '0')
    return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
        `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
}
