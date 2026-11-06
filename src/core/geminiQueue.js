import config from '@/config'
import mc from '@/config/minecraft'
import {scheduleCron, TAIPEI_OFFSET_MS, formatTaipeiDateTime} from '@/core/scheduler'
import {getState, updateState, registerRestore} from '@/core/state'
import logger from '@/core/logger'

//Gemini 失敗佇列(U16)。整條模型鏈都失敗的工作排進來，稍後重試，真的沒救才叫人。
//
//這支檔案不認識任何業務：「重跑一次」要做什麼由各功能用 registerKind() 登記
//(summary → minecraftFeed.js、translate → noticeTranslate.js)。
//反過來由佇列 import 那兩支的話，minecraftFeed 也要 import 佇列來排工作，會變成互相 import。
//
//刻意不 import discord.js：Discord 物件一律從呼叫端傳進來，測試才能用假的 client。
//
//⚠️ 佇列一定要落地(state.json)：bot 一天重啟好幾次，放記憶體的話重啟就全掉，
//而且不會有任何錯誤訊息。

export const SECTION = 'geminiQueue'

export const JOB_KEY = 'gemini:queue'

/////////////////////////// 純函式 ///////////////////////////

export const jobId = (kind, key) => `${kind}:${key}`

//金鑰或請求本身有問題 → 重試一百次也一樣，不排佇列(使用者 2026-11-06 決定)。
//no-key 是該環境刻意沒設金鑰，也不排。
//其他(all-failed、抓文章頁失敗、Discord 暫時性錯誤)都值得稍後再試。
export const isKeyFailure = (result) => {
    const reason = String((result && result.reason) || '')
    return reason === 'no-key' || reason === 'bad-key' || reason.startsWith('http-')
}

export const isRetryable = (result) => Boolean(result) && !result.text && !isKeyFailure(result)

//給人看的錯誤說明。管理員要能一眼分出「該等額度」還是「該處理別的」。
export const describeError = (result) => {
    const reason = (result && result.reason) || 'unknown'
    return result && result.quota ? `${reason}（429 額度用完）` : reason
}

//「隔天」的 HH:00(台灣時間)。照字面取下一個日期：凌晨 0:30 失敗也排到隔天，
//因為當天早上額度還沒重置(太平洋時間午夜 ≈ 台灣 16:00)。
//先平移到台北再用 UTC getter 讀，不碰系統時區(同 scheduler.nextWeeklyDate)。
//Date.UTC 會把 31+1 日自動進位到下個月。
export const nextQuotaRetryAt = (now, hour = mc.QUEUE_QUOTA_RETRY_HOUR) => {
    const local = new Date(now + TAIPEI_OFFSET_MS)
    return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, hour) - TAIPEI_OFFSET_MS
}

//失敗第 attempts 次之後，下次什麼時候再試。null = 已達上限，放棄。
//⚠️ 429 不能走 30 分鐘：額度是每天重置的，短間隔重試只會把各模型剩下的額度燒更快
//(2026-11-06 正式站實測)。
export const nextRetryAt = (now, attempts, quota) => {
    if(attempts >= mc.QUEUE_MAX_ATTEMPTS) return null
    return quota ? nextQuotaRetryAt(now) : now + mc.QUEUE_RETRY_MS
}

//第一次失敗 → 一筆工作。第一次就算失敗 1 次，所以實際是原本那次 ＋ 4 次重試。
//spec：{id, kind, channelId, messageId, url, label, payload}
//  channelId 是結果要貼回哪裡(討論串就是討論串的 id)
//  label / url 只用在管理員通知
export const buildJob = (spec, result, now) => {
    const quota = Boolean(result && result.quota)
    return {
        id: spec.id,
        kind: spec.kind,
        channelId: spec.channelId,
        messageId: spec.messageId || null,
        url: spec.url || '',
        label: spec.label || spec.id,
        payload: spec.payload || {},
        attempts: 1,
        createdAt: now,
        nextAt: nextRetryAt(now, 1, quota),
        lastError: describeError(result),
        quota,
    }
}

//重試又失敗一次 → {job, giveUp}
export const recordFailure = (job, result, now) => {
    const attempts = (Number(job.attempts) || 0) + 1
    const quota = Boolean(result && result.quota)
    const nextAt = nextRetryAt(now, attempts, quota)
    return {
        job: {...job, attempts, nextAt, lastError: describeError(result), quota},
        giveUp: nextAt === null,
    }
}

//同一個 id 已經在佇列裡就不動：不然同一篇被補發兩次，累積的失敗次數會被洗回 1
export const upsertJob = (jobs, job) => {
    const list = Array.isArray(jobs) ? jobs : []
    return list.some((one) => one.id === job.id) ? list : [...list, job]
}

export const dueJobs = (jobs, now) => (Array.isArray(jobs) ? jobs : [])
    .filter((job) => Number.isFinite(job.nextAt) && job.nextAt <= now)

const formatTime = (ms) => (Number.isFinite(ms) ? formatTaipeiDateTime(ms) : '（不明）')

export const buildAdminNotice = (job) => [
    `⚠️ Gemini 連續失敗 ${job.attempts} 次，需要人工處理`,
    '',
    `項目：${job.label}`,
    `網址：${job.url || '（無）'}`,
    `最後錯誤：${job.lastError}`,
    `首次失敗：${formatTime(job.createdAt)}`,
].join('\n')

/////////////////////////// 落地 ///////////////////////////

//updateState 是排隊執行的，mutator 裡只做同步的陣列操作。
//一律「依 id 改那一筆」，不整包覆寫：執行器跑到一半(等 Gemini 的那幾十秒)
//事件那邊新排進來的工作才不會被蓋掉。

const listOf = (current) => (Array.isArray(current && current.jobs) ? current.jobs : [])

export const getJobs = async() => listOf(await getState(SECTION))

export const saveJob = (job) => updateState(SECTION, (current) => {
    current.jobs = upsertJob(listOf(current), job)
})

export const replaceJob = (job) => updateState(SECTION, (current) => {
    current.jobs = listOf(current).map((one) => (one.id === job.id ? job : one))
})

export const removeJob = (id) => updateState(SECTION, (current) => {
    current.jobs = listOf(current).filter((one) => one.id !== id)
})

/////////////////////////// 各功能的處理器 ///////////////////////////

//kind → {run(client, job), onGiveUp?(client, job)}
//run 回傳：
//  {ok: true}             成功，移出佇列
//  {ok: false, result}    失敗；result 是 generateText 的回傳形狀(reason / quota)
//  {drop: '理由'}         再試也沒意義(例：原公告被刪了)，安靜地移出佇列
const kinds = new Map()

export const registerKind = (kind, handler) => {
    if(!handler || typeof handler.run !== 'function') throw new TypeError(`佇列處理器「${kind}」必須有 run()`)
    kinds.set(String(kind), handler)
}

/////////////////////////// 排入與執行 ///////////////////////////

//Discord 的 send 一律不解析提及
const sendText = (target, content) => target.send({content, allowedMentions: {parse: []}})

const notifyAdmin = async(client, job) => {
    const text = buildAdminNotice(job)
    const id = config.channels && config.channels.admin
    if(!id){
        logger.error(`Gemini 佇列：環境「${config.name}」沒有設定 channels.admin，通知改記 log：\n${text}`)
        return
    }
    try{
        const channel = await client.channels.fetch(id)
        await sendText(channel, text)
    }
    catch(e){
        logger.error(`Gemini 佇列：管理員通知貼不出去(${job.id})：\n${text}`, e)
    }
}

const callGiveUp = async(client, job) => {
    const handler = kinds.get(job.kind)
    if(!handler || typeof handler.onGiveUp !== 'function') return
    try{
        await handler.onGiveUp(client, job)
    }
    catch(e){
        logger.warn(`Gemini 佇列：${job.id} 的收尾失敗(已略過)：${e && e.message}`)
    }
}

const giveUp = async(client, job) => {
    logger.error(`Gemini 佇列：${job.label} 失敗 ${job.attempts} 次(${job.lastError})，放棄並通知管理員`)
    await notifyAdmin(client, job)
    await callGiveUp(client, job)
}

//第一次失敗時由各功能呼叫。回傳 true = 已排入(呼叫端可以加 ⏳ 之類的提示)。
//上限設成 1 時第一次就放棄，直接通知管理員，回 false。
export const enqueue = async(client, spec, result, now = Date.now()) => {
    const job = buildJob(spec, result, now)
    if(job.nextAt === null){
        await giveUp(client, job)
        return false
    }
    await saveJob(job)
    logger.warn(`Gemini 佇列：排入 ${job.id}(${job.lastError})，下次 ${formatTime(job.nextAt)}`)
    return true
}

//跑一筆，回傳結果分類(給 log 與測試用)
const runJob = async(client, job) => {
    const handler = kinds.get(job.kind)
    if(!handler){
        //通常是那個功能的模組這次沒被載入；留著，等它回來
        logger.warn(`Gemini 佇列：沒有登記「${job.kind}」的處理器，${job.id} 先留著`)
        return 'skipped'
    }

    let outcome
    try{
        outcome = await handler.run(client, job)
    }
    catch(e){
        //多半是 Discord 暫時性的錯誤，當一般失敗處理
        outcome = {ok: false, result: {reason: `error(${(e && e.message) || e})`}}
    }

    if(outcome && outcome.ok){
        await removeJob(job.id)
        logger.info(`Gemini 佇列：${job.label} 第 ${job.attempts + 1} 次成功，已補上`)
        return 'done'
    }
    if(outcome && outcome.drop){
        await removeJob(job.id)
        logger.warn(`Gemini 佇列：${job.label} 不再重試：${outcome.drop}`)
        return 'dropped'
    }

    const result = (outcome && outcome.result) || {reason: 'unknown'}
    if(!isRetryable(result)){
        await removeJob(job.id)
        logger.error(`Gemini 佇列：${job.label} 失敗(${describeError(result)})，金鑰或請求有問題，不再重試`)
        await callGiveUp(client, job)
        return 'dropped'
    }

    const {job: next, giveUp: exhausted} = recordFailure(job, result, Date.now())
    if(exhausted){
        await removeJob(job.id)
        await giveUp(client, next)
        return 'gaveUp'
    }
    await replaceJob(next)
    logger.warn(`Gemini 佇列：${job.label} 第 ${next.attempts} 次失敗(${next.lastError})，下次 ${formatTime(next.nextAt)}`)
    return 'retry'
}

//排程與手動觸發同時跑的話，同一筆會被做兩次
let running = false

//掃出到期的工作逐筆跑。不往外拋錯。
export const runQueue = async(client) => {
    const counts = {done: 0, retry: 0, gaveUp: 0, dropped: 0, skipped: 0}
    if(running){
        logger.warn('Gemini 佇列：上一次還沒跑完，這次略過')
        return counts
    }
    running = true
    try{
        const due = dueJobs(await getJobs(), Date.now())
        if(due.length === 0) return counts
        logger.info(`Gemini 佇列：${due.length} 筆到期`)
        for(const job of due){
            counts[await runJob(client, job)] += 1
        }
        return counts
    }
    catch(e){
        logger.error('Gemini 佇列執行失敗：', e)
        return counts
    }
    finally{
        running = false
    }
}

//記憶體裡的排程在重啟時全部消失，每次開機重掛(同 minecraftFeed.restore)。
//到期的工作不用另外處理：cron 每次都是掃「nextAt 已經過了」的。
const restore = async(client) => {
    scheduleCron(JOB_KEY, mc.QUEUE_CRON, () => runQueue(client))
}

registerRestore(SECTION, restore)

export default {
    SECTION,
    JOB_KEY,
    jobId,
    isKeyFailure,
    isRetryable,
    describeError,
    nextQuotaRetryAt,
    nextRetryAt,
    buildJob,
    recordFailure,
    upsertJob,
    dueJobs,
    buildAdminNotice,
    getJobs,
    saveJob,
    replaceJob,
    removeJob,
    registerKind,
    enqueue,
    runQueue,
}
