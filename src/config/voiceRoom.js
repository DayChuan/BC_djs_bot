//動態語音頻道(U13)的設定值。要調整房名、cooldown、掃描間隔，改這裡就好。
//哪個伺服器的大廳是哪個頻道不在這裡，在環境檔的 voiceLobbies(per-guild，沒填＝不啟用)。

//房名 = displayName + 這個後綴。
export const ROOM_NAME_SUFFIX = '的房間'

//Discord 頻道名稱上限 100 字元。displayName 太長時截掉的是 displayName，後綴永遠保留。
export const ROOM_NAME_MAX_LENGTH = 100

//displayName 去掉空白後是空字串時，用這個代替，避免房名只剩「的房間」。
export const ROOM_NAME_FALLBACK = '語音'

//同一個人兩次「建立房間」之間至少隔幾秒。
//這只是保險：重複觸發時優先把他搬回他既有的房間，查不到房間才會走到 cooldown。
export const CREATE_COOLDOWN_SECONDS = 10

//定期清理空房間的 cron，給 scheduleCron 用。補 gateway 斷線期間漏掉的「最後一人離開」事件。
//跟開機清理是同一支函式，只是觸發時機不同。
export const SWEEP_CRON = '*/10 * * * *'

export default {
    ROOM_NAME_SUFFIX,
    ROOM_NAME_MAX_LENGTH,
    ROOM_NAME_FALLBACK,
    CREATE_COOLDOWN_SECONDS,
    SWEEP_CRON,
}
