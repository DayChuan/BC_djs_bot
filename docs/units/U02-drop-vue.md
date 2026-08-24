# U02　拔掉 Vue／Pinia

狀態：待 jail 驗收
進度：5/5（`yarn.lock` 待補）
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
- [ ] 02-5 jail 驗收 ＋ 補 `yarn.lock`（程式碼已 commit）

## 驗收

單元測試：

1. `yarn test` 全數通過，含新增的靜態檢查

實機（測試 jail）：

1. `yarn install` 後 `node_modules` 內不再有 `vue` 與 `pinia`
2. bot 啟動正常，log 有 `Ready!`
3. `/help` 列得出指令（這條驗的是 `commandList` 有被正確填入）
4. 隨便下一個斜線指令有反應（驗 `commandActionMap`）
5. 對身分組訊息加反應仍然正確發放身分組

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
- 2026-08-24　單例改成 module-level 物件後，**沒有機制阻止誰在啟動前就讀它**（原本 `useAppStroe()` 至少要求 Pinia 已初始化）。實際寫入／讀取的順序沒變，且兩個消費端本來就有「map 還沒建好」的防護（ISSUES.md 的 C-04），所以不加 getter/setter。
