//投票系統的設定值。要調整保留期限之類的數字，改這裡就好。

//已結算的投票在 data/archive/ 保留幾天。
//一季足夠回溯「上個月那場副本誰報名了」，又不會讓資料夾無限長大。
export const ARCHIVE_RETENTION_DAYS = 90

//查詢歷史時一次列幾場
export const HISTORY_PAGE_SIZE = 10

export default {
    ARCHIVE_RETENTION_DAYS,
    HISTORY_PAGE_SIZE,
}
