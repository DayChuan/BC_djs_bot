# U13　動態語音頻道（Join-to-Create）

狀態：可開工
進度：0/9
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
| 設定 | 新增 `voiceLobbies: {伺服器id: 大廳頻道id}`，**兩個環境檔結構要一致**（`config/index.js` 的 `validate()` 會比對）。沒設定＝該伺服器不啟用 |
| Discord 的限制 | 「更新或刪除同一個頻道」是 **2 次 / 10 分鐘**。我們每間房只刪一次，不受影響；但**不要**做自動改名之類會重複打同一個頻道的功能 |

---

## 相關檔案

**要新增的：**

| 檔案 | 職責 | 碰 discord.js？ |
|---|---|---|
| `src/config/voiceRoom.js` | 房名樣板、名稱長度上限、cooldown 秒數、掃描間隔 | 否 |
| `src/core/voiceRoom.js` | 建立／搬移／刪除／紀錄讀寫／開機與定期清理 | 是 |
| `tests/voiceRoom.test.js` | 純邏輯：房名組法與截斷、該不該刪的判斷、cooldown | 否 |

> 可刪除的判斷請抽成純函式（輸入「紀錄、頻道是否存在、人數、是不是大廳」→ 輸出布林），
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

- [ ] 13-1 `src/config/voiceRoom.js` ＋ 兩個環境檔加 `voiceLobbies`
- [ ] 13-2 純邏輯 ＋ `tests/voiceRoom.test.js`（房名截斷、可刪判斷、cooldown）
- [ ] 13-3 `src/core/voiceRoom.js`：建立 → 搬移 → 失敗就刪掉剛建的
- [ ] 13-4 紀錄寫進 `state` 的 `voiceRooms` 區段
- [ ] 13-5 離開時清理（三道防線）
- [ ] 13-6 開機 `registerRestore` 對帳 ＋ `scheduleCron` 每 10 分鐘掃一次（**同一支函式**）
- [ ] 13-7 `voiceStateUpdate` 改成雙功能分派
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
