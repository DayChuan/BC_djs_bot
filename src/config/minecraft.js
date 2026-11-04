//Minecraft 更新通知(U14)的設定值。要調整關鍵字、頻率、模型，改這裡就好。
//頻道 id 不在這裡：那是環境相關的，放在 environments/ 的 channels.minecraftNotice / minecraftContent。

export const FEED_URL = 'https://www.minecraft.net/en-us/feeds/community-content/rss'

//minecraft.net 對沒帶瀏覽器 UA 的請求會拖到逾時(U14 的 14-0，開發機兩次逾時)
export const USER_AGENT = 'Mozilla/5.0'

//抓 RSS 與文章頁的逾時
export const FETCH_TIMEOUT_MS = 30 * 1000

//標題過濾，不分大小寫。只發 Java 版(使用者 2026-11-04 決定)。
//排除優先：同時含收錄字與排除字的標題一律不收。
//Preview 是 Bedrock 的測試版，所以也在排除清單裡。
export const INCLUDE_KEYWORDS = ['snapshot', 'java edition']
export const EXCLUDE_KEYWORDS = ['bedrock', 'preview']

//分 時 日 月 週。Minecraft 更新不急，太頻繁只是浪費。
export const CHECK_CRON = '*/30 * * * *'

//seen 最多留幾筆。feed 一次只有 10 篇，200 不可能把還在 feed 裡的擠掉。
export const SEEN_LIMIT = 200

//Discord 一則訊息的上限。超過會整則被退回，不是截斷。
export const MESSAGE_MAX = 2000

//討論串名稱的上限
export const THREAD_NAME_MAX = 100

//連發多篇時每篇之間的間隔
export const POST_INTERVAL_MS = 1000

//摘要失敗、退回貼原文時最多貼幾則，超過的部分請大家看原文
export const FALLBACK_MAX_MESSAGES = 8

//Gemini 依序嘗試的模型。503/429/404/逾時就換下一個。
//模型會被汰換(2026-11-04 實測 gemini-2.5-flash 對新帳號回 404)，換的時候只改這裡。
//gemini-3.6-flash 沒有實測過；不存在的話會回 404，直接跳到下一個，不會出錯。
export const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.8-flash']

//會思考的模型回得慢，給寬一點
export const GEMINI_TIMEOUT_MS = 90 * 1000

//要求模型守的長度。回來的文字仍然會過切段函式，不信任模型守長度。
export const SUMMARY_MAX_CHARS = 1500

export default {
    FEED_URL,
    USER_AGENT,
    FETCH_TIMEOUT_MS,
    INCLUDE_KEYWORDS,
    EXCLUDE_KEYWORDS,
    CHECK_CRON,
    SEEN_LIMIT,
    MESSAGE_MAX,
    THREAD_NAME_MAX,
    POST_INTERVAL_MS,
    FALLBACK_MAX_MESSAGES,
    GEMINI_MODELS,
    GEMINI_TIMEOUT_MS,
    SUMMARY_MAX_CHARS,
}
