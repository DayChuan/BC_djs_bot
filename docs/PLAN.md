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
| [U01](./units/U01-command-deploy.md) | 指令部署分離（`yarn deploy` ＋ 雜湊護欄 ＋ 絕對路徑 ＋ exit 交給 pm2） | **完成** | 7/7 | — | — |
| [U02](./units/U02-drop-vue.md) | 拔掉 Vue／Pinia，store 改為一般單例 | **下一個** | 0/5 | U01（已完成） | 可 |
| [U03](./units/U03-state.md) | 跨重啟狀態 `state.js` | **完成** | 5/5 | — | — |
| [U04](./units/U04-vmute.md) | 語音暫時靜音 `/vmute`（階段一直接靜音、階段二投票） | **階段一待實機驗收** | 6/12 | U03（已完成） | 可 |
| [U05](./units/U05-daily-japanese.md) | 每日日文分享（讀自維護資料表） | **下一個** | 1/7 | U03（已完成） | 可 |
| [U06](./units/U06-drive-readonly.md) | `/drive` NAS 檔案瀏覽（唯讀） | 未開始 | 0/8 | — | **可，完全獨立** |
| [U07](./units/U07-multi-guild.md) | 跨多伺服器的設定維護 | 窄版完成，整體擱置 | — | — | — |
| [U10](./units/U10-poll-thread.md) | 投票開在鎖定的討論串裡 | **可開工** | 0/8 | — | 可（但會動投票核心） |
| [U11](./units/U11-lineup.md) | 楓之谷出團名單（人員表 ＋ 自動分隊） | **可開工** | 0/9 | — | 可 |
| [U12](./units/U12-poll-lifecycle.md) | 截止前提醒 ＋ 討論串 30 天自動清理 | **可開工** | 0/9 | U10 | 可 |
| [U13](./units/U13-dynamic-voice.md) | 動態語音頻道（Join-to-Create） | **可開工** | 0/9 | U03（已完成） | 可（會動 voiceStateUpdate） |
| [U14](./units/U14-minecraft-feed.md) | Minecraft 更新通知（搬進討論串） | **可開工** | 0/8 | U03（已完成） | 可 |
| [U15](./units/U15-maplestory-news.md) | 楓之谷更新公告搬運 | 缺資訊 | 0/8 | U14 | 不可與 U14 平行 |
| [U16](./units/U16-notice-translate.md) | 公告自動翻日文 ＋ Gemini 失敗佇列 | **可開工** | 0/9 | U03、U14（皆已完成） | **不可**，會動 `minecraftFeed.js` |

已完成的單元收在 [units/done.md](./units/done.md)，平常不需要讀。

還沒成為單元的想法收在 [units/BACKLOG.md](./units/BACKLOG.md)。

## 現在可以同時開的

- **`U10`**（投票開討論串，規格已確認）
- 一條 `U06`（全新檔案，但仍缺掛載點等資訊）
- `U04` 階段二（等階段一在正式站實際用過再決定要不要做）

U01、U02、U03 皆已完成；U08、U09 已於 2026-08-25 驗收結案，見 [units/done.md](./units/done.md)。

## 等待使用者決定的

| 單元 | 事項 |
|---|---|
| U15 | 楓之谷官方 Discord 的公告頻道可不可以用內建的「追蹤」功能？官網公告頁有沒有 RSS？哪些公告算「重要」？要發到哪兩個頻道？ |
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
