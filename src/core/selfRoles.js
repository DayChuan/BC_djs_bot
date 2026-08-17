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
        .map((id) => ({id, name: ''})),
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

const load = () => {
    if(cache) return cache

    try{
        if(fs.existsSync(FILE_PATH)){
            const parsed = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'))
            if(parsed && Array.isArray(parsed.roles)){
                cache = parsed
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

export const addRole = (id, name) => {
    const data = load()
    if(data.roles.some((role) => role.id === id)) return {ok: false, reason: 'already'}
    if(data.roles.length >= MAX_ROLES) return {ok: false, reason: 'full'}

    data.roles.push({id, name: name || ''})
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
