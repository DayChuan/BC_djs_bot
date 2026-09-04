import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '@/core/logger'
import {ARCHIVE_RETENTION_DAYS, HISTORY_PAGE_SIZE, THREAD_RETENTION_DAYS} from '@/config/polls'
import {dataDir, deletePoll, isValidPollId, readJson, tally, writeJson} from '@/core/pollStore'

//已結算的投票放這裡，按年月分子資料夾。
//不分月的話跑一年就是幾百個檔案擠在同一層，列目錄會變慢，清理也難寫。
export const archiveDir = () => path.join(dataDir(), 'archive')

const DAY_MS = 24 * 60 * 60 * 1000

//從 ISO 時間取出 YYYY-MM 當資料夾名
export const monthOf = (iso) => String(iso || '').slice(0, 7)

const monthDir = (month) => path.join(archiveDir(), month)

//年月資料夾由新到舊。查歷史時要先看最近的，才不用整個掃完。
const listMonths = async () => {
    try{
        const names = await fs.readdir(archiveDir())
        return names.filter((name) => /^\d{4}-\d{2}$/.test(name)).sort().reverse()
    }
    catch(e){
        if(e.code === 'ENOENT') return []
        throw e
    }
}

const listFiles = async (month) => {
    try{
        return (await fs.readdir(monthDir(month))).filter((name) => name.endsWith('.json'))
    }
    catch(e){
        if(e.code === 'ENOENT') return []
        throw e
    }
}

/////////////////////////////// 歸檔 ///////////////////////////////

//結算時呼叫：把投票搬進 archive/，並補上結果快照。
//快照的用途是「以後查歷史不必重算」，也讓當時的結論固定下來 ——
//統計程式碼日後改了，回頭看舊投票才不會得到跟當初公布的不一樣的數字。
//reason 為 'cancelled' 時代表是管理員直接取消、沒有結算。
//一樣進歸檔而不是直接刪除 —— 誰在什麼時候砍掉一場投票，是該留痕跡的事。
export const archivePoll = async (poll, {reason = 'closed', by = null} = {}) => {
    const archivedAt = new Date().toISOString()
    const record = {
        ...poll,
        status: reason === 'cancelled' ? 'cancelled' : 'closed',
        archivedAt,
        archivedBy: by,
        result: tally(poll),
    }

    const month = monthOf(poll.closeAt || archivedAt)
    await writeJson(path.join(monthDir(month), `${poll.id}.json`), record)

    //先寫歸檔再刪原檔。順序反過來的話，中間當機就兩邊都沒有。
    await deletePoll(poll.id)

    logger.info(
        `投票已歸檔：${poll.id}「${poll.title}」→ archive/${month}/ ` +
        `狀態=${record.status}${by ? ` by=${by}` : ''}`
    )
    return record
}

//刪掉一筆歷史紀錄。管理面板用，真的要清掉時才呼叫。
export const deleteArchived = async (id) => {
    if(!isValidPollId(id)) return false

    for(const month of await listMonths()){
        const file = path.join(monthDir(month), `${id}.json`)
        try{
            await fs.unlink(file)
            logger.info(`歷史投票已刪除：${id}（archive/${month}/）`)
            return true
        }
        catch(e){
            if(e.code !== 'ENOENT') throw e
        }
    }

    return false
}

/////////////////////////////// 查詢 ///////////////////////////////

export const getArchived = async (id) => {
    if(!isValidPollId(id)) return null

    for(const month of await listMonths()){
        const record = await readJson(path.join(monthDir(month), `${id}.json`))
        if(record) return record
    }

    return null
}

//由新到舊列出歷史投票。keyword 會比對標題(不分大小寫)。
//只讀到湊滿 limit 就停，不會把整個 archive 掃完。
export const listArchived = async ({limit = HISTORY_PAGE_SIZE, keyword = ''} = {}) => {
    const needle = String(keyword || '').trim().toLowerCase()
    const found = []

    for(const month of await listMonths()){
        const records = []
        for(const name of await listFiles(month)){
            const record = await readJson(path.join(monthDir(month), name))
            if(!record) continue
            if(needle && !String(record.title || '').toLowerCase().includes(needle)) continue
            records.push(record)
        }

        //同一個月內也要由新到舊
        records.sort((a, b) => String(b.closeAt || '').localeCompare(String(a.closeAt || '')))
        found.push(...records)

        if(found.length >= limit) break
    }

    return found.slice(0, limit)
}

/////////////////////////////// 過期清理 ///////////////////////////////

//超過保留期限的歸檔刪掉。以結算時間為準，沒有的話用歸檔時間。
//開機時跑一次就夠 —— 這種清理不需要即時，跑太頻繁只是浪費 I/O。
export const purgeExpired = async (days = ARCHIVE_RETENTION_DAYS, now = Date.now()) => {
    const deadline = now - days * DAY_MS
    let removed = 0

    for(const month of await listMonths()){
        for(const name of await listFiles(month)){
            const file = path.join(monthDir(month), name)
            const record = await readJson(file)
            if(!record) continue

            const stamp = new Date(record.closeAt || record.archivedAt || 0).getTime()
            //時間讀不出來的不刪。寧可留著佔空間，也不要誤刪還在保留期內的資料。
            if(!Number.isFinite(stamp) || stamp === 0) continue
            if(stamp >= deadline) continue

            await fs.unlink(file).catch(() => undefined)
            removed += 1
        }

        //整個月都清空了就把資料夾也移除，避免留一堆空目錄
        if((await listFiles(month)).length === 0){
            await fs.rmdir(monthDir(month)).catch(() => undefined)
        }
    }

    if(removed > 0) logger.info(`已清除 ${removed} 場超過 ${days} 天的歷史投票`)
    return removed
}

/////////////////////////// 討論串清理 ///////////////////////////

//這一場的討論串是不是該刪了。**第一道防護**就在這裡：
//只認歸檔紀錄上 thread === true 的場次。
//
//判定用「結算後滿幾天」而不是「最後活動時間」：討論串是鎖定的，沒有人能發言，
//最後活動時間永遠停在 bot 貼結果那一刻，拿它當條件等於沒有條件。
export const isThreadExpired = (record, days = THREAD_RETENTION_DAYS, now = Date.now()) => {
    //=== true 而不是 truthy：舊紀錄沒有這個欄位就是 undefined，一律不碰
    if(!record || record.thread !== true) return false

    const stamp = new Date(record.closeAt || record.archivedAt || 0).getTime()
    //時間讀不出來的不碰。這裡誤判的代價是刪掉一個頻道，寧可讓討論串多留著
    if(!Number.isFinite(stamp) || stamp === 0) return false

    //「滿 N 天」＝ 已經過了 N 天，所以是 <=。
    //用 < 的話剛好整整 30 天的那一筆會被判成還沒到期，要多等一天才刪。
    return stamp <= now - days * DAY_MS
}

/**
 * 刪掉一場投票的討論串。
 *
 * ⚠️ **這是整個專案最危險的一段。**沒開討論串的投票，它的 channelId 是
 * **正式的文字頻道**，而 Discord 刪掉頻道**救不回來**。
 *
 * 所以有兩道防護，兩道都不能拿掉：
 *   1. 歸檔紀錄上 thread === true（在 isThreadExpired 裡）
 *   2. 真的把頻道抓回來之後，再問一次 channel.isThread()
 *
 * 第 2 道才是真正擋住災難的那一道：開串失敗而退回母頻道的場次，紀錄上
 * thread 仍然是 true，但 channelId 已經是母頻道 —— 只有 isThread() 分得出來。
 *
 * 失敗一律吞掉只記 log：權限不足、或早就被人手動刪掉都是正常情況，
 * 不該讓開機流程中斷（同 timerService 刪訊息的寫法）。
 */
const deletePollThread = async (client, record) => {
    const channelId = record.channelId
    if(!client || !channelId) return false

    const channel = await client.channels.fetch(channelId).catch(() => null)
    //抓不到多半是早就被手動刪掉了，那就是已經達成目的，不用吵
    if(!channel) return false

    //第二道防護。少了這一行就是把正式頻道刪掉。
    if(typeof channel.isThread !== 'function' || !channel.isThread()){
        logger.warn(
            `投票 ${record.id} 的頻道 ${channelId} 不是討論串，不刪除 ` +
            `（紀錄上 thread=true，可能是當初建串失敗退回母頻道）`
        )
        return false
    }

    try{
        await channel.delete(`投票討論串保留期滿：${record.id}`)
        logger.info(`已刪除投票 ${record.id}「${record.title}」的討論串 ${channelId}`)
        return true
    }
    catch(e){
        logger.warn(`刪除投票 ${record.id} 的討論串 ${channelId} 失敗(略過)：`, e)
        return false
    }
}

//掃過歸檔，把過期的投票討論串刪掉。開機時跑一次，跟 purgeExpired() 一起。
//歸檔紀錄本身不動 —— 那是 purgeExpired() 的事，兩者的保留期限不一樣。
export const purgeThreads = async (client, days = THREAD_RETENTION_DAYS, now = Date.now()) => {
    let removed = 0

    for(const month of await listMonths()){
        for(const name of await listFiles(month)){
            const record = await readJson(path.join(monthDir(month), name))
            if(!isThreadExpired(record, days, now)) continue
            if(await deletePollThread(client, record)) removed += 1
        }
    }

    if(removed > 0) logger.info(`已刪除 ${removed} 個結算滿 ${days} 天的投票討論串`)
    return removed
}

export default {
    archiveDir,
    archivePoll,
    deleteArchived,
    getArchived,
    listArchived,
    purgeExpired,
    isThreadExpired,
    purgeThreads,
}
