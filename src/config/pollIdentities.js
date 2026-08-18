//投票的「身分表」。
//建立投票時選一個群組(例如「楓之谷」)，投票者就會在該場投票看到這個群組的職業選單。
//要新增職業或新增群組，只改這個檔案，指令與結算邏輯都不用動。
//
//限制：Discord 的 StringSelectMenu 一次最多 25 個選項，所以每個群組的 options 上限是 25。

export const identityGroups = {
    maplestory: {
        label: '楓之谷',
        //placeholder 會顯示在選單未選擇時的灰字上
        placeholder: '選擇你的職業',
        options: [
            {value: 'dark-knight', label: '黑騎士'},
            {value: 'paladin', label: '聖騎士'},
            {value: 'hero', label: '英雄'},
            {value: 'arch-mage', label: '主教'},
            {value: 'ice', label: '冰雷'},
            {value: 'fire', label: '火毒'},
            {value: 'bowmaster', label: '箭神'},
            {value: 'marksman', label: '神射手'},
            {value: 'night-walker', label: '夜使者'},   
            {value: 'shadower', label: '刀賊'},
            {value: 'gunner', label: '槍手'},
            {value: 'cannon', label: '拳霸'},

        ],
    },
    trpg: {
        label: 'TRPG',
        placeholder: '選擇你的角色',
        //待補：先留空，空群組不會出現在 /poll 的選項裡(見下方 identityChoices)
        options: [],
    },
}

export const SELECT_MENU_MAX_OPTIONS = 25

//給 SlashCommandBuilder 的 addChoices() 用。
//options 為空的群組不列出來 —— 選了也只會得到一個沒有東西可選的選單。
export const identityChoices = () =>
    Object.entries(identityGroups)
        .filter(([, group]) => group.options.length > 0)
        .map(([value, group]) => ({name: group.label, value}))

//查不到就回 null，呼叫端一律當作「這場投票沒有身分選單」
export const getIdentityGroup = (key) => {
    if(!key) return null
    const group = identityGroups[key]
    return group ? group : null
}

//把儲存在 JSON 裡的 value 還原成顯示用的中文名稱。
//查不到時回傳原始 value 而不是空字串：結算報表寧可顯示一個看不懂的代碼，
//也不要讓那個人從名單上憑空消失。
export const identityLabel = (groupKey, value) => {
    const group = getIdentityGroup(groupKey)
    if(!group) return String(value)
    const option = group.options.find((item) => item.value === value)
    return option ? option.label : String(value)
}

//啟動時的靜態檢查。回傳問題清單，由呼叫端決定要警告還是中斷。
//獨立成純函式是為了能寫單元測試，不必真的啟動 bot。
export const validateIdentityGroups = (groups = identityGroups) => {
    const problems = []

    for(const [key, group] of Object.entries(groups)){
        if(!group || typeof group !== 'object'){
            problems.push(`群組「${key}」不是物件`)
            continue
        }
        if(!group.label) problems.push(`群組「${key}」沒有 label`)
        if(!Array.isArray(group.options)){
            problems.push(`群組「${key}」的 options 不是陣列`)
            continue
        }
        if(group.options.length > SELECT_MENU_MAX_OPTIONS){
            problems.push(
                `群組「${key}」有 ${group.options.length} 個選項，` +
                `超過 Discord 選單上限 ${SELECT_MENU_MAX_OPTIONS}`
            )
        }

        //value 重複會讓統計把兩個職業算成同一個，而且完全沒有錯誤訊息
        const seen = new Set()
        for(const option of group.options){
            if(!option || !option.value || !option.label){
                problems.push(`群組「${key}」有選項缺少 value 或 label`)
                continue
            }
            if(seen.has(option.value)) problems.push(`群組「${key}」的 value 重複：${option.value}`)
            seen.add(option.value)
        }
    }

    return problems
}

export default identityGroups
