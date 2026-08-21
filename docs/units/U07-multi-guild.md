# U07　跨多伺服器的設定維護

狀態：擱置（完整 U07 未做；下方「只讓 /horntail 能在別的伺服器用」的窄版三步已完成，等部署）
進度：0/0（窄版三步不計入本單元進度）
依賴：無
分支：（未開）
來源：原 PLAN.md Phase 8

---

## 問題

現在是「一個 bot 進程 ＝ 一個環境 ＝ 一份設定」。`src/config/environments/<環境>.js` 的 `guildIds` 雖然是陣列，但 `channels` 與 `roles` 只有一份，而**身分組 id 是綁死在特定伺服器**的。

這個結構真的加第二個伺服器就會壞：bot 會拿 A 伺服器的身分組 id 去 B 伺服器操作，而且是靜默失效。

## 方向

把每個伺服器的設定從程式碼搬到資料檔 `data/guilds/<guildId>.json`，由斜線指令維護。`src/core/selfRoles.js` 已經是這個模式（清單存 `data/selfRoles.json`、用 `/selfrole` 維護、不進版控），可以直接沿用它的作法。

理由是這些東西**本質上是資料不是程式常數**——新增一個伺服器不該需要改程式碼、commit、部署。改完之後的流程是：把 bot 邀進新伺服器 → 管理員用指令設定頻道與身分組 → 立刻可用。

---

## 只讓 `/horntail` 能在別的伺服器用（2026-08-21 使用者詢問，優先度低）

不必做完整個 U07。`/horntail` 是所有功能裡**最容易跨伺服器**的一個，因為它幾乎不吃伺服器設定：

| 它用到的東西 | 跨伺服器會不會壞 |
|---|---|
| 招式秒數（`src/config/horntail.js`） | 不會，跟伺服器無關 |
| 面板、按鈕、TTS | 不會 |
| 計時器狀態（記憶體，key 是 channelId） | 不會，channelId 全域唯一 |
| **`config.permissionRoles.gm`** | **會壞**。身分組 id 綁死在單一伺服器，拿 A 的 id 去 B 查一定查不到 |
| **`config.guildIds`** | 指令只註冊到清單裡的伺服器，新伺服器要加進去 |

所以只要三步：

1. `config.guildIds` 加上新伺服器的 id
2. `permissionRoles.gm` 從**單一字串**改成 **`{<guildId>: <roleId>}` 的對照表**，
   `isGmMember(member)` 改成用 `member.guild.id` 去查。查不到就退回「只有管理員能用」——
   fail closed 的語意不變，而且新伺服器在填 id 之前，管理員仍然可以用
3. jail 跑 `yarn deploy`（U01 完成後）或重啟，把指令註冊到新伺服器

工作量約半天，改動只有 `src/config/environments/*.js` 與 `timerService.js` 的 `isGmMember()`。
`/horntail` 的其他部分**完全不用動**。

**但要注意兩件事：**

- **這只解決 `/horntail`。** 同一個 bot 進到新伺服器，`/poll`、`/selfrole`、`/role-panel`
  這些吃 `config.roles` / `config.channels` 的功能會**靜默用錯 id**——不會報錯，只是拿 A 伺服器的
  身分組 id 去 B 伺服器操作，然後什麼都沒發生。這正是本單元要解決的問題
- **正式站與測試站是兩個不同的 bot application**（`applicationId` 不同）。
  「別的伺服器」要邀的是哪一個，要先決定

**建議**：真的要在別的伺服器用，就做上面那三步的窄版，不要順手把整個 U07 一起做。
但同時要在那個伺服器**只開放 `/horntail`**（伺服器設定 → 整合 → 關掉其他指令），
否則有人下 `/selfrole` 會得到莫名其妙的結果。

### 窄版三步：已完成的程式改動（2026-08-21）

改動範圍就只有這三個檔，`/horntail` 本身一行都沒動：

| 檔案 | 改了什麼 |
|---|---|
| `src/config/environments/production.js` | `permissionRoles.gm` 改成對照表；`guildIds` 與 `gm` 各加第二個伺服器 |
| `src/config/environments/test.js` | `permissionRoles.gm` 改成對照表（結構要與 production 一致，值不變） |
| `src/core/timerService.js` | `isGmMember()` 改用 `member.guild.id` 查對照表 |

第二個伺服器邀的是**正式站 bot**（`applicationId: 1133309593787826267`），
所以設定只寫在 `production.js`，**測試站看不到效果**，要合併到 `main` 部署後才會生效。

### 上線檢查清單（部署時照這個順序做）

1. `test` → `main` 合併，正式 jail `git pull`，重啟並重新註冊指令
2. 把正式站 bot 邀進第二個伺服器
3. **⚠ 立刻到「伺服器設定 → 整合 → BC bot」，只留 `/horntail`，把其他指令全部關掉。**
   `/poll`、`/selfrole`、`/role-panel` 吃 `config.roles` / `config.channels`，那些 id 綁死在 BCKF，
   在第二個伺服器會**靜默用錯 id**——不會報錯、不會有訊息，只是拿 BCKF 的身分組 id 去操作然後什麼都沒發生。
   這一步漏掉不會有任何徵兆，只會有人回報「指令按了沒反應」
4. 驗收：在第二個伺服器用**掛 GM（`1540261646436667452`）但不是管理員**的帳號下 `/horntail`，
   要能開面板且按鈕能按；普通成員要被擋；管理員不論有沒有 GM 都要能用
5. 回頭確認 BCKF 沒被影響：BCKF 的 GM（非管理員）仍然能用 `/horntail`

第 4 步失敗（GM 被當成普通人擋掉）而管理員可用時，代表 `guildIds` / `gm` 那串 id 不是真正的伺服器 id，
或 GM 身分組 id 填錯——查 `production.js` 那兩處，兩邊的 key 必須是同一串。

### 決策紀錄

- **`permissionRoles.gm`：單一字串 → `{伺服器id: 身分組id}` 對照表。**
  身分組 id 綁死在單一伺服器，多伺服器下沒有「一個 id 走天下」的選項。做成對照表而不是
  `data/guilds/<guildId>.json`（完整 U07 的方向），是因為 GM 只有一個值、一年改不到一次，
  為它拉出一套資料檔與維護指令不划算；等真的要搬 `channels` / `roles` 時一起搬。
- **查不到伺服器 → 回退「只有管理員能用」，不是全開。** 管理員檢查在函式最前面且沒動，
  所以新伺服器在填 id 之前管理員照樣能用，fail closed 的語意不變。
  `member.guild` 不存在（私訊、partial）也一樣走到 false。
- **保留舊的單一字串格式。** `isGmMember()` 遇到字串時沿用舊語意（不分伺服器都認）。
  現行兩個環境檔都已改成對照表，這條純粹是保險：日後有人加第三個環境檔卻沿用舊寫法時，
  現有伺服器的 GM 不會無聲失效。
- **沒有為這次改動寫單元測試。** `isGmMember()` 吃的是 discord.js 的 `GuildMember`，
  測試檔不得直接或間接 import discord.js（見 CLAUDE.md），造假物件要連 `permissions.has`、
  `roles.cache.has` 一起假，測到的是假物件不是實際行為。權限正確性照慣例走實機驗收（上方清單第 4、5 步）。

## 為什麼整個 U07 擱置

目前只有一個伺服器。等要擴張時再做。

**開工前提**：確定要加第二個伺服器。屆時要先盤點所有讀 `config.roles` / `config.channels` 的地方（`src/config/index.js`、`src/core/selfRoles.js`、`src/core/roleGrant.js`、`src/core/rolePanel.js`），因為那些呼叫全部要多帶一個 `guildId`。
