# U03　跨重啟狀態 `state.js`

狀態：停擺後復工（`src/core/state.js` 已有一份未 commit 的半成品）
進度：0/5
依賴：無
可平行：可（新檔為主，只在 `src/events/ready/index.js` 加一行）
分支：**留在 `test`，不要開分支**（見 CLAUDE.md 的單元制第 2 條）
　　　舊的 `unit/U03-state` 分支已經落後 `test` 15 個 commit，**不要用它、不要 checkout**，
　　　等這個單元做完再由使用者刪掉即可。
來源：原 PLAN.md Phase 2-C／2-D

---

## 目標

提供一個給「小量、需要撐過 bot 重啟」的狀態用的共用儲存層，並在開機時把未完成的計時重新掛回排程器。

## 為什麼要做

U04 的靜音到期時間、U05 的「最近發過哪些內容」都必須撐過 pm2 重啟。目前專案裡每個需要持久化的功能都各自寫了一份檔案存取（`pollStore.js`、`selfRoles.js`、`pollTemplate.js`），再多兩個功能就會變成第四、第五份。

---

## 相關檔案

**要新增的：**

- `src/core/state.js` — 單一 JSON 檔（`data/state.json`）的具名區段存取。

**要改的：**

| 檔案 | 改什麼 |
|---|---|
| `src/events/ready/index.js`（44 行） | 在既有的三個開機工作後面加第四個：還原 state 裡未到期的計時。用檔案裡現成的 `safely(label, task)` 包起來——它會攔截例外只記 log，一項失敗不影響其他項 |
| `.gitignore` | `data/` 應該已經在裡面，確認一下 |

**只讀，但這個單元一定要看懂：**

| 檔案 | 你需要知道的事 |
|---|---|
| `src/core/pollStore.js`（414 行，第 1-30、200-245 行） | **本單元的實作範本，照抄它的作法**：<br>・`ROOT_DIR` 用 `import.meta.url` 推導，不依賴 CWD<br>・路徑一律在「用到時」才解析成函式（`dataDir()`），不在模組載入時定死——這樣測試才能靠換環境變數指到暫存資料夾，不必 `vi.resetModules()`<br>・`readJson()`：`ENOENT` 回 `null`；內容壞掉先備份成 `.broken-<時間>` 再回 `null`，不直接覆蓋<br>・`writeJson()`：先寫 `.tmp` 再 `rename`，rename 在同一檔案系統上是原子操作<br>・`enqueue()`：用 Promise 鏈串行化「讀→改→寫」，佇列本身要吞掉錯誤，否則一次失敗會讓後面全部 reject |
| `src/core/scheduler.js`（209 行） | `export default` 與具名匯出都有。本單元會用到：<br>・`scheduleAt(key, when, task)` 一次性排程，內部用 `chunkDelay()` 分段等待避開 `setTimeout` 的 32 位元上限（約 24.8 天）<br>・`cancel(key)` / `has(key)` / `keys()`<br>・`TIMEZONE = 'Asia/Taipei'`、`parseTaipeiDateTime()` / `formatTaipeiDateTime()` |
| `src/core/pollService.js` 的 `restorePolls()`（第 218 行起） | 開機還原的既有寫法：讀出所有進行中的項目，已過期的立刻處理，未過期的重新 `scheduleAt`。本單元的還原邏輯照這個形狀寫 |
| `src/core/logger.js` | `export default logger` |

---

## 設計

**單一檔案、具名區段**。API 就三個：

```js
getState(section)              // 回傳副本，沒有就回 {}
setState(section, value)       // 整段覆寫
updateState(section, mutator)  // 讀→改→寫，走佇列
```

區段名由使用者自己約定（`vmute`、`japanese`…），`state.js` 不認識任何業務欄位。這樣 U04 與 U05 可以各自平行開發，不必協調檔案格式。

**用 JSON 檔而不是資料庫**：資料量是「幾筆到幾十筆」的等級，為它在 jail 裡多裝一個服務不划算。

**為什麼不直接沿用 `pollStore` 的一場一檔**：投票會累積上百場、需要歸檔查詢，所以拆檔；state 是少量長期存在的鍵值，拆檔只會讓 `data/` 變亂。

**佇列以 section 為單位**，不同區段的寫入互不阻塞——同一個理由讓 `pollStore` 從「全域一條佇列」改成「一場投票一條」。

**開機還原不放在 `state.js` 裡**。`state.js` 只管存取，「哪些狀態需要重掛排程」由各功能自己在 `ready` 事件註冊。理由是 `state.js` 一旦認識了業務語意，U04 與 U05 就得共同維護同一個檔案。

---

## 復工前先看：工作目錄裡有一份未 commit 的半成品

`src/core/state.js`（104 行）已經存在，但**從來沒有 commit 過**，
是這個單元第一次開工時寫到一半就停擺的。復工時**接著它做，不要重寫**——
它的取捨已經跟本單元的設計對齊了，重寫等於把同樣的判斷再做一次。

它目前的狀態：

| 項目 | 狀況 |
|---|---|
| `dataDir()` / `stateFile()` | 已完成。路徑在呼叫時才解析，測試可用 `STATE_DATA_DIR` 指到暫存資料夾 |
| `readJson()` / `writeJson()` | 已完成。暫存檔 ＋ rename 的原子寫入 |
| 佇列 `enqueue()` | 已完成，**整份檔案共用一條**（不是像 `pollStore` 一場一條）。註解裡寫了理由：所有 section 住在同一個檔案、每次寫入都要重寫整份，分多條佇列會讓兩段的「讀→改→寫」交錯，後寫的蓋掉先寫的 |
| `getState` / `setState` / `updateState` | 已完成 |
| **壞檔備份（03-2）** | **未完成**。`readJson()` 的註解明說「先讓它照原樣往外丟」，要補成 `pollStore.readJson()` 那樣：`ENOENT` 回 null、壞檔備份成 `.broken-<時間>` 再回 null |
| **`ready` 掛鉤（03-3）** | **未完成**，`src/events/ready/index.js` 完全沒碰過 |
| **測試（03-4）** | **未完成**，`tests/state.test.js` 不存在 |

所以實際上 03-1 幾乎做完了，**要做的是 03-2 到 03-5**。第一步請先讀完那個檔案，
把「哪些已經有、哪些還沒有」講給我聽，再開始動手。

## 進度

- [ ] 03-1 `src/core/state.js`：`getState` / `setState` / `updateState` ＋ 原子寫入 ＋ 佇列
- [ ] 03-2 壞檔備份與 `ENOENT` 處理
- [ ] 03-3 `ready` 事件掛上還原掛鉤（`registerRestore(name, fn)` 或直接列舉，實作時決定）
- [ ] 03-4 `tests/state.test.js`
- [ ] 03-5 jail 驗收 ＋ commit

## 驗收

單元測試（`tests/state.test.js`，**不得 import discord.js**）：

1. 寫入後讀得回來；讀不存在的 section 回 `{}`
2. 同一 section 併發 10 次 `updateState` 遞增，結果為 10（沒有互相覆寫）
3. 檔案內容故意寫成壞 JSON → 讀取回 `{}` 且產生 `.broken-*` 備份檔，原檔不被靜默覆蓋
4. 不同 section 的寫入互不影響

實機（測試 jail）：

1. 寫入一段 state → `cat data/state.json` 看得到 → `pm2 restart` 後仍讀得回來
2. 排一個 30 秒後觸發的測試任務 → 中途重啟 bot → 到點仍然觸發

## 決策紀錄

- 2026-08-20　`state.js` 不認識業務欄位，還原邏輯由各功能自理。理由：讓 U04 與 U05 能平行開發。
