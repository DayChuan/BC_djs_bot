//投票系統的設定值。要調整保留期限之類的數字，改這裡就好。

//已結算的投票在 data/archive/ 保留幾天。
//一季足夠回溯「上個月那場副本誰報名了」，又不會讓資料夾無限長大。
export const ARCHIVE_RETENTION_DAYS = 90

//我們自己開的投票討論串，**結算後**滿幾天就刪掉（U12）。
//不用「最後活動時間」：討論串是鎖定的，沒有人能發言，
//最後活動時間永遠停在 bot 貼結果那一刻，拿它當條件等於沒有條件。
export const THREAD_RETENTION_DAYS = 30

//截止前幾小時各發一次提醒（U12）。由大到小排。
//增減時間點只要改這個陣列，排程 key 與「已發過」的欄位都是由小時數組出來的。
export const REMIND_HOURS = [12, 3]

//「我這次不參與」的表態方式：在投票的公開訊息上按這顆表情（U+274E）。
//發布時 bot 會自己先按一顆 —— 不先按的話沒有人知道有這個機制，
//而且鎖定的討論串裡成員只點得動已經存在的表情。
export const OPT_OUT_EMOJI = '❎'

//查詢歷史時一次列幾場
export const HISTORY_PAGE_SIZE = 10

export default {
    ARCHIVE_RETENTION_DAYS,
    THREAD_RETENTION_DAYS,
    REMIND_HOURS,
    OPT_OUT_EMOJI,
    HISTORY_PAGE_SIZE,
}
