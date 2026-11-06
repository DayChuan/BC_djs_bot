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
//⚠️⚠️ ListModels 會列出這把金鑰**實際上不能用**的模型。
//2026-11-06 正式站實測：清單裡有 gemini-2.5-flash 與 gemini-2.5-pro，
//真的去呼叫卻回 404「no longer available to new users」——
//新辦的金鑰拿不到 2.5 系列。所以**挑模型不能只看清單，一定要真的打一次**。
//我就是只看清單挑，才讓正式站的四棒裡死了兩棒。
//
//排序依據是「量能池要夠不一樣」，不是「版號由新到舊」：
//免費層的額度**各模型分開計算**，所以鏈越長、模型越不一樣，一天能用的總量就越多。
//
//- 3.5-flash：品質最好也最穩(snapshot 5、7 的中日文都是它一次過)
//- 3.5-flash-lite：2026-11-06 探測時唯一還回 200 的(883ms)。
//  lite 的免費額度比 flash 寬，整理條列這種任務綽綽有餘，是真正能救火的那一棒
//- 3.6-flash：活著(回 429 代表能用、只是當下額度滿了)
//- 3.1-pro-preview：最後一棒。pro 的量能跟 flash 分開。
//  **例外地放了 -preview**：這把金鑰能用的模型就這麼少，而下架後只是回 404 被跳過，
//  代價很低；Google 自己的 404 訊息也是叫人改用它替代 2.5-pro。
//
//2026-11-06 探測後剔除的，不要再加回來：
//  3.7-flash / 3.8-flash / 3.1-flash-lite → 呼叫會卡住不回應(20 秒以上)
//  2.5-flash / 2.5-pro / 2.5-flash-lite   → 404，新金鑰用不了
//  gemma-4-31b-it                          → 回 500
//  *-latest 別名                            → Google 隨時換它指向誰，可能跟第一棒撞同一個
//
//要重新挑模型時，用「真的打一次」的探測，不要用 ListModels：
//  node -e 'require("dotenv").config();
//    const models=["模型A","模型B"];
//    (async()=>{for(const m of models){const t=Date.now();
//      try{const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
//        {method:"POST",headers:{"x-goog-api-key":process.env.GEMINI_API_KEY,"Content-Type":"application/json"},
//         body:JSON.stringify({contents:[{parts:[{text:"say ok"}]}]}),
//         signal:AbortSignal.timeout(20000)});
//        console.log(m,r.status,Date.now()-t+"ms")}
//      catch(e){console.log(m,"逾時或錯誤",e.name)}}})()'
//  200=可用｜429=可用但額度滿了(要留著)｜404=這把金鑰不能用｜逾時=剔除
export const GEMINI_MODELS = [
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.1-pro-preview',
]

//單一模型等多久放棄。
//會思考的模型正常 10-20 秒回完，原本給 90 秒，但等到 90 秒幾乎都是等不到了，
//只是把時間花在必然失敗的等待上(2026-11-06)。
export const GEMINI_TIMEOUT_MS = 45 * 1000

//Gemini 失敗佇列(U16，core/geminiQueue.js)。整條模型鏈都失敗(all-failed)的工作排進來稍後重試，
//取代原本的「等 20 秒當場再跑一輪」(GEMINI_RETRY_DELAY_MS，已拿掉)。
//
//多久掃一次佇列。工作自己的 nextAt 到了才會跑，這裡只是檢查頻率。
//⚠️ U16 驗收用的暫時設定(原值 '*/30 * * * *'、30 分鐘、5 次)，驗完要 revert
export const QUEUE_CRON = '*/2 * * * *'
//一般失敗(503／逾時)後多久再試
export const QUEUE_RETRY_MS = 2 * 60 * 1000
//失敗幾次(含第一次)就放棄並通知管理員
export const QUEUE_MAX_ATTEMPTS = 30
//額度用完(429)時排到「隔天」幾點(台灣時間)。
//額度實際上是太平洋時間午夜重置(約台灣 16:00)，但使用者要的是隔天再試，不精算(單元檔 U16)。
export const QUEUE_QUOTA_RETRY_HOUR = 9

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
    QUEUE_CRON,
    QUEUE_RETRY_MS,
    QUEUE_MAX_ATTEMPTS,
    QUEUE_QUOTA_RETRY_HOUR,
    SUMMARY_MAX_CHARS,
}
