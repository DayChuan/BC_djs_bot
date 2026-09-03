# U10　投票開在鎖定的討論串裡

狀態：程式已完成，等測試 jail 跑 `yarn test` 與實機驗收
進度：6/8
依賴：無（投票系統本身早就完成並上線）
可平行：可，但**會動到投票系統的核心檔案**，投票相關的其他改動要避開
分支：**留在 `test`，不要開分支**（見 CLAUDE.md 的單元制第 2 條）
工作目錄：`\fongxiang.duckdns.org\admin_only\Program\Discord_bot\BC_djs_bot_test`
來源：`docs/Functions/Claude_Handover_Thread_Poll.md`（若使用者尚未放入，以本檔為準）

---

## 目標

`/poll` 增加一個選填參數 `thread`。開啟時，投票不直接發在當下的頻道，而是：

1. 在當下的頻道建一個討論串，名稱 `【投票】<標題> YYYY-MM-DD`
2. 投票訊息發在討論串裡
3. 把討論串**鎖定**（一般成員不能在裡面發言）

目的是讓投票不被日常聊天洗掉。鎖定不影響按鈕與面板——**Discord 的鎖定只擋發訊息，不擋元件互動**。

模板也要能設定這個選項，套用模板建立的投票會沿用。

---

## 核心作法：把 `channelId` 換成討論串 id

投票系統的**所有發布路徑都收斂在 `sendPollMessage()`**（`/poll` 當下發、每週續辦、`/poll_admin` 的立即發布，三條路都走它），而它取頻道只靠一行：

```js
const channel = await fetchChannel(client, poll.channelId)
```

所以只要在那裡做一件事：

> 若 `poll.thread` 為真，先建討論串，**再把 `poll.channelId` 改成討論串的 id**。

因為討論串在 Discord 就是一種頻道，`channels.fetch(threadId)` 拿得到、`.send()` 送得進去。**投票、結算、編輯訊息、開機還原全部不用改**——它們只認 `poll.channelId`。

要另外存的只有 `parentChannelId`（母頻道），給每週續辦開新串用。

---

## 四個一定要處理的細節

### 1. 模板的 Modal 已經滿了，只能用切換按鈕

Discord 的 Modal **最多 5 個文字欄位**，而 `TEMPLATE_MODAL_FIELDS` 正好是 5 個
（`name` / `options` / `startDate` / `identity` / `weekly`）。**加不進去第 6 個。**

好消息是模板詳情面板**已經有現成的切換按鈕機制**，`multi`、`multiChar`、`peek` 都是這樣做的：

```js
new ButtonBuilder().setCustomId(templateId('tgl', template.id, 'peek'))
```

分派也已經寫好了（`handleTemplateAction()` 的 `action === 'tgl'` 那段），
所以模板這邊只要**加一顆按鈕 ＋ 在那段 if 裡多一個 `extra === 'thread'` 分支**，約 5 行。

### 2. 討論串會自動封存，而每週投票剛好卡在邊界

自動封存上限是 **7 天（10080 分鐘）**，每週投票的週期也是 7 天。封存之後 bot 編輯訊息會失敗。

- 建立時就設 `autoArchiveDuration: 10080`
- **結算前檢查 `thread.archived`，是的話先 `setArchived(false)`**（bot 有 `ManageThreads` 就做得到）

少了第二點，每週投票會在結算當下**剛好**踩到——最難查的那種時機。

### 3. 每一輪要開新的討論串

`publishPending()`（每週續辦）走的是同一個 `sendPollMessage()`。
續辦時 `poll.channelId` 已經是**上一輪的討論串 id**，直接拿它建串會失敗（討論串裡不能再開討論串）。

**所以建串一律用 `parentChannelId`，不是 `channelId`。**

### 4. 建串失敗要能退回，不能讓整場投票發不出來

權限不足（缺 `CreatePublicThreads` / `ManageThreads`）時：**記 log，退回直接發在母頻道**。
投票本身比「發在討論串」重要得多。鎖定失敗也一樣——訊息已經發出去了，鎖不起來只是會被聊天洗，不該讓整場投票消失。

---

## 不做的事

- **`/quickpoll` 不做。** 語音現場的快速投票開討論串沒有意義
- **結果不在母頻道貼連結**（2026-08-25 使用者決定）。結果貼在討論串裡就好，要轉發用 `/poll_admin` 的「公開分享到頻道」
- **不改互動方式。** 交接文件寫「點按鈕 → Modal → 輸入身分」，但現行做法是 ephemeral 個人面板 ＋ 選單，**功能比 Modal 強**（Modal 做不到多角色切換）。討論串只是換載體，互動邏輯一行都不動

---

## 相關檔案

**要改的：**

| 檔案 | 改什麼 |
|---|---|
| `src/core/pollService.js` | `sendPollMessage()` 加建串／鎖定／改 `channelId`；`closePoll()` 結算前解封存。**這是本單元的主戰場** |
| `src/core/pollStore.js` | 投票紀錄多兩個欄位 `thread`、`parentChannelId`。舊資料沒有＝不開串，天然相容，不需要遷移 |
| `src/commands/poll/index.js` | 加選填參數 `thread`（布林）；建 draft 時帶上 `thread` 與 `parentChannelId: ctx.channel.id`。目前 14 個參數，上限 25 |
| `src/core/pollTemplate.js` | 模板紀錄多一個 `thread` 欄位 |
| `src/core/pollTemplateAdmin.js` | 詳情面板加一顆切換按鈕；`action === 'tgl'` 那段加 `extra === 'thread'` 分支 |
| `tests/pollStore.test.js` 或新增 `tests/pollThread.test.js` | 純邏輯測試 |
| `src/config/environments/production.js` / `test.js` | `noticeRoles.poll`：開串時要提及的身分組（2026-09-03 追加，**原本不在檔案領域內，已取得使用者同意**） |

**只讀，但一定要看懂的：**

| 檔案 | 你需要知道的事 |
|---|---|
| `src/core/pollService.js` 的 `sendPollMessage()` | **三條發布路徑的唯一入口**：`createAndPublish()`（`/poll` 當下發）、`publishPending()`（每週續辦與立即發布）都走它。改這一個函式等於三條路都改到 |
| `src/core/pollService.js` 的 `fetchChannel()` | `client.channels.fetch(id).catch(() => null)`，討論串也走這條，不必另外寫 |
| `src/core/pollService.js` 的 `closePoll()`、`restorePolls()`、`cancelPoll()` | 都用 `poll.channelId` 取頻道。`channelId` 換成討論串 id 之後它們自動跟著走，**不要去改它們** |
| `src/core/pollTemplateAdmin.js` 的 `handleTemplateAction()` | `tgl` 那段就是切換按鈕的範本，照抄即可 |
| `src/commands/poll/index.js` 第 116-140 行 | 模板怎麼套用進 draft 的。`thread` 要跟著這條路徑帶進去 |
| `src/core/pollAdmin.js` | 「公開分享到頻道」用的是歸檔紀錄，不受本單元影響 |
| `src/core/pollTemplate.js` 的 `parseTemplateFields()` | 模板欄位的驗證。`thread` 是切換按鈕改的，**不經過這裡** |

---

## 10-1／10-2 做出來的介面（後續步驟直接用，不用再翻程式碼）

`src/core/pollStore.js` 的純函式區段（**沒有任何 Discord 相依，可單元測試**）：

| 函式 | 行為 |
|---|---|
| `taipeiDateOnly(now = Date.now())` | 台北時間的 `YYYY-MM-DD` |
| `taipeiMonthDay(now = Date.now())` | 台北時間的 `MM/DD` |
| `MAX_THREAD_NAME` | `100` |
| `buildThreadName(title, dateLabel = null, now)` | `【投票】<標題> <日期>`，`dateLabel` 留空就用今天的 `MM/DD`；過長只截標題，總長 ≤ 100 |
| `wantsThread(poll)` | `Boolean(poll.thread)`，舊紀錄沒欄位 → `false` |
| `threadParentId(poll)` | `poll.parentChannelId \|\| null` |
| `resolveNoticeRole(table, guildId)` | `{伺服器id: 身分組id}` 查表，查不到回 `''` |

`src/core/pollTemplate.js` 的 `optionDateRange(options, dateStart)`：
選項涵蓋的日期範圍，短格式 `08/18~08/24`；只有一天回 `08/18`；沒有起日回 `null`。
迄日走既有的 `endDateOf()`（不是「起日＋選項數」，同一天分早中晚時那樣會算錯）。

`src/core/pollService.js` 新增私有函式 `openPollThread(client, poll)`：
建串（`autoArchiveDuration: 10080`、`ChannelType.PublicThread`）＋ `setLocked(true)`，
回傳「訊息要發到哪裡」的頻道物件 —— 建串或鎖定失敗回傳母頻道，母頻道 fetch 不到才回 `null`。
`sendPollMessage()` 在 `wantsThread(poll)` 為真時走它，並在既有的 `updatePoll()` 裡把
`record.channelId` 換成 `channel.id`。

`src/core/pollService.js` 另有私有函式 `wakeThread(channel, pollId)`（10-3）：
不是討論串就原樣回傳；是討論串就重抓一次（快取的 `archived` 可能是舊的），
封存了就 `setArchived(false)`。`closePoll()` 取完頻道後套一層，其餘流程不變。

`/poll` 的 `thread`（布林，掛在 `peek` 之後）走現成的 `fromTemplate()`——指令沒填才吃模板。
draft 多帶 `thread` 與 `parentChannelId`。模板的 `thread` 由詳情面板第二列第四顆按鈕
（`tgl` / `thread`）切換，`parseTemplateFields()` 從 `base.thread` 帶過來。

**開串成功時，投票訊息本身會帶上通知身分組的提及**（`content: <@&id>` ＋
`allowedMentions: {roles: [id]}`）。身分組 id 放在 `src/config/environments/*.js` 的
`noticeRoles.poll`，是 `{伺服器id: 身分組id}` 對照表。**退回母頻道時不提及**，
在既有討論串裡下 `thread:false` 的 `/poll` 也不提及。

**`poll` 紀錄的兩個新欄位不需要改讀寫邏輯**：`createPoll()` / `updatePoll()` 都是整份寫檔，
`scheduleNextRound()` 的 `...carried` 也會自動把 `thread` 與 `parentChannelId` 帶進下一輪，
所以每週續辦第二輪拿得到母頻道。

## 進度

- [x] 10-1 `pollStore` 加 `thread` / `parentChannelId` 欄位 ＋ 舊資料相容
- [x] 10-2 `sendPollMessage()` 建串、發訊息、鎖定、改 `channelId`；失敗退回母頻道
- [x] 10-3 `closePoll()` 結算前解封存
- [x] 10-4 `/poll` 的 `thread` 參數
- [x] 10-5 模板的 `thread` 欄位 ＋ 詳情面板切換按鈕
- [x] 10-6 討論串名稱組法與相容判斷的單元測試
- [ ] 10-7 `yarn test` 全套通過（要在測試 jail 跑，等 push 後）
- [ ] 10-8 測試伺服器實機驗收（commit 已完成，見下方步驟）

## 驗收

**單元測試**（**不得 import discord.js**，所以名稱組法要抽成純函式）：

1. 名稱 `【投票】<標題> YYYY-MM-DD` 組得正確；標題過長時截斷後總長不超過 Discord 的 100 字元上限
2. 舊的投票紀錄（沒有 `thread` / `parentChannelId` 欄位）判定為「不開串」，不會是 `undefined` 造成的意外行為
3. 模板的 `thread` 切換：`undefined` → `true` → `false`

**實機（測試伺服器）：**

4. `/poll ... thread:true` → **開出討論串**，名稱格式正確，投票訊息在裡面
4-1. 有 `date_start` 的投票，串名的日期是**選項涵蓋的範圍**（`08/18~08/24`）；沒有 `date_start` 的用今天（`09/03`）
4-2. 串裡的投票訊息**提及 @龍王**（測試站是 GM 身分組），該身分組的成員收得到通知；退回母頻道的情況**不提及**
5. 一般成員在那個討論串**打字被擋**，但**點按鈕、開個人面板、投票都正常**
6. `/poll ... thread:false`（或不帶）→ 行為跟現在完全一樣，直接發在頻道
7. 到期結算 → **結果貼在討論串裡**，原訊息的元件消失
8. `weekly:true` ＋ `thread:true` → 下一輪續辦時**開一個新的討論串**，不是沿用舊的
9. 模板詳情面板有「討論串」切換按鈕，開啟後用該模板建立的投票會開串
10. 把 bot 的「管理討論串」權限拿掉再試 → **投票照樣發得出來（退回母頻道）**，log 有記錄，不是整場投票消失
11. `/poll_admin` 對開在討論串裡的投票：查看結果、編輯、提早結算、取消，全部正常

**權限**：bot 需要 `建立公開討論串`、`在討論串發送訊息`、`管理討論串`。驗收前先確認測試伺服器有給。

**測試 jail 的步驟**（依序，使用者代跑）：

```
/root/update.sh                     # 抓 origin/test
cd /root/BC_djs_bot && yarn test     # 全套約 4 秒，不要單獨跑一支
yarn deploy                          # /poll 多了 thread 參數，只重啟看不到新參數
pm2 restart bc-test
```

`yarn deploy` 這一步**不能省**：斜線指令的參數變動要重新註冊，`commandsHash` 會自己算出內容有變並打 REST，不需要另外改任何檔案。

**驗收清單第 3 項（模板切換）測不到單元測試**：切換邏輯在 `pollTemplateAdmin.js` 的
`handleTemplateAction()`，那支 import 了 `EmbedBuilder`，測試檔不能碰。
改成在 `tests/pollTemplate.test.js` 測 `parseTemplateFields()` 會保留 `base.thread`
（真正會出錯的地方是「編輯模板把開關洗掉」），按鈕本身留給實機第 9 項。

## 決策紀錄

- 2026-08-25　核心作法是「把 `poll.channelId` 換成討論串 id」，不另外加一套討論串專用的發送路徑。理由：三條發布路徑都走 `sendPollMessage()`，下游只認 `channelId`，改一個點就全部到位。
- 2026-08-25　模板用切換按鈕而不是 Modal 欄位。理由：Discord 的 Modal 上限 5 欄，`TEMPLATE_MODAL_FIELDS` 已經滿了。
- 2026-08-25　建串一律用 `parentChannelId`。理由：每週續辦時 `channelId` 已是上一輪的討論串，討論串裡不能再開討論串。
- 2026-08-25　建串或鎖定失敗一律退回母頻道並記 log。理由：投票本身比載體重要。
- 2026-08-25　**結果不在母頻道貼連結**，要轉發用 `/poll_admin`。使用者決定：貼在討論串更乾淨、更好找。
- 2026-08-25　名稱用 `【投票】<標題> YYYY-MM-DD`。使用者決定。
- 2026-08-25　**所有 `/poll` 都能開串**，不限每週投票。使用者決定：一次性投票也常被聊天洗掉。
- 2026-08-25　`/quickpoll` 不做。理由：語音現場的快速投票開討論串沒有意義。
- 2026-08-25　不改用 Modal 輸入身分（交接文件的寫法）。理由：現行的 ephemeral 個人面板支援多角色切換，Modal 做不到，改過去是退步。
- 2026-09-03　（10-1）日期用「毫秒 +8 小時再取 UTC 欄位」算，不用 `Intl` / locale。理由：台灣沒有日光節約，時差固定，而 `Intl` 的行為會被執行環境的 ICU 資料完整度影響（模板列表的中文定序踩過同一個坑）。
- 2026-09-03　（10-1）`buildThreadName()` 過長時只截標題、日期一定保留。理由：每一輪都開新串，名稱沒有日期的話討論串清單會出現一排一模一樣的項目，管理員分不出哪個是這週的。
- 2026-09-03　（10-2）`openPollThread()` 建串失敗時回傳「母頻道物件」而不是 `null`。理由：`sendPollMessage()` 的 `null` 語意是「頻道不存在 → 刪掉這場投票」，建串失敗若也回 `null` 會把整場投票刪掉，正好與「退回母頻道」相反。
- 2026-09-03　（10-2）鎖定失敗只記 warn，不退回母頻道。理由：討論串已經開好、訊息還沒發，退回去只會讓頻道裡多一個空討論串，比「沒鎖上」更亂。
- 2026-09-03　（追加）串名的日期改用**選項涵蓋的範圍**（`08/18~08/24`），選項上沒有日期才用今天。使用者決定：一眼看得出這一輪是哪幾天。格式用 `MM/DD` 短格式，把字數留給標題。
- 2026-09-03　（追加）迄日走既有的 `endDateOf()`，不用「起日＋選項數」。理由：同一天分早中晚三段時，選項數比實際天數多，會算出一個沒涵蓋到的日期（`applyDates` 早就踩過這個坑）。
- 2026-09-03　（追加）開串後提及通知身分組，做法是**把提及放進投票訊息的 `content`**，不另外發一則。使用者決定：討論串裡只留一則訊息比較乾淨。同時帶 `allowedMentions: {roles: [id]}`，只通知這一個身分組。
- 2026-09-03　（追加）身分組 id 放 `config/environments/*.js` 的 `noticeRoles.poll`，是 `{伺服器id: 身分組id}` 對照表。理由：id 綁死在單一伺服器（U07 的教訓），而且正式站與測試站的值不同；沒填到的伺服器就是不提及，不會亂 tag。**正式站只填了 BCKF（`1544967637128323112`）**，第二個伺服器只開放 `/horntail`，刻意留白。
- 2026-09-03　（追加）「有沒有開成討論串」用 `wantsThread(poll) && channel.isThread()` 判斷，不用「`channel.id` 跟 `poll.channelId` 有沒有變」。理由：每週續辦又建串失敗時，`channelId`（上一輪的討論串）跟母頻道本來就不同，用 id 比會誤判成開串成功，變成在母頻道 tag 全體；而只看 `isThread()` 又會讓「在既有討論串裡下 `thread:false` 的 `/poll`」也 tag 人。
- 2026-09-03　（10-4）`parentChannelId` 取 `ctx.channel.isThread() ? ctx.channel.parentId : ctx.channel.id`。理由：有人會在討論串裡下 `/poll`，直接存 `ctx.channel.id` 的話那一場必定建串失敗、每次都退回母頻道。原單元檔寫「`parentChannelId: ctx.channel.id`」，漏了這個情況。
- 2026-09-03　（10-4）開串結果寫進 `/poll` 的 ephemeral 回覆（成功貼討論串連結、失敗說明已退回母頻道）。理由：退回是靜默的，不講的話發起人只會以為參數沒作用；這也讓驗收第 10 項不必去翻 log。
- 2026-09-03　（10-5）模板的 `thread` 不做前置條件檢查（不像 `multiChar` 要身分表）。理由：開串不依賴任何其他設定。舊模板沒有這個欄位，`!undefined` 就是 `true`，第一次按剛好是「開啟」。
- 2026-09-03　（10-6）新增 `tests/pollThread.test.js`，並在 `tests/pollTemplate.test.js` 補兩個 case。理由：前者測 pollStore 的純函式，後者測「編輯模板不會洗掉切換按鈕設的值」——`tests/pollTemplate.test.js` 不在原單元檔的檔案清單裡，已取得使用者同意。
- 2026-09-03　（10-3）解封存前先 `channel.fetch()` 重抓。理由：`archived` 是快取值，封存發生在 bot 離線期間時快取會是舊的（開機還原後補結算正好是這種情況），照舊值判斷就會略過解封存。
- 2026-09-03　（10-3）解封存失敗只記 error、不中斷結算。理由：後面的排下一輪與歸檔不依賴頻道，停在這裡會讓每週投票直接斷掉下一輪；編輯訊息與貼結果本來就各自有 try/catch。
- 2026-09-03　（10-3）只有 `closePoll()` 解封存，`cancelPoll()` / `applyPollEdit()` 不做。理由：那兩條路失敗只會讓一則舊訊息沒更新，不像結算會連帶影響下一輪與歸檔；等實機看到真的有問題再加。
- 2026-09-03　（10-2）`thread` 為真但缺 `parentChannelId` 時，記 error 後改用 `channelId` 當母頻道。理由：這種紀錄理論上不存在（`/poll` 一定會帶、續辦會整份複製），真的遇到時「投票發得出去」比「一定發在討論串」重要。
