//暗黑龍王計時器的設定值。要調整招式秒數或各種時限，改這裡就好，
//其他檔案（timerState / timerRender / timerService）不得寫死數字。

//三個招式。陣列順序就是面板上按鈕的順序。
//  key    出現在 customId 裡（ht:t:<channelId>:<key>），只用小寫英數，不要改成中文
//  label  面板上顯示的全名
//  voice  TTS 唸出來的字。刻意比 label 短 —— 語音現場要的是「聽到就知道是哪一招」，
//         唸「左手消技還有五秒」的時間，招式早就放完了。連秒數都不唸。
//  emoji  招式的顏色。按鈕只有藍/紅/灰/綠四色、沒有黃色，
//         所以顏色靠 emoji 表達，按鈕本身的顏色留給「在跑 / 沒在跑」。
export const SKILLS = Object.freeze([
    Object.freeze({key: 'fire', label: '吐火', voice: '吐火', emoji: '🔴', seconds: 60}),
    Object.freeze({key: 'dispel', label: '左手消技', voice: '消技', emoji: '🟡', seconds: 90}),
    Object.freeze({key: 'lock', label: '黑鎖', voice: '黑鎖', emoji: '🔵', seconds: 30}),
])

//剩幾秒觸發語音提醒。
//7 不是 5：Discord 的 TTS 唸出來是「<發訊者> 說 <內容>」，前面那段固定開場約吃掉兩秒。
//剩 7 秒發出，招式名稱才剛好落在剩五秒的當下。
export const WARN_SECONDS = 7

//面板上寫給人看的秒數。人看到的是「剩 5 秒提醒」，
//上面那兩秒是補償 TTS 的開場，不是使用者需要知道的事。
//調整 WARN_SECONDS 時記得一起看這個值。
export const WARN_DISPLAY_SECONDS = 5

//記憶體 tick 的間隔。只更新數字，不碰 Discord API。
export const TICK_MS = 1000

//實際編輯面板訊息的間隔。三個招式合併成同一次編輯，
//所以是 0.5 次/秒 —— Discord 的編輯限制約每頻道 5 次/5 秒，這樣有很大的餘裕。
//調小這個值就是直接往 429 靠近，非必要不要動。
export const EDIT_MS = 2000

//面板的總時限：兩小時後自動停掉所有計時器、移除按鈕。
//沒有這條的話，打完王大家關掉 Discord，面板會每 2 秒編輯一次直到 bot 重啟。
export const PANEL_MAX_MS = 2 * 60 * 60 * 1000

//連續多久沒有人按過按鈕就自動收掉
export const PANEL_IDLE_MS = 30 * 60 * 1000

//面板所在的語音頻道連續多久沒有人(bot 不算)就自動收掉。
//60 秒是寬限：有人斷線重連是常事，設 0 的話打到一半面板就沒了。
//設 0 就是「沒人立刻收」。
//這一條跟計時器有沒有在跑無關 —— 人都走光了，倒數給誰看。
export const VOICE_EMPTY_MS = 60 * 1000

//TTS 提醒訊息發出後幾毫秒自動刪除（每分鐘約三則，不刪會洗版）
export const TTS_DELETE_MS = 5000

export default {
    SKILLS,
    WARN_SECONDS,
    WARN_DISPLAY_SECONDS,
    TICK_MS,
    EDIT_MS,
    PANEL_MAX_MS,
    PANEL_IDLE_MS,
    VOICE_EMPTY_MS,
    TTS_DELETE_MS,
}
