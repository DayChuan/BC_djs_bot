# U09　暗黑龍王計時器 `/horntail`

狀態：可開工（規格已確認）
進度：0/10
依賴：**無**（不需要 U03 的 `state.js`，見「為什麼不做持久化」）
工作目錄：`\\fongxiang.duckdns.org\admin_only\Program\Discord_bot\BC_djs_bot_test`
（**不是**同層的 `BC_djs_bot`，那是已無作用的舊目錄）
可平行：可，全部是新檔案
分支：**留在 `test`，不要開分支**（見 CLAUDE.md 的單元制第 2 條）
來源：`docs/Functions/Claude_Handover_Horntail_Timer.md`

---

## 目標

一則公開面板，三顆按鈕分別對應暗黑龍王的三個招式，點下去開始倒數，剩 5 秒語音提醒，歸零後自動接下一輪，再點一次停止。

| 招式 | 預設秒數 | customId |
|---|---|---|
| 吐火 | 60 | `ht:t:<面板id>:fire` |
| 左手消技 | 90 | `ht:t:<面板id>:dispel` |
| 黑鎖 | 60 | `ht:t:<面板id>:lock` |

---

## 交接文件沒有處理、但一定會出事的四件事

這一節是本單元的重點。照著交接文件的寫法直接做，上線當天就會壞。

### 1. 每秒編輯訊息會撞上 Discord 的速率限制

文件寫「每 1～2 秒編輯一次原訊息」，而且是三個招式各自 `setInterval`。三個計時器同時跑就是**每秒三次編輯**。Discord 對「編輯訊息」的限制大約是**每個頻道 5 次 / 5 秒**，一分鐘內就會開始吃 429，接著整個 bot 的 API 都會被拖慢。

**做法**：整個面板**只有一個** `setInterval`，一秒 tick 一次只更新記憶體裡的數字，**每 2 秒才實際編輯一次訊息，而且三個招式合併成同一次編輯**。這樣是 0.5 次/秒，安全。

同一個頻道**同時只允許一個面板**。第二次下指令時，把舊面板停掉再開新的——否則兩個面板就是兩倍的編輯量，而且畫面上會有兩份互相矛盾的倒數。

### 2. 沒有結束條件 ＝ 永遠不會停的 API 呼叫

文件寫「倒數至 0 秒不停止，自動重置繼續下一輪，直到使用者再次點擊」。如果打完王大家直接關掉 Discord，這個面板會**每 2 秒編輯一次訊息，直到 bot 重啟為止**。

`/quickpoll` 踩過同一個坑，當初的結論是「語音現場的東西沒有人會記得回來收尾」。

**做法**：面板有**總時限 2 小時**，到時自動停掉所有計時器並把按鈕移除，訊息改成「面板已結束」。另外連續 30 分鐘沒有任何人按過按鈕也自動收掉。

### 3. TTS 不會在語音頻道發出聲音

這是最需要你先確認的一點。Discord 的 `tts: true` 是**文字轉語音訊息**：它由**接收者的用戶端**朗讀，而且只有在

- 那個人的 Discord 設定裡開了 TTS（**預設是關的**），而且
- 他當下正在看那個文字頻道

兩個條件都成立時才會出聲。**它不會播進語音頻道**，所以在語音裡打王的人，絕大多數聽不到。

**做法（2026-08-21 使用者確認：採用 TTS 就好，主要的人聽得到即可）**：實作 TTS 訊息，不加任何相依套件。**面板的說明文字一定要寫「要在 Discord 設定開啟文字轉語音才聽得到」**，否則聽不到的人會以為功能壞了。

語音頻道播放（`@discordjs/voice`）**不在本單元範圍**，之後真有需要再另開單元。

### 4. TTS 訊息會把頻道洗版

三個招式循環，60/90/60 秒各提醒一次，等於**每分鐘約三則訊息**，打一場王下來就是上百則。

**做法**：TTS 訊息發出後 **5 秒自動刪除**。刪除失敗一律吞掉只記 log（訊息可能已被人手動刪掉），這段程式在計時的路徑上，不能因為清垃圾失敗就把計時器打斷。

### 5. 權限：只有 GM 身分組能操作

2026-08-21 使用者確認：**指令與按鈕都限 GM 身分組**。

Discord 的 `setDefaultMemberPermissions()` **只吃權限位元，不吃身分組**，所以身分組的檢查一定要寫在 handler 裡：

```js
member.roles.cache.has(config.permissionRoles.gm)
```

指令與每一次按鈕互動**都要各檢查一次**。只檢查指令是不夠的——面板是公開訊息，任何人都看得到那三顆按鈕，按下去就是一次 interaction。

**設定放哪**：新增 `permissionRoles: {gm: '<身分組 id>'}` 到兩個環境檔。**不要塞進現有的 `roles`**——那個欄位是「emoji → 身分組」的自助領取清單，`src/core/selfRoles.js` 會拿它的每一個值當成可自助領取的身分組，塞進去等於讓所有人可以自己領 GM。

**沒設定時要 fail closed**：`permissionRoles.gm` 是空字串的話，退回「只有管理員能用」，不是「所有人都能用」。少了這一行，任何一個環境忘了填 id 就會全開。

**一個已知的小瑕疵**：`/help` 是讀各指令的 `default_member_permissions` 來過濾的，看不到身分組條件，所以 `/horntail` 會列給所有人看。非 GM 的人點了會得到一則 ephemeral 的拒絕訊息。這不影響安全性，先接受；真的礙眼再在 `src/core/helpText.js` 加一個 roleGated 標記。

---

## 為什麼不做持久化

`state.js`（U03）現在停擺，但這個單元不需要它。

計時器是**現場工具**，bot 重啟時大家還在打王的機率很低；就算真的重啟了，正確的行為也是重開一個面板，而不是還原一個已經和實際戰況脫節的倒數。所以狀態只放記憶體。

但**重啟後的舊面板必須處理**：那則訊息還在頻道裡、按鈕還在，記憶體裡卻已經沒有它的狀態。點下去要回一句 ephemeral 的「這個面板已經失效，請重新輸入 `/horntail`」，不能報錯也不能沒反應。

---

## 檔案配置

**要新增的：**

| 檔案 | 職責 | 碰 discord.js？ |
|---|---|---|
| `src/config/horntail.js` | 招式表（名稱、秒數、key）、總時限、閒置上限、編輯間隔。**改秒數只改這裡** | 否 |
| `src/core/timerState.js` | 純狀態機：建立面板狀態、start/stop、tick 一秒、判斷「該提醒了」「該重置了」、格式化剩餘秒數 | **否（要單元測試）** |
| `src/core/timerRender.js` | Embed 與三顆按鈕、customId 的組成與解析 | 是 |
| `src/core/timerService.js` | 單一 tick 迴圈、節流編輯、TTS 發送與自動刪除、面板生命週期、一頻道一面板 | 是 |
| `src/commands/horntail/index.js` | 指令。匯出 `command` 與 `action`，loader 會自動掃到 | 是 |

**要改的：**

| 檔案 | 改什麼 |
|---|---|
| `src/events/interactionCreate/index.js`（278 行） | 在 `isButton()` 的分派鏈裡加 `ht:` 前綴。**注意順序**：現有的鏈是 `parseTemplateCustomId`（`ptpl:`）→ `parseAdminCustomId`（`padm:`）→ `parsePollCustomId`（`poll:`），每個認不出來就回 `null` 往下走。`ht:` 不會被任何既有 parser 誤認 |
| `src/config/environments/test.js`、`production.js` | 各加 `permissionRoles: {gm: '<id>'}`。**兩個檔案的結構必須完全一致**，`src/config/index.js` 的 `validate()` 會在啟動時比對。id 見下方「待你確認」 |

**只讀，這個單元一定要看的：**

| 檔案 | 你需要知道的事 |
|---|---|
| `src/commands/quickpoll/index.js`（約 100 行） | **指令檔的標準寫法**：`SlashCommandBuilder`、`setDefaultMemberPermissions`、`deferReply({flags: MessageFlags.Ephemeral})`、失敗時用 `editReply` 回友善訊息 |
| `src/core/pollRender.js` 的 `POLL_PREFIX` / `customId()` / `parsePollCustomId()`（檔案前段） | customId 的組成與解析範本。**customId 上限 100 字元**，而且它是從用戶端送回來的，**不可信任**，解析後一定要驗格式 |
| `src/core/pollRender.js` 的 `buildQuickMessage()`（檔案後段） | Embed ＋ 按鈕列的組法。按鈕只有藍(`Primary`)、紅(`Danger`)、灰(`Secondary`)、綠(`Success`)四色，**沒有黃色** |
| `src/core/scheduler.js`（209 行） | 這個單元**用不到它**——`node-cron` 是給「每天幾點」這種排程用的，秒級 tick 用 `setInterval` 就好。但總時限那個一次性的關閉可以用 `scheduleAt(key, when, task)` |
| `src/core/ephemeralTracker.js`（64 行） | 面板是**公開訊息**，不是 ephemeral，所以**不要**經過 tracker。只有「已失效」那種一次性的 ephemeral 回覆才需要 `trackEphemeral()` |
| `src/core/logger.js` | `export default logger`，`info` / `warn` / `error` |
| `src/config/index.js`（96 行） | `config.guildIds`、`config.channels`。這個單元目前不需要新增設定欄位 |

---

## 設計重點

**面板 id**：用 `channelId` 當 key 就夠了（一頻道一面板），customId 裡不必再塞訊息 id，省下字元。格式 `ht:t:<channelId>:<招式key>`，另有 `ht:stop:<channelId>` 全部停止。

**面板訊息用 `channel.send()`，不要用 interaction 的回覆。** 指令的回覆是 webhook 訊息，**壽命 15 分鐘**，之後就編輯不了了，而面板要活兩小時。指令本身回一則 ephemeral 的「面板已建立」即可。

**按鈕互動一律先 `deferUpdate()`**，實際的畫面更新交給 tick 迴圈的下一次編輯，不要在互動裡各自編輯一次——那等於把速率限制的分母又乘上人數。

**tick 迴圈只有一個**，掛在 service 模組的模組層級，管理所有頻道的面板；沒有任何面板在跑時要 `clearInterval` 把它收掉，不要讓一個空轉的迴圈永遠留著。

**時間用絕對時間戳算，不要累加 tick 次數。** `setInterval` 在有負載時會漂移，累加法打完一場王可能差好幾秒。每次 tick 都用 `結束時間 - Date.now()` 重算。

---

## 進度

- [ ] 09-1 `src/config/horntail.js` ＋ `src/core/timerState.js`（純狀態機）
- [ ] 09-2 `tests/timerState.test.js`
- [ ] 09-3 `src/core/timerRender.js`（Embed、按鈕、customId 組解）
- [ ] 09-4 `src/core/timerService.js`：單一 tick、節流編輯、一頻道一面板
- [ ] 09-5 TTS 提醒 ＋ 5 秒後自動刪除
- [ ] 09-6 總時限 2 小時、閒置 30 分鐘自動收掉、重啟後的舊面板處理
- [ ] 09-7 GM 身分組檢查（指令 ＋ 每次按鈕互動，沒設定時 fail closed）＋ 兩個環境檔加 `permissionRoles`
- [ ] 09-8 `/horntail` 指令 ＋ `interactionCreate` 分派
- [ ] 09-9 jail `yarn test` 通過
- [ ] 09-10 測試伺服器實機驗收，commit

## 驗收

**單元測試**（`tests/timerState.test.js`，**不得 import discord.js**，所以 `timerState.js` 要跟 Discord 完全分離）：

1. start 之後剩餘秒數隨時間遞減；用假時間戳推進，不要真的等
2. 剩 5 秒時「該提醒」為真，且**同一輪只會為真一次**（連續 tick 不會重複觸發）
3. 歸零後自動重置為初始秒數，並開始下一輪
4. stop 之後不再遞減，再 start 從初始秒數重新開始
5. 剩餘秒數的格式化：90 秒顯示為 `1:30`
6. 三個招式各自獨立，停掉其中一個不影響另外兩個

**實機**（測試伺服器）：

1. `/horntail` → 出現面板，三顆按鈕、三個招式都顯示初始秒數
2. 按「吐火」→ 開始倒數，畫面每 2 秒更新一次
3. 倒數到剩 5 秒 → 出現 TTS 訊息並在 5 秒後自己消失
4. 歸零 → 自動回到 60 秒繼續跑，不需要再按
5. 再按一次「吐火」→ 停止，另外兩個招式不受影響
6. 三個同時跑 30 分鐘 → **log 裡沒有 429**（這條是本單元最重要的驗收）
7. 同一頻道再下一次 `/horntail` → 舊面板停掉並標示已結束，只有新的在跑
8. 重啟 bot 後點舊面板的按鈕 → 回「面板已失效，請重新輸入 `/horntail`」，bot 不報錯
9. **非 GM 的人下 `/horntail`** → 被拒絕，沒有面板產生
10. **非 GM 的人點面板上的按鈕** → 被拒絕，計時器狀態完全沒變（這一條比第 9 條重要：面板是公開的，按鈕誰都看得到）
11. 把 `permissionRoles.gm` 故意改成空字串 → 只有管理員能用，**不是所有人都能用**

---

## 待你確認

**GM 身分組的 id**（正式站與測試站各一個）。這一項只擋 09-7，前面六步都可以先做。

拿到之後填進 `src/config/environments/production.js` 與 `test.js` 的 `permissionRoles.gm`。

## 決策紀錄

- 2026-08-21　狀態只放記憶體，不做持久化。理由：計時器是現場工具，重啟後正確的行為是重開而不是還原。
- 2026-08-21　整個面板共用一個 tick 與一次編輯，2 秒一次。理由：三個招式各自每秒編輯會撞 Discord 的速率限制。
- 2026-08-21　加上總時限 2 小時與閒置 30 分鐘自動收掉。理由：無限循環的面板等於永不停止的 API 呼叫，`/quickpoll` 已經踩過。
- 2026-08-21　TTS 訊息發出後 5 秒自動刪除。理由：每分鐘約三則，一場王下來會洗版。
- 2026-08-21　面板用 `channel.send()` 而非 interaction 回覆。理由：interaction 的 webhook 訊息 15 分鐘後就編輯不了。
- 2026-08-21　**採用 TTS 訊息，不做語音頻道播放。** 使用者確認「主要注意的人聽得到就好」。
- 2026-08-21　**指令與按鈕都限 GM 身分組**，設定放 `permissionRoles.gm`，沒設定時退回只有管理員能用。使用者指定。
