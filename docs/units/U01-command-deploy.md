# U01　指令部署分離

狀態：未開始
進度：0/7
依賴：無
可平行：**不可與 U02 同時進行**（兩者都改 `src/main.js`、`src/core/loader.js`）
分支：`unit/U01-command-deploy`
來源：`docs/ISSUES.md` 的 M-01、M-05、C-07

---

## 目標

把「向 Discord 註冊斜線指令」從 bot 啟動流程拆成獨立的部署步驟，讓指令表建不起來的錯誤在部署當下就爆出來，而不是等使用者發現指令消失。

## 為什麼要做

2026-08-18 發生過一次（commit `6400626`）：`src/commands/poll/index.js` 有語法錯誤，bot 照常連線、`ready` 也正常，只有指令表默默建不起來，畫面上只看得到「機器人還在啟動中」。因為註冊是啟動流程的一部分，失敗被 `loadCommands()` 的 rejection 吞掉了。

指令目前有 8 個資料夾（`help`、`poll`、`poll-admin`、`quickpoll`、`role-panel`、`selfrole`、`sip`），每次重啟都無條件打一次 `PUT applicationGuildCommands`。搭配 pm2 的自動重啟，crash loop 會反覆打同一個端點，容易吃到 429。

---

## 相關檔案

**要改的：**

| 檔案 | 現況 | 要改成 |
|---|---|---|
| `src/core/loader.js`（78 行） | `loadCommands()` 掃 `./src/commands/**/index.js`、組出 `commands` 陣列、**對每個 guild 呼叫 `updateSlashCommands()` 打 REST**、再把 `commandActionMap` / `commandList` 寫進 store。第 46 行還有一句 `console.log(appStroe.commandActionMap)` 每次啟動印出整個 Collection | 拆成兩個 export：`collectCommands()` 只回傳 `{commands, actions}` 純資料（給部署腳本用），`loadCommands()` 只建對照表不碰 REST。掃檔路徑改用 `import.meta.url` 推導絕對路徑。刪掉那句 `console.log` |
| `src/main.js`（84 行） | 第 41 行 `loadCommands()` **沒有 await**；第 18 行 `uncaughtException` 是「記錄後繼續跑」 | `await loadCommands()`；`uncaughtException` 改為記錄後 `process.exit(1)` 交給 pm2 重啟 |
| `package.json` | 只有 `dev` 與 `test` | 加 `"deploy": "vite-node src/scripts/deploy-commands.js"` |
| `.gitignore` | `.commands-hash.json` **已經在裡面了**，不用再加 | — |

**要新增的：**

- `src/scripts/deploy-commands.js` — 讀 `collectCommands()`、算 payload 的 SHA-256、與 `.commands-hash.json` 比對，相同就印「內容未變、跳過」直接結束；不同才 `rest.put`，成功後寫回雜湊。結束時要 `process.exit(0)`（`vite-node` 不會自己結束）。

**只讀、不要改：**

| 檔案 | 你需要知道的事 |
|---|---|
| `src/config/index.js`（96 行） | `export default config`，提供 `config.applicationId`、`config.guildIds`（陣列）、`config.roles`、`config.channels`。依 `.env` 的 `BOT_ENV` 選 `environments/production.js` 或 `environments/test.js`，預設 production。載入時會自己呼叫 `dotenv.config()` |
| `src/store/app.js` | Pinia store，欄位 `client` / `commandActionMap` / `commandList`。**U02 會把它換成一般物件，本單元不要動它** |
| `src/events/interactionCreate/index.js`（第 47-68 行） | 已經處理好「指令表還沒建好」與「未知指令」兩種情況（ISSUES.md 的 C-04、C-05），本單元不需要再補 |
| `src/commands/help/index.js` | 讀 `appStroe.commandList` 列出指令，所以 `loadCommands()` 仍然必須填這個欄位 |
| `src/core/logger.js`（73 行） | `export default logger`，方法 `info` / `warn` / `error`。同時寫 console 與 `logs/YYYY-MM-DD.log` |
| `src/core/pollStore.js`（第 1-8 行） | **絕對路徑的正確寫法照抄這裡**：`path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')` |

---

## 設計

**雜湊護欄**：把 `JSON.stringify(commands.map(c => c.toJSON()))` 做 SHA-256（用 `node:crypto`），存進專案根目錄的 `.commands-hash.json`。內容沒變就跳過 PUT。這一層的價值在於部署腳本可以無腦每次都跑，不必人工判斷「這次有沒有改到指令」。

**掃檔路徑**：`fast-glob` 即使在 Windows 上也**只吃正斜線**，用 `import.meta.url` 推出來的路徑要先 `.replace(/\\/g, '/')` 再丟給 `fg()`。編輯機是 Windows、執行環境是 FreeBSD，這一步漏掉會在其中一邊靜默掃不到檔。

**`uncaughtException` 改為 exit**：pm2 早就在兩個 jail 上運行了（`docs/ENVIRONMENTS.md`）。繼續跑的策略是當初沒有 supervisor 時的權宜之計，現在留著只會讓 bot 停在半死不活的狀態。`unhandledRejection` 維持只記錄不退出。

---

## 進度

- [ ] 01-1 `loader.js` 拆出 `collectCommands()`，`loadCommands()` 不再打 REST
- [ ] 01-2 `loader.js` 掃檔改為 `import.meta.url` 絕對路徑（M-05），刪除 `console.log`
- [ ] 01-3 `src/scripts/deploy-commands.js` ＋ `yarn deploy`
- [ ] 01-4 `.commands-hash.json` 雜湊護欄 ＋ `.gitignore`
- [ ] 01-5 `main.js` `await loadCommands()`
- [ ] 01-6 `main.js` `uncaughtException` 改為 exit(1)
- [ ] 01-7 jail 驗收 ＋ commit

## 驗收

單元測試（`tests/`，不得 import discord.js）：

1. 雜湊函式對同一份 payload 兩次呼叫結果相同、改動任一指令名稱後結果不同

實機（測試 jail，指令請使用者代跑）：

1. `yarn deploy` → 指令正確註冊，輸出列出指令數量與 guild
2. 立刻再跑一次 `yarn deploy` → 顯示「內容未變、跳過」，沒有發出 REST
3. 故意把某個指令檔改壞（例如少一個括號）→ `yarn deploy` **當場失敗並印出錯誤**，不是靜默跳過
4. `pm2 restart` → 啟動 log 裡沒有指令註冊相關訊息，斜線指令仍可正常使用
5. 在 jail 內 `kill -9` bot 行程 → pm2 自動拉起

## 決策紀錄

- 2026-08-20　`uncaughtException` 改為 exit。理由：pm2 已在運行，繼續跑會讓 bot 停在不確定狀態。
- 2026-08-20　C-04／C-05 不列入本單元。理由：`interactionCreate` 已經處理完畢，實際只剩 `main.js` 那個沒 await 的呼叫。
