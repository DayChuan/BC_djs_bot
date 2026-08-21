# U04　語音暫時靜音 `/vmute`

狀態：未開始
進度：0/11（階段一 0/6、階段二 0/5）
依賴：U03（到期時間要撐過重啟）
可平行：可（新指令為主，不動既有檔案）
分支：`unit/U04-vmute`
來源：原 PLAN.md Phase 3

---

## 目標

把語音頻道裡的成員做**伺服器端靜音**，時間到自動解除。分兩階段做，階段一先讓功能會動，階段二再加上防濫用的投票機制。

---

## 階段一　管理員直接靜音（先做）

**指令**：`/vmute user:<成員> seconds:<選單> [reason:<文字>]`

| 項目 | 內容 |
|---|---|
| 權限 | `setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers)`，只有具「靜音成員」權限的人看得到 |
| `user` | 必填。**只能是發起人當下所在語音頻道裡的成員**，不在同一個頻道就拒絕 |
| `seconds` | 必填，`addChoices` 六個級距：60 / 120 / 180 / 240 / 300 / 600（1～5 分鐘 ＋ 10 分鐘） |
| `reason` | 選填，寫進 audit log 與 bot 的 log |
| 實作 | `await member.voice.setMute(true, reason)`；到期 `setMute(false)` |
| 持久化 | 到期時間寫進 U03 的 state（區段名 `vmute`），開機還原，**已過期的立即解除** |

**邊界處理**（每一項都要有明確回覆，不能讓指令靜默失敗）：

- 發起人不在語音頻道 → 拒絕
- 目標不在發起人的語音頻道 → 拒絕
- 目標已被靜音 → 覆蓋為新的到期時間（不是疊加）
- 目標是 bot 自己或伺服器擁有者 → 拒絕
- `50013 Missing Permissions`（bot 身分組低於目標，或沒有靜音成員權限）→ 友善訊息 ＋ 寫 log，不能讓行程掛掉
- 到期解除時目標已離開語音 → `setMute(false)` 會失敗，吞掉只記 log；state 那筆照樣清掉

**注意**：這是**伺服器靜音**，不是 Discord 內建的 timeout。內建 timeout 會連文字訊息一起禁掉、到期由 Discord 端處理；伺服器靜音只影響語音，但**到期解除必須由我們自己記時**，這就是為什麼要依賴 U03。

### 階段一進度

- [ ] 04-1 `src/commands/vmute/index.js` 指令骨架與六個 choices
- [ ] 04-2 `src/core/vmute.js`：`mute()` / `unmute()` / 到期排程 / state 讀寫
- [ ] 04-3 同語音頻道的檢查與所有邊界回覆
- [ ] 04-4 開機還原（過期立即解除、未過期重掛排程）
- [ ] 04-5 `tests/vmute.test.js`（純邏輯：剩餘時間計算、過期判定、參數驗證）
- [ ] 04-6 jail ＋ 測試伺服器驗收，commit

---

## 階段二　一般成員發起投票靜音（階段一驗收後再做）

**動機**：階段一的權限直接開放給所有人一定會被濫用，但只留給管理員又等於現場沒人可用。

**流程**：

1. 一般成員下 `/vmute`（同一個指令，權限判斷在 handler 裡而不是在 `setDefaultMemberPermissions`）
2. bot 在該文字頻道發起一場**二選一投票**：同意靜音 / 反對
3. **只有當下在同一個語音頻道的人**投的票才算數，被提名的對象本人不算票
4. 1 分鐘後結算；若「語音頻道內扣掉被提名者之後的所有人都投完了」就**提早結算**
5. 同意票**超過 50%** 才執行靜音

**規則**（2026-08-20 使用者確認）：

| 項目 | 值 |
|---|---|
| 最低人數 | **語音頻道內至少 3 人**（含被提名者）才受理，不足就回覆「人數不足，請找管理員」 |
| 計票母數 | 語音頻道內的人數**扣掉被提名者**（不是「已投票的人數」） |
| 通過門檻 | 同意票 / 母數 **> 50%**。剛好 50% 不通過 |
| 投票靜音的時長 | 固定 60 秒，不給選（時長也開放選會讓投票變成兩段式） |
| 冷卻 | 同一個提名對象 10 分鐘內只能被發起一次，同一個發起人 5 分鐘一次 |
| 不可提名 | 具「靜音成員」權限的人、bot |

> **母數用「語音頻道內的人數」而不是「已投票人數」**是刻意的：用已投票人數當分母的話，
> 一個人投同意、其他人都不投，就變成 100% 通過。用頻道人數當分母，不投票等同於反對，
> 這也是「全員投完就提早結算」這條規則能成立的前提——母數本來就是固定的。
>
> 母數在**發起當下**就固定下來。中途有人離開或加入語音都不重新計算，否則被提名者
> 只要拉人進頻道就能讓門檻永遠達不到。

### 階段二進度

- [ ] 04-7 權限分流：有 `MuteMembers` 走階段一，沒有走投票
- [ ] 04-8 `src/core/vmuteVote.js`：發起、計票、提早結算條件、通過後執行靜音
- [ ] 04-9 冷卻與不可提名的防濫用檢查
- [ ] 04-10 `tests/vmuteVote.test.js`（計票、門檻、提早結算條件，全部純函式）
- [ ] 04-11 測試伺服器驗收，commit

---

## 相關檔案

**要新增的：**

- `src/commands/vmute/index.js` — 指令定義與參數驗證。匯出 `command`（`SlashCommandBuilder`）與 `action`，`src/core/loader.js` 會自動掃到，不需要改 loader
- `src/core/vmute.js` — 靜音本體與到期管理
- `src/core/vmuteVote.js` — 階段二才建

**要改的：**

| 檔案 | 改什麼 |
|---|---|
| `src/events/ready/index.js` | 加一項開機還原（用檔案裡的 `safely()` 包起來） |
| `src/events/interactionCreate/index.js`（278 行） | 階段二才需要：在 `isButton()` 的分派鏈裡加一段 `vmute:` 前綴的處理。**注意分派順序**——現有的鏈是先 `parseTemplateCustomId` → `parseAdminCustomId` → `parsePollCustomId`，每個 parser 認不出來就回 `null` 往下走，新增的前綴要挑一個不會被既有 parser 誤認的字串 |

**只讀，這個單元一定要看的：**

| 檔案 | 你需要知道的事 |
|---|---|
| `src/commands/quickpoll/index.js`（88 行） | **階段一的指令寫法直接照抄這一份**：`SlashCommandBuilder` ＋ `addChoices` ＋ `setDefaultMemberPermissions` ＋ `deferReply({flags: MessageFlags.Ephemeral})` ＋ 失敗時 `editReply` 友善訊息的完整範例。階段二的投票也可以參考它怎麼呼叫 `createAndPublish()` |
| `src/core/state.js`（U03 產出） | `getState('vmute')` / `updateState('vmute', fn)` |
| `src/core/scheduler.js`（209 行） | `scheduleAt(key, when, task)` 一次性排程、`cancel(key)`、`has(key)`。key 建議用 `vmute:<guildId>:<userId>`，覆蓋靜音時先 `cancel` 舊的 |
| `src/core/pollRender.js` 的 `QUICK_COLORS`、`quickOptions()`、`buildQuickMessage()`、`percentBar()`（檔案後段「快速投票」那一節） | 階段二的投票畫面。Discord 按鈕只有藍(`Primary`)、紅(`Danger`)、灰(`Secondary`)、綠(`Success`)四種內建色，**沒有黃色**。順序是**藍在前**（藍＝正向），所以「同意」用 `o0`、「反對」用 `o1` |
| `src/core/pollService.js` 的 `handleQuickVote()`（第 526 行）、`checkQuickEnd()`（第 545 行） | 快速投票的計票與提早結束怎麼寫的 |
| `src/core/logger.js` | `export default logger` |
| `src/config/index.js` | `config.channels`、`config.guildIds`。要在特定頻道公告的話從這裡拿 |

---

## 設計筆記

**為什麼階段一用 `addChoices` 而不是 autocomplete**：使用者要求先讓功能會動。`addChoices` 是宣告式的，寫完就結束；autocomplete 要另外在 `interactionCreate` 接 `isAutocomplete()` 分支、自己過濾建議清單、還要自己驗證使用者亂打的數字。自訂秒數等階段二之後有實際需求再說。

**階段二的投票不重用 `/quickpoll` 的資料流**：`quickpoll` 的票是誰都能投、結算只看票數。這裡多了兩個 quickpoll 沒有的條件——「投票者必須在同一個語音頻道」與「全員投完提早結束」——都需要在計票當下讀語音頻道成員。共用會把語音的概念污染進通用投票，所以另開 `vmuteVote.js`，只借用 `pollRender` 的畫面元件。

**投票資料放記憶體還是 state**：階段二的投票只活 60 秒，重啟就失效是可以接受的（現場重新發起即可），所以放記憶體，不進 state。**已經生效的靜音一定要進 state**，因為那是實際改變了伺服器狀態、不解除會一直留著的東西。

---

## 決策紀錄

- 2026-08-20　分兩階段，階段一先用 `addChoices`。理由：使用者指定先讓功能可運作。
- 2026-08-20　六個級距定為 60/120/180/240/300/600 秒。
- 2026-08-20　目標必須與發起人在同一個語音頻道。
- 2026-08-20　階段二：語音內至少 3 人才受理；母數＝頻道人數扣掉被提名者，同意 > 50% 才通過。使用者確認。
- 2026-08-20　（原案）單一 `seconds` 參數 ＋ autocomplete 讓使用者自訂秒數 —— **暫緩**，等階段二之後再評估。
