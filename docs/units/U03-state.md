# U03　跨重啟狀態 `state.js`

狀態：實作完成，等 jail 驗收（03-5）
進度：5/5
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
| `.gitignore` | ~~`data/` 應該已經在裡面，確認一下~~ 已確認，第 6 行就有，**不需要改** |

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

**佇列是整份檔案共用一條**（規劃時原本寫「以 section 為單位」，實作時推翻，見決策紀錄 2026-08-24）。`pollStore` 能做到一場投票一條，是因為它一場一個檔案；這裡所有 section 住在同一個檔案、每次寫入都要重寫整份，分成多條佇列會讓兩段的「讀→改→寫」交錯，後寫的把先寫的那段蓋掉。

**開機還原的邏輯不放在 `state.js` 裡**，但**登記表放**（實作時的決定，見決策紀錄 2026-08-25）。`state.js` 提供 `registerRestore(name, fn)` / `runRestores(...args)`，只存 `name → fn`，仍然不認識 `vmute`、`japanese` 是什麼；「怎麼重掛排程」由各功能自己寫、自己在模組載入時登記。

```js
registerRestore(name, fn)   // 各功能在自己的模組載入時登記
runRestores(...args)        // ready 事件呼叫一次，逐項跑，單項失敗只記 log
restoreNames()              // 目前登記了哪些(除錯與測試用)
clearRestores()             // 測試用
```

選登記制而不是在 `ready/index.js` 直接列舉，是因為 `ready/index.js` 不在 U04、U05 的檔案領域裡：直接列舉的話兩個單元都得改同一支檔案，正是單元制要避免的撞車。

---

## 交付內容（2026-08-25 完成，停擺復工後接著半成品做完）

| 檔案 | 狀況 |
|---|---|
| `src/core/state.js`（新增，161 行） | `dataDir()` / `stateFile()` 呼叫時才解析，環境變數 `STATE_DATA_DIR` 可指到暫存資料夾；`readJson()`（ENOENT → null、壞檔備份 `.broken-<時間>` → null）／`writeJson()`（`.tmp` ＋ rename 原子寫入）；整份檔案共用一條佇列；`getState` / `setState` / `updateState`；開機還原登記表 |
| `src/events/ready/index.js`（改，+5 行） | 在既有三個開機工作後面加第四個 `safely('還原跨重啟狀態', () => runRestores(c))` |
| `tests/state.test.js`（新增，13 個案例） | 讀寫、併發、壞檔、登記表四組 |
| `.gitignore` | 不需要改，`data/` 本來就在 |

**給後續單元（U04 / U05）的使用方式**：在自己的模組頂層呼叫
`registerRestore('vmute', async (client) => {...})`，`ready` 事件會在開機時跑到，
`client` 由 `runRestores(c)` 傳入。**不需要、也不要再去改 `ready/index.js`。**

**寫測試時**：`state.js` 會 import `@/core/logger`，測試檔一定要
`vi.mock('@/core/logger', ...)` 換成假的——真 logger 會開檔與串流，
在測試 jail 裡會讓 vitest 沒有錯誤訊息地卡住跑不完（`pollStore.test.js` 同一套寫法）。

## 進度

- [x] 03-1 `src/core/state.js`：`getState` / `setState` / `updateState` ＋ 原子寫入 ＋ 佇列
- [x] 03-2 壞檔備份與 `ENOENT` 處理
- [x] 03-3 `ready` 事件掛上還原掛鉤（採登記制 `registerRestore(name, fn)`）
- [x] 03-4 `tests/state.test.js`
- [x] 03-5 commit（jail 驗收指令見下方「驗收」，由使用者代跑）

## 驗收

單元測試（`tests/state.test.js`，**不得 import discord.js**）——四條原訂條件都有對應案例，另補了副本語意、mutator 就地改動、失敗不連累後續、登記表四類：

1. ✔ 寫入後讀得回來；讀不存在的 section 回 `{}`
2. ✔ 同一 section 併發 10 次 `updateState` 遞增，結果為 10（沒有互相覆寫）
3. ✔ 檔案內容故意寫成壞 JSON → 讀取回 `{}` 且產生 `.broken-*` 備份檔，備份內容與原檔逐字相同
4. ✔ 不同 section 的寫入互不影響

jail 指令（使用者代跑）：

```sh
cd /root/BC_djs_bot && /root/update.sh
yarn vitest run tests/state.test.js --no-file-parallelism
yarn vitest run tests/moduleLayout.test.js --no-file-parallelism
pm2 restart bc-test && pm2 logs bc-test --lines 30
```

前兩項預期全綠；`pm2 logs` 預期看到 bot 正常上線、四個開機工作都沒有錯誤
（「還原跨重啟狀態」目前沒有人登記，會安靜通過）。

實機（測試 jail）：

1. 寫入一段 state → `cat data/state.json` 看得到 → `pm2 restart` 後仍讀得回來
   ```sh
   cd /root/BC_djs_bot
   yarn vite-node -e "import('@/core/state').then(s => s.setState('smoke', {at: Date.now()}))"
   cat data/state.json
   pm2 restart bc-test
   yarn vite-node -e "import('@/core/state').then(s => s.getState('smoke')).then(console.log)"
   ```
2. ~~排一個 30 秒後觸發的測試任務 → 中途重啟 bot → 到點仍然觸發~~
   **移交 U04 驗收**：這條需要一個真的會 `registerRestore` 的功能才驗得到，
   U03 本身不提供任何業務功能，重啟後的新行程裡沒有東西會去讀那段 state。
   等 `/vmute` 接上後用它的到期時間一併驗。

## 決策紀錄

- 2026-08-20　`state.js` 不認識業務欄位，還原邏輯由各功能自理。理由：讓 U04 與 U05 能平行開發。
- 2026-08-24　佇列改成整份檔案共用一條，推翻設計段原本的「以 section 為單位」。理由：所有 section 共用同一個 JSON 檔、每次寫入都要重寫整份，分成多條佇列時兩段的「讀→改→寫」會交錯，後寫的把先寫的那段整段蓋掉——正好會讓驗收條件 4 失敗。資料量是幾十筆、寫入頻率極低，序列化的代價可以忽略。
- 2026-08-25　非 `ENOENT` 的讀取錯誤一律當成壞檔處理（含 `EACCES` 這種檔案其實沒壞的情況），不細分。理由：與 `pollStore.readJson()` 保持同一套錯誤處理比較好維護；真的是權限問題時 rename 也會失敗，原檔還在原地，`.broken-*` 不會產生。
- 2026-08-25　03-3 採登記制 `registerRestore(name, fn)`，登記表放在 `state.js` 裡，而不是在 `ready/index.js` 直接列舉。理由：`ready/index.js` 不在 U04、U05 的檔案領域內，直接列舉會讓兩個單元同時卡在同一支檔案上。登記表只存 `name → fn`，`state.js` 仍然不認識任何業務欄位，與 2026-08-20 那條不衝突。
- 2026-08-25　實機驗收第 2 條（30 秒任務跨重啟）移交 U04。理由：需要一個真的會登記還原的功能才驗得到，U03 沒有業務功能，臨時腳本在重啟後的新行程裡沒有東西會去讀那段 state。
- 2026-08-25　`getState` 沒有記憶體快取，每次重新從檔案 parse。理由：回傳值天然就是副本，呼叫端改它不會影響檔案，也省掉快取失效；資料量小，重讀的成本可以忽略。
