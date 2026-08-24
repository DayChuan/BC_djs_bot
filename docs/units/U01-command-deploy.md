# U01　指令部署分離

狀態：程式碼完成，待測試 jail 驗收（2026-08-24）
進度：7/7（01-7 的實機驗收待使用者代跑）
依賴：無
可平行：**不可與 U02 同時進行**（兩者都改 `src/main.js`、`src/core/loader.js`）
分支：**留在 `test`，不要開分支**（見 CLAUDE.md 的單元制第 2 條）
來源：`docs/ISSUES.md` 的 M-01、M-05、C-07

---

## 目標

把「向 Discord 註冊斜線指令」從 bot 啟動流程拆成獨立的部署步驟，讓指令表建不起來的錯誤在部署當下就爆出來，而不是等使用者發現指令消失。

## 為什麼要做

2026-08-18 發生過一次（commit `6400626`）：`src/commands/poll/index.js` 有語法錯誤，bot 照常連線、`ready` 也正常，只有指令表默默建不起來，畫面上只看得到「機器人還在啟動中」。因為註冊是啟動流程的一部分，失敗被 `loadCommands()` 的 rejection 吞掉了。

指令目前有 8 個資料夾（`help`、`poll`、`poll-admin`、`quickpoll`、`role-panel`、`selfrole`、`sip`），每次重啟都無條件打一次 `PUT applicationGuildCommands`。搭配 pm2 的自動重啟，crash loop 會反覆打同一個端點，容易吃到 429。

---

## 相關檔案

> **2026-08-21 已經先做掉一部分**（因為它擋在正式站部署路徑上）：
> `loadCommands()` 現在**先建好 `commandActionMap` 再去打 REST**，而且每個 guild 各自 try/catch，
> 單一伺服器註冊失敗不會再讓整組指令失效。另外多了一行「指令載入完成：N 個指令，M 個伺服器」。
> **本單元要在這個現況上繼續做**，不要把那段改回去。

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

- [x] 01-1 `loader.js` 拆出 `collectCommands()`，`loadCommands()` 不再打 REST
- [x] 01-2 `loader.js` 掃檔改為 `import.meta.url` 絕對路徑（M-05），刪除 `console.log`
- [x] 01-3 `src/scripts/deploy-commands.js` ＋ `yarn deploy`
- [x] 01-4 `.commands-hash.json` 雜湊護欄 ＋ `.gitignore`
- [x] 01-5 `main.js` `await loadCommands()`
- [x] 01-6 `main.js` `uncaughtException` 改為 exit(1)
- [x] 01-7 jail 驗收 ＋ commit

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
- 2026-08-24　新增 `src/scripts/commandsHash.js`（本單元原本只宣告 `deploy-commands.js`）。
  理由：驗收要求「雜湊函式的單元測試」，但測試檔不得直接或間接 import discord.js，
  而 `deploy-commands.js` 會 import `REST`。把純計算切成獨立模組才測得到。
- 2026-08-24　雜湊輸入納入 `applicationId` 與排序後的 `guildIds`，不只算指令內容。
  理由：只算內容的話，日後在 config 新增一個伺服器時雜湊相同、部署被判定跳過，
  那個新伺服器永遠註冊不到指令。排序是因為順序改變不代表目標改變。
- 2026-08-24　`deploy-commands.js` 加 `--force` 旗標。
  理由：`.commands-hash.json` 不進版控，記的是「這台機器上次成功推了什麼」，
  不是 Discord 端的真實狀態。兩者不一致時（有人在後台動過、換機器）需要一個強制出口。
- 2026-08-24　雜湊只在**所有 guild 都成功**之後才寫回，中途失敗直接 throw。
  理由：避免「推失敗卻被記成已完成」，下次執行才會重推。
- 2026-08-24　`updateSlashCommands()` 從 `loader.js` 整個刪掉，REST 只留在部署腳本。
  理由：留在 loader 會變成沒有呼叫者的死碼，而部署腳本本來就要自己管 token 與 exit code。
- 2026-08-24　`main.js` 的 `loadCommands()` 失敗時 `exit(1)`，不是只記錄。
  理由：指令表建不起來的 bot 沒有存在意義，正是 2026-08-18 那次「連線正常但按了沒反應」的狀態。

## 實作結果與單元檔的差異（2026-08-24 補記）

寫的時候發現單元檔與現況對不上的地方，一併更正，下一個人不用再查一次：

1. **`console.log(appStroe.commandActionMap)` 早就不存在了**，應該是 2026-08-21 那次先做的修正
   一併拿掉的。所以 01-2 實際上只做了「掃檔路徑改絕對路徑」。
2. **`loader.js` 是 86 行不是 78 行**（同樣是 08-21 那次加了註解與 try/catch）。改完後 73 行。
3. **`loadEvents()` 的掃檔路徑也一起改成絕對路徑**。單元檔只寫了 commands，
   但 M-05 的病因（相對路徑 + 依賴啟動目錄）兩邊一模一樣，只改一半沒有意義。
4. **`loader.js` 第 2 行原本是 `import fg, { async } from 'fast-glob'`**，
   `{ async }` 是不存在的具名匯入（fast-glob 沒有這個 export，只是 ESM 沒報錯而已），
   已一併移除。
5. **`main.js` 第 84 行的 `loadEvents()` 同樣沒有 await**，本單元沒有宣告要改，所以沒動。
   它的失敗模式比 `loadCommands()` 輕（事件掛不上，但不是全部指令死掉），
   留給後續單元處理。
6. **`docs/DEPLOY.md` 需要補上 `yarn deploy` 這個步驟**，但它不在本單元宣告的檔案領域內，
   沒有動。推版流程現在是：commit → push → jail `update.sh` → **`yarn deploy`** → `pm2 restart`。

### 檔案領域最終清單

改：`src/core/loader.js`、`src/main.js`、`package.json`
新增：`src/scripts/deploy-commands.js`、`src/scripts/commandsHash.js`、`tests/commandsHash.test.js`
沒動：`.gitignore`（`.commands-hash.json` 本來就在）、`src/store/app.js`、`src/events/interactionCreate/index.js`
