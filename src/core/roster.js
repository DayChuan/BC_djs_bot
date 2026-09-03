import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {rosterKey} from '@/config/lineup'
import logger from '@/core/logger'

//出團名單的人員表：只存**等級與角色名**。
//職業不存在這裡 —— 投票資料的 entry.identity 已經有了，兩邊各存一份必然會不同步。
//
//實作範本是 selfRoles.js：同步 fs、用 import.meta.url 推根目錄(不依賴當前工作目錄)、
//讀壞了退回空表不讓 bot 掛掉、對外一律回副本。
//
//與 selfRoles.js 的差別：**沒有 seed**。自助身分組能從環境檔推出初始清單，
//人員表推不出來(等級只有人自己知道)，所以第一次讀不到就是空表，也不寫檔。

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DATA_DIR = path.join(ROOT_DIR, 'data')
const FILE_PATH = path.join(DATA_DIR, 'roster.json')

const VERSION = 1

export {rosterKey}

const emptyData = () => ({version: VERSION, updatedAt: new Date().toISOString(), members: {}})

//一筆資料長得對不對。等級必須是數字 —— 字串 '168' 會讓分隊的排序變成字典序，
//而且完全不會報錯，只是隊伍排得莫名其妙。
const isValidRecord = (record) =>
    Boolean(record) && typeof record === 'object' && typeof record.level === 'number'

/**
 * 建立一個綁定到指定檔案的人員表。
 *
 * 做成工廠而不是單純的模組單例，是為了讓測試能指定暫存檔 ——
 * 直接測模組單例會寫到專案真正的 data/roster.json，把實際資料洗掉。
 */
export const createRosterStore = (filePath) => {
    const dir = path.dirname(filePath)
    let cache = null

    const save = (data) => {
        try{
            fs.mkdirSync(dir, {recursive: true})
            fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf8')
            return true
        }
        catch(e){
            logger.error(`寫入 ${filePath} 失敗：`, e)
            return false
        }
    }

    //舊格式相容：單元檔最初規劃的是沒有外層包裝的扁平 map。
    //真的讀到那種檔案就當成 members 收下，不要判定成「格式壞掉」把人員資料丟光。
    const normalize = (parsed) => {
        if(!parsed || typeof parsed !== 'object') return null
        if(parsed.members && typeof parsed.members === 'object'){
            return {version: parsed.version || VERSION, updatedAt: parsed.updatedAt || '', members: parsed.members}
        }
        if(Object.values(parsed).every(isValidRecord)){
            logger.info(`${filePath} 是舊的扁平格式，載入時補上 version/members 外層`)
            return {version: VERSION, updatedAt: parsed.updatedAt || '', members: parsed}
        }
        return null
    }

    const load = () => {
        if(cache) return cache

        try{
            if(fs.existsSync(filePath)){
                const normalized = normalize(JSON.parse(fs.readFileSync(filePath, 'utf8')))
                if(normalized){
                    cache = normalized
                    return cache
                }
                logger.warn(`${filePath} 格式不正確(缺少 members)，這次先當成空的人員表`)
            }
        }
        catch(e){
            //讀壞了不能讓 bot 起不來。這裡刻意**不覆蓋檔案** ——
            //空表寫回去就等於把所有人的等級永久刪掉，留著壞檔至少還救得回來。
            logger.error(`讀取 ${filePath} 失敗，這次先當成空的人員表：`, e)
        }

        cache = emptyData()
        return cache
    }

    const commit = (data) => {
        data.updatedAt = new Date().toISOString()
        return save(data) ? {ok: true} : {ok: false, reason: 'io'}
    }

    //整張表的副本，直接餵給 buildLineup()
    const getMembers = () => ({...load().members})

    const get = (userId, identity) => {
        const record = load().members[rosterKey(userId, identity)]
        return record ? {...record} : null
    }

    //攤平成陣列給 /roster list 用。等級由高到低，沒登記等級的排最後。
    const list = (userId = null) => Object.entries(load().members)
        .map(([key, record]) => {
            const at = key.indexOf(':')
            return {
                userId: key.slice(0, at),
                identity: key.slice(at + 1),
                level: typeof record.level === 'number' ? record.level : null,
                name: record.name || '',
            }
        })
        .filter((item) => !userId || item.userId === userId)
        .sort((a, b) => (b.level || 0) - (a.level || 0))

    //新增或整筆覆寫。管理員專用。
    const set = (userId, identity, level, name) => {
        const data = load()
        data.members[rosterKey(userId, identity)] = {
            level,
            name: name || '',
            updatedAt: new Date().toISOString(),
        }
        return commit(data)
    }

    //只改等級，而且只改**已經存在**的那一筆。一般成員用這個維護自己的角色。
    //查不到就回 missing，不要順手建一筆 —— 職業選錯的話會多出一筆
    //永遠對不到投票的孤兒資料，而且本人看不出來。
    const setLevel = (userId, identity, level) => {
        const data = load()
        const record = data.members[rosterKey(userId, identity)]
        if(!record) return {ok: false, reason: 'missing'}

        record.level = level
        record.updatedAt = new Date().toISOString()
        return commit(data)
    }

    const remove = (userId, identity) => {
        const data = load()
        const key = rosterKey(userId, identity)
        if(!data.members[key]) return {ok: false, reason: 'missing'}

        delete data.members[key]
        return commit(data)
    }

    return {getMembers, get, list, set, setLevel, remove, filePath}
}

const store = createRosterStore(FILE_PATH)

export const getMembers = () => store.getMembers()
export const getMember = (userId, identity) => store.get(userId, identity)
export const listMembers = (userId = null) => store.list(userId)
export const setMember = (userId, identity, level, name) => store.set(userId, identity, level, name)
export const setMemberLevel = (userId, identity, level) => store.setLevel(userId, identity, level)
export const removeMember = (userId, identity) => store.remove(userId, identity)
