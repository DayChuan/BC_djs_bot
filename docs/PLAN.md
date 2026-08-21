# BC_djs_bot 開發總表

更新日期：2026-08-20

這一份是**儀表板**，只放狀態與依賴。每個單元的目標、設計、檔案清單、進度與驗收都在它自己的檔案裡。
**開工時只讀 `CLAUDE.md` ＋ 你負責的那一個單元檔，不要讀這裡以外的其他單元。**

---

## 現在的狀態

投票系統（`/poll`、`/poll_admin`、`/quickpoll`）已全部完成並在正式站運行。
`origin/test` 與 `origin/main` 目前同一個 commit，工作區乾淨。

## 單元總表

| 單元 | 內容 | 狀態 | 進度 | 依賴 | 可平行 |
|---|---|---|---|---|---|
| [U01](./units/U01-command-deploy.md) | 指令部署分離（`yarn deploy` ＋ 雜湊護欄 ＋ 絕對路徑 ＋ exit 交給 pm2） | 未開始 | 0/7 | — | 不可與 U02 |
| [U02](./units/U02-drop-vue.md) | 拔掉 Vue／Pinia，store 改為一般單例 | 未開始 | 0/5 | U01 | 不可與 U01 |
| [U03](./units/U03-state.md) | 跨重啟狀態 `state.js` | **停擺** | 0/5 | — | 可 |
| [U04](./units/U04-vmute.md) | 語音暫時靜音 `/vmute`（階段一直接靜音、階段二投票） | 未開始 | 0/11 | U03（停擺中） | 可 |
| [U05](./units/U05-daily-japanese.md) | 每日日文分享（讀自維護資料表） | 未開始 | 1/7 | U03（停擺中） | 可 |
| [U06](./units/U06-drive-readonly.md) | `/drive` NAS 檔案瀏覽（唯讀） | 未開始 | 0/8 | — | **可，完全獨立** |
| [U07](./units/U07-multi-guild.md) | 跨多伺服器的設定維護 | 擱置 | — | — | — |
| [U08](./units/U08-quickpoll-labels.md) | `/quickpoll` 自訂選項文字 ＋ 藍紅順序對調 | **待驗收** | 3/4 | — | — |
| [U09](./units/U09-horntail-timer.md) | 暗黑龍王計時器 `/horntail` | **最優先** | 0/9 | — | 可 |

已完成的單元收在 [units/done.md](./units/done.md)，平常不需要讀。

## 現在可以同時開的

- **`U09`（最優先，全新檔案，與任何單元都不重疊）**
- 一條 `U01 → U02`（兩者都改 `main.js` 與 `loader.js`，必須前後做）
- 一條 `U06`（全新檔案）

`U03` 停擺中，因此 `U04` 與 `U05` 目前開不了工。`U09` 不依賴 `U03`。

## 等待使用者決定的

| 單元 | 事項 |
|---|---|
| U06 | `fongxiang.duckdns.org:5990` 是既有的檔案服務，還是要我們自己起 server？NAS 資料夾在 jail 內的掛載點？身分組與資料夾的對照？（只擋下載路由，前面的部分可以先做） |

U04 與 U05 的待決事項已於 2026-08-20 全部確認，見各自單元檔的決策紀錄。

---

## 相關文件

| 文件 | 內容 |
|---|---|
| [CLAUDE.md](../CLAUDE.md) | 協作規範、專案結構、硬性限制。**每次開工必讀** |
| [ENVIRONMENTS.md](./ENVIRONMENTS.md) | 三個環境的差異、測試環境的地雷 |
| [DEPLOY.md](./DEPLOY.md) | 推版與 jail 端的指令 |
| [ISSUES.md](./ISSUES.md) | 2026-08-13 的問題盤點，已修的都標了結案。參考索引，不是主線 |
| [Functions/](./Functions/) | 使用者提供的新功能交接文件，是各單元的需求來源 |
