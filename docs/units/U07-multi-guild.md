# U07　跨多伺服器的設定維護

狀態：擱置
進度：0/0
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

## 為什麼整個 U07 擱置

目前只有一個伺服器。等要擴張時再做。

**開工前提**：確定要加第二個伺服器。屆時要先盤點所有讀 `config.roles` / `config.channels` 的地方（`src/config/index.js`、`src/core/selfRoles.js`、`src/core/roleGrant.js`、`src/core/rolePanel.js`），因為那些呼叫全部要多帶一個 `guildId`。
