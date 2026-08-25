# 已完成的單元

只留結論與 commit，細節在 git 歷史裡。**平常不需要讀這個檔**，只有要理解「某個既有機制當初為什麼這樣做」時才翻。

---

## D01　錯誤攔截與檔案 log（原 Phase 0）
2026-08-17　`c107e65`

`src/core/logger.js`：同時寫 console 與 `logs/YYYY-MM-DD.log`。`main.js` 加上 `unhandledRejection` / `uncaughtException` / `SIGHUP`·`SIGTERM`·`SIGINT` / `exit` 的 handler，以及 client 的 `error` / `shardError` / `shardDisconnect` / `shardReconnecting` / `warn`。啟動訊息記錄 pid、Node 版本與 cwd。

> `uncaughtException` 目前仍是「記錄後繼續跑」，改成 exit 是 **U01** 的工作。

## D02　測試 jail 與 git 同步管線（原 Phase T）
2026-08-17～18　`c107e65`、`981a098`、`e8f969d`、`9c14244`、`3a41429`

三層架構（NAS 編輯 → `test` 分支 → jail 執行）、jail 內 `/root/update.sh`、導入 vitest。踩過的坑全部寫進 `vite.config.js` 的註解與 `docs/ENVIRONMENTS.md`。

原本評估的 iocage `fstab` 掛載方案**已廢除**：掛載進來的位置無法執行 jail 內部程式，權限也會與 host 連動。

## D03　既有問題修復（原 Phase 1-B／1-C／1-D、ISSUES 的 C-02／C-03／F-01～F-03／M-03／M-04）
2026-08-17　`c97ac41`、`726e3bd`

- emoji→身分組對照表合併進 `src/config/environments/<環境>.js`，兩個事件檔改為共用 `src/core/roleGrant.js` 的 `createRoleReactionHandler(mode)`，各自只剩 10 行
- partial 訊息先 `fetch()`、成員改用 `await guild.members.fetch()`
- 通知管理頻道改成自帶 try/catch 的 `notifyAdmin()`——原本錯誤處理本身就是崩潰來源
- `Message_listening` 全面加 `await` ＋ 外層 try/catch
- emoji 比對正規化掉 U+FE0F 變體選擇符

> 同批的 1-A（拔 Vue／Pinia）**沒有做**，是 **U02**。

## D04　自助身分組面板
2026-08-17　`6e15149`、`298e8bd`、`1befe69`

`/role-panel` 發面板、`/selfrole` 維護清單。清單存 `data/selfRoles.json`（不進版控），首次啟動用環境檔的 roles 當種子。`src/core/selfRoles.js` 是「資料表型功能」的參考實作。

## D05　投票系統（原 Phase 4 全部）
2026-08-18　`e0e0b15` → `777e0f5`（十餘個 commit）

`/poll`（可複選、身分選單、一人多角色、每週重複、中途查看）、`/quickpoll`（語音現場的顏色快速投票）。

關鍵決策：
- **不用 discord.js 原生 Poll API**。它不支援自訂身分選單與自訂結算格式，資料也不在我們手上
- 資料改為**一場一檔**（`data/polls/<id>.json`），結算後歸檔到 `data/archive/YYYY-MM/`，保留 90 天。單一檔案會讓查不到歷史、壞掉全部陪葬、所有投票共用一條寫入佇列
- 一人多角色**必須搭配身分群組**，沒有身分就只會是一堆「第 N 筆」
- 快速投票**一定要有自動結束時間**，現場沒人會記得回來收尾
- Discord 按鈕只有紅／藍／綠／灰四種內建色，**沒有黃色**

## D06　`/poll_admin` 管理面板
2026-08-18　`333ed89`、`9604d14`、`f94f604`

一則 ephemeral 面板管完進行中／排程中／已結束三類，不必記 id。編輯用 Modal，**選項不可改**——已投的票綁在選項編號上。取消不結算但仍歸檔並標記 `cancelled`。

## D07　ephemeral 清理與 `/help`（原 Phase 9）
2026-08-19　`524d720`

`src/core/ephemeralTracker.js`：每人每伺服器只留最新一則 ephemeral。刪別次互動的訊息靠該次 interaction 的 webhook token，**壽命 15 分鐘**，tracker 只留 14 分鐘。刪除失敗一律吞掉只記 log——這段程式在使用者等回覆的路徑上。

`/help` 的權限判斷直接讀各指令的 `default_member_permissions`，不另外維護清單。排版邏輯放 `src/core/helpText.js`（不碰 discord.js）才測得到。

同批移除 `/ask`、`/test`，`/poll` 權限由 `ManageMessages` 放寬為 `SendMessages`。

## D08　投票模板
2026-08-19　`a2d61f9`、`e89c5aa`

`src/core/pollTemplate.js` ＋ `pollTemplateAdmin.js`。常辦的投票存成模板重複使用，`/poll_close` 與 `/poll_peek` 併進 `/poll_admin`。排序不依賴 ICU 中文定序（jail 的 Node 不一定帶完整 ICU）。

## D10　`/quickpoll` 自訂選項文字 ＋ 藍紅順序對調（原 U08）
2026-08-21　`a852683`　2026-08-25 實機驗收通過

按鈕順序由紅藍灰綠改為**藍紅灰綠**（藍＝預設的正向選項，發起人不必每次說明哪個是贊成）。
新增選填參數 `labels`，依「藍,紅,灰,綠」的順序用逗號分開，不給就沿用顏色名。
解析沿用 `pollStore.parseOptionsInput()`（吃全形逗號、去空白、去重複，key 剛好對上顏色順序）。

數量對不上一律擋下，不自動補齊也不截斷——按鈕文字與顏色錯位的話現場就是集體投錯，
而且沒有人會發現。`styleOf()` 改為「先比對文字、再退回用 key 查」，讓改版前發出的舊投票
顏色仍然對得上。

## D11　闇黑龍王計時器 `/horntail`（原 U09）
2026-08-21～24　`c1dcd26` 起十餘個 commit　2026-08-25 實機驗收通過

語音頻道專用的三招計時器（吐火 60／左手消技 90／黑鎖 30 秒），剩 5 秒 TTS 提醒，
歸零自動接下一輪。限 GM 身分組或伺服器管理員。

交接文件原本的寫法會撞 Discord 的速率限制，實作時改掉的四件事：

| 原規格 | 改成 | 理由 |
|---|---|---|
| 三個招式各自 `setInterval`、每 1～2 秒編輯訊息 | 整個面板共用一個 tick，**倒數由用戶端的 `<t:秒:R>` 自己算** | 每秒三次編輯會吃 429；改用戶端算之後 bot 連不上也不影響倒數，編輯量從每分鐘 30 次降到約 4 次 |
| 歸零不停止、無限循環 | 兩小時總時限 ＋ 30 分鐘閒置 ＋ **語音頻道沒人 60 秒**自動收面板 | 沒有結束條件等於永不停止的 API 呼叫 |
| `interaction.message.edit()` | 面板改用 `channel.send()` | interaction 的 webhook 訊息 15 分鐘後就編輯不了，而面板要活兩小時 |
| 剩 5 秒 TTS | 一度改 7 秒補 TTS 開場，後來**改回 5 秒** | 發訊者名稱 TTS 唸不出來，那段開場並不存在 |

其他關鍵決策：狀態只放記憶體不做持久化（重啟後正確的行為是重開而不是還原）；
只能開在語音頻道的聊天室（TTS 由「正在看該頻道」的人的用戶端朗讀，開在文字頻道等於提醒不存在）；
按一下開始、**再按一下從頭重算**而不是停止（現場遇到 delay 要的是重算，舊語意得按兩次）。

`src/main.js` 為此加了 `GuildVoiceStates` intent。

## D09　測試範圍的取捨
2026-08-18 決議

**只為資料層與純邏輯寫測試，不為介面寫測試。** 介面測試維護成本極高（每次調整介面都要重寫一輪），實際抓到的 bug 是零，還發生過「把錯誤行為寫成預期」的情況。介面正確性改用測試伺服器實機驗收。

已刪除 `tests/pollRender.test.js`、`pollPanel.test.js`、`pollAdmin.test.js`、`pollService.test.js`。

**硬性限制：測試檔不得直接或間接 import `discord.js`**（詳見 `docs/ENVIRONMENTS.md`）。

唯一的例外是 `tests/moduleLayout.test.js`——純靜態檢查，只讀原始碼文字不 import 任何模組，守住「`export default` 必須在所有宣告之後」（TDZ 事故發生過兩次，`11522ce`）與「引號括號要平衡」（`6400626`）。
