# U02　拔掉 Vue／Pinia

狀態：完成（2026-08-24 測試 jail 驗收通過）
進度：5/5
依賴：U01（同樣改 `main.js` 與 `loader.js`，等 U01 併回 `test` 再開工）
可平行：**不可與 U01 同時進行**
分支：**留在 `test`，不要開分支**（見 CLAUDE.md 的單元制第 2 條）
來源：`docs/ISSUES.md` 的 M-02、M-06

---

## 目標

把 `src/store/app.js` 從 Pinia store 換成一般的 ES module 單例物件，移除 `vue` 與 `pinia` 兩個相依套件，順手修掉一路沿用下來的拼字錯誤。

## 為什麼要做

`src/core/vue.js` 建了 `createApp()` 卻**從來沒有掛載**，整個 Vue 執行期只是為了讓 Pinia 能被初始化，而 Pinia 只用來存兩個全域變數。bot 是純後端行程，這兩個套件完全用不到，卻每次啟動都在初始化。

另外 `src/store/app.js` 的 state 宣告的鍵是 `commandsActionMap`，實際使用的是 `commandActionMap`（少一個 s）。Pinia 允許寫入未宣告的鍵而且讀得回來，所以不會壞，但那個欄位其實已經脫離 state 管理。換成一般物件之後這種寫法就不會再有模糊地帶。

---

## 相關檔案

**要改的（六個檔案，全部只是換 import 與呼叫方式）：**

| 檔案 | 現況 | 要改成 |
|---|---|---|
| `src/store/app.js`（13 行） | `export const useAppStroe = defineStore('app', {...})`，state 有 `client` / `commandsActionMap`（拼錯） / `commandList`。第 1 行還 import 了沒用到的 `GatewayIntentBits` | `export const appStore = {client: null, commandActionMap: null, commandList: null}`，不 import 任何東西 |
| `src/core/vue.js`（10 行） | 建 `createApp()` 與 `createPinia()`，從不掛載 | **整個檔案刪除** |
| `src/main.js` | 第 4 行 `import vueInit`、第 37 行 `vueInit()`、第 6 行 import store、第 58 行 `const appStore = useAppStroe()`。第 2 行還 import 了沒用到的 `Events`、`Message` | 刪掉 vue 相關三處；改成 `import {appStore} from '@/store/app'`，直接 `appStore.client = client`。順手刪掉沒用到的 import |
| `src/core/loader.js` | 第 3、28、51 行 | 同上，`const appStroe = useAppStroe()` 整行刪除，直接用 `appStore.xxx` |
| `src/events/interactionCreate/index.js` | 第 2、48 行 | 同上 |
| `src/commands/help/index.js` | 第 2、13 行 | 同上 |
| `package.json` | dependencies 有 `pinia`、`vue` | 移除這兩項。**`vite-node` 必須保留**——`@/` 別名靠它，不能直接用 `node` 跑 |
| `tests/moduleLayout.test.js` | 靜態檢查 | 加一條：`src/` 底下不得出現 `from 'vue'` 或 `from 'pinia'` |

**只讀：**

| 檔案 | 你需要知道的事 |
|---|---|
| `vite.config.js` | `@/` 別名的定義；`test.fileParallelism: false` 與 `server.deps.external: ['discord.js']` 是測試 jail 的必要繞道，**不要動** |
| `src/core/logger.js` | `export default logger`，`info` / `warn` / `error` |

---

## 設計

**單例就是一個匯出的物件字面值**，不做 getter/setter、不做 class。理由是它只有三個欄位、只在啟動時寫一次，任何額外結構都是為了不存在的需求而加。

**拼字一次改到位**：`useAppStroe` → 不再存在，`commandsActionMap` → `commandActionMap`。全專案只有六個檔案引用，用 grep 確認沒有漏網之魚：

```
grep -rn "useAppStroe\|commandsActionMap\|core/vue" src tests
```

改完這個指令必須是零結果。

**yarn.lock**：移除相依後 `yarn install` 會重算 lock。jail 端的 `update.sh` 只在 `package.json` / `yarn.lock` 有變動時才重裝，所以這次部署一定會觸發重裝，這是預期行為。

---

## 進度

- [x] 02-1 `src/store/app.js` 改為一般單例物件
- [x] 02-2 四個引用點全部改掉，刪除 `src/core/vue.js`
- [x] 02-3 `package.json` 移除 `vue`、`pinia`
- [x] 02-4 `moduleLayout.test.js` 加上禁止 import vue/pinia 的靜態檢查
- [x] 02-5 jail 驗收 ＋ 補 `yarn.lock`

## 驗收

單元測試：

1. `yarn test` 全數通過，含新增的靜態檢查

實機（測試 jail）：

1. `yarn install` 後 `node_modules` 內不再有 `vue` 與 `pinia`
2. bot 啟動正常，log 有 `Ready!`
3. `/help` 列得出指令（這條驗的是 `commandList` 有被正確填入）
4. 隨便下一個斜線指令有反應（驗 `commandActionMap`）
5. 對身分組訊息加反應仍然正確發放身分組

## 驗收結果（2026-08-24，測試 jail `DiscordBot-Test`）

程式碼 commit：`953d0c3`（9 files changed, +59 / −53，含刪除 `src/core/vue.js`）。
`yarn.lock` 依下面「lock 分兩次處理」的決策另行 commit。

| 項目 | 結果 |
|---|---|
| `yarn install` 後 `node_modules` 不再有 `vue` 與 `pinia` | 通過。實地檢查 jail 的 `node_modules/`，兩個目錄都不存在 |
| `yarn test` 全數通過，含新增的靜態檢查 | 通過（使用者代跑，全綠） |
| bot 啟動正常，log 有 `Ready!` | 通過 |
| `/help` 列得出指令（驗 `commandList`） | 通過 |
| 隨便下一個斜線指令有反應（驗 `commandActionMap`） | 通過 |
| 對身分組訊息加反應仍正確發放身分組（驗 `client`） | 通過 |

靜態驗收：`grep -rn "useAppStroe\|commandsActionMap\|core/vue\|appStroe" src tests` 零結果。

## 決策紀錄

- 2026-08-20　排在 U01 之後而非之前。理由：兩者都改 `main.js` 與 `loader.js`，平行必衝突；U01 是修實際發生過的事故，優先。
- 2026-08-24　實際引用點是**四個**消費端（`main.js` / `loader.js` / `interactionCreate` / `help`）＋ `app.js` 自己 ＋ 刪掉的 `vue.js`。上面「相關檔案」表的行號全部對不上，因為 U01 已經動過 `main.js` 與 `loader.js`；實際位置是 `main.js` 第 4/6/41/77 行、`loader.js` 第 5/48/50/52/58/59 行。
- 2026-08-24　`commandsActionMap` 這個拼錯只出現在 `app.js` 的宣告裡，四個消費端一直都寫對成 `commandActionMap`。所以改名對執行期**沒有任何影響**，純粹是讓宣告與實際使用對齊。
- 2026-08-24　grep 驗收指令要多掃一個 `appStroe`。`loader.js` / `interactionCreate` / `help` 裡的區域變數名也是拼錯的（`const appStroe = useAppStroe()`），原本的指令抓不到它。實際用的是 `grep -rn "useAppStroe\|commandsActionMap\|core/vue\|appStroe" src tests`，已歸零。
- 2026-08-24　`main.js` 第 77 行的 `const appStore = useAppStroe()` 必須**整行刪除**，不能只改右側。改成 `import {appStore}` 之後留著會撞名，`SyntaxError: Identifier 'appStore' has already been declared`。
- 2026-08-24　`loader.js` 第 26 行的註解原本寫「不必先把 Pinia 初始化起來」，理由隨 Pinia 一起消失，改寫為「不碰 store」。
- 2026-08-24　順手刪掉 `main.js` 第 2 行沒用到的 `Events` 與 `Message`。已確認全檔沒有使用：`Message` 只出現在 `Partials.Message` 與 `GatewayIntentBits.GuildMessages` 等處，不是被 import 的那個 class。
- 2026-08-24　`vite.config.js` 沒有掛 vue plugin，`src/scripts/deploy-commands.js` 走 `collectCommands()` 不碰 store —— 兩者都不用改。
- 2026-08-24　**`yarn.lock` 分兩次處理**。它有進版控，但編輯目錄在 NAS 上禁止執行 process，我無法跑 `yarn install` 重算 lock；而 jail 端 `update.sh` 是 `git reset --hard`，在 jail 裡重算的 lock 下次 pull 就被沖掉。作法：先只 commit `package.json`，jail 驗收時跑 `yarn install`，再從 `\\fongxiang.duckdns.org\mnt\iocage\jails\DiscordBot_test\root\root\BC_djs_bot\yarn.lock` 讀回真正由 yarn 產生的 lock，複製回編輯目錄補一次 commit。手改 lock 不可行。
- 2026-08-24　新增的靜態檢查只認 `from 'vue'` 這種字面寫法，抓不到 `import('vue')`。專案全是靜態 ESM import，為動態 import 去寫 parser 不值得。
- 2026-08-24　**版控裡原本的 `yarn.lock` 是壞的，這次一併重生 —— 這是 U02 唯一超出原訂範圍的改動，需要專案經理知情。**
  拿回 jail 產生的 lock 後 diff 是 **+769 / −334 行**，遠大於「拿掉兩個套件」該有的規模。追查後確認原因不在 U02，而是舊 lock（2026-08-17）早就與 `package.json` 對不上：

  | 套件 | `package.json` | 舊 lock | 新 lock |
  |---|---|---|---|
  | `vitest` | `^3.2.4`（dev） | **完全沒有條目** | `vitest@^3.2.4` |
  | `node-cron` | `^3.0.3` | **完全沒有條目** | `node-cron@^3.0.3` |
  | `discord.js` | `^14.13.0` | 鎖在 `^14.11.0` | `^14.13.0` |
  | `vue` / `pinia` | 已移除 | 有（含 9 個 `@vue/*`） | 已清掉 |
  | `vite-node` | `^0.33.0` | 有 | `^0.33.0` 保留，另有 vitest 帶進來的 `3.2.4` |

  也就是說舊 lock 名不副實：跑 `yarn test` 需要的 vitest 根本不在裡面，任何人重裝都拿不到可重現的環境。新增的約 100 個條目大多是 esbuild / rollup 的各平台二進位，yarn v1 本來就會全部列進 lock，屬正常。
  決定照樣 commit。理由有三：新 lock 是 yarn 在測試 jail 真的解析出來的，不是手改的；bot 就是靠這份 `node_modules` 在跑且六項驗收全過，它是目前唯一經過實機驗證的版本；留著舊 lock 只是把問題往後推。
  **遺留風險（請專案經理留意）**：這份 lock 跟著 `test` → `main` 進正式站時，正式站的 `yarn install` 會一次升級 discord.js 的解析版本與整套建置工具鏈，超出「拔掉 vue/pinia」的範圍。上正式站前應比照測試站流程，先 `yarn install` 再重啟，不要直接沿用舊 `node_modules`。
  另外評估過「只留 vue/pinia 的部分、把 lock 整理拆成另一個單元」，做不到：lock 是 yarn 整份重寫的產物，無法只取其中一段，手改 lock 更不可行。
- 2026-08-24　**`CLAUDE.md` 的 jail 路徑寫錯，找檔案時撞到。** 正確路徑是
  `\\fongxiang.duckdns.org\mnt\iocage\jails\DiscordBot-Test\root\root\BC_djs_bot_test`。
  兩處出入：jail 目錄實際叫 `DiscordBot-Test`（連字號），文件寫 `DiscordBot_test`；測試 jail 內的 repo 目錄叫 `BC_djs_bot_test`，文件寫 `BC_djs_bot`。
  `CLAUDE.md` 在本單元的檔案領域外，**未修改**，記在這裡供後續單元或專案經理處理。
  順帶記錄：`/root/` 底下另有一個 86 bytes 的 `yarn.lock` 與一個 `node_modules/`（2026-08-14），不在 repo 內、與本單元無關，未動。
- 2026-08-24　單例改成 module-level 物件後，**沒有機制阻止誰在啟動前就讀它**（原本 `useAppStroe()` 至少要求 Pinia 已初始化）。實際寫入／讀取的順序沒變，且兩個消費端本來就有「map 還沒建好」的防護（ISSUES.md 的 C-04），所以不加 getter/setter。
