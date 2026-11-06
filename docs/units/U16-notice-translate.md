# U16　公告自動翻日文 ＋ Gemini 失敗佇列

狀態：進行中
進度：6/9（程式全部完成，剩 jail 測試與兩站驗收）
依賴：U03（`state.js`，已完成）、U14（`gemini.js` / `minecraftFeed.js`，已完成）
可平行：**不可**。會動到 `minecraftFeed.js` 的貼文流程，跟其他要改那支檔案的單元會衝突
分支：**留在 `test`，不要開分支**（見 CLAUDE.md 的單元制第 2 條）
工作目錄：`\\fongxiang.duckdns.org\admin_only\Program\Discord_bot\BC_djs_bot_test`
來源：2026-11-06 使用者需求 ＋ 正式站當天的 Gemini 失敗事故

---

## 目標

兩件事，共用同一套「呼叫 Gemini，失敗就排進佇列稍後重試」的機制。

### A. 公告自動翻日文

伺服器裡有日本成員。使用者在**手動公告頻道**用中文發公告時，機器人要自動翻成日文，
**以回覆的形式貼在同一個頻道**，並標明是 AI 翻譯。

頻道 id 已經寫進 config（`channels.manualNotice`）：

| 環境 | 頻道 id |
|---|---|
| 正式 | `1568103397331046453` |
| 測試 | `1568104599863435264` |

### B. Gemini 失敗佇列

目前 Gemini 失敗就當場放棄（摘要退回貼原文、翻譯乾脆不貼）。改成：

1. 失敗的工作進佇列
2. **每 30 分鐘**重試一次
3. 失敗 **5 次**後，到管理員頻道（`channels.admin`）發通知，說明是哪一篇、哪個語言、最後的錯誤
4. 若失敗原因是 **429 額度用完**，不走 30 分鐘，改排**隔天**再試

---

## ⚠️ 一定會出事的地方

### 1. 不擋 `author.bot` 會無限迴圈 ← 最重要

機器人把自己剛貼的日文翻譯又翻一次，再翻譯那則翻譯……**幾秒內就會灌爆頻道並撞上 Discord rate limit**。

`action` 的第一行必須是：

```js
if(message.author.bot) return
```

這不是防禦性程式碼，是這個功能唯一會造成實質損害的風險。

### 2. 429 跟 503 是兩回事，混在一起會把額度燒更快

```
503 → 當下尖峰，等幾十秒就過了
429 → 這把金鑰的額度用完，等再久也一樣（免費層每天重置）
```

2026-11-06 正式站就是因為沒分開，兩輪重試共 16 次呼叫把本來還能用的額度打完。
`core/gemini.js` 的 `generateText()` **已經**會回 `quota: true`（commit `882c9d1`），
佇列要讀這個欄位決定下次什麼時候重試。

> 額度實際上是**太平洋時間午夜**重置（約台灣時間下午 16:00）。
> 使用者要求的是「隔天再試」，所以排到隔天早上，不是精算重置時刻 —— 不要為了早幾小時去算時區。
> （Node 在 jail 裡的 ICU 不完整，`toLocaleString({timeZone})` 不可靠，見 `docs/ENVIRONMENTS.md`。）

### 3. 佇列一定要落地，不能只放記憶體

bot 重啟（`update.sh`、`pm2 restart`）一天會發生好幾次。佇列放記憶體 = 重啟就全掉，
那些「等 30 分鐘後補上」的工作會永遠不補，而且**不會有任何錯誤訊息**。

用 `core/state.js`，並 `registerRestore()` 在開機時把到期的工作重新掛上排程。

### 4. 補上的摘要要貼回「原本那一篇的討論串」

佇列成功之後不能貼到預設頻道，要貼回當初那一篇所在的討論串。
所以工作裡要存 `channelId`（實際貼文的目標，可能是討論串而不是頻道）。
那個 id 在 `postArticle()` 裡才知道（`target.id`），要往外傳。

### 5. `splitMessage()` 不能跳過

翻譯和補發的摘要一樣可能超過 2000 字。Discord 超長會**整則被退回**，不是截斷。
用現成的 `minecraftFeed.splitMessage()`，不要自己切。

### 6. 測試檔不能 import `discord.js`

測試 jail 裡只要測試檔直接或間接 import 到 discord.js 就會卡住跑不完
（`tests/moduleLayout.test.js` 有自動檢查）。
所以**純函式要跟 Discord 物件分開**：
建訊息字串、算下次重試時間、判斷要不要通知管理員 —— 這些都要是可單獨測試的純函式。

### 7. 正規表示式裡不要出現奇數個雙引號

`tests/moduleLayout.test.js` 的括號平衡掃描不是完整的 parser，看到 `"` 就當字串開頭。
regex 字面值裡的雙引號會害它誤判「字串沒有結束」。
需要時用 `new RegExp('...', 'i')` 配單引號字串（`minecraftFeed.js` 的 `OG_TITLE` 是現成的例子）。

---

## 不做的事

- **不處理訊息編輯**。原公告編輯後要不要重翻、舊翻譯要不要跟著改，規則會變複雜，v1 不做。
- **不處理圖片／貼圖**。`message.content` 是空字串就直接 return。
- **不翻譯其他頻道**。只有 `channels.manualNotice` 那一個。
- **不做日文→中文**。只做中文→日文。
- **不改 `classifyStatus()` 的行為**。429 仍然是「換下一個模型」，只是多回報一個 `quota` 旗標。
- **不動既有的關鍵字回覆**。排除清單已經做好了（`config.noKeywordReply`，commit `4a055cb`）。

---

# 做法

## A. 公告翻譯

### 新增 `src/events/noticeTranslate/index.js`

```js
export const event = {name: Events.MessageCreate}
```

> `core/loader.js` 對每個 `src/events/**/index.js` 各做一次 `client.on()`，
> 所以多個檔案監聽同一個事件沒問題，不會蓋掉既有的 `Message_listening`。

流程：

```
收到訊息
  ↓ message.author.bot                → return（最重要的一條）
  ↓ channelId !== channels.manualNotice → return
  ↓ message.content 去空白後是空的      → return
  ↓
丟給 Gemini 翻譯（沿用 GEMINI_MODELS / GEMINI_TIMEOUT_MS）
  ↓ 成功 → message.reply() 貼出日文，附 AI 標註
  ↓ 失敗 → 進佇列；在原訊息加 ⏳ 反應，讓人知道「在處理，還沒好」
```

輸出格式（第一行是 Discord 的小字 subtext）：

```
-# 🤖 AI 翻訳（Gemini gemini-3.5-flash）

（日文內容）
```

用 `message.reply()` 而不是 `channel.send()`：公告之間會夾雜其他人的發言，
不回覆的話日文會跟原文分開，日本成員對不起來。

送出時一律 `allowedMentions: {parse: []}`：
公告裡常有 `@everyone`，翻譯**不能**再 tag 一次全體。

### 提示詞

放在新的 `src/core/noticeTranslate.js`（純函式，不碰 discord.js）：

- 要求只輸出譯文，不要前言、不要解釋、不要附中文原文
- 要求保留原文的換行與條列結構
- 要求 Discord 的提及字串（`<@123>`、`<#123>`、`<@&123>`、`:emoji:`）**原樣保留不翻**
  （翻掉就變成純文字，點不開也 tag 不到人）

---

## B. 佇列

### 存放

`core/state.js` 的新區段 `geminiQueue`：

```js
{
  jobs: [
    {
      id: '…',              //唯一值，用來取消與去重
      kind: 'summary' | 'translate',
      channelId: '…',       //要把結果貼回哪裡（討論串就是討論串的 id）
      messageId: '…',       //要回覆哪一則；沒有就直接 send
      payload: {…},         //summary：{link, title, lang}；translate：{text}
      attempts: 2,
      nextAt: 1762400000000,
      lastError: 'all-failed(quota)',
    },
  ],
}
```

### 觸發

獨立的 `scheduleCron(QUEUE_JOB_KEY, '*/30 * * * *', …)`，
每次掃出 `nextAt <= Date.now()` 的工作來跑。

`registerRestore()` 裡重新掛上這個 cron —— 跟 `minecraftFeed.js` 的 `restore()` 同樣寫法。

### 重試規則

| 情況 | 下次 `nextAt` |
|---|---|
| 一般失敗（503／逾時／all-failed） | 現在 + 30 分鐘 |
| `quota: true`（429） | **隔天 09:00（台灣時間）** |
| `attempts >= 5` | 不再排，發管理員通知後移出佇列 |

算下次時間要寫成**純函式**，吃 `(now, attempts, quota)` 回 timestamp，才測得到。
`core/scheduler.js` 有 `TAIPEI_OFFSET_MS` 可以用，不要自己湊時區。

### 管理員通知

貼到 `config.channels.admin`，內容要讓人一眼判斷「該等額度還是該修金鑰」：

```
⚠️ Gemini 連續失敗 5 次，需要人工處理

項目：Minecraft 26.4 Snapshot 7（日文摘要）
網址：https://www.minecraft.net/...
最後錯誤：all-failed（429 額度用完）
首次失敗：2026-11-06 10:25
```

### 成功之後

- `summary`：把補上的那段摘要貼進 `channelId`，開頭標明是後補的
  （例：`-# ⏳ 稍後補上的日文摘要`），一樣要有模型標註
- `translate`：`message.reply()` 貼譯文；原訊息的 ⏳ 反應要移除

---

## 要改的 `minecraftFeed.js`

1. `postArticle()` 回傳值加 `targetId`（實際貼文的頻道／討論串 id）
2. `buildContentMessages()` 裡，某個語言失敗且 `reason === 'all-failed'` 時
   **不要只貼一行「產生失敗」**，改成貼「⏳ 稍後自動補上」，並把工作排進佇列
3. 兩種語言都失敗時維持現狀（退回貼原文），但**同時**把兩個語言都排進佇列
4. 既有的「等 20 秒重試一輪」（`GEMINI_RETRY_DELAY_MS`）**整段拿掉**，由佇列取代

---

## 相關檔案

### 要改的

| 檔案 | 改什麼 |
|---|---|
| `src/core/minecraftFeed.js` | 上面那四點 |
| `src/config/minecraft.js` | 拿掉 `GEMINI_RETRY_DELAY_MS`，加佇列的常數 |
| `src/core/state.js` | 不用改，直接用 `getState`/`updateState` 開新區段 |
| `tests/minecraftFeed.test.js` | 拿掉重試延遲相關的兩條，改驗佇列（2026-11-06 使用者同意） |

### 要新增的

| 檔案 | 內容 |
|---|---|
| `src/core/geminiQueue.js` | 佇列本體：純函式（排程計算、訊息組裝）＋ 執行器 |
| `src/core/noticeTranslate.js` | 翻譯的提示詞與純函式 |
| `src/events/noticeTranslate/index.js` | MessageCreate 監聽 |
| `src/config/noticeTranslate.js` | 翻譯相關設定（若常數夠多才拆，否則併進 `minecraft.js`） |
| `tests/geminiQueue.test.js` | 佇列純函式 |
| `tests/noticeTranslate.test.js` | 提示詞與訊息組裝 |

### 只讀但一定要看的

| 檔案 | 為什麼 |
|---|---|
| `src/core/gemini.js` | `generateText()` 的回傳形狀，特別是 `reason` 與 `quota` |
| `src/core/minecraftFeed.js` | `splitMessage()`、`SUMMARY_LANGS`、`restore()` 的寫法 |
| `src/core/scheduler.js` | `scheduleCron` / `scheduleAt` / `TAIPEI_OFFSET_MS` |
| `src/core/state.js` | `updateState` 是**排隊**執行的，不要在 mutator 裡做 await 之外的事 |
| `src/events/Message_listening/index.js` | 既有的 MessageCreate 監聽長什麼樣 |
| `tests/minecraftFeed.test.js` | 怎麼在不碰 discord.js 的前提下測整條流程（假 client） |
| `docs/ENVIRONMENTS.md` | 測試 jail 的地雷 |

---

## 進度

- [x] 16-1　`noticeTranslate.js` 提示詞與純函式 ＋ 測試（jail 全過，2026-11-06）
- [x] 16-2　`events/noticeTranslate/` 監聽（含 `author.bot` 擋線）（jail 全過，測試站實機翻譯 OK）
- [x] 16-3　`geminiQueue.js` 的純函式（下次時間、管理員通知文字）＋ 測試
- [x] 16-4　佇列的落地與 `registerRestore`
- [x] 16-5　佇列執行器（兩種 kind）＋ 測試；翻譯失敗接上佇列與 ⏳
- [x] 16-6　`minecraftFeed.js` 接上佇列，拿掉 `GEMINI_RETRY_DELAY_MS`
- [ ] 16-7　`yarn test` 全過（在測試 jail 跑，不要在 NAS 目錄跑）
- [ ] 16-8　測試站實機驗收
- [ ] 16-9　正式站驗收

---

## 驗收

1. 在測試站的 `1568104599863435264` 發一則中文公告 → 機器人回覆日文，附 AI 標註
2. 機器人自己發的訊息**不會**被再翻一次（確認沒有無限迴圈）
3. 該頻道不會出現「確かに」之類的關鍵字回覆
4. 把 `config/minecraft.js` 的 `GEMINI_MODELS` 暫時換成不存在的模型（例：`['gemini-nonexistent']`）
   → 回 404、整條鏈 `all-failed` → 翻譯失敗，原訊息出現 ⏳，佇列裡有工作
5. 改回正確的模型清單 → 30 分鐘後自動補上譯文，⏳ 消失
4b. 把 `.env` 的 `GEMINI_API_KEY` 暫時改錯 → **不**出現 ⏳、佇列是空的、log 有 ERROR（金鑰失效不排佇列）
6. 把重試上限暫時改成 1 → 失敗後管理員頻道收到通知，內容含項目／網址／錯誤
7. `yarn test` 全過

> 備註：佇列預設 30 分鐘才掃一次。驗收 4～6 想加快，可暫時把 `config/minecraft.js` 的
> `QUEUE_CRON` 改 `'*/2 * * * *'`、`QUEUE_RETRY_MS` 改 `2 * 60 * 1000`(驗收 6 再把 `QUEUE_MAX_ATTEMPTS` 改 2：
> 第一次失敗排入，下一輪再失敗就通知)，驗完 revert。
> 驗收 5 中間做一次 `pm2 restart`，順便確認重啟後佇列還在。
> 摘要那條路：模型換成不存在的時候用 `/mc_check` 補發一篇 → 討論串出現「稍後自動補上」→ 改回模型後補貼進同一個討論串。

---

## 決策紀錄

### 2026-11-06　為什麼要做佇列

正式站連兩次補發 snapshot 7，日文摘要都失敗。log：

```
10:25  3.5-flash 503 → 2.5-flash 404 → 3.8-flash 逾時 45s → 2.5-pro 404
10:36  3.5-flash 429 → 2.5-flash 404 → 3.8-flash 503     → 2.5-pro 404
```

兩個問題：模型鏈有一半是死的（已於 `882c9d1` 修掉），以及**失敗之後沒有任何自動補救**，
只能靠人看到了手動重跑。使用者要求改成自動重試，並在真的沒救時才叫人。

### 2026-11-06　為什麼 429 要排到隔天而不是 30 分鐘

免費層的額度是**每天**重置的。30 分鐘後重試不但不會成功，還會多消耗一次呼叫 ——
而額度本來就是各模型分開計算的，多打一次就少一次救命的機會。

### 2026-11-06　16-1：「要不要翻」也做成純函式

`shouldTranslate({bot, channelId, content}, noticeChannelId)` 把 bot 擋線、頻道比對、空內容判斷收在一起，
這樣最危險的那條規則(`author.bot`)有單元測試守著。事件檔的 `action` 第一行仍然照寫
`if(message.author.bot) return`，兩層都擋；16-2 會再加一條靜態檢查確認那行沒被挪走。
環境沒設 `manualNotice` 時一律不翻。

譯文標註分兩種：當下翻好的是 `-# 🤖 AI 翻訳（Gemini 模型）`，
佇列補上的是 `-# ⏳ 後から追加された AI 翻訳（…）`。讀者是日本成員，所以補上的標示也寫日文；
不分開的話，補上的那則看起來會像重複貼。

### 2026-11-06　只有 all-failed 進佇列，金鑰失效不排(使用者決定)

`generateText()` 的失敗分三類：
- `all-failed`(503／逾時／429 都換過一輪模型)→ 進佇列，摘要與翻譯一致
- `bad-key`、`http-400/401/403` 這類放棄整條鏈的 → **不排**，記 `logger.error`。
  重試一百次也一樣，排進去只會在 5 次後才叫人，不如當下就記 ERROR。
  (依 `channels.admin` 的註解「管理員看到的 ERROR」推測 logger.error 會送到管理員頻道，未讀 logger.js 確認)
- `no-key` → 該環境刻意沒設金鑰，不排也不記 ERROR(gemini.js 已記 warn)

因此原本的驗收第 4 步(改錯金鑰觸發佇列)不成立，改成用不存在的模型名稱製造 `all-failed`，
改錯金鑰的情境另列為 4b，驗的是「不排佇列」。

### 2026-11-06　16-2：回覆時 repliedUser: false

`message.reply()` 預設會 ping 被回覆的人。公告者每發一則就被機器人 ping 一次沒有意義，
所以 `allowedMentions: {parse: [], repliedUser: false}`。譯文超過 2000 字被切段時，每段都用 reply，
讓每一則都連得回原公告。

### 2026-11-06　檔案領域追加 `tests/minecraftFeed.test.js`(使用者同意)

16-6 拿掉 `GEMINI_RETRY_DELAY_MS` 後，該檔「第二輪成功」與「429 不做 20 秒重試」兩條會失效，要改寫成驗佇列。

### 2026-11-06　16-3～16-6 的實作決定

**佇列不認識業務，各功能用 `registerKind()` 登記處理器。**
重做摘要要用 `minecraftFeed` 的 `fetchArticle`，而 `minecraftFeed` 又要 import 佇列來排工作；
佇列反過來 import 它就變成互相 import。處理器回 `{ok}` / `{ok:false, result}` / `{drop}` 三種。

**失敗次數含第一次。** 原本那次算第 1 次，所以是原本 ＋ 4 次重試，第 5 次失敗通知管理員。
`QUEUE_MAX_ATTEMPTS` 設成 1 時第一次失敗就直接通知、不排。

**「隔天 09:00」照字面取下一個日期。** 凌晨 0:30 失敗也排到隔天，當天早上額度還沒重置。

**job 比單元檔的格式多四個欄位：** `createdAt`(通知的「首次失敗」)、`url`(通知的「網址」)、
`label`(通知的「項目」，例：`Minecraft 26.4 Snapshot 7（日文摘要）`、`公告翻譯：公告開頭 30 字`)、`quota`。
id 寫死成 `summary:<link>:<lang>`、`translate:<messageId>`，同一個 id 再排不會把次數洗回 1。

**落地一律「依 id 改那一筆」**，不整包覆寫：執行器在等 Gemini 的那幾十秒內，
事件那邊新排進來的工作才不會被蓋掉(有測試)。

**摘要工作不存內文**，重跑時重抓文章頁：`state.json` 每次寫入都整份重寫，不值得塞整篇文章。
補貼前先確認討論串拿得到，才呼叫 Gemini，免得白白消耗額度。

**摘要要等第一則貼出去才排。** `buildContentMessages()` 跑的時候還沒開討論串，不知道 `target.id`，
所以改成回 `{messages, pending, results}`，由 `postArticle()` 貼完再排。第一則就失敗的話整篇下一輪重來，不排。

**佔位與補上的標示：** 中文 `（⏳ 中文摘要暫時產生失敗，稍後自動補上）` ／ `-# ⏳ 稍後補上的中文摘要`；
日文 `（⏳ 日本語の要約は後ほど自動で追加されます）` ／ `-# ⏳ 後から追加された日本語の要約`。
日文那邊寫日文(讀者是日本成員)，同公告翻譯的 `-# ⏳ 後から追加された AI 翻訳`。

**翻譯流程搬進 `core/noticeTranslate.js` 的 `translateMessage()`**，事件檔只剩擋 bot ＋ 呼叫它，
這樣整條流程(成功、排佇列加 ⏳、金鑰錯誤不排、補上拿掉 ⏳、原公告被刪)都能用假物件測。
原公告或頻道被刪(10003／10008)→ `drop`，不再呼叫 Gemini。放棄時也拿掉 ⏳。

**處理器丟例外(多半是 Discord 暫時性錯誤)當一般失敗重排**；重試時變成金鑰錯誤則移出佇列、記 ERROR，不另發通知。

**沒有做手動觸發佇列的指令**，驗收時用暫時調短的 `QUEUE_CRON` / `QUEUE_RETRY_MS`(見驗收的備註)。

**未確認的地方：** 往已封存(7 天無動靜)的討論串貼訊息，Discord 應會自動解除封存(信心中等，未實測)；
不行的話那筆會失敗 5 次後通知管理員，不會無聲消失。

### 2026-11-06　為什麼翻譯用回覆而不是另開頻道

使用者原話是「同步更新日文的通知」。分兩個頻道的話日本成員要兩邊對照，
而公告之間會夾雜其他人的發言，不用回覆就對不起來。
