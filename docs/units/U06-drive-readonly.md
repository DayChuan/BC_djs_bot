# U06　`/drive` NAS 檔案瀏覽（唯讀）

狀態：未開始
進度：0/8
依賴：無
可平行：**可，與其他單元完全不重疊**（全部是新檔案）
分支：**留在 `test`，不要開分支**（見 CLAUDE.md 的單元制第 2 條）
來源：`docs/Functions/Claude_Handover_NAS_File_System.md`

---

## 範圍

交接文件描述的是「雙軌制檔案共享系統」：Discord 虛擬檔案總管 ＋ Vue3 Web 面板 ＋ OAuth2 登入 ＋ 拖曳上傳。

**本單元只做其中的唯讀部分**（2026-08-20 使用者確認）：

| 做 | 不做（之後另開單元） |
|---|---|
| 掛載目錄的檔案列表與資料夾瀏覽 | 上傳、刪除、建資料夾 |
| 路徑穿越防護 | Vue3 Web 面板 |
| `/drive` 指令與選單式瀏覽 | Discord OAuth2 登入 |
| 產生檔案直連網址丟回 Discord | multer 與大檔上傳 |
| 支援影片拖曳進度的 Range 回應 | 靜態資源託管（`dist/`） |

理由：唯讀部分自成一個可用的功能，而上傳與 OAuth2 帶進來的攻擊面與維運成本，值得等唯讀跑穩再談。

---

## 目錄結構（2026-08-20 使用者指定）

所有內容都在服務根目錄下的 `Discord/` 資料夾裡，往下分兩類：

```
<掛載點>/Discord/
   ├─ <身分組資料夾>/          依 Discord 身分組開放，一個身分組一個資料夾
   │     例：楓之谷/  TRPG/  ...
   └─ personal/
         └─ <Discord ID>/     個人專屬，只有本人看得到
```

**注意是 `personal/<ID>` 兩層**，不是直接 `<ID>`。交接文件原本寫的是 `/Share` 與 `/Private/<ID>`，以這一版為準。

身分組→資料夾名的對照放 `src/config/environments/<環境>.js` 的新欄位 `driveFolders`（`{roleId: 資料夾名}`），跟 `roles` 一樣兩個環境結構要一致。使用者看得到的資料夾 ＝ 他實際擁有的身分組所對應的那幾個，用 `member.roles.cache` 判斷。沒有任何對應身分組的人，就只看得到自己的 `personal/<ID>`。

## 架構

```
文字頻道
   └─ /drive  →  String Select Menu 逐層瀏覽
                    ├─ 他有身分組的那幾個資料夾
                    └─ 我的個人資料夾（personal/<自己的 ID>）
                          └─ 選中檔案 → Embed 附直連網址
                                            ↓
                              唯讀的 HTTP 下載路由
                                 http://fongxiang.duckdns.org:5990/...
```

**三個模組：**

1. `src/core/drive.js` — 檔案系統存取層。列出目錄、判斷型別、**路徑穿越防護**。這一層完全不認識 Discord
2. `src/core/driveServer.js` — 最小的 HTTP server（用 Node 內建 `node:http`，不引入 Express），只有一個下載路由
3. `src/commands/drive/index.js` ＋ `src/core/drivePanel.js` — Discord 端的選單介面

---

## 安全設計（這個單元最重要的部分）

**路徑穿越防護**：所有使用者送進來的路徑一律走同一個函式

```js
const resolveSafe = (base, userPath) => {
    const full = path.resolve(base, userPath)
    if(full !== base && !full.startsWith(base + path.sep)) return null   // 逃出根目錄
    return full
}
```

`startsWith(base)` **不夠**——`/data/share-evil` 也會通過。一定要比對 `base + path.sep`。另外 `path.resolve` 之後才比對，否則 `..` 還沒被解掉。

**權限**：不依賴 TrueNAS 的 SMB／系統帳號，改用 Discord 身分判斷。

- 個人資料夾：一律用 `interaction.user.id` 現場組出 `personal/<id>`
- 身分組資料夾：用 `member.roles.cache.has(roleId)` 檢查，**每一次互動都重查**，不快取在 customId 裡

使用者送回來的 `customId` **不可信任**——選單裡就算塞了別人的 ID 或沒領到的身分組資料夾，handler 也必須重新驗一次，不能直接採用 customId 帶回來的值。`src/core/pollStore.js` 的 `isValidPollId()`（第 31 行）就是同一個教訓的產物：id 會組成檔名，不驗格式就等於開放任意路徑讀寫。

**直連網址**：不能直接把檔案路徑放進網址（等於公開整個目錄結構，而且任何人都能改路徑）。改為簽章 token：

- token 內容 ＝ `{path, userId, exp}`，用 `.env` 裡的密鑰做 HMAC-SHA256（`node:crypto`，不加套件）
- 有效期建議 30 分鐘。過期就回 403
- 下載路由驗簽章、驗過期，再驗一次 `resolveSafe`

**符號連結**：列目錄時遇到 symlink 一律跳過，不然可以繞過根目錄檢查。

**影片預覽**：Response header 要有 `Content-Type: video/mp4` 與 `Accept-Ranges: bytes`，並且**實作 Range 請求**（回 206 與 `Content-Range`），否則 Discord 的播放器拖不動進度。

---

## 相關檔案

**要新增的：**

- `src/core/drive.js`、`src/core/driveServer.js`、`src/core/drivePanel.js`、`src/commands/drive/index.js`

**要改的：**

| 檔案 | 改什麼 |
|---|---|
| `src/events/ready/index.js`（44 行） | 啟動 HTTP server。用檔案裡現成的 `safely()` 包起來，server 起不來不該讓 bot 下線 |
| `src/events/interactionCreate/index.js`（278 行） | 加 `drive:` 前綴的選單分派。**注意分派順序**：現有的鏈是 `parseTemplateCustomId` → `parseAdminCustomId` → `parsePollCustomId`，每個認不出來就回 `null` 往下走。新前綴要挑一個不會被既有 parser 誤認的字串 |
| `src/config/environments/production.js`、`test.js` | 加掛載根目錄與 server 埠號。**兩個環境檔結構必須一致**（`src/config/index.js` 的 `validate()` 會比對並警告） |
| `.env`（不進版控，兩個 jail 各自維護） | 加簽章密鑰與對外網址 |

**只讀，這個單元一定要看的：**

| 檔案 | 你需要知道的事 |
|---|---|
| `src/core/pollStore.js`（第 1-30 行、第 202-240 行） | id 驗證的理由與寫法、`import.meta.url` 推導根目錄、原子寫入 |
| `src/core/pollAdmin.js`（332 行） | **選單式面板的完整範本**：`ADMIN_PREFIX` ＋ `adminId()` 組 customId ＋ `parseAdminCustomId()` 解析 ＋ `buildAdminList()` / `buildAdminDetail()` 兩層畫面 ＋ 「回上一層」按鈕。`/drive` 的逐層瀏覽就是同一個形狀 |
| `src/core/ephemeralTracker.js`（64 行） | `trackEphemeral(interaction)` / `refreshEphemeral(interaction)`。**開新的 ephemeral 面板一定要呼叫 `trackEphemeral`**，否則使用者畫面上會愈疊愈多；就地更新的路徑改呼叫 `refreshEphemeral` 續期 |
| `src/events/interactionCreate/index.js` 的 `handleAdmin()`（第 154 行起） | 「開 Modal 不能先 defer」「就地更新用 `deferUpdate` ＋ `editReply`」這兩條規則的實例 |
| `src/core/logger.js` | `export default logger` |

---

## 進度

- [ ] 06-1 確認掛載點路徑與 5990 的性質（見阻擋項）
- [ ] 06-2 `src/core/drive.js`：列目錄、`resolveSafe()`、symlink 過濾、型別判斷
- [ ] 06-3 `tests/drive.test.js`：**路徑穿越的攻擊案例要寫滿**（`../`、絕對路徑、`share-evil`、URL 編碼、空字串、`.`）
- [ ] 06-4 簽章 token 的產生與驗證 ＋ 測試
- [ ] 06-5 `src/core/driveServer.js`：下載路由 ＋ Range 支援
- [ ] 06-6 `src/core/drivePanel.js` ＋ `/drive` 指令
- [ ] 06-7 `interactionCreate` 分派 ＋ `ready` 啟動 server
- [ ] 06-8 jail ＋ 測試伺服器驗收，commit

## 驗收

單元測試（**不得 import discord.js**，所以 `drive.js` 與 token 這兩層要跟 Discord 完全分離）：

1. 路徑穿越的每一種攻擊都回 `null`
2. 合法的相對路徑正確解析
3. token 簽章驗得過；改任一欄位後驗不過；過期回失敗

實機（測試 jail ＋ 測試伺服器）：

1. `/drive` → 只列出「自己有的身分組資料夾」＋「我的個人資料夾」
2. 逐層進資料夾、回上一層都正常
3. 沒有某身分組的人看不到那個資料夾；A 看不到 B 的 `personal/`；把 customId 裡的 ID 或資料夾名換掉也拿不到
4. 選中 `.mp4` → Embed 的網址在 Discord 裡可播放且**進度條拖得動**
5. 網址過期後再點 → 403
6. 目錄裡放一個 symlink 指到 jail 系統目錄 → 列表不顯示它

---

## 阻擋項

**只擋 06-5（下載路由），前面四項可以先做。**

1. **`fongxiang.duckdns.org:5990` 是什麼？** 兩種可能，做法完全不同：
   - **(a) 已經存在的檔案服務**，根目錄下有 `Discord/` 資料夾 → 那就不必自己起 HTTP server，`driveServer.js` 整個不用做，直接組出它的網址就好。但要確認它**有沒有存取控制**——如果任何人拿到網址就能下載，那 `personal/` 的隔離只擋得住「看不到」，擋不住「猜得到網址」
   - **(b) 要我們自己在 5990 起 server** → 照原設計做 `driveServer.js`，並確認 jail 的 5990 有對外開通
2. **NAS 資料夾在 jail 內的掛載點是什麼？**（bot 要用本地路徑列目錄，這一項不論 1 選哪個都需要）
3. 身分組資料夾的對照：哪些身分組、對應哪個資料夾名？

## 決策紀錄

- 2026-08-20　只做唯讀，Web 面板與上傳延後。使用者確認。
- 2026-08-20　目錄結構：`Discord/<身分組資料夾>` 與 `Discord/personal/<Discord ID>`。使用者指定。
- 2026-08-20　對外網址 base 為 `fongxiang.duckdns.org:5990`。**性質待確認**（見阻擋項 1）。
- 2026-08-20　自建 server 的話用 Node 內建 `node:http`，不引入 Express。理由：只有一個路由。
- 2026-08-20　自建 server 的話，直連網址用 HMAC 簽章 token，不放明文路徑。
