import {
    FIRST_TEAM_IDENTITIES,
    LOWEST_LEVEL_IDENTITIES,
    rosterKey,
    SECOND_TEAM_SIZE,
    TOP_OPTION_LEVELS,
} from '@/config/lineup'

//出團名單的純分隊邏輯。
//
//**這個檔案不碰 discord.js、不讀檔、不看時間**，所以整組規則都能單元測試。
//輸入是 tally(poll).options[i].entries 加上人員表，輸出只有資料結構，
//排版(等級 ??、(缺人)、訊息切段)一律留給 pollRender.js。

//把投票的 entry 補上人員表的等級與角色名。
//
//查不到的人**不能被丟掉**：等級留 null(排版時顯示 ??)、角色名退回 Discord 顯示名稱，
//照樣排進隊伍。名單少一個人比顯示 ?? 嚴重得多。
//
//index 是原始順序，等級相同時用它當穩定排序的第二鍵，讓輸出可重現。
const toMembers = (entries, roster, displayNames) => entries.map((entry, index) => {
    const record = roster[rosterKey(entry.userId, entry.identity)] || null
    const level = record && typeof record.level === 'number' ? record.level : null

    return {
        userId: entry.userId,
        identity: entry.identity || null,
        level,
        name: (record && record.name) || displayNames[entry.userId] || '',
        index,
    }
})

//等級由高到低。等級未知(null)一律排最後 —— ?? 是資料缺漏，
//不該因為「未知」而擠掉有登記的人。同級維持原始順序。
const byLevelDesc = (a, b) => {
    if(a.level === b.level) return a.index - b.index
    if(a.level === null) return 1
    if(b.level === null) return -1
    return b.level - a.level
}

const byLevelAsc = (a, b) => {
    if(a.level === b.level) return a.index - b.index
    return a.level - b.level
}

//挑一個人進一隊。預設取等級最高，LOWEST_LEVEL_IDENTITIES 裡的職業取最低。
//
//取最低時只在**有登記等級**的人裡面挑：null 不是「等級 0」，
//把未知當成最低會讓沒登記的人反而擠掉有登記的人。全部都沒登記才退回原始順序第一個。
const pickForFirstTeam = (candidates, identity) => {
    if(candidates.length === 0) return null
    if(!LOWEST_LEVEL_IDENTITIES.has(identity)) return [...candidates].sort(byLevelDesc)[0]

    const known = candidates.filter((member) => member.level !== null)
    if(known.length === 0) return [...candidates].sort(byLevelDesc)[0]
    return known.sort(byLevelAsc)[0]
}

/**
 * 把一個選項(＝一個日期)底下的出席者編成一隊／二隊／候補。
 *
 * @param entries       tally(poll).options[i].entries，即 [{userId, options, identity}]
 * @param roster        {"<userId>:<identity>": {level, name}}，roster.js 的 members
 * @param displayNames  {userId: '顯示名稱'}，人員表查不到時的角色名退路。
 *                      由呼叫端提供 —— 這個模組不碰 discord.js，拿不到 guild member。
 * @returns {
 *   firstTeam: [{identity, member|null}]  固定六筆、順序固定，沒人就 member 為 null
 *   secondTeam: [member]                  上限 SECOND_TEAM_SIZE，等級由高到低
 *   reserves:   [member]                  其餘全部，等級由高到低，不設上限
 * }
 */
export const buildLineup = (entries = [], roster = {}, {displayNames = {}} = {}) => {
    const members = toMembers(entries, roster, displayNames)

    //進了一隊的人不能再出現在二隊。用物件參考比對，
    //因為同一個人的同一個職業理論上只會有一筆，但 userId+identity 當 key 反而不夠保險。
    const picked = new Set()

    const firstTeam = FIRST_TEAM_IDENTITIES.map((identity) => {
        const chosen = pickForFirstTeam(members.filter((member) => member.identity === identity), identity)
        if(chosen) picked.add(chosen)
        return {identity, member: chosen}
    })

    //剩下的人：固定六職裡沒被選上的，加上完全不在六職裡的職業(英雄、拳霸…)。
    //兩者一視同仁按等級排，不因為「本來是固定職」而插隊。
    const rest = members.filter((member) => !picked.has(member)).sort(byLevelDesc)

    return {
        firstTeam,
        secondTeam: rest.slice(0, SECOND_TEAM_SIZE),
        reserves: rest.slice(SECOND_TEAM_SIZE),
    }
}

/**
 * 取票數最高的前幾個「層級」，同票數的選項全部列出。
 *
 * 例：票數 5、5、3、1 → 層級取 [5, 3] → 回傳三個選項(兩個 5 票、一個 3 票)。
 * 沒人投的選項(count 0)不算一個層級，不然全場零票時會列出所有日期。
 *
 * 同票數之間維持選項原本的順序 —— 選項多半是日期，照原順序就是照時間先後。
 */
export const pickTopOptions = (options = [], levels = TOP_OPTION_LEVELS) => {
    const voted = options.filter((option) => option.count > 0)
    const top = [...new Set(voted.map((option) => option.count))]
        .sort((a, b) => b - a)
        .slice(0, levels)

    return voted
        .filter((option) => top.includes(option.count))
        .sort((a, b) => b.count - a.count || options.indexOf(a) - options.indexOf(b))
}
