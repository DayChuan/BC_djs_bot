# U02　拔掉 Vue／Pinia

狀態：未開始
進度：0/5
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

- [ ] 02-1 `src/store/app.js` 改為一般單例物件
- [ ] 02-2 六個引用點全部改掉，刪除 `src/core/vue.js`
- [ ] 02-3 `package.json` 移除 `vue`、`pinia`
- [ ] 02-4 `moduleLayout.test.js` 加上禁止 import vue/pinia 的靜態檢查
- [ ] 02-5 jail 驗收 ＋ commit

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
