# 環境差異

更新日期：2026-08-20

---

## 三個位置

| | 編輯（本目錄） | 測試 jail `DiscordBot_test` | 正式 jail `DiscordBot` |
|---|---|---|---|
| 位置 | NAS SMB：`\\fongxiang.duckdns.org\admin_only\Program\Discord_bot\BC_djs_bot_test` | `/root/BC_djs_bot_test` | `/root/BC_djs_bot` |
| 用途 | 改檔、commit、push | 執行與驗證 | 實際運行 |
| 執行 process | **禁止** | 可，由使用者代跑 | 由使用者操作 |
| 來源 | git 工作區 | `git clone -b test` | `git clone -b main`（同一個 repo） |
| 抓檔 | — | `sh /root/update.sh` | `git pull origin main` |
| 啟動 | — | pm2，程序名 **`discord-bot`** | pm2，程序名 **`bc-djs-bot`** |
| OS | Windows 11 | FreeBSD（TrueNAS jail） | FreeBSD（TrueNAS jail） |
| Node | — | v24.14.1 | v24.14.1 |
| `.env` | 測試站設定 | 測試站設定 | 正式站設定 |
| Discord 伺服器 | — | 測試伺服器 | 正式伺服器 |

同層的 `BC_djs_bot` 是**正式環境的舊工作目錄**，已無作用（正式 jail 現在自己 clone git），非必要不要動。

**jail 檔案可以從 Windows 唯讀查看**：`\\fongxiang.duckdns.org\mnt\iocage\jails\<jail>\root\root\BC_djs_bot`。查 log 或確認檔案有沒有同步過去時很好用。

---

## 不進版控的東西

`.gitignore` 排除，兩個 jail 各自持有，git 操作不會動到它們：

| 項目 | 說明 |
|---|---|
| `.env` | 兩站各一份。測試站必須寫 `BOT_ENV=test`，正式站可以不寫（`src/config/index.js` 的預設值就是 production） |
| `data/` | 投票、歸檔、模板、自助身分組清單。回滾不會影響它們 |
| `logs/` | 每日一個檔 `logs/YYYY-MM-DD.log` |
| `node_modules/` | |
| `CLAUDE.md` | 只給編輯端的協作規範，不需要同步到 jail |
| `docs/Functions/` | 使用者的 Handover 原始文件（含 PDF），只在 NAS 端 |
| `.commands-hash.json` | 指令註冊的雜湊護欄（U01 產出），兩站各自持有 |

**環境設定本身進版控**：`src/config/environments/production.js` 與 `test.js`，兩邊的結構（`roles` 的 emoji 清單、`channels` 的欄位）必須一致。`src/config/index.js` 的 `validate()` 會在啟動時比對並警告不一致——但只是警告，不會擋。

---

## 效能基線（2026-08-21 實測）

NAS 主機：4 核、實體記憶體 12.71 GB（12,122 MiB）、開機 269 天、CPU 98.7% idle。

每個 jail 實際跑三個行程：

| 行程 | 測試站 | 正式站 |
|---|---|---|
| bot 本體（node） | 181 MB | 180 MB |
| pm2 daemon | 97 MB | 96 MB |
| esbuild（`vite-node` 帶起來的） | ~14 MB | 14 MB |
| 磁碟（含 `node_modules`） | 55 MB | 53 MB |

**兩站合計約 582 MB ＝ NAS 記憶體的 4.8%**（只算 bot 本體是 361 MB ＝ 3.0%）。
CPU 幾乎是零：正式站連續運行 40.5 小時只累計 28 秒 CPU 時間，等於單核的 0.019%。

三個容易誤判的數字：

- **`pm2 list` 的 `ram usage: 91%`** 是 TrueNAS 的正常狀態，7,496 MB 的 Wired 裡有
  5,772 MB 是 ZFS 的 ARC 快取，隨時可回收。真正的壓力指標是 swap——16 GB 只用了 73 MB
- **`VSZ 17G`** 是虛擬位址空間，不是實際佔用。看 `RES` 那一欄
- **測試站重啟 33 次**是正常的，它本來就拿來反覆弄壞

**E-02（用 `vite-node` 跑正式站）的 OOM 疑慮到此結案**：離 OOM 差得非常遠。
它的成本是那顆 esbuild 子行程（14 MB，累計 CPU 38 秒，比 bot 本體的 28 秒還多），
換成原生 `node` 推測每站可省 60～80 MB（信心中等），但要先解決全專案都在用的 `@/` 別名，
回報遠低於改動成本，維持不修。

U06 的 `/drive` 上線後值得重新量一次——檔案傳輸會實際吃 I/O 與記憶體。

## 測試環境的地雷（加測試前一定要看）

測試 jail 是 FreeBSD，vitest 在這裡有兩個必須繞開的問題。兩個都已寫進 `vite.config.js`：

| 症狀 | 原因 | 對策 |
|---|---|---|
| 多支測試檔停在 `0/N` 不動，先跑完的那支正常 | 同時開多個 worker。推測 jail 內取到的 CPU 數是宿主機的 | `fileParallelism: false` |
| 有 import `discord.js` 的測試檔一跑就停住，CPU 全閒，`--testTimeout` 攔不到 | 卡在 vite/esbuild 的轉換階段，測試根本還沒開始執行 | `server.deps.external: ['discord.js']` |

### 硬性限制：測試檔不得直接或間接 import `discord.js`

`server.deps.external` 只是把卡住的點往後推，沒有真正解決。這條規則是靠實驗歸納的——卡住的檔案全部有碰（`pollRender`、`pollPanel`、`pollAdmin`、`pollService`），跑得完的全部沒碰（`pollStore`、`pollArchive`、`scheduler`、`pollIdentities`）。已經花掉太多時間在這個環境問題上而報酬是零，所以不再嘗試修它，改為繞開。

**實務作法**：把純邏輯抽成不碰 discord.js 的模組（`helpText.js`、`pollStore.js` 都是這樣分的），只測那一層；介面正確性用測試伺服器實機驗收。

### 另一個設定檔擋不掉的禁忌

**不要在 `beforeEach` 裡用 `vi.resetModules()` ＋ 動態 `import()`。** 只要那條 import 鏈上有 `discord.js`，每個案例都會把它整包重新載入，在這個環境會卡死到跑不完。

要換設定就改成「換環境變數 ＋ 清模組內的快取」。`pollStore.js` 的路徑函式（`dataDir()`、`pollsDir()`）就是為此改成**呼叫時才解析**，不在模組載入時定死。新模組請照這個寫法。

`tests/example.test.js` 是可以直接照抄的範本，涵蓋斷言、前後置、假物件、假計時器與上述禁忌。

---

## 其他環境事實

- **`@/` 別名由 `vite.config.js` 提供，所以必須用 `vite-node` 執行，不能直接 `node`。** 這也是 `vite-node` 不能從 `package.json` 移除的原因
- `src/core/loader.js` 目前用相對路徑 `./src/**` 掃檔，**依賴當前工作目錄**；從別的目錄啟動會靜默掃不到任何檔案（U01 會修）
- Node 的未處理 rejection 會終止行程（`--unhandled-rejections=throw` 自 Node 15 起為預設）。**未 await 的 Promise 若 reject，外層 try/catch 攔不到**
- `fast-glob` 即使在 Windows 上也只吃正斜線。編輯機是 Windows、執行環境是 FreeBSD，路徑要記得 `.replace(/\\/g, '/')`
- jail 的 Node 不保證帶完整 ICU，**排序不要依賴中文定序**（`localeCompare` 在這裡的結果與 Windows 不同，`e89c5aa` 就是為此改的）
- **不做觀察期。** 掛掉時由使用者撈 log 回來判斷
