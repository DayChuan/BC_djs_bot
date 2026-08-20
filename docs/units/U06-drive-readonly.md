# U06　`/drive` NAS 檔案瀏覽（唯讀）

狀態：未開始
進度：0/8
依賴：無
可平行：**可，與其他單元完全不重疊**（全部是新檔案）
分支：`unit/U06-drive-readonly`
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

## 架構

```
語音／文字頻道
   └─ /drive  →  String Select Menu 逐層瀏覽
                    ├─ /Share            公用
                    └─ /Private/<Discord ID>   私有，只有本人看得到
                          └─ 選中檔案 → Embed 附直連網址
                                            ↓
                              bot 內建的 HTTP server（唯讀）
                                 GET /api/file?token=...
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

**私有目錄的權限**：不依賴 TrueNAS 的 SMB／系統帳號，改用 `interaction.user.id` 決定他只能進 `/Private/<自己的 ID>`。使用者送回來的 `customId` **不可信任**——選單裡就算塞了別人的 ID，handler 也必須用 `interaction.user.id` 重新組一次路徑，不能直接用 customId 裡的值。`src/core/pollStore.js` 的 `isValidPollId()`（第 31 行）就是同一個教訓的產物：id 會組成檔名，不驗格式就等於開放任意路徑讀寫。

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

- [ ] 06-1 確認掛載點路徑、對外網址與埠號（見阻擋項）
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

1. `/drive` → 出現 `/Share` 與 `/Private` 兩個入口
2. 逐層進資料夾、回上一層都正常
3. A 的面板看不到 B 的 `/Private`；把 customId 裡的 ID 換成別人的也拿不到
4. 選中 `.mp4` → Embed 的網址在 Discord 裡可播放且**進度條拖得動**
5. 網址過期後再點 → 403
6. 目錄裡放一個 symlink 指到 jail 系統目錄 → 列表不顯示它

---

## 阻擋項

1. NAS 資料夾在 jail 內的**掛載點路徑**是什麼？
2. 直連網址要用哪個**對外網址與埠號**？（Discord 端要能連得到才播得出來）
3. `/Share` 是所有伺服器成員都能看，還是限特定身分組？

## 決策紀錄

- 2026-08-20　只做唯讀，Web 面板與上傳延後。使用者確認。
- 2026-08-20　HTTP server 用 Node 內建 `node:http`，不引入 Express。理由：只有一個路由，為它多一個相依不划算。
- 2026-08-20　直連網址用 HMAC 簽章 token，不放明文路徑。
