//出團名單的分隊規則。**要改規則只改這個檔案**，src/core/lineup.js 不寫死任何職業。
//
//這裡的職業一律用 pollIdentities.js 的 value(例如 'ice')而不是中文標籤：
//標籤日後可能改字，value 不會，而且投票資料存的就是 value。

//一隊固定這六個職業，**陣列順序就是輸出順序**。
//對照中文：箭神、夜使者、冰雷、火毒、黑騎士、聖騎士。
export const FIRST_TEAM_IDENTITIES = [
    'bowmaster',      //箭神
    'night-walker',   //夜使者
    'ice',            //冰雷
    'fire',           //火毒
    'dark-knight',    //黑騎士
    'paladin',        //聖騎士
]

//同一個職業有多人時，預設取**等級最高**的進一隊；只有列在這裡的職業取**最低**。
//
//⚠ 冰雷取高、黑騎士取低是**刻意不對稱**的，不是筆誤。
//看到「規則不一致」時請不要順手統一 —— 這是使用者 2026-09-03 確認過的隊伍需求。
export const LOWEST_LEVEL_IDENTITIES = new Set([
    'dark-knight',    //黑騎士
])

export const FIRST_TEAM_SIZE = FIRST_TEAM_IDENTITIES.length
export const SECOND_TEAM_SIZE = 6

//候補不設上限：實際人數還沒多到需要截斷，硬截只會讓人從名單上消失。
//要限制的話在這裡加常數，不要散在 core/lineup.js 裡。

//取票數最高的幾個「層級」。同一層級(同票數)的日期全部各出一份名單。
export const TOP_OPTION_LEVELS = 2

//只有這個身分群組的投票會產生出團名單，其他群組(TRPG…)安靜跳過
export const LINEUP_IDENTITY_GROUP = 'maplestory'

//排版用的字樣。core/lineup.js 只輸出資料結構，字串一律在這裡定義。
export const MISSING_LABEL = '(缺人)'
export const UNKNOWN_LEVEL = '??'

//人員表的 key。用「Discord ID ＋ 職業」而不是單獨的 Discord ID：
//投票支援一人多角色，等級是角色的屬性，同一個人可以有刀賊 168 和冰雷 150 兩隻。
//放在 config 是因為 core/lineup.js 與 core/roster.js 都要用，
//而讓純邏輯去 import 會讀檔的 roster.js 並不划算。
export const rosterKey = (userId, identity) => `${userId}:${identity}`
