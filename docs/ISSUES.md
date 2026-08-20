# BC_djs_bot 問題清單

盤點日期：2026-08-13
盤點範圍：`src/**`、`package.json`、`vite.config.js`、`.env`（僅鍵名）

> **這是 2026-08-13 的盤點快照，不是主線計畫。** 主線在 `docs/PLAN.md` 的單元總表。
> 下面各條的內文**維持當初的原文沒有改寫**，現況一律以這張表為準（2026-08-20 核對過原始碼）。

## 結案狀態（2026-08-20）

| 編號 | 現況 | 依據 |
|---|---|---|
| C-01 `/ask` 必定崩潰 | ✅ 已解決 | 指令整個移除（`524d720`） |
| C-02 事件內未 await | ✅ 已解決 | `Message_listening` 全面 await ＋ try/catch；兩個 Role 事件改用 `core/roleGrant.js`（`726e3bd`、`c97ac41`） |
| C-03 catch 自己爆炸 | ✅ 已解決 | 改用 `roleGrant.js` 的 `notifyAdmin()`，自帶 try/catch |
| C-04 開機競態 | ✅ 已解決 | `interactionCreate` 第 47-56 行擋掉。**但 `main.js` 的 `loadCommands()` 仍未 await → U01** |
| C-05 已刪除的指令 | ✅ 已解決 | `interactionCreate` 第 58-66 行 |
| C-06 缺 `client.on('error')` | ✅ 已解決 | `main.js` 已監聽 error / shardError / shardDisconnect / shardReconnecting / warn |
| C-07 無行程層級保護 | 🟡 部分 | handler 與檔案 log 都有了；**`uncaughtException` 仍是「記錄後繼續跑」，改為 exit 是 U01** |
| F-01 partial 未 fetch | ✅ 已解決 | `roleGrant.js` |
| F-02 未快取成員 | ✅ 已解決 | `roleGrant.js` 改用 `members.fetch()` |
| F-03 `🏕️` 變體選擇符 | ✅ 已解決 | `config/index.js` 的 `normalizeEmoji()` |
| F-04 關鍵字順序遮蔽 | ⬜ 未處理 | 判定為刻意設計，不修 |
| M-01 每次啟動重註冊指令 | ⬜ **U01** | |
| M-02 store 鍵名拼錯 ＋ Vue/Pinia | ⬜ **U02** | |
| M-03 Role 對照表重複兩份 | ✅ 已解決 | 合併進 `config/environments/` |
| M-04 錯誤訊息文字錯誤 | ✅ 已解決 | 隨 M-03 一起 |
| M-05 相對路徑掃檔依賴 CWD | 🟡 部分 | `logger` / `pollStore` / `selfRoles` 都改用 `import.meta.url` 了；**`loader.js` 仍是相對路徑 → U01** |
| M-06 未使用的匯入 | 🟡 部分 | 大多隨改版消失；`main.js` 的 `Events`/`Message`、`store/app.js` 的 `GatewayIntentBits` 還在 → U02 |
| M-07 除錯輸出與死碼 | 🟡 部分 | `loader.js` 第 46 行的 `console.log` 還在 → U01 |
| M-08 缺自動重啟 | ✅ 已解決 | 兩個 jail 都以 pm2 運行 |
| E-01 `yarn dev` 無 supervisor | ✅ 已解決 | 同 M-08 |
| E-02 用 `vite-node` 跑正式站 | ⬜ 不修 | `@/` 別名靠它，換掉要先處理別名。目前沒有 OOM 跡象 |
| E-03 手動複製部署 | ✅ 已解決 | 兩個 jail 都改為 git clone，見 `docs/DEPLOY.md` |
| E-04 `.env` 無測試隔離 | ✅ 已解決 | 測試 jail ＋ 測試伺服器 ＋ 各自的 `.env` |

## 環境

| 項目 | 開發機（本次掃描環境） | 正式站 |
|---|---|---|
| 位置 | Windows 11，SMB 共用目錄 | TrueNAS jail |
| 部署方式 | — | 手動複製原始碼過去 |
| 相依套件 | 已安裝於工作目錄 | 依 `package.json` + `yarn.lock` 於 jail 內安裝 |
| Node 版本 | v22.15.1 | **v24.14.1**（2026-08-17 確認，早期紀錄的 v20 已過時） |
| discord.js | 14.13.0 | 依 yarn.lock 解析 |
| 啟動指令 | `npm run dev` | `yarn dev`（= `vite-node src/main.js`） |
| 行程管理 | 無 | **無**（未使用 pm2 或任何 supervisor） |
| `.env` 指向 | — | **正式站** |

已確認事項（Phase 0）：
- 正式站原始碼與此工作目錄一致（直接複製）
- `.env` 為正式站設定，非測試站
- Node 20 與 Node 22 在本清單相關的行為上一致：`--unhandled-rejections=throw` 自 Node 15 起即為預設，**未處理的 Promise rejection 一樣會終止行程**，故 C-01～C-05 的推論不受版本差異影響

> 重要前提：Node 22 預設 `--unhandled-rejections=throw`。
> **任何未被處理的 Promise rejection 都會直接終止行程。**
> 本專案大量出現「呼叫 Discord API 但不 await」的寫法，這是崩潰的主要機制。

---

## 嚴重度定義

| 標記 | 意義 |
|---|---|
| P0 | 會導致行程終止（bot 直接下線） |
| P1 | 功能靜默失效，使用者感受得到 |
| P2 | 可維護性 / 效能 / 整潔，不影響當前行為 |

---

## P0 — 會讓 bot 掛掉

### ~~C-01　`/ask` 指令必定崩潰~~（2026-08-19 已解決：指令整個移除）
- 位置：`src/commands/ask/index.js:19`（檔案已刪除）
- 現況：`await ctx.reply({question})`
- 問題：`reply()` 需要字串或 `{content, embeds, ...}`。`{question: "..."}` 不含 `content`，Discord 回 `50006 Cannot send an empty message`。`src/events/interactionCreate/index.js` 沒有 try/catch，rejection 冒到頂層 → 行程終止。
- 附帶：`question` 為 `setRequired(true)`，永遠不為 null，第 22 行的 `else` 分支是死碼；第 17 行的 `row` 建了但沒用。
- 信心：高（純程式碼推導，可在測試伺服器一次重現）

### C-02　事件處理器內的 Discord API 呼叫未 await
- 位置：
  - `src/events/Message_listening/index.js`（全檔，所有 `message.channel.send()` / `message.react()`）
  - `src/events/Role_Add_Emoji/index.js:22,27,32,...`（`guildMember.roles.add(role)`）
  - `src/events/Role_Remove_Emoji/index.js:18,23,28,...`（`guildMember.roles.remove(role)`）
- 問題：未 await 的 Promise 若 reject，**不會被外層 try/catch 攔截**，直接成為未處理 rejection → 行程終止。
- 觸發情境：
  - `50013 Missing Permissions`（bot 身分組低於目標身分組 / 該頻道無發言或加反應權限）
  - `10008 Unknown Message`（原訊息在反應送出前被刪除）
  - 429 rate limit
- 附帶：`Message_listening` 全檔完全沒有 try/catch。
- 信心：高

### C-03　catch 區塊本身會二次拋錯
- 位置：`src/events/Role_Add_Emoji/index.js:79`、`src/events/Role_Remove_Emoji/index.js:75`
- 現況：`reaction.message.guild.channels.cache.get(process.env.AdminChannel_ID).send('...')`
- 問題：三個風險疊加 —
  1. `reaction.message.guild` 在 partial 訊息時可能為 `null`
  2. `channels.cache.get()` 在頻道未快取時回 `undefined`
  3. `.send()` 沒有 await
  任一發生就在 catch 內拋錯，此時已無人接手 → 行程終止。
- 結論：**錯誤回報機制本身就是崩潰來源**，很可能是「時不時報錯就停」的主因之一。
- 信心：高

### C-04　開機競態：commandActionMap 可能為 null
- 位置：`src/main.js:12`（`loadCommands()` 未 await，且在 `appStore.client = client` 之前呼叫）
- 問題：`loadCommands()` 是 async。若在它把 `commandActionMap` 寫入之前就有人下斜線指令，`src/events/interactionCreate/index.js:11` 會對 `null` 呼叫 `.get()` → TypeError → 無 try/catch → 行程終止。
- 附帶：`loadEvents()` 同樣未 await。
- 信心：中（時間窗短，但 bot 剛上線時最容易被觸發）

### C-05　已刪除／過期的斜線指令
- 位置：`src/events/interactionCreate/index.js:11-12`
- 問題：若某指令曾註冊過、之後資料夾被移除，Discord 端仍保留該指令。使用者點擊 → `commandActionMap.get(name)` 回 `undefined` → `action is not a function` → 無 try/catch → 行程終止。
- 信心：中

### C-06　缺少 `client.on('error')`
- 位置：`src/main.js`
- 問題：discord.js 的 `Client` 繼承 EventEmitter。WebSocket 斷線等情況會 emit `'error'`，若無監聽器，Node 會直接 throw。
- 補充：`shardError`、`shardDisconnect` 也應監聽。
- 特徵：符合「不定時、看似無規律」的崩潰模式。
- 信心：中

### C-07　完全沒有行程層級的保護與紀錄
- 位置：`src/main.js`
- 問題：沒有 `process.on('unhandledRejection')`、`process.on('uncaughtException')`，也沒有任何檔案 log。崩潰後零線索，無法回溯是 C-01～C-06 的哪一種。
- 影響：這是排查的最大障礙，應優先處理。

---

## P1 — 功能靜默失效

### F-01　舊訊息的反應收不到（partial 未 fetch）
- 位置：`src/events/Role_Add_Emoji/index.js:13`、`src/events/Role_Remove_Emoji/index.js:10`
- 現況：`if(!reaction.message.guild) return;`
- 問題：已啟用 `Partials.Message / Reaction`。bot 重啟後，對「未快取的舊訊息」（身分組公告訊息幾乎必然是舊訊息）收到的是 partial 物件，`reaction.message.guild` 為 `null` → 直接 return，**靜默不給身分組，也不報錯**。
- 正解：先 `await reaction.fetch()` / `await reaction.message.fetch()` 再判斷。
- 信心：高

### F-02　未快取成員取不到 GuildMember
- 位置：`src/events/Role_Add_Emoji/index.js:18`、`src/events/Role_Remove_Emoji/index.js:14`
- 現況：`guild.members.cache.get(user.id)`
- 問題：成員未在快取中時回 `undefined`，接著 `guildMember.roles.add()` → TypeError → 走進 C-03 的爆炸 catch。
- 正解：`await guild.members.fetch(user.id)`。
- 信心：高

### F-03　`🏕️` 變體選擇符比對風險
- 位置：兩個 Role 檔的 `case '🏕️'`
- 問題：字面值含 U+FE0F（VS16）。若原訊息上的反應是不含 VS16 的 `🏕`，`switch` 不會命中。
- 正解：比對前對 emoji name 做 VS16 正規化。
- 信心：中（需實際比對該訊息上的反應才能確認）

### F-04　字元偵測的順序遮蔽
- 位置：`src/events/Message_listening/index.js`
- 問題：規則由上而下、命中即 `return`，且「機率沒過」也會 return，不會往下比對。實際後果：
  - 規則 3（含 `確`）遮蔽了規則 13/14 之前所有含「確」的訊息
  - 規則 13（含 `可`）在規則 15（含 `要不要`）之前 → 「可以要不要」不會走 15
  - 「笑死吧」有 1/2 機率完全靜默，不會退回規則 14
- 註：這可能是刻意設計。列出供確認，非必修。

---

## P2 — 可維護性 / 整潔

### M-01　每次啟動都重新註冊斜線指令
- 位置：`src/core/loader.js:40-42`
- 問題：無條件 `PUT applicationGuildCommands`。加上自動重啟後，crash loop 會反覆打同一端點，容易吃到 429。
- 建議：拆出獨立的 `npm run deploy` 腳本手動執行；並加 payload 雜湊護欄（`.commands-hash.json`），內容未變就跳過。

### M-02　store 鍵名拼錯 + 過重的 Vue/Pinia
- 位置：`src/store/app.js:6-7`、`src/core/vue.js`
- 問題：
  - state 宣告 `clint` / `commandsActionMap`，實際使用 `client` / `commandActionMap`（**已實測驗證**：Pinia 允許寫入未宣告鍵且讀得回來，`$state` 內僅有 `clint`、`commandsActionMap` 兩個鍵 → 不會崩潰，但資料脫離 state 管理）
  - `useAppStroe` 拼字錯誤（應為 Store）
  - `src/core/vue.js` 建了 `createApp()` 卻從不掛載，只為存兩個全域變數就引入 vue + pinia
- 建議：改為一般 ES module 單例物件，移除 vue / pinia 相依。

### M-03　Role 對照表重複兩份、硬編碼
- 位置：`src/events/Role_Add_Emoji/index.js`、`src/events/Role_Remove_Emoji/index.js`
- 問題：10 組 emoji→roleId 完全重複兩份，只差 `add` / `remove`。新增身分組要改兩個地方。
- 建議：抽成 `src/config/roleMap.js` 單一設定表 + 共用 handler。

### M-04　錯誤訊息文字錯誤
- 位置：`src/events/Role_Remove_Emoji/index.js:75`
- 現況：訊息寫 `Role_add by emoji`，應為 `Role_remove`。複製貼上遺留。

### M-05　相對路徑掃檔依賴 CWD
- 位置：`src/core/loader.js:29`、`src/core/loader.js:52`
- 問題：`fg('./src/commands/**/index.js')` 相對於當前工作目錄。從其他目錄啟動（例如 pm2 未設 `cwd`）會掃不到任何檔案，且**不會報錯**，只是沒有任何指令與事件被載入。
- 建議：以 `import.meta.url` 推導絕對路徑。

### M-06　未使用的匯入
| 檔案 | 未使用 |
|---|---|
| `src/main.js:2` | `Events`、`Message` |
| `src/core/loader.js:2` | `{ async }` |
| `src/events/Message_listening/index.js:1` | `GatewayIntentBits` |
| `src/events/Role_Add_Emoji/index.js:1` | `Client` |
| `src/events/Role_Remove_Emoji/index.js:1` | `Client` |
| `src/store/app.js:1` | `GatewayIntentBits` |

### M-07　殘留的除錯輸出與死碼
- `src/core/loader.js:46`：`console.log(appStroe.commandActionMap)` 每次啟動印出整個 Collection
- `src/events/Message_listening/index.js:140`：空的 `roll` function，未被呼叫
- `src/events/Message_listening/index.js:127-138`：大段註解掉的舊邏輯
- `src/events/ready/index.js:6`：`type: ActivityType.Playing` 寫在 `event` 物件裡，但 `loader.js` 只讀 `event.name` 與 `event.once`，此欄位從未被使用

### M-08　缺少自動重啟機制
- 現況：崩潰後需人工重啟。
- 建議：Windows 環境用 pm2，並設定 backoff 重啟延遲，避免 crash loop 打爆指令註冊 API（與 M-01 相關）。

---

---

## E — 環境與部署（Phase 0 後新增）

> 這一組與程式碼無關。「時不時停止」不必然是 C-01～C-06 造成的，
> 以下任一項都會讓 bot 消失，且**完全不留任何錯誤訊息** — 這正符合使用者描述的症狀。
> 必須與 P0 並行排查，不能只看程式碼。

### E-01　`yarn dev` 為前景行程，無 supervisor　【P0】
- 現況：TrueNAS jail 內以 `yarn dev` 啟動，未使用 pm2 或任何行程管理工具。
- 問題：只要行程的父 session 消失，bot 就跟著消失：
  - SSH 連線中斷 / terminal 關閉 → 收到 SIGHUP → 行程終止
  - jail 重啟、TrueNAS 重開機、系統更新 → 不會自動拉起
  - 任何原因終止後，**沒有任何機制重啟**
- 關鍵特徵：這種終止**不會產生錯誤訊息**，也不會有堆疊。若你的印象是「有時候看到報錯、有時候就是無聲無息不見了」，無聲無息的那些很可能是這一項。
- 待確認：目前是否有搭配 tmux / screen / nohup / `&` 背景執行？（見下方「待確認事項」）
- 信心：高（機制確定，是否為實際主因待確認）

### E-02　用開發用 runner 跑正式站　【P1】
- 現況：正式站執行 `vite-node src/main.js`。
- 問題：`vite-node` 是開發用執行器，會在記憶體中常駐 Vite 的模組轉換管線與 esbuild。相較於直接 `node`，記憶體占用明顯較高，且並非設計給長時間運行的正式服務。
- 風險：在有記憶體上限的 jail 中，長時間運行後被 OOM killer 終止 — 同樣**不留任何應用層錯誤訊息**，只會在 jail / host 的系統日誌留下紀錄。
- 排查方向：查 jail 的記憶體上限與系統日誌是否有 OOM 紀錄；長期則考慮改用原生 `node` 執行（見 PLAN.md Phase 5 選配）。
- 信心：中（機制成立，需實機資料佐證）

### E-03　手動複製部署，無版本追蹤　【P2】
- 現況：正式站原始碼靠手動複製，jail 內無 git。
- 問題：無法確認正式站當下跑的是哪個 commit；出事時難以回滾；本次雖確認一致，但下次修改後同樣的不確定性會再出現。
- 建議：Phase 3 起每階段都建立 commit，部署時記錄 commit hash（可寫入 log 的啟動訊息中）。

### E-04　`.env` 為正式站，無測試環境隔離　【P2】
- 現況：開發與正式共用同一組正式站設定；`.env` 內測試站設定被註解掉。
- 問題：任何驗收動作（例如觸發 `/ask` 確認崩潰）都會直接影響正式伺服器的使用者。
- 建議：啟用被註解掉的測試站設定，Phase 3、4 的驗收在測試站進行。

---

## 尚未驗證、需要實機確認的項目

以下為靜態分析得出的推論，尚未在真實環境重現。修復 C-07（加上 log）之後即可對照確認：

1. C-01 是否為實際發生過的崩潰之一（需確認是否有人使用過 `/ask`）
2. C-02 中具體是哪一種錯誤碼在觸發（50013 / 10008 / 429）
3. F-03 的 `🏕️` 是否實際比對失敗（需檢查該訊息上實際的反應字元）
4. ~~目前線上執行的版本是否與此工作目錄一致~~ → **Phase 0 已確認一致**
5. E-01：`yarn dev` 目前是如何維持運行的？（前景 / tmux / screen / nohup / 背景 `&`）
6. E-02：jail 的記憶體上限為何？系統日誌中是否有 OOM 紀錄？
7. 「時不時報錯而停止」中，**有錯誤訊息**與**無聲消失**各占多少？這是區分 C 組（程式碼）與 E 組（環境）的關鍵
