import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import config from '@/config'
import logger from '@/core/logger'

//以檔案位置推導專案根目錄，不依賴當前工作目錄(避免 ISSUES.md 的 M-05)
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DATA_DIR = path.join(ROOT_DIR, 'data')
const FILE_PATH = path.join(DATA_DIR, 'selfRoles.json')

const VERSION = 1

//Discord 單一下拉選單最多 25 個選項，超過就放不下
export const MAX_ROLES = 25

//環境檔的 roles 是「emoji → id」，這裡反過來查，讓初始清單能沿用原本訊息上的 emoji。
//鍵如果是純英數(例如 Minecraft)，那是伺服器自訂表情的名稱而不是 emoji 本身，
//少了表情 ID 就沒辦法放進選單，所以略過，之後用 /selfrole emoji 補。
const isUnicodeEmoji = (key) => !/^[\w-]+$/.test(key)

const EMOJI_BY_ROLE_ID = new Map(
    Object.entries(config.roles)
        .filter(([key, id]) => id && isUnicodeEmoji(key))
        .map(([key, id]) => [id, key])
)

//這份清單刻意不進版控(data/ 已在 .gitignore)：
//正式站與測試站各自維護一份，git 更新不會覆蓋，管理員也不必改程式碼。
let cache = null

//首次啟動時，用目前環境檔裡的 role id 當初始清單，避免現有身分組漏掉。
//name 只是給人看的快照，實際運作一律用 id。
const buildSeed = () => ({
    version: VERSION,
    updatedAt: new Date().toISOString(),
    roles: Object.values(config.roles)
        .filter(Boolean)
        .map((id) => ({id, name: '', emoji: EMOJI_BY_ROLE_ID.get(id) || ''})),
})

const save = (data) => {
    try{
        fs.mkdirSync(DATA_DIR, {recursive: true})
        fs.writeFileSync(FILE_PATH, JSON.stringify(data, null, 4), 'utf8')
        return true
    }
    catch(e){
        logger.error(`寫入 ${FILE_PATH} 失敗：`, e)
        return false
    }
}

//舊版的檔案沒有 emoji 欄位，載入時補上，不必刪檔重來
const migrate = (data) => {
    let changed = false
    for(const role of data.roles){
        if(role.emoji === undefined){
            role.emoji = EMOJI_BY_ROLE_ID.get(role.id) || ''
            changed = true
        }
    }
    if(changed){
        logger.info('selfRoles.json 補上 emoji 欄位')
        save(data)
    }
    return data
}

const load = () => {
    if(cache) return cache

    try{
        if(fs.existsSync(FILE_PATH)){
            const parsed = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'))
            if(parsed && Array.isArray(parsed.roles)){
                cache = migrate(parsed)
                return cache
            }
            logger.warn(`${FILE_PATH} 格式不正確(缺少 roles 陣列)，改用環境檔的預設清單`)
        }
    }
    catch(e){
        //讀壞了不能讓 bot 起不來，退回預設清單並留下紀錄
        logger.error(`讀取 ${FILE_PATH} 失敗，改用環境檔的預設清單：`, e)
    }

    cache = buildSeed()
    save(cache)
    logger.info(
        `建立 data/selfRoles.json，以環境「${config.name}」的 ` +
        `${cache.roles.length} 組身分組作為初始清單`
    )
    return cache
}

//回傳副本，避免呼叫端不小心改到快取
export const getRoles = () => load().roles.map((role) => ({...role}))

export const getRoleIds = () => load().roles.map((role) => role.id)

export const addRole = (id, name, emoji) => {
    const data = load()
    if(data.roles.some((role) => role.id === id)) return {ok: false, reason: 'already'}
    if(data.roles.length >= MAX_ROLES) return {ok: false, reason: 'full'}

    data.roles.push({id, name: name || '', emoji: emoji || ''})
    data.updatedAt = new Date().toISOString()
    return save(data) ? {ok: true} : {ok: false, reason: 'io'}
}

export const removeRole = (id) => {
    const data = load()
    const index = data.roles.findIndex((role) => role.id === id)
    if(index < 0) return {ok: false, reason: 'missing'}

    data.roles.splice(index, 1)
    data.updatedAt = new Date().toISOString()
    return save(data) ? {ok: true} : {ok: false, reason: 'io'}
}

export const setEmoji = (id, emoji) => {
    const data = load()
    const role = data.roles.find((item) => item.id === id)
    if(!role) return {ok: false, reason: 'missing'}

    role.emoji = emoji || ''
    data.updatedAt = new Date().toISOString()
    return save(data) ? {ok: true} : {ok: false, reason: 'io'}
}

//面板顯示時順手把名稱快照更新成伺服器上的實際名稱。
//只有真的變了才寫檔，避免每次開面板都動硬碟。
export const refreshNames = (nameById) => {
    const data = load()
    let changed = false

    for(const role of data.roles){
        const name = nameById.get(role.id)
        if(name && role.name !== name){
            role.name = name
            changed = true
        }
    }

    if(changed){
        data.updatedAt = new Date().toISOString()
        save(data)
    }
}

//啟動時就把清單讀進來(或建立)，不要等到第一次有人下指令。
//這個模組會被 interactionCreate import，而 loadEvents() 在啟動階段就會載入事件檔。
const initial = load()
logger.info(`可自助領取的身分組清單：${initial.roles.length} 組(上限 ${MAX_ROLES})`)
