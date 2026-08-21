# U05　每日日文分享

狀態：未開始（阻擋項已解除）
進度：1/7
依賴：U03（記錄發過哪些項目，避免重複）
可平行：可
分支：**留在 `test`，不要開分支**（見 CLAUDE.md 的單元制第 2 條）
來源：原 PLAN.md Phase 5

---

## 目標

每天固定時間在指定頻道發一則日文分享（慣用句／單字＋讀音＋意思＋例句），內容來自**專案自己維護的資料表**，bot 只負責挑選與排版。

---

## 參考網站的調查結果（2026-08-20）

使用者提供的參考來源：<https://nihongo.hicross.jp/fixed-expression>（HICROSS 日本語，慣用句・ことわざ 201 件）。

**結論：不能當作自動化資料來源，但可以當作人工建表時的參考。**

實際抓取後確認：

- 清單頁的 HTML **不含任何慣用句內容**，只有導覽列、語言切換與「用所選單字出題」等介面按鈕。內容需要 JavaScript 或登入後才看得到（頁面上出現「電子郵件地址尚未驗證」的提示）
- 沒有找到 RSS 或公開 JSON API
- 多語言採路徑前綴（`/zh-hant/fixed-expression`、`/en/…`），但繁中版一樣看不到清單內容
- 總量只有 201 件

即使技術上繞得過去（跑無頭瀏覽器、帶登入 cookie），為了 201 筆固定不變的資料在 bot 裡養一套爬蟲並不划算，而且抓取需登入才能看的內容有使用條款上的疑慮。**採用使用者原本的方向：自己維護資料表。** 這個網站的價值在於它的欄位設計（表現／読み方／意味／例文／JLPT 等級／分類）值得照抄，以及建表時可以人工挑內容。

---

## 設計

**資料表**：`data/japanese/entries.json`（不進版控，正式站與測試站各自維護）。首次啟動時若檔案不存在，就從 `src/config/japaneseSeed.js` 的初始清單建檔——這跟 `src/core/selfRoles.js` 的作法完全一樣，照抄即可。

每一筆的欄位：

```json
{
  "id": "j_0001",
  "type": "idiom",
  "expression": "猫の手も借りたい",
  "reading": "ねこのてもかりたい",
  "meaning": "忙得不可開交，連貓的手都想借來用",
  "level": "N2",
  "tags": ["慣用句"],
  "examples": [
    {"ja": "年末は猫の手も借りたいほど忙しい。", "zh": "年底忙到連貓的手都想借。"}
  ],
  "note": "文法或用法補充，可留空"
}
```

`type` 先支援 `idiom`（慣用句）、`word`（單字）、`grammar`（文法）三種，排版時決定 embed 的欄位順序。

**挑選規則**：每天從「最久沒發過」的那批裡隨機挑一筆。已發過的 id 與時間記在 U03 的 state（區段 `japanese`），全部發完一輪就重新開始。用「最久沒發過」而不是純隨機，是因為純隨機在 200 筆的規模下很快就會重複，看起來像壞掉。

**排程**：每天 09:00 **台北時間**（`src/core/scheduler.js` 的 `TIMEZONE` 已經固定為 `Asia/Taipei`），用 `scheduleCron()`。

**指令**：`/jp` 讓成員隨時抽一則，不影響每日的挑選紀錄。權限 `SendMessages`。

**AI 摘要與新聞來源**：**本單元不做**。等資料表跑順了再開 U08 討論，那時候要一併決定 API 供應商、金鑰放哪、費用上限。目前的定位是「bot 讀資料表顯示資料」。

---

## 相關檔案

**已經有的：**

- `src/config/japaneseSeed.js` — **已產出 60 筆**（30 慣用句 ＋ 20 ことわざ ＋ 10 文法），2026-08-20 建立。欄位說明寫在檔案開頭的註解。使用者要續補或改寫都直接改這個檔

**要新增的：**

- `src/core/japanese.js` — 讀寫資料表、挑選邏輯、排版成 embed
- `src/commands/jp/index.js` — `/jp` 指令
- `src/jobs/dailyJapanese.js` — 每日排程任務（新增 `src/jobs/` 資料夾）

**要改的：**

| 檔案 | 改什麼 |
|---|---|
| `src/events/ready/index.js`（44 行） | 掛上每日排程。用檔案裡現成的 `safely()` 包起來 |
| `src/config/environments/production.js`、`test.js` | `channels` 加一個 `japanese` 欄位。**兩個環境檔的結構必須一致**，`src/config/index.js` 開機時會比對並警告不一致 |

**只讀，這個單元一定要看的：**

| 檔案 | 你需要知道的事 |
|---|---|
| `src/core/selfRoles.js`（158 行） | **本單元資料表的實作範本**：`ROOT_DIR` 用 `import.meta.url` 推導、`load()` 帶記憶體快取、檔案不存在就 `buildSeed()` 建檔、讀壞了退回預設清單而不是讓 bot 起不來、`migrate()` 補新欄位。它是同步 `fs`，資料量小的情況可以照抄 |
| `src/core/scheduler.js`（209 行） | `scheduleCron(key, expression, task)`、`weeklyCron()`、`TIMEZONE = 'Asia/Taipei'`。cron 運算式的時區由 `node-cron` 處理，不要自己算時差 |
| `src/core/state.js`（U03 產出） | `getState('japanese')` / `updateState('japanese', fn)` |
| `src/config/index.js`（96 行） | `config.channels.*` 的取法；兩個環境檔結構一致的檢查在 `validate()` |
| `src/commands/quickpoll/index.js` | 指令檔的標準寫法（匯出 `command` 與 `action`） |
| `src/core/pollRender.js` | embed 的組法可以參考 `buildResultMessage()` |

---

## 頻道

| 環境 | 頻道 ID |
|---|---|
| 測試站 | `1539905791564193862` |
| 正式站 | `1217432781877940305` |

寫進 `src/config/environments/test.js` 與 `production.js` 的 `channels.japanese`。

## 進度

- [x] 05-1 頻道 ID 確認（2026-08-20）
- [x] 05-2 `src/config/japaneseSeed.js` 初始清單 60 筆（2026-08-20 先行產出，供使用者測試與續補）
- [ ] 05-3 `src/core/japanese.js`：讀表、挑選、embed 排版
- [ ] 05-4 `src/commands/jp/index.js`
- [ ] 05-5 `src/jobs/dailyJapanese.js` ＋ `ready` 掛排程
- [ ] 05-6 `tests/japanese.test.js`（挑選規則、一輪發完重來、壞資料處理，全部純函式）
- [ ] 05-7 jail ＋ 測試伺服器驗收，commit

## 驗收

單元測試：

1. 連續挑 N 次（N＝資料表筆數）不會重複；第 N+1 次重新開始一輪
2. 資料表某一筆缺 `examples` → 排版不炸，只是少那一段
3. 資料表整個壞掉 → 回退到 seed 並留下 log，不讓 bot 起不來

實機（測試伺服器）：

1. `/jp` 抽得出一則，格式正確（表現／讀音／意思／例句都在）
2. 把排程改成每分鐘 → 確認會在指定頻道自動發文
3. 重啟 bot → 已發過的紀錄還在，不會從頭再發一次

---

## 阻擋項

無。

## 決策紀錄

- 2026-08-20　時間定為每天 09:00 **台北時間**（原本待確認是台北或日本時間）。
- 2026-08-20　內容來源＝自維護 JSON 資料表；AI 摘要與新聞來源延後到另一個單元。理由：使用者指示先做「讀資料表顯示資料」。
- 2026-08-20　參考網站 nihongo.hicross.jp **不做自動抓取**。理由：清單內容不在伺服器端 HTML、疑似需登入、無 API，且只有 201 筆固定資料。
