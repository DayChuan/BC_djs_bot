# U14　Minecraft 更新通知

狀態：可開工（頻道 id 已齊）
進度：0/9
依賴：U03（`state.js`，已完成）
可平行：可，全部是新檔案
分支：**留在 `test`，不要開分支**（見 CLAUDE.md 的單元制第 2 條）
工作目錄：`\\fongxiang.duckdns.org\admin_only\Program\Discord_bot\BC_djs_bot_test`
來源：`docs/Functions/minecraft_update_bot_specification.md`

---

## 目標

定時讀 Minecraft 官方 RSS，有新的 Snapshot／Preview／Release 時：

1. **更新內容頻道**開一個討論串，把文章內容整包搬進去
2. **通知頻道**貼一則短通知，附原文連結與那個討論串的連結

目的是讓成員**在自己的伺服器裡就能看完、就地討論**，不用跳到官網。

> **AI 摘要不做**（2026-11-04 使用者決定）。先把「整包搬過來」做到會動，
> 之後真的覺得太長再考慮加摘要。相關評估留在 `docs/units/BACKLOG.md`。

---

## ⚠️ 交接文件是寫給「獨立 Python 專案」的，不能照抄

那份規格描述的是一個 `main.py` ＋ `requirements.txt` 的獨立程式。我們要的是**長進現有 bot 裡的一個功能**。
對應關係：

| 交接文件 | 這個專案要怎麼做 | 為什麼 |
|---|---|---|
| `main.py` 的無窮迴圈 ＋ `CHECK_INTERVAL_SECONDS` | `scheduleCron()` ＋ `registerRestore()` | 專案已有排程器；自己開迴圈會跟 bot 的生命週期打架 |
| **Discord Webhook ＋ `DISCORD_WEBHOOK_URL`** | **`channel.send()`** | bot 本來就在伺服器裡，用 webhook 等於多管一組密鑰，而且發出來的不是 bot 本人 |
| `feedparser`（Python） | `fast-xml-parser`（新相依） | 見下方「為什麼要加這個相依」 |
| `requests` ＋ `BeautifulSoup` 抓內文 | **先用 RSS 的 description，不夠長才抓網頁** | 少一個相依、少一個會壞的地方 |
| 「啟動時快取最新文章 ID」 | `state.js` 的 `minecraft` 區段 | 記憶體的快取一重啟就沒了，會整串重發 |
| `openai` SDK ＋ AI 摘要 | **不做** | 使用者 2026-11-04 決定：先整包搬過來，覺得太長再說 |

**原始交接文件不要改**，它是需求的歷史紀錄。

---

# 做法

先把「有新版本就通知」做到會動。這一段**沒有任何外部 API 金鑰**，可以立刻開工、立刻上線。

## 資料流程

```
每 30 分鐘 scheduleCron 觸發
  ↓
fetch RSS（Node 24 有原生 fetch，不用裝 http 套件）
  ↓
解析出 items：title / link / pubDate / guid
  ↓
關鍵字過濾：標題含 snapshot / preview / update / release（不分大小寫）
  ↓
扣掉 state 裡「已經貼過」的 guid
  ↓
還有剩 → 依 pubDate 由舊到新，逐則：
     ├ 在「更新內容頻道」開討論串，名稱＝文章標題
     ├ 把文章內容切段貼進那個討論串（一則 2000 字元上限）
     └ 在「通知頻道」貼短通知：標題 ＋ 原文連結 ＋ 討論串連結
  ↓
把 guid 寫進 state（只留最近 N 筆）
```

## 四個一定要處理的細節

### 1. 第一次執行不可以把整個 feed 洗版出來

feed 裡有幾十篇歷史文章，對空的 state 來說**全部都是「沒貼過」**。

**第一次跑（`seen` 是空的）→ 只把現有的 guid 全部記起來，一則都不發。**
這就是交接文件說的「啟動時需快取當前最新的文章 ID」，但它沒講清楚**第一次必須靜默**。

### 2. `seen` 清單要有上限

每次把新 guid 塞進去，不設上限就會無限長大，而 `state.json` 每次寫入都要重寫整份。

**只留最近 200 筆**，超過就從最舊的丟。200 遠大於一次抓回來的 feed 筆數，不可能誤判成「沒看過」。

### 3. 一次發現多則時要排序，而且要分開發

RSS 回來的順序不保證。**依 `pubDate` 由舊到新排**，否則畫面上會變成新的在上、舊的在下。

連發多則時中間留一點間隔（例如 1 秒），不要一口氣打四五則。

### 4. 任何失敗都不要寫 `seen`

網路錯誤、RSS 格式怪掉、頻道不存在——一律 `logger.warn` 之後 return，
**絕對不要把 guid 寫進 `seen`**。寫進去的話那次漏掉的更新就永遠不會補發了。

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

## 為什麼要加 `fast-xml-parser` 這個相依

專案一向很省相依（U06 連 Express 都不裝）。但 RSS 是 XML，而用字串比對或正規表達式解析 XML
會在 CDATA、HTML 實體、巢狀標籤上出錯——**而且是安靜地出錯**，拿到半截標題或空連結。

`fast-xml-parser` 零相依、單一套件、只做這件事。**這個相依值得加。**

加完兩個 jail 都要 `yarn install`（`update.sh` 會在 `package.json` / `yarn.lock` 變動時自動跑）。

## 進度

- [ ] 14-0 **先確認 feed 長什麼樣**（不寫程式，請使用者代跑，見下方「開工第一件事」）
- [ ] 14-1 `src/config/minecraft.js`：RSS 網址、關鍵字、cron、`seen` 上限、訊息字元上限
- [ ] 14-2 兩個環境檔加 `channels.minecraftNotice` / `channels.minecraftContent` ＋ `package.json` 加 `fast-xml-parser`
- [ ] 14-3 `src/core/minecraftFeed.js` 的純邏輯：解析 items、關鍵字過濾、算出「這次要發哪些」、`seen` 上限、**內容切段**
- [ ] 14-4 `tests/minecraftFeed.test.js`（**這個單元的重點**，見驗收）
- [ ] 14-5 抓 RSS、取內文、開討論串、貼內容、貼通知
- [ ] 14-6 state 讀寫 ＋ `scheduleCron` ＋ `registerRestore`
- [ ] 14-7 `yarn test` ＋ 測試伺服器實機驗收，commit

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
| `src/config/minecraft.js` | RSS 網址、關鍵字、cron、`seen` 上限、每則訊息字元上限 | 否 |
| `src/core/minecraftFeed.js` | 抓取、解析、過濾、比對、貼文、state | 是（只有貼文那段） |
| `tests/minecraftFeed.test.js` | 純邏輯測試 | 否 |

**要改的：**

| 檔案 | 改什麼 |
|---|---|
| `src/config/environments/production.js`、`test.js` | `channels` 加 `minecraftNotice` 與 `minecraftContent`。**兩邊結構必須一致**，`config/index.js` 的 `validate()` 會比對 |
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

1. 一段寫死的 RSS XML → 解析出正確的 title / link / guid / pubDate
2. 標題含 `Snapshot`／`snapshot`／`SNAPSHOT` 都要命中（**不分大小寫**）
3. 不含關鍵字的一般社群文 → 過濾掉
4. **`seen` 是空的（第一次執行）→ 回傳「不發任何一則」**，但要回「這些 guid 要記起來」
5. `seen` 已有資料 → 只回沒看過的那幾則
6. 多則待發 → **依 pubDate 由舊到新排序**
7. `seen` 超過上限 → 保留最新的 N 筆，最舊的被丟掉
8. RSS 壞掉／空字串／不是 XML → 回空陣列，**不丟例外**

**實機（測試伺服器）：**

9. 把 cron 暫時改成每分鐘 → 第一次跑**什麼都不發**，log 說明已記住 N 筆
10. 手動把 state 的 `seen` 刪掉一兩筆 → 下一次跑會把那幾則補發出來
11. 貼出來的訊息有標題與連結，點得開
12. 把 `channels.minecraft` 設成不存在的 id → **log 有警告、bot 不崩潰、`seen` 沒有被寫入**
13. 文章很長（超過 2000 字元）→ **自動切成多則**，接起來讀得通、沒有被截斷
14. 同一篇文章不會重複開第二個討論串

---

## 待使用者決定

| # | 事項 | 擋住 |
|---|---|---|
| 1 | **要發到哪個頻道？**（測試站與正式站各一個 id） | 14-2 |
| 3 | 檢查頻率 30 分鐘可以嗎？（Minecraft 更新不急，太頻繁只是浪費） | 14-1，可先用預設 |

---

## 決策紀錄

- 2026-11-04　**不用 Discord Webhook，用 `channel.send()`**。理由：bot 本來就在伺服器裡，webhook 等於多管一組密鑰，而且發出來的不是 bot 本人。
- 2026-11-04　**不用無窮迴圈 ＋ 固定秒數，改用 `scheduleCron` ＋ `registerRestore`**。理由：專案已有排程器，自己開迴圈會跟 bot 的生命週期打架。
- 2026-11-04　**加 `fast-xml-parser` 這個相依**。理由：用字串或正規表達式解析 XML 會在 CDATA 與 HTML 實體上安靜地出錯，拿到半截標題；這是少數值得為它加相依的情況。
- 2026-11-04　**不裝 HTML 解析套件**，內文先用 RSS 的 description，太短才抓網頁粗略去標籤。理由：摘要用的文字不需要精確到那個程度。
- 2026-11-04　**第一次執行只記 guid、一則都不發**。理由：feed 裡有幾十篇歷史文章，不這樣做上線當下就會洗版。
- 2026-11-04　**任何失敗都不寫 `seen`**。理由：寫進去的話那次漏掉的更新永遠不會補發。
- 2026-11-04　**不做 AI 摘要**，改成把內容整包搬進討論串。使用者決定。
- 2026-11-04　**摘要失敗一定要照樣貼標題與連結**。理由：通知比摘要重要得多。
