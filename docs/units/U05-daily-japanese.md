# U05　每日日文分享

狀態：進行中
進度：8/9
依賴：U03（記錄發過哪些項目，避免重複）
可平行：可
分支：**留在 `test`，不要開分支**（見 CLAUDE.md 的單元制第 2 條）
來源：原 PLAN.md Phase 5；2026-08-25 使用者追加「複習與筆記」需求（見下方決策紀錄）

---

## 目標

每天固定時間在指定頻道發一則日文分享（慣用句／單字＋讀音＋意思＋例句），內容來自**專案自己維護的資料表**，bot 只負責挑選與排版。

2026-08-25 追加：發過的內容要能回頭複習、成員能加筆記、老師身分組能就地修正內容，資料表能用指令貼 JSON 維護。

---

## 參考網站的調查結果（2026-08-20）

使用者提供的參考來源：<https://nihongo.hicross.jp/fixed-expression>（HICROSS 日本語，慣用句・ことわざ 201 件）。

**結論：不能當作自動化資料來源，但可以當作人工建表時的參考。**

實際抓取後確認：

- 清單頁的 HTML **不含任何慣用句內容**，只有導覽列、語言切換與「用所選單字出題」等介面按鈕。內容需要 JavaScript 或登入後才看得到（頁面上出現「電子郵件地址尚未驗證」的提示）
- 沒有找到 RSS 或公開 JSON API
- 多語言採路徑前綴（`/zh-hant/fixed-expression`、`/en/…`），但繁中版一樣看不到清單內容
- 總量只有 201 件

即使技術上繞得過去（跑無頭瀏覽器、帶登入 cookie），為了 201 筆固定不變的資料在 bot 裡養一套爬蟲並不划算，而且抓取需登入才能看的內容有使用條款上的疑慮。**採用使用者原本的方向：自己維護資料表。** 這個網站的價值在於它的欄位設計（表現／読み方／意味／例文／JLPT 等級／分類）值得照抄，以及建表時可以人工挑內容。

---

## 設計

### 資料表

`data/japanese/entries.json`（不進版控，正式站與測試站各自維護）。首次啟動時若檔案不存在，就從 `src/config/japaneseSeed.js` 的初始清單建檔——這跟 `src/core/selfRoles.js` 的作法完全一樣，照抄即可。

每一筆的欄位：

```json
{
  "id": "j_0001",
  "type": "idiom",
  "expression": "猫の手も借りたい",
  "reading": "ねこのてもかりたい",
  "meaning": "忙得不可開交，連貓的手都想借來用",
  "level": "N2",
  "tags": ["慣用句"],
  "examples": [
    {"ja": "年末は猫の手も借りたいほど忙しい。", "zh": "年底忙到連貓的手都想借。"}
  ],
  "note": "文法或用法補充，可留空",
  "notes": [
    {"userId": "123456789012345678", "text": "老師說這句商業信件不要用", "at": "2026-08-25T01:00:00.000Z"}
  ]
}
```

`type` 先支援 `idiom`（慣用句）、`word`（單字）、`grammar`（文法）三種，排版時決定 embed 的欄位順序。

**`note` 與 `notes` 是兩種東西，不要混用**（2026-08-25）：

| 欄位 | 誰維護 | 內容 |
|---|---|---|
| `note` | 建表的人 / 老師 | 用法或文法補充，是**內容本身**的一部分，seed 檔裡已經有 |
| `notes` | 所有成員（`/jp_note`） | 大家的補充筆記，每筆記錄 `userId` 與時間，顯示時掛 `<@userId>` |

舊資料沒有 `notes` 欄位，`load()` 時由 `migrate()` 自動補成空陣列，不必刪檔重來。

### 挑選規則

每天從「最久沒發過」的那批裡隨機挑一筆。已發過的 id 與時間記在 U03 的 state（區段 `japanese`），全部發完一輪就重新開始。用「最久沒發過」而不是純隨機，是因為純隨機在 200 筆的規模下很快就會重複，看起來像壞掉。

實作上「最久沒發過的那批」＝「還沒發過的那批」：候選為空時清空紀錄、`round + 1`、候選換成全部。state 的形狀：

```json
{"sent": {"j_0012": "2026-08-25T01:00:00.000Z"}, "round": 1, "lastAt": "2026-08-25T01:00:00.000Z"}
```

**`/jp` 私下抽的不寫紀錄**，所以不影響每日的輪替，也不會出現在 `/jp_history`（2026-08-25 使用者確認）。

### 排程

每天 09:00 **台北時間**（`src/core/scheduler.js` 的 `TIMEZONE` 已經固定為 `Asia/Taipei`），用 `scheduleCron()`。

排程掛載走 U03 的 `registerRestore('japanese', fn)`，**不改 `src/events/ready/index.js`**（那支檔案不在本單元的檔案領域，且登記制就是為了避免各單元搶同一支檔案，見 `state.js` 的註解）。

⚠️ `registerRestore` 只有在模組被載入時才會登記，而 **loader 只掃 `src/commands/` 與 `src/events/`，不掃 `src/jobs/`**——沒有人 import `dailyJapanese.js` 的話排程永遠掛不上。`vmute.js` 是靠它的指令檔被掃到才連帶載入的。這裡的作法是 `src/commands/jp/index.js` 直接 import `postDaily`，一併解決這件事。

### 指令

| 指令 | 誰能用 | 做什麼 |
|---|---|---|
| `/jp` | 所有人 | 私下抽一則複習（ephemeral），不寫紀錄 |
| `/jp post:true` | 老師 | 立刻完整跑一次每日流程：挑選 → 貼到日文頻道 → **寫紀錄** |
| `/jp_history range:` | 所有人 | 列出今天／本週／本月發過的每日一句 |
| `/jp_note id: text:` | 所有人 | 對某一筆加筆記 |
| `/jp_admin find\|edit\|import\|note_remove` | 老師 | 搜尋、修正內容、匯入 JSON、刪筆記 |

**每一則輸出都要帶 id**（embed 的 footer，或清單的行首），成員才複製得到、貼得進 `/jp_note` 與 `/jp_admin edit`。

### 權限

新增 `config.permissionRoles.teacher`，格式與既有的 `gm` 一樣是 `{伺服器id: 身分組id}` 對照表——身分組 id 綁死在單一伺服器，拿 A 伺服器的 id 去 B 查一定查不到（U07 踩過）。

- **不放行管理員**（2026-08-25 使用者指示）。這跟 `timerService.isGmMember` 不同，那支是管理員一律放行
- 查不到該伺服器的 id ＝ 沒有人能用（fail closed），不會全開
- `/jp_admin` 用 `setDefaultMemberPermissions(0)`（照 `horntail` 的作法）：預設只有管理員在選單裡看得到，再由管理員到「伺服器設定 → 整合」把老師身分組加白名單。**Discord 端的設定擋不住直接打 API，所以程式裡一定要再驗一次**

### 匯入格式（`/jp_admin import`）

用斜線指令的字串選項貼純文字 JSON，**不用 Modal**。兩個理由：字串選項上限 6000 字比 Modal 段落欄位的 4000 字大；而且 Modal 送出的路由寫死在 `src/events/interactionCreate/index.js`（一串 `parseXxxCustomId` 的 if），那支檔案不在本單元的檔案領域。

檢查規則：

1. `JSON.parse` 失敗 → 回報 `e.message`，不寫入
2. 接受陣列；單一物件自動包成一筆
3. 必填 `type` / `expression` / `meaning`；`type` 只能是 `idiom` / `word` / `grammar`
4. 選填 `reading` / `level` / `tags` / `note`，缺就補空值
5. `examples` 若有，必須是陣列且每筆有 `ja`（不是陣列直接判錯，不靜默丟掉，免得以為例句進去了）
6. 匯入的資料一律不接受 `notes`（別人的筆記不該用貼 JSON 的方式偽造），一律建成空陣列
7. **任何一筆有問題就整批不寫入**（all-or-nothing），回報是第幾筆、錯在哪。純文字貼上最常見的意外是貼到一半，半批寫入的話不會知道到底進了幾筆

序號：`id` 沒給、格式不是 `j_NNNN`、跟現有資料重複、或跟本批內其他筆重複 → 自動改成目前最大號 +1，回覆列出 `j_0007 → j_0061`。**既有那筆的號碼永遠不動**——已發送紀錄與筆記都靠 id 對應，改號等於紀錄失聯。

寫入前把舊檔複製成 `entries.json.bak`（只留一份），匯入炸掉時有東西可以退回去。

**備份與檢視不另做指令**：jail 的 `data/` 從 Windows 就能唯讀開啟（路徑規則見 CLAUDE.md），要備份直接複製那個檔。

### 修改內容（`/jp_admin edit`）

可改 `expression` / `reading` / `meaning` / `level` / `note` 五個欄位，用下拉選單挑欄位、字串選項給新值。**例句不做 `edit`**：結構是陣列包物件，用選項表達會很難用，整筆重貼 `import` 比較實在。

`reading` / `level` / `note` 傳 `-` 代表清空（Discord 的必填選項送不出空字串）。

history 只存 id 不存內容快照，所以老師修正之後，回頭看 `/jp_history` 顯示的是修正後的版本——這正是「內容有誤可以修正」要的行為。

### AI 摘要與新聞來源

**本單元不做**。等資料表跑順了再開 U08 討論，那時候要一併決定 API 供應商、金鑰放哪、費用上限。目前的定位是「bot 讀資料表顯示資料」。

---

## 相關檔案

**已經有的：**

- `src/config/japaneseSeed.js` — **已產出 60 筆**（30 慣用句 ＋ 20 ことわざ ＋ 10 文法），2026-08-20 建立。欄位說明寫在檔案開頭的註解。使用者要續補或改寫都直接改這個檔（只影響首次建檔；資料表已存在時改它不會生效，要用 `/jp_admin import`）

**要新增的：**

- `src/core/japanese.js` — 讀寫資料表、挑選、排版、匯入、編輯、筆記、歷史。**不 import discord.js**
- `src/commands/jp/index.js` — `/jp`
- `src/commands/jp_history/index.js` — `/jp_history`
- `src/commands/jp_note/index.js` — `/jp_note`
- `src/commands/jp_admin/index.js` — `/jp_admin`
- `src/jobs/dailyJapanese.js` — 每日排程任務（新增 `src/jobs/` 資料夾）
- `tests/japanese.test.js`

**要改的：**

| 檔案 | 改什麼 |
|---|---|
| `src/config/environments/production.js`、`test.js` | `channels` 加 `japanese`、`permissionRoles` 加 `teacher`。**兩個環境檔的結構必須一致** |

**只讀，這個單元一定要看的：**

| 檔案 | 你需要知道的事 |
|---|---|
| `src/core/selfRoles.js`（158 行） | **本單元資料表的實作範本**：`load()` 帶記憶體快取、檔案不存在就 `buildSeed()` 建檔、讀壞了退回預設清單而不是讓 bot 起不來、`migrate()` 補新欄位。它是同步 `fs`，資料量小的情況可以照抄。**唯一不照抄的是「模組載入時就 `load()`」**——那會讓測試沒機會換掉資料夾（見下方「測試上的地雷」） |
| `src/core/scheduler.js`（209 行） | `scheduleCron(key, expression, task)`、`TIMEZONE = 'Asia/Taipei'`、`TAIPEI_OFFSET_MS`。cron 運算式的時區由 `node-cron` 處理，不要自己算時差 |
| `src/core/state.js`（U03 產出） | `getState` / `updateState` / `registerRestore`。**全部是非同步的**（回 Promise） |
| `src/config/index.js`（96 行） | `config.channels.*`、`config.permissionRoles.*` 的取法 |
| `src/commands/quickpoll/index.js` | 指令檔的標準寫法（匯出 `command` 與 `action`） |
| `src/commands/horntail/index.js` | `setDefaultMemberPermissions(0)` ＋ 程式內再驗一次身分組的作法 |
| `src/core/timerService.js` 的 `isGmMember` | 身分組對照表的查法與 fail closed 的寫法 |

---

## 這個單元踩到／確認過的地雷

1. **`src/config/index.js` 的 `validate()` 只比對兩個環境的 `roles`，沒有比對 `channels` 與 `permissionRoles`。** 所以 `channels.japanese` 只加一邊**不會有任何警告**，而是正式站 `config.channels.japanese` 變成 `undefined`、排程送訊息時才炸。`config/index.js` 不在本單元的檔案領域，所以改用 `tests/japanese.test.js` 直接比對兩個環境檔的結構來守。
2. **loader 不掃 `src/jobs/`**，見上方「排程」。
3. **新增指令後只重啟 bot 沒有用**，指令註冊已拆成獨立的 `yarn deploy`，見下方驗收步驟。
4. **測試上的地雷**：
   - 測試檔不得直接或間接 import `discord.js`，所以 `japanese.js` 一律回傳「純物件 embed」而不是 `EmbedBuilder`（`channel.send({embeds: [純物件]})` 一樣吃）
   - 資料夾路徑沿用 `state.js` 的 `dataDir()`，也就是吃 `STATE_DATA_DIR` 環境變數、**用到時才解析**。不能在模組載入時定死，否則測試要換資料夾就得 `vi.resetModules()`，那在測試 jail 裡會卡死
   - 同理，`japanese.js` **不在模組載入時 `load()`**，並且匯出 `resetCache()` 給測試在每個案例前清快取

---

## 頻道與身分組

| 環境 | 日文頻道 ID | 老師身分組 |
|---|---|---|
| 測試站（伺服器 `974484668252565544`） | `1539905791564193862` | `1541654719251091608`（2026-08-25 補上） |
| 正式站（伺服器 `820702012592619570`） | `1217432781877940305` | `1541645092727824404` |

正式站的第二個伺服器（`1540261363639648318`）不開放，維持 fail closed。

## 進度

- [x] 05-1 頻道 ID 確認（2026-08-20）
- [x] 05-2 `src/config/japaneseSeed.js` 初始清單 60 筆（2026-08-20 先行產出，供使用者測試與續補）
- [x] 05-3 單元檔改寫：把 `notes` / history / 老師權限 / 四支指令的設計寫進來（2026-08-25）
- [x] 05-4 `src/core/japanese.js`（2026-08-25）
- [x] 05-5 `src/commands/jp/`、`jp_history/`、`jp_note/`（2026-08-25）
- [x] 05-6 `src/commands/jp_admin/`（2026-08-25）
- [x] 05-7 `src/jobs/dailyJapanese.js` ＋ 兩個環境檔（2026-08-25）
- [x] 05-8 `tests/japanese.test.js`（2026-08-25，共 56 個案例，**尚未在 jail 跑過**）
- [ ] 05-9 jail ＋ 測試伺服器驗收，commit

## 驗收

單元測試（`yarn test` 跑全套，不要單獨跑一支，見 `docs/ENVIRONMENTS.md`）：

1. 連續挑 N 次（N＝資料表筆數）不會重複；第 N+1 次重新開始一輪
2. 資料表某一筆缺 `examples` → 排版不炸，只是少那一段
3. 資料表整個壞掉 → 回退到 seed 並留下 log，不讓 bot 起不來
4. 匯入：JSON 壞掉／不是陣列／缺必填／`type` 非法／`examples` 不是陣列 → 整批擋下，檔案沒被動過
5. 匯入：id 重複、本批內自撞、沒給 id → 接在最大號後面，回報改號清單
6. 筆記：新增後帶得到 `userId` 與時間；刪除指定序號
7. 歷史：今天／本週／本月的區間用**台北時間**切，跨月與跨週的邊界要對
8. 權限：對照表查不到該伺服器 → 誰都不能用（fail closed），且**管理員不例外**
9. 兩個環境檔的 `channels` 與 `permissionRoles` key 集合完全相同

實機（測試伺服器）：

1. `yarn deploy` 後 `/jp` 抽得出一則，格式正確（表現／讀音／意思／例句／id 都在）
2. `/jp post:true` 立刻在日文頻道發一則。**驗收前要先把老師身分組掛到自己身上**——管理員不放行，沒掛就是按不動
3. `/jp_admin import` 貼一筆正確的 JSON 進得去；貼一筆故意壞的整批擋下、`entries.json` 沒被動過
4. `/jp_admin find` 搜得到剛匯入那筆，`/jp_admin edit` 改得動，`/jp` 抽到時看得到改後的內容
5. 重啟 bot → 開機 log 出現「排程已註冊：japanese:daily」，且已發過的紀錄還在，不會從頭再發一次
6. `/jp_history range:本月` 列得出剛才那幾則
7. `/jp_note` 加一則筆記，再 `/jp` 抽到同一筆時看得到；`/jp_admin note_remove` 刪得掉

---

## 阻擋項

無。曾經有一項「測試站沒有老師身分組」，使用者於 2026-08-25 建了 `1541654719251091608` 並填進 `test.js`，`/jp_admin` 與 `/jp post:true` 現在測試站驗得到。

⚠️ 仍要注意：權限**不放行管理員**，所以驗收的人要先把老師身分組掛到自己身上，否則指令按不動——這不是壞掉。

## 決策紀錄

- 2026-08-20　時間定為每天 09:00 **台北時間**（原本待確認是台北或日本時間）。
- 2026-08-20　內容來源＝自維護 JSON 資料表；AI 摘要與新聞來源延後到另一個單元。理由：使用者指示先做「讀資料表顯示資料」。
- 2026-08-20　參考網站 nihongo.hicross.jp **不做自動抓取**。理由：清單內容不在伺服器端 HTML、疑似需登入、無 API，且只有 201 筆固定資料。
- 2026-08-25　排程改用 `registerRestore` 登記，**不動 `src/events/ready/index.js`**。理由：那支檔案不在本單元的檔案領域，登記制就是為了讓新功能只動自己的模組。
- 2026-08-25　embed 一律回傳**純物件**而不是 `EmbedBuilder`。理由：`japanese.js` 因此完全不必 import discord.js，排版邏輯才寫得出單元測試。
- 2026-08-25　資料表維護改用 `/jp_admin import` 貼純文字 JSON，**維持 `data/entries.json` 不進版控**。曾評估「資料表直接用版控的 `japaneseSeed.js`、走 git 更新」，使用者選擇指令維護，理由是不想每次改內容都要開編輯器 commit push。
- 2026-08-25　匯入用斜線指令的字串選項而非 Modal。理由：6000 字上限比 Modal 的 4000 大，且 Modal 路由寫死在領域外的 `interactionCreate/index.js`。
- 2026-08-25　`note`（內容補充）與 `notes`（大家的筆記）分成兩個欄位。理由：seed 檔已經有 `note`，混在一起之後分不開誰寫的。
- 2026-08-25　老師權限**不放行管理員**（與 `isGmMember` 的慣例相反），依使用者指示。副作用是測試站驗不了，見阻擋項。
- 2026-08-25　`/jp` 私下抽不寫紀錄、不進 history。理由：history 的定位是「大家一起看過的每日一句」。
