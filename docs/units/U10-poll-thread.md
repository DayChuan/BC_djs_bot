# U10　投票開在鎖定的討論串裡

狀態：可開工（規格已確認）
進度：0/8
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

## 進度

- [ ] 10-1 `pollStore` 加 `thread` / `parentChannelId` 欄位 ＋ 舊資料相容
- [ ] 10-2 `sendPollMessage()` 建串、發訊息、鎖定、改 `channelId`；失敗退回母頻道
- [ ] 10-3 `closePoll()` 結算前解封存
- [ ] 10-4 `/poll` 的 `thread` 參數
- [ ] 10-5 模板的 `thread` 欄位 ＋ 詳情面板切換按鈕
- [ ] 10-6 討論串名稱組法與相容判斷的單元測試
- [ ] 10-7 `yarn test` 全套通過
- [ ] 10-8 測試伺服器實機驗收，commit

## 驗收

**單元測試**（**不得 import discord.js**，所以名稱組法要抽成純函式）：

1. 名稱 `【投票】<標題> YYYY-MM-DD` 組得正確；標題過長時截斷後總長不超過 Discord 的 100 字元上限
2. 舊的投票紀錄（沒有 `thread` / `parentChannelId` 欄位）判定為「不開串」，不會是 `undefined` 造成的意外行為
3. 模板的 `thread` 切換：`undefined` → `true` → `false`

**實機（測試伺服器）：**

4. `/poll ... thread:true` → **開出討論串**，名稱格式正確，投票訊息在裡面
5. 一般成員在那個討論串**打字被擋**，但**點按鈕、開個人面板、投票都正常**
6. `/poll ... thread:false`（或不帶）→ 行為跟現在完全一樣，直接發在頻道
7. 到期結算 → **結果貼在討論串裡**，原訊息的元件消失
8. `weekly:true` ＋ `thread:true` → 下一輪續辦時**開一個新的討論串**，不是沿用舊的
9. 模板詳情面板有「討論串」切換按鈕，開啟後用該模板建立的投票會開串
10. 把 bot 的「管理討論串」權限拿掉再試 → **投票照樣發得出來（退回母頻道）**，log 有記錄，不是整場投票消失
11. `/poll_admin` 對開在討論串裡的投票：查看結果、編輯、提早結算、取消，全部正常

**權限**：bot 需要 `建立公開討論串`、`在討論串發送訊息`、`管理討論串`。驗收前先確認測試伺服器有給。

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
