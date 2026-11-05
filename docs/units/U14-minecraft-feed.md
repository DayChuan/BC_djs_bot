# U14　Minecraft 更新通知

狀態：程式與測試已完成並 commit，等 jail 端 `yarn test` 與實機驗收
進度：9/10（只剩實機驗收）
依賴：U03（`state.js`，已完成）
可平行：可，全部是新檔案
分支：**留在 `test`，不要開分支**（見 CLAUDE.md 的單元制第 2 條）
工作目錄：`\\fongxiang.duckdns.org\admin_only\Program\Discord_bot\BC_djs_bot_test`
來源：`docs/Functions/minecraft_update_bot_specification.md`

---

## 目標

定時讀 Minecraft 官方 RSS，有新的 **Java 版** Snapshot／正式版時：

1. **更新內容頻道**開一個討論串，貼兩則 AI 摘要：**繁體中文一則、日文一則**，完整原文看連結
2. **通知頻道**貼一則短通知，附原文連結與那個討論串的連結

目的是讓成員**在自己的伺服器裡就能看懂、就地討論**。

> **範圍變更**（2026-11-04 使用者決定）：原本「不做 AI 摘要、整包搬原文」改為
> **只發 Java 版 ＋ Gemini 產生繁中／日文摘要**。Bedrock 不發。
> 摘要失敗時退回貼原文（有則數上限），見細節第 8 點。

---

## ⚠️ 交接文件是寫給「獨立 Python 專案」的，不能照抄

那份規格描述的是一個 `main.py` ＋ `requirements.txt` 的獨立程式。我們要的是**長進現有 bot 裡的一個功能**。
對應關係：

| 交接文件 | 這個專案要怎麼做 | 為什麼 |
|---|---|---|
| `main.py` 的無窮迴圈 ＋ `CHECK_INTERVAL_SECONDS` | `scheduleCron()` ＋ `registerRestore()` | 專案已有排程器；自己開迴圈會跟 bot 的生命週期打架 |
| **Discord Webhook ＋ `DISCORD_WEBHOOK_URL`** | **`channel.send()`** | bot 本來就在伺服器裡，用 webhook 等於多管一組密鑰，而且發出來的不是 bot 本人 |
| `feedparser`（Python） | `fast-xml-parser`（新相依） | 見下方「為什麼要加這個相依」 |
| `requests` ＋ `BeautifulSoup` 抓內文 | **原生 `fetch` 文章頁，切出內文區塊後自己轉純文字**（14-0 確認 description 只有摘要） | 內文區塊的標籤種類很少（見 14-0 結論），不值得為它加 HTML 解析套件 |
| 「啟動時快取最新文章 ID」 | `state.js` 的 `minecraft` 區段，key 用**文章網址** | 記憶體的快取一重啟就沒了，會整串重發；feed 沒有 guid |
| `openai` SDK ＋ AI 摘要 | **Gemini REST API，用原生 `fetch` 呼叫，不裝 SDK**；key 放 `.env` 的 `GEMINI_API_KEY` | 免費額度夠用（一篇只呼叫兩次）；用 `fetch` 就不必多加相依 |

**原始交接文件不要改**，它是需求的歷史紀錄。

---

# 做法

只需要一把外部金鑰：`GEMINI_API_KEY`。**沒設定就跳過摘要、直接退回貼原文**，所以沒有 key 也能上線。

## 資料流程

```
每 30 分鐘 scheduleCron 觸發
  ↓
fetch RSS（Node 24 有原生 fetch，不用裝 http 套件）
  ↓
用 arrayBuffer() 讀 bytes → 判斷編碼（目前是 UTF-16LE 無 BOM）→ 解碼成字串
  ↓
解析出 items：title / link（來自 <a10:link href>）/ pubDate
  ↓
標題過濾（不分大小寫）：含 snapshot 或 java edition 才收；含 bedrock 或 preview 一律排除（排除優先）
  ↓
扣掉 state 裡「已經貼過」的文章網址
  ↓
log：抓到幾則、過濾掉幾則（列出被過濾的標題）、扣掉看過的剩幾則
  ↓
還有剩 → 依 pubDate 由舊到新，逐則：
     ├ fetch 文章頁，切出內文區塊，轉成純文字
     ├ Gemini 產生繁中摘要、日文摘要（各一次呼叫；失敗處理見細節第 8 點）
     ├ 在「更新內容頻道」開討論串，名稱＝文章標題
     ├ 貼繁中摘要、日文摘要（各自仍過切段函式，以防超過 2000 字元）
     └ 在「通知頻道」貼短通知：標題 ＋ 原文連結 ＋ 討論串連結
  ↓
把文章網址寫進 state（只留最近 N 筆）
```

## 八個一定要處理的細節

### 1. 第一次執行不可以把整個 feed 洗版出來

feed 裡有 10 篇歷史文章（14-0 實測），對空的 state 來說**全部都是「沒貼過」**。

**第一次跑（`seen` 是空的）→ 只把現有的文章網址全部記起來，一則都不發。**
這就是交接文件說的「啟動時需快取當前最新的文章 ID」，但它沒講清楚**第一次必須靜默**。

### 2. `seen` 清單要有上限

每次把新網址塞進去，不設上限就會無限長大，而 `state.json` 每次寫入都要重寫整份。

**只留最近 200 筆**，超過就從最舊的丟。200 遠大於一次抓回來的 feed 筆數，不可能誤判成「沒看過」。

### 3. 一次發現多則時要排序，而且要分開發

RSS 回來的順序不保證。**依 `pubDate` 由舊到新排**，否則畫面上會變成新的在上、舊的在下。

連發多則時中間留一點間隔（例如 1 秒），不要一口氣打四五則。

### 4. 任何失敗都不要寫 `seen`

網路錯誤、RSS 格式怪掉、頻道不存在——一律 `logger.warn` 之後 return，
**絕對不要把文章網址寫進 `seen`**。寫進去的話那次漏掉的更新就永遠不會補發了。

### 5. 內容要切段，而且不能切在半路

Discord 一則訊息上限 **2000 字元**。整篇文章塞一則會被整包退回（不是截斷，是**整則發不出去**）。

切段的規則：**優先在換行處切，其次在句號，都找不到才硬切**。
切在單字或句子中間，讀起來會像壞掉。

這段是純字串處理，**抽成純函式寫測試**。

### 6. 討論串要用「內容頻道」開，不要鎖定

- 用 `channels.minecraftContent` 那個頻道開討論串，名稱＝文章標題（**上限 100 字元，要截斷**）
- `autoArchiveDuration` 設 10080（7 天，上限）
- **不要 `setLocked(true)`** —— 這個功能的目的就是讓大家在串裡討論。
  （U10 另外發現：鎖定還會讓一般成員的按鈕元件失效）

開串失敗（缺 `CreatePublicThreads`）→ 退回直接貼在內容頻道，**不要整則漏掉**。

### 7. 兩個頻道的失敗要分開看

通知頻道貼不出去 ≠ 內容頻道貼不出去。**內容搬成功才算這篇處理完**；
通知失敗只記 log，不要因此重發整篇內容（會變成重複搬運）。

### 8. Gemini 一定會偶爾失敗，要能退回

14-0 實測就遇過兩種：**404**（模型被汰換，`gemini-2.5-flash` 已不開放給新帳號）與 **503**（`high demand`，暫時性過載）。

- **模型名稱放設定檔**（`src/config/minecraft.js`），汰換時只改一行
- **依序換模型**（`GEMINI_MODELS`：3.5-flash → 3.6-flash → 3.8-flash）：503／429／404／5xx／逾時／200 但沒有文字 → 換下一個；400／401／403（key 的問題）→ 直接放棄。不在同一個模型上重試
- 兩種語言**各自一次呼叫、各自判斷**：
  - 一種成功一種失敗 → 成功的照貼，失敗的那一則改成一行「（日文摘要產生失敗，請看原文）」
  - **兩種都失敗，或沒設定 `GEMINI_API_KEY`** → 退回貼原文（切段，**最多 8 則**，超過就在最後一則加「完整內容見原文」＋連結）
- 摘要失敗**不算這篇失敗**：內容有貼出去就寫 `seen`，否則下一輪會重開討論串（違反驗收 14）
- log 要記：每次嘗試的模型與 HTTP 狀態碼、最後用哪個模型成功或退回原文
- 提示詞要求每份摘要 1500 字元以內、條列重點；回來的文字仍過切段函式，不信任模型守長度

## 為什麼要加 `fast-xml-parser` 這個相依

專案一向很省相依（U06 連 Express 都不裝）。但 RSS 是 XML，而用字串比對或正規表達式解析 XML
會在 CDATA、HTML 實體、巢狀標籤上出錯——**而且是安靜地出錯**，拿到半截標題或空連結。

`fast-xml-parser` 零相依、單一套件、只做這件事。**這個相依值得加。**

加完兩個 jail 都要 `yarn install`（`update.sh` 會在 `package.json` / `yarn.lock` 變動時自動跑）。

## 進度

- [x] 14-0 **先確認 feed 長什麼樣**（結論見下方「14-0 結論」）
- [x] 14-1 `src/config/minecraft.js`：RSS 網址、收錄／排除關鍵字、cron、`seen` 上限、訊息字元上限、Gemini 模型清單、退回原文的則數上限
- [x] 14-2 兩個環境檔加 `channels.minecraftNotice` / `channels.minecraftContent` ＋ `package.json` 加 `fast-xml-parser@^5.12.0`
- [x] 14-3 `src/core/minecraftFeed.js` 的純邏輯：**解碼 bytes**、解析 items、關鍵字過濾、算出「這次要發哪些」、`seen` 上限、**文章頁 HTML → 純文字**、**內容切段**、摘要提示詞
- [x] 14-4 `tests/minecraftFeed.test.js`（含用假 client／假 fetch 跑整段 `runCheck`）
- [x] 14-5 抓 RSS、抓文章頁、開討論串、貼內容、貼通知；`/mc_check` 指令
- [x] 14-5b `src/core/gemini.js`：呼叫 Gemini、依序換模型、回應解析；`tests/gemini.test.js`
- [x] 14-6 state 讀寫 ＋ `scheduleCron` ＋ `registerRestore`
- [~] 14-7 `yarn test` 已通過（2026-11-05，21 檔 732 條全綠）；**實機驗收待做**，步驟見「實機驗收步驟」
- [x] 14-8 把 jail 裡 `yarn install` 更新過的 `yarn.lock` 帶回版控（2026-11-05）

## 開工第一件事：先看 feed 實際長什麼樣

**內容從哪來，要看了才知道**，不要照猜的寫。請使用者在 jail 裡跑：

```sh
curl -s "https://www.minecraft.net/en-us/feeds/community-content/rss" | head -c 4000
```

要確認三件事：

1. 每個 `<item>` 有哪些欄位（`description`？`content:encoded`？）
2. **`description` 裡是純文字摘要，還是完整的文章 HTML？**
3. 最近幾則標題長什麼樣，關鍵字過濾會不會誤殺

**如果 `description` 就有完整內容** → 直接用它，不必抓網頁，整個單元少一半風險。
**如果只有一兩句摘要** → 才需要 `fetch` 文章網頁、粗略去標籤取純文字。

> 我（專案經理）試過從開發機抓這個 feed，**兩次都逾時**，所以沒辦法先替你確認。
> 這一步沒做就動手，等於賭 `description` 的內容形狀，賭錯要重寫取內文那一整段。

## 14-0 結論（2026-11-04 實測）

實際使用的指令（在測試 jail 跑；**要帶 `-A` 瀏覽器 UA 和 `-m` 逾時**）：

```sh
curl -sS -m 30 -A "Mozilla/5.0" -o /root/mc_feed.xml -w "HTTP %{http_code}  %{size_download} bytes\n" "https://www.minecraft.net/en-us/feeds/community-content/rss"
curl -sS -m 30 -A "Mozilla/5.0" -o /root/mc_snapshot.html -w "HTTP %{http_code}  %{size_download} bytes\n" "https://www.minecraft.net/en-us/article/minecraft-26-4-snapshot-7"
curl -sS -m 30 -A "Mozilla/5.0" -o /root/mc_bedrock.html -w "HTTP %{http_code}  %{size_download} bytes\n" "https://www.minecraft.net/en-us/article/minecraft--bedrock-edition-26-60-changelog"
```

三個都是 HTTP 200。樣本留在測試 jail 的 `/root/`，Windows 唯讀路徑：
`\\fongxiang.duckdns.org\mnt\iocage\jails\DiscordBot-Test\root\root\`（**jail 名稱是 `DiscordBot-Test`**，不是 `DiscordBot_test`）。
開發機逾時的原因**推測**是沒帶瀏覽器 UA，未驗證。

### RSS（11654 bytes）

| 項目 | 實際 | 對實作的影響 |
|---|---|---|
| 編碼 | **UTF-16LE，無 BOM**（開頭 `3C 00 3F 00`，宣告 `encoding="utf-16"`） | `res.text()` 會當 UTF-8 解成夾 NUL 的亂碼，解析**安靜地**失敗。必須 `arrayBuffer()` 後依 bytes 判斷編碼再 `TextDecoder`，判斷結果記 log |
| 篇數 | 10 篇 | `seen` 上限 200 足夠 |
| 欄位 | `title` / `description` / `pubDate` / `<a10:link href="..."/>` | **沒有 `<guid>`、沒有 `<link>`**。連結要讀 `a10:link` 的 `href` 屬性，`seen` 的 key 用文章網址 |
| description | **只有摘要**：版本文只有標題本身（如 `Minecraft 26.4 Snapshot 7`）或一句話（`26.60 is out now in Minecraft!`），有一篇是空的 | **不能用 description，必須抓文章頁** |
| description 的實體 | 有雙重跳脫（`&amp;#39;`） | 不用 description，影響不大 |
| pubDate | `Tue, 03 Nov 2026 18:00:03 Z`（結尾是 ` Z` 不是 `GMT`） | `Date` 能否解析**未驗證**。解析前把結尾 ` Z` 換成 ` GMT`，並寫單元測試確認 |

當時的版本文標題：

- `Minecraft 26.4 Snapshot 7`（Java 快照）
- `Minecraft Preview 26.70.23 Changelog`、`Minecraft Preview 26.70.22`（Bedrock 預覽）
- `Minecraft: Bedrock Edition 26.60 Changelog`（Bedrock 正式版）—— 不含 snapshot / preview / update / release 任何一個。（後來決定只發 Java 版，Bedrock 一律排除，所以不必為它加關鍵字）
- **Java 正式版的標題格式沒有樣本**：當時 feed 裡沒有 Java 正式版。舊格式是 `Minecraft Java Edition 1.21.4`，`java edition` 抓得到；改用 26.x 版號後若只叫 `Minecraft 26.4` 就會漏。對策：被過濾掉的標題全部記進 log，第一次 Java 正式版發布時對 log 確認
- 非版本文的例子：`Creator Pages arrive on the Marketplace`、`Everything you can test from the upcoming game drop`、`Halloween on Realms: Creeping Suspicion`

### 文章頁（411311 / 482053 bytes，UTF-8）

- 內文是**伺服器端直接輸出在 HTML 裡**，不是 JavaScript 載入後才產生，`fetch` 拿得到
- 內文區塊：`class="article-text"` 底下的第一個 `<div class="MC_Link_Style_RichText">`，結尾在 `data-mc-ref="mc_social_socialShareA"`（分享列）之前。`MC_Link_Style_RichText` 頁面上共出現 3 次，另外兩次在頁尾的文章列表，**要從 `article-text` 之後找第一個**
- 兩篇（Java 快照、Bedrock 正式版）的版面一樣
- 內文用到的標籤：`p`、`h2`～`h5`、`ul` / `ol` / `li`（**有巢狀清單**）、`a`、`b`、`i`、`span`、`blockquote`、`code`、`pre`。沒有圖片、沒有表格
- 有 HTML 實體（`&#39;`、`&#34;`、`&#43;`）要解碼
- 去標籤後的長度：快照約 **11,800 字元**（約 6～7 則訊息），Bedrock 正式版約 **59,000 字元**（**約 30 則以上**）

文章頁上的分類標籤（`MC_articleHeroA_category`）兩篇都是 `News`，**不能拿來分 Java／Bedrock**，只能看標題。

轉純文字的規則（14-3 實作）：`h2`～`h5` 轉成 Discord 的 `##` / `###` 標題，`li` 依巢狀層級縮排並加上 `- `，`p` 和區塊結尾換行，`a` 保留文字（網址可附在後面），`code` / `pre` 用反引號包起來，其餘標籤去掉，最後解碼實體。
這份純文字同時是**送給 Gemini 的輸入**和**摘要失敗時退回貼出的原文**。

### Gemini（2026-11-04 實測）

用 `curl` 帶 `x-goog-api-key` 標頭打 `https://generativelanguage.googleapis.com/v1beta/models`：

- 使用者現有的 key（`AQ.` 開頭，不是常見的 `AIza`）**有效**，列得出模型
- `models/gemini-2.5-flash:generateContent` → **404**：「no longer available to new users」，建議改用 `gemini-3.8-flash`
- `models/gemini-3.8-flash:generateContent` → **503** `high demand`：模型存在、key 被接受，只是暫時過載。**實際生成一次成功的結果尚未取得**，14-5b 開工前要再試一次

**key 只放兩個 jail 的 `.env`（`GEMINI_API_KEY`），不得寫進任何進版控的檔案。**

---

## 頻道設定（2026-11-04 使用者提供）

| 環境 | 通知頻道 | 更新內容頻道 |
|---|---|---|
| 測試站 | `1567438450800463882` | `1567438526801510400` |
| 正式站 | `991202308597764157` | `1567438366788685925` |

兩個都進 `channels`：`minecraftNotice` 與 `minecraftContent`。
**沒設定就是不啟用**，跟其他功能一致。

---

## 相關檔案

**要新增的：**

| 檔案 | 職責 | 碰 discord.js？ |
|---|---|---|
| `src/config/minecraft.js` | RSS 網址、收錄／排除關鍵字、cron、`seen` 上限、每則訊息字元上限、Gemini 模型名稱、退回原文則數上限 | 否 |
| `src/core/minecraftFeed.js` | 抓取、解析、過濾、比對、貼文、state | 是（只有貼文那段） |
| `src/core/gemini.js` | 呼叫 Gemini REST API（原生 `fetch`）、依序換模型、回應解析。不認識業務，提示詞在 `minecraftFeed.js` | 否 |
| `src/commands/mc_check/index.js` | `/mc_check`（管理員）：立刻檢查一次並回報；**同時負責讓 `minecraftFeed.js` 被載入**（loader 不掃 `src/core/`，沒人 import 的話排程不會掛上） | 是 |
| `tests/minecraftFeed.test.js` | 純邏輯測試 | 否 |
| `tests/gemini.test.js` | 回應解析、哪些狀態碼換模型、換模型流程（假 fetch，不打真的 API） | 否 |

**環境設定（不進版控，由使用者在兩個 jail 加）：** `.env` 加 `GEMINI_API_KEY`。
依 CLAUDE.md 這個差異應記進 `docs/ENVIRONMENTS.md`，但該檔不在本單元領域內，要動之前先問使用者。

**要改的：**

| 檔案 | 改什麼 |
|---|---|
| `src/config/environments/production.js`、`test.js` | `channels` 加 `minecraftNotice` 與 `minecraftContent`。**兩邊結構必須一致**。（勘誤：`config/index.js` 的 `validate()` 只比對 `roles`，**不會**比對 `channels`；本單元改由 `tests/minecraftFeed.test.js` 檢查兩邊都有這兩個 id） |
| `package.json` | 加 `fast-xml-parser` |

**只讀，一定要看的：**

| 檔案 | 你需要知道的事 |
|---|---|
| `src/jobs/dailyJapanese.js` ＋ `src/core/japanese.js` | **本單元最接近的範本**：`scheduleCron` ＋ `registerRestore` ＋「挑一則貼出去 ＋ 記住發過什麼」的完整形狀 |
| `src/core/state.js` | `getState('minecraft')` / `updateState`。路徑在呼叫時才解析，測試可用 `STATE_DATA_DIR` 指到暫存資料夾 |
| `src/core/scheduler.js` | `scheduleCron(key, expression, task)`，key 要帶前綴 |
| `src/core/vmute.js` | `registerRestore()` 的用法；純邏輯與 discord.js 分離的寫法 |
| `src/config/environments/test.js` | `channels` 的結構 |
| `src/core/pollService.js` 的 `openPollThread()` | **開討論串的完整範本**：`threads.create({name, autoArchiveDuration: 10080, type, reason})`、失敗退回母頻道、名稱長度處理。注意它**刻意不鎖定**，理由寫在那一段的註解裡 |

---

## 驗收

**單元測試**（`tests/minecraftFeed.test.js`，**不得 import discord.js**，所以解析與過濾要抽成純函式）：

1. 一段寫死的 RSS XML（**照 14-0 實測的形狀**：`<a10:link href>`、沒有 guid）→ 解析出正確的 title / link / pubDate
2. 標題含 `Snapshot`／`snapshot`／`SNAPSHOT` 都要命中（**不分大小寫**）；`Minecraft Java Edition 1.21.4` 要命中
3. 不含關鍵字的一般社群文 → 過濾掉；`Minecraft Preview 26.70.23 Changelog`、`Minecraft: Bedrock Edition 26.60 Changelog` → 過濾掉；同時含收錄字與排除字（如 `Bedrock Edition ... Snapshot`）→ **排除優先**
4. **`seen` 是空的（第一次執行）→ 回傳「不發任何一則」**，但要回「這些網址要記起來」
5. `seen` 已有資料 → 只回沒看過的那幾則
6. 多則待發 → **依 pubDate 由舊到新排序**（`... 18:00:03 Z` 這種格式要能正確解析）
7. `seen` 超過上限 → 保留最新的 N 筆，最舊的被丟掉
8. RSS 壞掉／空字串／不是 XML → 回空陣列，**不丟例外**
9. UTF-16LE（無 BOM）的 bytes 與 UTF-8 的 bytes → 都解碼成同一段正確字串
10. 文章頁 HTML 片段 → 只取 `article-text` 後第一個 `MC_Link_Style_RichText`，不混入頁尾的文章列表；巢狀清單有縮排、實體已解碼
11. 找不到內文區塊 → 回空字串（呼叫端視為失敗、不寫 `seen`）
12. （`tests/gemini.test.js`）503／429 判定要重試，401／403／404 不重試
13. （`tests/gemini.test.js`）Gemini 回應的 JSON → 取出 `candidates[0].content.parts` 的文字；沒有 candidates、被安全過濾擋下、格式怪掉 → 回 null，**不丟例外**

**實機（測試伺服器）：**

9. 把 cron 暫時改成每分鐘 → 第一次跑**什麼都不發**，log 說明已記住 N 筆
10. 手動把 state 的 `seen` 刪掉一兩筆 → 下一次跑會把那幾則補發出來
11. 貼出來的訊息有標題與連結，點得開
12. 把 `channels.minecraftContent` 設成不存在的 id → **log 有警告、bot 不崩潰、`seen` 沒有被寫入**
13. 摘要失敗退回原文時，文章很長（超過 2000 字元）→ **自動切成多則**，接起來讀得通；超過 8 則時最後一則有「完整內容見原文」＋連結
14. 同一篇文章不會重複開第二個討論串
15. 討論串內有繁中摘要、日文摘要各一則，內容是條列重點、語言正確
16. 把 `.env` 的 `GEMINI_API_KEY` 拿掉 → 退回貼原文，log 寫明原因，bot 不崩潰

### 實機驗收步驟（測試 jail `DiscordBot-Test`，repo 在 `/root/BC_djs_bot_test`）

第 9 條不必改 cron：用 `/mc_check` 觸發，走的是跟排程完全同一條路徑。

1. 兩個 jail 的 `.env` 加 `GEMINI_API_KEY=...`
2. push 之後在 jail 跑 `/root/update.sh`（會因 `package.json` 變動自動 `yarn install`）
3. `cd /root/BC_djs_bot_test && yarn test` → 全部通過
4. `yarn deploy`（註冊新指令 `/mc_check`）→ `pm2 restart bc-test`
5. log 裡要有 `排程已註冊：minecraft:feed cron=「*/30 * * * *」`。**沒有這行 = 排程沒掛上**
6. `/mc_check` → 回「首次執行，記住 N 篇，不發送」；兩個頻道都沒有新訊息（驗收 9）
7. 再 `/mc_check` → 「沒有新文章」
8. 編輯 `data/state.json` 的 `minecraft.seen`，刪掉 `minecraft-26-4-snapshot-7` 那一筆 → `/mc_check` → 內容頻道開出討論串（標題＋原文連結、中文摘要、日文摘要），通知頻道有通知、兩個連結點得開（驗收 10、11、15）
9. 再 `/mc_check` → 「沒有新文章」，沒有第二個討論串（驗收 14）
10. `.env` 暫時拿掉 `GEMINI_API_KEY`、重啟、重做第 8 步 → 討論串裡是原文（切段、最多 8 則）（驗收 13、16）。做完把 key 放回去
11. `test.js` 的 `minecraftContent` 暫時改成不存在的 id、重做第 8 步 → log 有警告、bot 沒崩潰、`seen` 沒有加回那一筆（驗收 12）。做完改回來，**不要 commit 這個改動**

每一步把 `/mc_check` 的回覆與 `grep -i minecraft` 的 log 貼回來。

---

## 待使用者決定

| # | 事項 | 擋住 |
|---|---|---|
| 3 | 檢查頻率 30 分鐘可以嗎？（Minecraft 更新不急，太頻繁只是浪費） | 14-1，可先用預設 |
| 6 | `docs/ENVIRONMENTS.md` 要不要記 `GEMINI_API_KEY`？（`docs/DEPLOY.md` 也可能要補「新增指令後要 `yarn deploy`」，本單元沒讀過該檔，未確認）CLAUDE.md 要不要更正 jail 名稱與路徑？（兩者都在本單元領域外） | 不擋 |

已決定（2026-11-04）：頻道 id 已提供；關鍵字只收 `snapshot`、`java edition`；長文改由 AI 摘要處理、退回原文時上限 8 則；討論串放繁中＋日文摘要（方案 A）。

---

## 2026-11-05：抓取改用 curl（Node 的 fetch 被 403 擋死）

實機驗收第一步 `/mc_check` 就失敗：`Minecraft feed 抓取失敗：HTTP 403`。

### 四輪實測（都在測試 jail）

| 測試 | 結果 |
|---|---|
| `curl -A "Mozilla/5.0" <feed>` | **200** |
| `curl` 完整瀏覽器 UA ＋ Accept ＋ Accept-Language | **200** |
| **Node `fetch` 同一個 UA（feed）** | **403** |
| **Node `fetch` 同一個 UA（文章頁）** | **403** |
| Node `fetch` ＋ 完整 UA ＋ Accept ＋ Accept-Language ＋ Sec-Fetch-* | **403** |
| 再觸發一次 `/mc_check` | 一樣 403（可重現，不是暫時性的） |

**同一台機器、同一個 UA、同一個網址，curl 過、Node 不過，而且補 header 無效。**
所以不是 UA、不是 header，是 minecraft.net 前面的 Akamai 在看 TLS 握手與請求指紋，
而 Node 內建的 undici 跟 curl 的指紋完全不同。**feed 與文章頁都被擋**。

### 評估過但否決的替代來源

`https://launchercontent.mojang.com/javaPatchNotes.json`（啟動器的 Java 更新說明）
格式漂亮得多——純 JSON、有 `type`（snapshot／release）、`body` 直接就是完整 HTML，
換過去可以刪掉 UTF-16 解碼、XML 解析、關鍵字過濾、文章頁抓取。**但它是死的**：

```
總筆數 230，最新一筆 Minecraft Snapshot 24w03b
last-modified: Wed, 07 Feb 2024 17:42:08 GMT
```

2024 年 2 月之後就沒更新了。採用的話會變成「永遠沒有新文章」，而且不會報錯。

`version_manifest_v2.json` 是活的，但**只有版本號沒有內文**，搬不了內容。

### 結論：HTTP 那一層換成 curl

改動只在 `fetchBytes()` 一個函式——整個模組只有它碰網路。
RSS 解析、UTF-16 解碼、文章頁、`htmlToText`、切段、討論串、摘要、`seen`、排程**全部不動**，
單元測試也不用改（它們測的是純函式）。

實作上的四個要點（都寫進程式註解了）：

| 項目 | 理由 |
|---|---|
| `encoding: 'buffer'` | feed 是 UTF-16LE，當字串收會在這一步就毀掉 |
| `-f` | HTTP 錯誤時讓 curl 以非零結束，呼叫端才接得到 |
| `-S` | 錯誤訊息留在 stderr，寫得進 log |
| curl 走絕對路徑（`/usr/local/bin/curl`） | pm2 起的行程環境跟登入 shell 不一定一樣。兩個 jail 都在這個位置（已確認） |

另外在 `restore()` 開機時檢查 curl 在不在，不在就記 ERROR——
不檢查的話要等第一次排程才發現，而那時只看得到一行「抓取失敗」，不會知道是工具不見了。

**Gemini 那邊維持用 Node 的 `fetch`**，Google 的 API 沒有這個問題，實測正常。

## 2026-11-05 實機驗收的兩個發現

### ① AI 摘要全部失敗：`.env` 的編碼問題，不是金鑰錯

```
Gemini[zh]：gemini-3.5-flash 呼叫失敗(Cannot convert argument to a ByteString
because the character at index 0 has a value of 65533 which is greater than 255.)
```

**65533 = U+FFFD（�，取代字元）**，而且在**第 0 個字元**。
金鑰是直接塞進 HTTP header 的，而 header 只容得下 Latin-1（0–255），
所以金鑰開頭有一個非 ASCII 字元就會丟這個錯。

U+FFFD 代表「這段 bytes 不是合法的 UTF-8」——也就是 `.env` 裡那一行的編碼壞了。
`TOKEN` 那些舊的行都正常，只有 `GEMINI_API_KEY` 壞掉，典型原因是用
PowerShell 的 `>>` 或 `Add-Content` 附加（Windows PowerShell 5.1 的預設不是 UTF-8）。

**使用者端的修法**：在 jail 裡用 `vi` 把那一行重打一次，存成純 ASCII。

**程式端已補**：`gemini.js` 在呼叫前先檢查金鑰是不是可列印 ASCII，
不是就記一行看得懂的 ERROR 並直接放棄，不再對每個模型、每種語言各噴一次那串天書
（這次就噴了 6 次）。

### ② 更新內容「頻道」其實是一個討論串 —— 這是刻意的

```
[WARN] Minecraft：更新內容頻道 1567438526801510400 不支援討論串，改直接貼在頻道裡
```

2026-11-05 使用者確認：那個 id 本來給的就是**一個既有的討論串**，不是頻道。
討論串裡開不出討論串，所以程式退回「直接貼進去」——**結果正好就是想要的行為**，
只是訊息寫得像出了事。

**決定：不每次開新討論串，全部累積在那一串。** 理由：

- Minecraft 更新一個月幾篇，開新串的話頻道側邊欄會長出一排（U13 與 BACKLOG 的 B1 都踩過討論串累積的問題）
- 每一篇都有自己的標題行（`**標題**` ＋ 原文連結）當分隔，在同一串裡仍然找得到
- 要討論特定版本可以直接對那則訊息回覆

程式已改：目標本身是討論串時走 `logger.info` 的正常路徑，不再開串也不再報 WARN。
`channels.minecraftContent` 填討論串或填一般頻道都支援——填頻道就會每篇開一串。

## 決策紀錄

- 2026-11-04　**不用 Discord Webhook，用 `channel.send()`**。理由：bot 本來就在伺服器裡，webhook 等於多管一組密鑰，而且發出來的不是 bot 本人。
- 2026-11-04　**不用無窮迴圈 ＋ 固定秒數，改用 `scheduleCron` ＋ `registerRestore`**。理由：專案已有排程器，自己開迴圈會跟 bot 的生命週期打架。
- 2026-11-04　**加 `fast-xml-parser` 這個相依**。理由：用字串或正規表達式解析 XML 會在 CDATA 與 HTML 實體上安靜地出錯，拿到半截標題；這是少數值得為它加相依的情況。
- 2026-11-04　**不裝 HTML 解析套件**，內文先用 RSS 的 description，太短才抓網頁粗略去標籤。理由：摘要用的文字不需要精確到那個程度。
- 2026-11-04　**第一次執行只記 guid、一則都不發**。理由：feed 裡有幾十篇歷史文章，不這樣做上線當下就會洗版。
- 2026-11-04　**任何失敗都不寫 `seen`**。理由：寫進去的話那次漏掉的更新永遠不會補發。
- 2026-11-04　~~**不做 AI 摘要**，改成把內容整包搬進討論串。~~ 使用者決定；同日被下方「推翻『不做 AI 摘要』」取代。
- 2026-11-04　**摘要失敗一定要照樣貼標題與連結**。理由：通知比摘要重要得多。
- 2026-11-04　**14-0 實測：description 只有摘要，所以內文一律從文章頁取**。上面「先用 description」那條不適用了。仍然不裝 HTML 解析套件，理由：內文在固定的 `MC_Link_Style_RichText` 區塊，用到的標籤只有十來種，自己轉就夠了。
- 2026-11-04　**`seen` 的 key 用文章網址**。理由：feed 沒有 `<guid>`，連結是唯一穩定的識別。
- 2026-11-04　**RSS 用 `arrayBuffer()` 讀 bytes，自己判斷編碼**。理由：feed 是無 BOM 的 UTF-16LE，`res.text()` 會安靜地解成亂碼。
- 2026-11-04　~~關鍵字加 `changelog`~~（被下一條取代）。理由：Bedrock 正式版的標題是 `Minecraft: Bedrock Edition 26.60 Changelog`，原本的關鍵字一個都不含。
- 2026-11-04　**只發 Java 版：收錄 `snapshot`、`java edition`；排除 `bedrock`、`preview`，排除優先**。使用者決定只要 Java 版、拿掉 `update`。排除清單是保險，防止同時含兩種字的標題混進來。文章頁的分類標籤兩篇都是 `News`，無法用來分版本，所以只能看標題；被過濾的標題記進 log，以便日後確認 Java 正式版的標題格式。
- 2026-11-04　**推翻「不做 AI 摘要」：討論串放繁中、日文 AI 摘要各一則，原文看連結（方案 A）**。使用者決定。沒選「全文翻譯＋摘要」，理由：一篇快照會變成 15 則以上，翻譯錯了也很難察覺。
- 2026-11-04　**用 Gemini REST API ＋ 原生 `fetch`，不裝 SDK**。理由：使用者已有可用的 key、免費額度遠超所需（一篇兩次呼叫）、`fetch` 足夠，不必再加相依。
- 2026-11-04　**模型名稱放設定檔，目前用 `gemini-3.8-flash`**。理由：實測 `gemini-2.5-flash` 已對新帳號回 404，模型會被汰換，換的時候只改一行。
- 2026-11-04　**503／429 在同一次執行內重試（最多 3 次），其他錯誤不重試；兩種語言各自判斷；都失敗或沒 key 就退回貼原文（上限 8 則）**。理由：實測遇過 503 high demand；摘要不應該擋住通知。
- 2026-11-04　**模型改成依序換：`gemini-3.5-flash` → `3.6-flash` → `3.8-flash`，取代「同一模型重試 3 次」**。使用者決定以 3.5-flash 為主。實測 3.5-flash 生成成功、3.8-flash 回 503、2.5-flash 回 404；3.6-flash 未實測。404 也換下一個（模型被汰換時功能不中斷）；400／401／403 是 key 的問題，換模型沒用，直接放棄。
- 2026-11-04　**新增 `/mc_check`（管理員）**，使用者同意。理由：loader 只掃 `commands/` 與 `events/`，`minecraftFeed.js` 沒人 import 的話 `registerRestore` 不會執行，排程永遠掛不上而且 log 一片乾淨（同 U05 的地雷 2）。順便讓實機驗收不必改 cron 再重啟。不改 `events/ready/index.js`，因為那是各單元共用的檔案。
- 2026-11-04　**首次執行看 `initialized` 旗標，不看「`seen` 是空的」**。理由：第一次剛好沒有 Java 文章時 `seen` 是空的，用它判斷的話之後每一輪都會被當成首次，新文章永遠不會發。
- 2026-11-04　**`seen` 一篇寫一次，不等整輪結束**。理由：後面某篇失敗時不會連累前面已經貼出去的（否則下一輪會重貼）。
- 2026-11-04　**「內容處理完」= 討論串（或內容頻道）的第一則（標題＋原文連結）有貼出去**。第一則失敗就刪掉剛開的討論串、不寫 `seen`；第一則之後個別失敗只記 log。理由：留一個空討論串的話下一輪重試會再開一個。
- 2026-11-04　**加記憶體鎖**：排程與 `/mc_check` 同時觸發時後到的略過。理由：否則同一篇會貼兩次。
- 2026-11-04　**`minecraftFeed.js` 不 import discord.js**：討論串類型直接寫 `11`（`ChannelType.PublicThread`）。理由：這樣測試檔能 import 它，連整段 `runCheck` 都能用假 client 測。
- 2026-11-04　**所有訊息帶 `allowedMentions: {parse: []}`**。理由：文章或 AI 摘要裡出現 `@everyone` 也不能真的 tag 到人。
- 2026-11-04　**提示詞放 `minecraftFeed.js`，`gemini.js` 只管呼叫**。理由：`gemini.js` 不認識業務，之後別的功能要用 Gemini 可以直接共用。
- 2026-11-04　**`yarn.lock` 有進版控，但這個目錄不能跑 `yarn`**，所以該次 commit 只改了 `package.json`。jail 端 `update.sh` 會自己 `yarn install`，更新過的 `yarn.lock` 只在 jail 裡。
- 2026-11-05　**14-8 完成**：測試 jail 裝好之後（`success Saved lockfile.`），從唯讀路徑把 jail 的 `yarn.lock` 複製回本目錄 commit，新增 `fast-xml-parser@5.12.0` 與它的相依 `@nodable/entities`，共 52 行。
- 2026-11-05　**`channels.minecraftContent` 填討論串時就直接貼進去，不再開新串**。使用者確認那個 id 本來就是討論串。理由：一個月幾篇全部累積在同一串比較好找，也不會讓側邊欄長出一排討論串；每篇的標題行就是分隔。填一般頻道的話仍然會每篇開一串，兩種都支援。
- 2026-11-05　**金鑰在送出前先檢查是不是可列印 ASCII**。理由：非 ASCII 會讓 undici 丟一串看不懂的 ByteString 錯誤，而且每個模型每種語言各噴一次；真正的原因是 `.env` 的編碼，訊息要直接講出來。
- 2026-11-05　**minecraft.net 的抓取改用 curl，不用 Node 的 `fetch`**。理由：四輪實測確認 Node 被 403 擋死而 curl 可以，補 header 無效，feed 與文章頁都一樣。改動只在 `fetchBytes()` 一個函式。
- 2026-11-05　**否決 `javaPatchNotes.json`**。它的格式好很多，但 2024-02-07 之後就停更了，採用會變成「永遠沒有新文章」而且不報錯。
- 2026-11-05　**否決「只做版本通知」（`version_manifest_v2.json`）**。使用者選 A：核心需求就是把內容搬回來讓大家就地討論，拿掉內容等於拿掉這個功能的意義。
- 2026-11-05　~~「不補 `yarn.lock` 的話正式 jail `git pull` 會被本機修改擋住」~~ **這個理由是錯的**：正式站也有自己的 `update.sh`，用的是 `git reset --hard origin/main`，本機修改一律被丟棄，不會擋住更新。補 `yarn.lock` 的真正理由是**版本可重現**——不補的話兩個 jail 各自解析 `^5.12.0`，可能裝到不同的修補版，而且本機與 jail 的相依樹會長期對不起來。
- 2026-11-04　**摘要失敗不算這篇失敗，內容有貼出去就寫 `seen`**。理由：不寫的話下一輪會重開討論串（重複搬運）。「任何失敗都不寫 `seen`」指的是抓 RSS、抓文章頁、貼到內容頻道這些步驟。
- 2026-11-04　**文件勘誤**：測試 jail 的名稱是 `DiscordBot-Test`，repo 路徑是 `/root/BC_djs_bot_test`。CLAUDE.md 寫的是 `DiscordBot_test` 與 `/root/BC_djs_bot`，那個檔案不在本單元的檔案領域內，要不要改由使用者決定。
