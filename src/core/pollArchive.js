import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '@/core/logger'
import {ARCHIVE_RETENTION_DAYS, HISTORY_PAGE_SIZE} from '@/config/polls'
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
export const archivePoll = async (poll) => {
    const archivedAt = new Date().toISOString()
    const record = {
        ...poll,
        status: 'closed',
        archivedAt,
        result: tally(poll),
    }

    const month = monthOf(poll.closeAt || archivedAt)
    await writeJson(path.join(monthDir(month), `${poll.id}.json`), record)

    //先寫歸檔再刪原檔。順序反過來的話，中間當機就兩邊都沒有。
    await deletePoll(poll.id)

    logger.info(`投票已歸檔：${poll.id}「${poll.title}」→ archive/${month}/`)
    return record
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

export default {
    archiveDir,
    archivePoll,
    getArchived,
    listArchived,
    purgeExpired,
}
