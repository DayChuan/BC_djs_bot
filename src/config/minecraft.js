//Minecraft 更新通知(U14)的設定值。要調整關鍵字、頻率、模型，改這裡就好。
//頻道 id 不在這裡：那是環境相關的，放在 environments/ 的 channels.minecraftNotice / minecraftContent。

export const FEED_URL = 'https://www.minecraft.net/en-us/feeds/community-content/rss'

export const USER_AGENT = 'Mozilla/5.0'

//抓 RSS 與文章頁的逾時
export const FETCH_TIMEOUT_MS = 30 * 1000

//**一律用 curl 抓 minecraft.net，不要用 Node 的 fetch**(2026-11-05 實測，見單元檔)。
//同一台機器、同一個 UA、同一個網址：curl 回 200，Node fetch 回 403，而且可重現，
//feed 與文章頁都一樣。補 Accept / Accept-Language / Sec-Fetch 也還是 403，
//所以不是 header 的問題，是 Akamai 在看 TLS 與請求指紋，undici 跟 curl 天差地遠。
//
//寫絕對路徑而不是靠 PATH：pm2 起的行程環境跟登入 shell 不一定一樣。
//兩個 jail 都是這個位置(2026-11-05 確認)。
export const CURL_PATH = '/usr/local/bin/curl'

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

//Gemini 依序嘗試的模型。503/429/404/逾時就換下一個。換模型時只改這裡。
//
//⚠️ 排序的依據是「量能池要夠不一樣」，不是「版號由新到舊」。
//2026-11-06 的事故：gemini-3.5-flash 與 gemini-3.6-flash **在 14 秒內接連回 503**，
//相鄰版號顯然共用量能，排在一起的話第二棒形同虛設 —— 中文摘要就是這樣整條鏈走完還是失敗。
//所以 3.6-flash 拿掉，改成跨世代(3.x → 2.x)再跨等級(flash → pro)。
//
//- 3.5-flash：實測最穩(snapshot 5、7 的中日文都是它一次過)
//- 2.5-flash：隔一個世代，量能池明顯不同，這是整條鏈的重點
//- 3.8-flash：最新最快，但實測失敗過兩次(11/04 回 503、11/06 逾時)，所以不排第一
//- 2.5-pro：最後一棒。pro 的量能跟 flash 是分開的，慢但這時候有結果比快重要
//
//不要放 -preview 結尾的(會無預警下架變成 404，備援會安靜地少一條)，
//也不要放 *-latest 別名(Google 隨時換它指向誰，可能跟第一棒指到同一個)。
//
//可用的清單以 API 為準，不要憑印象寫：
//  node -e 'require("dotenv").config();
//    fetch("https://generativelanguage.googleapis.com/v1beta/models",
//      {headers:{"x-goog-api-key":process.env.GEMINI_API_KEY}})
//     .then(r=>r.json()).then(j=>{for(const m of j.models||[])
//       if((m.supportedGenerationMethods||[]).includes("generateContent"))
//         console.log(m.name)})'
export const GEMINI_MODELS = [
    'gemini-3.5-flash',
    'gemini-2.5-flash',
    'gemini-3.8-flash',
    'gemini-2.5-pro',
]

//單一模型等多久放棄。
//會思考的模型正常 10-20 秒回完，原本給 90 秒，但等到 90 秒幾乎都是等不到了，
//只是把時間花在必然失敗的等待上。縮短才有預算做 GEMINI_RETRY_DELAY_MS 那一輪重試，
//縮短後「整條鏈跑兩輪」的最壞耗時反而比原本「跑一輪」短(2026-11-06)。
export const GEMINI_TIMEOUT_MS = 45 * 1000

//整條模型鏈都失敗時，等多久再重跑一輪。0 代表不重試。
//503 的尖峰通常幾十秒就過去了，而這個功能一個月才跑幾次，多等 20 秒換一次成功很划算。
//只重試一輪：再多就會逼近 Discord 互動的 15 分鐘上限。
export const GEMINI_RETRY_DELAY_MS = 20 * 1000

//要求模型守的長度。回來的文字仍然會過切段函式，不信任模型守長度。
export const SUMMARY_MAX_CHARS = 1500

export default {
    FEED_URL,
    USER_AGENT,
    CURL_PATH,
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
    GEMINI_RETRY_DELAY_MS,
    SUMMARY_MAX_CHARS,
}
