# U13　動態語音頻道（Join-to-Create）

狀態：程式完成，待 `yarn test` 與實機驗收
進度：7/9
依賴：U03（`state.js`，已完成）
可平行：可，但**會動 `src/events/voiceStateUpdate/index.js`**，該檔目前是 U04 的領域
分支：**留在 `test`，不要開分支**（見 CLAUDE.md 的單元制第 2 條）
工作目錄：`\fongxiang.duckdns.org\admin_only\Program\Discord_bot\BC_djs_bot_test`
來源：`docs/Functions/Claude_Handover_VoiceChannel.md`

---

## 目標

伺服器只留一個「大廳」語音頻道。有人點進大廳，bot 立刻幫他開一個專屬語音頻道、把他拉過去；
房間裡的人走光就自動刪掉。目的是擺脫對第三方 bot（Yeecord）的依賴。

---

## 現有程式碼給了什麼（不用重做）

| 已經有的 | 在哪 | 怎麼用 |
|---|---|---|
| `GuildVoiceStates` intent | `src/main.js` | U09 已經加了，**不用再動 main.js** |
| `voiceStateUpdate` 事件 | `src/events/voiceStateUpdate/index.js` | 已存在（U04 用它補解除靜音），**要共用不是新建** |
| 跨重啟狀態 | `src/core/state.js` | `getState('voiceRooms')` / `updateState` / `registerRestore` |
| 開機還原掛鉤 | `registerRestore(name, fn)` | `ready` 會自動呼叫，**不用改 `events/ready/index.js`** |
| 排程器 | `src/core/scheduler.js` | `scheduleCron(key, expr, task)`，定期掃空房間用 |
| per-guild 設定的慣例 | `permissionRoles` / `noticeRoles` | `{伺服器id: 值}`，沒填＝該伺服器關閉這個功能 |
| 讀環境設定 | `src/config/index.js` | `import config from '@/config'`，default 就是依 `BOT_ENV` 選好的環境物件，`config.voiceLobbies[guildId]`。這支會讀 `.env`，**測試裡要 `vi.mock('@/config')`** |
| 測試的 logger | `tests/vmute.test.js` 開頭 | 真的 logger 會讓測試 jail 卡住，測試檔要 `vi.mock('@/core/logger')`，照抄即可 |

---

## ⚠️ 交接文件沒處理、但一定會出事的五件事

### 1. `voiceStateUpdate` 已經有人在用，而且它現在就把「離開」擋掉了

```js
//現況（U04 的 vmute 用）
if(!newState.channelId) return          // ← 離開語音就 return，而你要的正是這個情境
if(oldState.channelId === newState.channelId) return
```

**必須把這個檔案改成「分派給兩個功能」**，不能各自 return。建議長這樣：

```js
export const action = async(oldState, newState) => {
    try{ await handleVoiceJoin(...) }  catch(e){ logger.error(...) }   // U04，維持原本的進入判斷
    try{ await handleDynamicVoice(oldState, newState) } catch(e){ logger.error(...) }
}
```

**兩段各自 try/catch**：其中一個失敗不該讓另一個不執行。
事件處理器的 rejection 沒人接得到，會終止整個行程（CLAUDE.md 技術重點第一條）。

### 2. 用 `Set` 記房間 ＋ 靠名稱特徵辨識 → 不要照做

交接文件建議「記憶體 `Set`」加上「檢查頻道名稱特徵或權限覆寫」當重啟防護。
**不要用啟發式的辨識**——誤判的代價是**刪掉伺服器原有的頻道，而且救不回來**。

專案已經有 `state.js`（U03）就是為這種情境做的。改成：

- 建立房間時把 `channelId` 寫進 `state` 的 `voiceRooms` 區段，連同 `guildId`、`ownerId`、`createdAt`
- 開機時 `registerRestore('voiceRooms', …)` 對照紀錄逐一處理：
  - 頻道不存在 → 把紀錄刪掉
  - 頻道在、沒人 → 刪頻道 ＋ 刪紀錄
  - 頻道在、有人 → 留著繼續追蹤

**刪除前的三道防線（這是本單元最危險的地方，比照 U12 的 `isThread()`）：**

```js
if(!record) return                               // ① 不在我們的紀錄裡 → 絕對不碰
if(channelId === lobbyIdOf(guildId)) return      // ② 永遠不刪大廳本身
if(!channel.isVoiceBased()) return               // ③ 型別不對就不刪
```

### 3. 建好頻道卻搬不過去 → 房間永遠留著

`setChannel()` 可能失敗（人已經離開、bot 缺 `MoveMembers`）。
失敗時那個房間是空的，而且**沒有人會再觸發「離開」事件**，所以永遠不會被刪。

**建完立刻搬，搬失敗就馬上把剛建的頻道刪掉**，並記 log。

### 4. 連點大廳會開出一排房間

快速進出大廳會一直觸發建立。交接文件要的是 cooldown，但更自然的作法是：

**先查紀錄——這個人已經有房間就直接把他搬過去，不要開第二間。**
查不到才建立，另外加一道每人 10 秒的 cooldown 當保險。

### 5. 漏接事件的空房間

gateway 斷線重連期間的「最後一人離開」事件會漏掉，那間房就永遠空在那裡。
**用 `scheduleCron` 每 10 分鐘跑一次跟開機完全相同的清理函式**（同一支，不要寫兩份）。

---

## 其他要注意的

| 項目 | 說明 |
|---|---|
| 頻道名稱 | `${displayName}的房間`，**上限 100 字元**，`displayName` 可能很長或含特殊字元，要先截斷 |
| 建在哪 | 大廳的同一個 Category（`lobby.parent`）。大廳沒有 Category 就建在伺服器根層 |
| 給房主的權限 | 照交接文件：`ViewChannel`、`Connect`、`ManageChannels`、`MoveMembers`。**注意 `ManageChannels` 讓房主可以自己刪掉房間**，刪除時要能吃 `10003 Unknown Channel` |
| bot 需要的權限 | `ManageChannels` ＋ `MoveMembers`（寫進單元檔與啟動檢查都好） |
| 設定 | **已經填好了**（見下方「大廳頻道」），你不用再動環境檔。格式是 `voiceLobbies: {伺服器id: 大廳頻道id}`
| Discord 的限制 | 「更新或刪除同一個頻道」是 **2 次 / 10 分鐘**。我們每間房只刪一次，不受影響；但**不要**做自動改名之類會重複打同一個頻道的功能 |

---

## 大廳頻道（2026-10-01 已設定）

| 環境 | 伺服器 | 大廳頻道 id |
|---|---|---|
| 測試站 | `974484668252565544` | `974484668906868766` |
| 正式站 | `820702012592619570` | `1238173847430107136` |

正式站的第二個伺服器（`1540261363639648318`）**刻意不設**，那邊只開放 `/horntail`。
沒設定的伺服器就是不啟用，不會有任何動作。

**這兩個 id 是清理邏輯的白名單**：第二道防線就是拿它比對，確保大廳本身永遠不會被刪。

## 相關檔案

**要新增的：**

| 檔案 | 職責 | 碰 discord.js？ |
|---|---|---|
| `src/config/voiceRoom.js` | 房名樣板、名稱長度上限、cooldown 秒數、掃描間隔 | 否 |
| `src/core/voiceRoom.js` | 建立／搬移／刪除／紀錄讀寫／開機與定期清理 | 否（照 vmute.js，物件由呼叫端傳入） |
| `tests/voiceRoom.test.js` | 純邏輯：房名組法與截斷、該不該刪的判斷、cooldown；另用假造的 guild 測 `cleanupRoom` 的三道防線 | 否 |

> 可刪除的判斷抽成純函式 `decideCleanup()`，輸出 `{action: delete|forget|keep, reason}`（見決策紀錄），
> 那是本單元唯一有邏輯的地方，也是最該測的地方。

**要改的：**

| 檔案 | 改什麼 |
|---|---|
| `src/events/voiceStateUpdate/index.js` | 改成分派給 U04 與本單元兩段，各自 try/catch（見上面第 1 點）。**這是 U04 的領域，動之前先 `git status` 確認沒有別人未 commit 的改動** |
| `src/config/environments/production.js`、`test.js` | 各加 `voiceLobbies` |

**只讀，一定要看的：**

| 檔案 | 你需要知道的事 |
|---|---|
| `src/core/vmute.js` | **本單元的最佳範本**：`registerRestore()` 怎麼用、state 怎麼讀寫、Discord 操作失敗怎麼吞、純函式怎麼跟 discord.js 分開 |
| `src/core/state.js` | `getState` / `updateState` / `registerRestore`。路徑在呼叫時才解析，測試可用 `STATE_DATA_DIR` 指到暫存資料夾 |
| `src/core/pollArchive.js` 的 `deletePollThread()` | **刪東西前要怎麼層層確認**的實例，三道防線的寫法照抄它 |
| `src/core/scheduler.js` | `scheduleCron(key, expression, task)`，key 要帶前綴 |
| `src/config/environments/test.js` | `permissionRoles` / `noticeRoles` 的 per-guild 寫法 |

---

## 進度

- [x] 13-1a 兩個環境檔加 `voiceLobbies`（2026-10-01 由專案經理填入，id 見下）
- [x] 13-1b `src/config/voiceRoom.js`（房名樣板、長度上限、cooldown 秒數、掃描間隔）
- [x] 13-2 純邏輯 ＋ `tests/voiceRoom.test.js`（房名截斷、可刪判斷、cooldown）
- [x] 13-3 `src/core/voiceRoom.js`：建立 → 搬移 → 失敗就刪掉剛建的
- [x] 13-4 紀錄寫進 `state` 的 `voiceRooms` 區段
- [x] 13-5 離開時清理（三道防線）
- [x] 13-6 開機 `registerRestore` 對帳 ＋ `scheduleCron` 每 10 分鐘掃一次（**同一支函式**）
- [x] 13-7 `voiceStateUpdate` 改成雙功能分派
- [ ] 13-8 `yarn test` 全套通過
- [ ] 13-9 測試伺服器實機驗收，commit

## 驗收

**單元測試**（不得 import discord.js）：

1. 房名用 `${displayName}的房間`；displayName 超長時截斷後總長 ≤ 100
2. 不在紀錄裡的頻道 → 判定「不可刪」
3. **大廳本身即使空著也判定「不可刪」**
4. 紀錄裡、頻道存在、人數 0 → 可刪
5. 紀錄裡、人數 > 0 → 不可刪
6. 同一個人在 cooldown 內再次觸發 → 不建立第二間

**實機（測試伺服器）：**

每一步都看 pm2 log（`pm2 logs bc-test`）：每次判斷都有一行 `voiceRoom 清理判斷(...)` 或 `voiceRoom 大廳判斷`，
內容含紀錄有無、大廳 id、存在、型別、人數與 `→ action(reason)`。開機時應看到 `voiceRoom 啟用：guild=… 大廳=…`，
缺權限會有 `bot 缺少權限` 警告。

7. 點進大廳 → 自動開房並被拉進去，房名正確，房主能改名與調位元率
8. 自己離開、房間沒人 → 房間消失
9. 兩個人在房內，房主先走 → **房間還在**；最後一人走 → 才消失
10. 連續快速進出大廳五次 → **只會有一間房**，log 看得到跳過的紀錄
11. 房主自己把房間刪掉 → bot 不報錯，紀錄跟著清掉
12. 房間裡有人時重啟 bot → 房間還在、紀錄還在，人走光後仍會被刪
13. **bot 離線時把人清空再開機** → 開機時那間空房被刪掉
14. ⚠️ **伺服器原有的靜態語音頻道（空的也一樣）→ 完全不受影響**（最重要的一條）
15. 把 bot 的 `MoveMembers` 權限拿掉再點大廳 → **不會留下空房間**（建了要馬上刪掉），log 有紀錄

## 決策紀錄

- 2026-10-01　**不用記憶體 `Set` ＋ 名稱特徵辨識**（交接文件的建議），改用 `state.js` 持久化紀錄。理由：啟發式辨識誤判的代價是刪掉伺服器原有頻道，而且救不回來；U03 的 state 就是為跨重啟狀態做的。
- 2026-10-01　刪除前三道防線：不在紀錄裡不碰、永遠不刪大廳、型別不對不刪。理由：比照 U12 刪討論串的 `isThread()` 教訓。
- 2026-10-01　搬移失敗要立刻刪掉剛建的頻道。理由：空房間沒有人會再觸發「離開」事件，不主動刪就永遠留著。
- 2026-10-01　重複觸發時「搬去既有房間」優先於 cooldown。理由：那才是使用者真正想要的行為，cooldown 只是保險。
- 2026-10-01　定期掃描與開機清理共用同一支函式。理由：兩份實作遲早會不一致，而不一致的那一份會安靜地刪錯東西。
- 2026-10-01　設定用 per-guild 的 `voiceLobbies`，沒設定＝不啟用。理由：與 `permissionRoles` / `noticeRoles` 一致，正式站有兩個伺服器。
- 2026-10-01　`src/config/voiceRoom.js` 只放數值不放邏輯，匯出方式照 `polls.js`（大寫具名常數 ＋ default 物件）。房名存「後綴」而不是樣板字串，截斷時只截 displayName、後綴永遠保留；另加 `ROOM_NAME_FALLBACK` 處理 displayName 全空白。理由：樣板字串要再解析才知道哪一段能截，後綴寫法讓截斷邏輯單純、可測。
- 2026-10-01　`src/core/voiceRoom.js` 不 import discord.js（原檔案表寫「是」，已更正），`ChannelType.GuildVoice`(2)、`10003` 直接寫值，權限用字串。理由：照 vmute.js，純函式與實際執行的程式在同一支檔，測試測的就是正式在跑的那份。
- 2026-10-01　`decideCleanup()` 輸出 `{action, reason}` 而不是布林，三種動作：`delete`（刪頻道＋紀錄）、`forget`（只刪紀錄，絕不刪頻道）、`keep`。理由：log 要寫得出「為什麼刪／為什麼不刪」；布林只看得到結果。
- 2026-10-01　輸入不合法（`exists`／`isVoice` 不是真正的布林、人數不是 ≥0 整數、缺 channelId）一律 `keep`。理由：最近兩次故障都是條件拿到錯的輸入後安靜走錯分支；`undefined` 不能被當成 `false` 或 `0`。
- 2026-10-01　第二道防線比對**所有**伺服器的大廳 id，不只本伺服器；另加「紀錄的 guildId 與目前伺服器不符 → keep」。理由：guildId 傳錯時只比本伺服器會安靜地比對不到，大廳就失去保護。
- 2026-10-01　第三道防線用 `channel.type === GuildVoice`，不用 `isVoiceBased()`。理由：後者連舞台頻道也算，我們開的房間只會是一般語音，條件越窄越安全。
- 2026-10-01　**先寫紀錄再搬人**（原計畫是搬成功才寫）。理由：搬失敗時要刪掉剛建的頻道，這樣它也走 `cleanupRoom()` 的三道防線，全專案只有一條刪除路徑，沒有「不經紀錄直接刪」的例外。紀錄寫入失敗時**不刪**，記 error 請人手動處理（不在紀錄裡就不碰，沒有例外）。
- 2026-10-01　抓頻道時區分 `10003`（確定不存在 → 清紀錄）與其他錯誤（暫時抓不到 → 不判斷、紀錄保留）。理由：把暫時性錯誤當成不存在，紀錄會被丟掉，那間房就再也沒人記得要刪。
- 2026-10-01　新房間的權限覆寫 = 抄大廳的覆寫 ＋ 房主四個權限。理由：建立時有給 `permissionOverwrites` 就不會繼承 Category，不抄的話，限定身分組可見的分類底下會多出一間所有人都看得到的房間。
- 2026-10-01　cooldown 的時間在「決定建立」的同一個同步區段就記下（在任何 await 之前）。理由：建立途中第二個事件進來時要能被擋下。cooldown 只在記憶體，重啟歸零，可接受（它只是保險）。
- 2026-10-01　判斷 log：有設定大廳的伺服器，每一次「清理判斷」與「大廳判斷」都寫 info，含全部輸入與結果（包括 `not-tracked`）。沒設定大廳的伺服器完全不寫。理由：`not-tracked` 也要留下，否則「紀錄 key 對不上、房間永遠不刪」這種錯在 log 上會完全安靜；未啟用的伺服器是設定上的刻意關閉，開機時已記一行「啟用：guild=…」。

### 靜態分析的推論，待實機確認（信心：中）

- 開機清理時 `channel.members.size` 是否已正確：依賴 discord.js 在 `ready` 前已收齊各伺服器的語音狀態。若不正確，有人的房間會在開機時被當成空房刪掉（只影響我們開的房，不影響靜態頻道）。→ 實機第 12 條驗證。
- 「離開」事件觸發時 `channel.members` 已經是離開後的人數：依賴 discord.js 先更新快取再發事件。→ 實機第 8、9 條驗證。
- 抄大廳覆寫時，若覆寫裡有 bot 自己沒有的權限，建立會失敗（50013），log 會有「建立房間失敗」。→ 實機第 7 條若失敗先看這裡。
