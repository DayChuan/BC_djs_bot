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

## 為什麼擱置

目前只有一個伺服器。等要擴張時再做。

**開工前提**：確定要加第二個伺服器。屆時要先盤點所有讀 `config.roles` / `config.channels` 的地方（`src/config/index.js`、`src/core/selfRoles.js`、`src/core/roleGrant.js`、`src/core/rolePanel.js`），因為那些呼叫全部要多帶一個 `guildId`。
