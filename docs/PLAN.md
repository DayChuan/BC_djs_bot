# BC_djs_bot 開發計畫

重寫日期：2026-08-14
問題清單：[ISSUES.md](./ISSUES.md)（僅作為既有問題的參考索引，不再是計畫主軸）
jail 建置步驟：[JAIL-SETUP.md](./JAIL-SETUP.md)

## 現況

- 正式站 bot 與測試 bot 都已連續運行超過兩天且穩定（2026-08-17 確認）。**不再做觀察期，掛掉時再撈 log 給我判斷。**
- 錯誤攔截與檔案 log（`src/core/logger.js` + `main.js` 的 process / client 層級 handler）已實作完成並進版控，尚未在測試 jail 完成驗收。
- 原本以「查崩潰原因」為主軸的階段計畫已作廢。

## 目標

1. **在測試環境修掉既有問題**：先拔掉 Vue/Pinia，合併重複的 Role 對照表。
2. **加四個新功能**：語音暫時靜音、每週投票、每日日文分享、帳號管理指令。

## 核心原則

1. **所有改動都先在測試 jail 驗證，再合併到正式站。** NAS 工作目錄只編輯、不執行。
2. **一次做一個階段**，做完停下來，列出「改了什麼」與「怎麼驗證」。
3. **每階段一個 commit**，出問題只回滾該階段。
4. 新功能一律建立在 Phase 1 的共用地基上，不各自造輪子。

## 階段總覽

| 階段 | 內容 | 依賴 |
|---|---|---|
| **Phase T** | **建立測試 jail + git 同步管線** | — |
| Phase 0 | 上線既有的 logger（純新增，已寫完） | T |
| Phase 1 | 清理既有問題：拔 Vue/Pinia、合併 Role 對照表 | 0 |
| Phase 2 | 新功能共用地基：discord.js 升級、排程器、狀態持久化 | 1 |
| Phase 3 | 功能 2-1　語音暫時靜音指令 | 2 |
| Phase 4 | 功能 2-2　每週投票 | 2 |
| Phase 5 | 功能 2-3　每日日文分享 | 2 |
| Phase 6 | 功能 2-4　帳號管理指令（NAS API） | 2 |
| Phase 7 | 指令部署分離 + pm2 自動重啟 | 3～6 任一完成後 |

> Phase 3～6 彼此獨立，Phase 2 完成後可依你想要的順序做。

---

## Phase T — 建立測試環境（git 同步）

### 為什麼不用原本的 fstab 方案

原方案是用 iocage `fstab` 把 NAS 上的 `BC_djs_bot_test` 以 nullfs 掛進測試 jail。**已廢除**：

1. 掛載進來的位置無法執行 jail 內部程式。
2. 資料夾權限會與 host 端連動，jail 內改不動也管不了。

改為 **jail 內放實體檔案，用 git 當唯一同步管道**。jail 有自己的檔案系統與權限，上述兩個問題都不存在。

### 架構

| 角色 | 位置 | 職責 |
|---|---|---|
| 編輯 | NAS `\\<NAS>\…\Discord_bot\BC_djs_bot_test` | 改檔、commit、push。**禁止在此執行任何 process** |
| 傳遞 | GitHub `origin` 的 **`test` 分支** | 唯一同步管道 |
| 測試執行 | jail `DiscordBot_test`：`/root/BC_djs_bot` | 跑 bot、跑單元測試、可隨意重啟與弄壞 |
| 正式執行 | jail `DiscordBot`：`/root/BC_djs_bot` | 維持手動複製，本階段不接 git |

流程：**NAS 編輯 → push `test` → jail 每日 cron 或手動抓 → jail 內驗證 → 合併 `test` 到 `main` → 依既有方式部署正式站**。

### 同步腳本（jail 內 `/root/update.sh`）

```sh
#!/bin/sh
set -e
cd /root/BC_djs_bot
git fetch origin test
before=$(git rev-parse HEAD)
git reset --hard origin/test
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then echo "no change"; exit 0; fi
if ! git diff --quiet "$before" "$after" -- package.json yarn.lock; then yarn install; fi
pm2 restart bc-test --update-env
```

- 用 `reset --hard` 而非 `pull`：jail 端永遠不改檔案，硬對齊遠端才不會因衝突讓 cron 默默卡住。
- 相依套件只在 `package.json` / `yarn.lock` 真的變動時才重裝。
- cron 每天跑一次；需要時直接 `sh /root/update.sh` 手動抓，兩種方式同一支腳本。

### 單元測試

用 **vitest**：專案已有 `vite.config.js` 提供 `@/` 別名，vitest 直接沿用同一份設定，換任何其他 runner 都得先解決別名問題。測試一律在測試 jail 內 `yarn test` 執行。

### 驗收

1. NAS 改一行、push 到 `test`，jail 執行 `sh /root/update.sh` 後檔案內容一致。
2. `crontab -l` 看得到排程，且手動觸發正常。
3. jail 內 `yarn test` 跑通至少一個單元測試（拿 `logger.js` 當第一個對象）。
4. 測試 jail 的 bot 連到**測試 Discord 伺服器**，對正式站零影響。

### Progress

- [x] T-1 建立 jail `DiscordBot-Test`（Node v24.14.1，git / yarn / pm2 皆已就緒）
- [ ] T-2 GitHub 建立 `test` 分支；NAS 端把現有變更 commit 並 push
- [ ] T-3 jail 內 `git clone -b test`，手動放入測試站 `.env`，`yarn install`
- [ ] T-4 寫 `/root/update.sh` 並手動跑通一次
- [ ] T-5 設定 cron 每日執行 `update.sh`
- [x] T-6 導入 vitest（Phase 4-A 已加入 `vitest` 與 `yarn test`，待在 jail 內跑通）
- [ ] T-7 建立 `docs/ENVIRONMENTS.md` 記錄正式 / 測試環境差異
- [ ] T-8 完成上述四項驗收

### 待確認（阻擋 T-2、T-3）

1. **GitHub repo 是 public 還是 private？** private 的話 jail 需要一把唯讀 deploy key。
2. **`.gitignore` 目前排除 `yarn.lock`。** 這會讓 jail 每次自行解析版本，與正式站不一致。建議改為納入版控。

---

## Phase 0 — 上線既有的 logger

程式碼已寫完（`src/core/logger.js`、`main.js` 的 handler、`.gitignore` 加 `logs/`），只差驗證與上線。
留著它的理由：新功能有排程與外部 API，出錯時沒有 log 就查不動。

**驗收**（測試 jail）：
1. bot 啟動，log 檔內有啟動訊息、Node 版本與 pid
2. `logs/` 產生當日檔案
3. 觸發一次已知錯誤，log 有完整堆疊且 bot 不下線
4. `kill -HUP <pid>` → log 出現「收到 SIGHUP」而非無聲消失

**Progress**
- [x] 0-1 `src/core/logger.js`
- [x] 0-2 `main.js` process 層級 handler（含訊號處理）
- [x] 0-3 `main.js` client error / shardError / shardDisconnect / warn 監聽
- [x] 0-4 啟動訊息記錄版本與 pid
- [x] 0-5 `.gitignore` 加入 `logs/`
- [ ] 0-6 在測試 jail 完成四項驗收
- [ ] 0-7 commit

---

## Phase 1 — 清理既有問題

只做你點名的兩項，其餘 P2 問題留在 ISSUES.md，之後有需要再處理。

| 子步驟 | 對應 | 修改內容 |
|---|---|---|
| 1-A | M-02 | 拔掉 Vue / Pinia：`src/store/app.js` 改為一般 ES module 單例物件；刪 `src/core/vue.js`；`main.js` 移除 `vueInit()`；所有 `useAppStroe()` 改為 import `appStore`；順手修掉 `clint` / `commandsActionMap` 的鍵名錯字；`package.json` 移除 `vue`、`pinia` |
| 1-B | M-03 | 新增 `src/config/roleMap.js` 存唯一一份 emoji→roleId 對照表；`Role_Add_Emoji` / `Role_Remove_Emoji` 改為共用 handler，只差 `add` / `remove` |
| 1-C | F-01、F-02 | 併進 1-B 一起做：共用 handler 開頭加 `if (reaction.partial) await reaction.fetch()`，成員改用 `await guild.members.fetch(user.id)`。不做這兩項，重構完的 Role 功能在 bot 重啟後照樣靜默失效 |
| 1-D | C-03 | 併進 1-B：catch 區塊改用 logger，通知管理頻道改成自帶 try/catch 的安全函式（頻道取不到就只寫 log），避免錯誤處理本身把 bot 打掛 |

**限制**：此階段不改變任何對外行為，emoji 與身分組的對應關係必須與現況完全一致。

**驗收**（測試伺服器）：
1. bot 正常啟動，斜線指令與關鍵字回覆行為不變
2. bot 重啟後（不先發新訊息），對既有身分組訊息加反應 → 身分組正確發放
3. 移除反應 → 身分組正確收回
4. 對 bot 無權限操作的身分組加反應 → log 記錄 50013，bot 不下線

**Progress**
- [ ] 1-A 移除 Vue/Pinia，改用單例物件
- [ ] 1-B 抽出 `roleMap.js` + 共用 handler
- [ ] 1-C partial fetch + members.fetch
- [ ] 1-D catch 改用 logger + 安全通知函式
- [ ] 1-E 驗收
- [ ] 1-F commit

---

## Phase 2 — 新功能共用地基

四個新功能有三個共同需求，先一次做好，避免各自造輪子。

| 子步驟 | 內容 | 為什麼 |
|---|---|---|
| 2-A | 升級 discord.js 到 v14.16 以上 | 目前 14.13.0 沒有原生 Poll API。Phase 4 的投票用原生 poll，Discord 端就會自動計票與到期，不必自己數 reaction |
| 2-B | 新增 `src/core/scheduler.js`，以 `node-cron` 建立排程器，時區固定 `Asia/Taipei` | Phase 4、5 都要定時觸發。用 in-process 排程而非 jail 的 crontab，理由：排程規則跟程式碼一起進版控，且不必為了排程去碰 jail 系統設定 |
| 2-C | 新增 `src/core/state.js`，以單一 JSON 檔（`data/state.json`，加入 `.gitignore`）存需要跨重啟保留的狀態 | Phase 3 的靜音到期時間、Phase 4 的投票追蹤都得撐過 bot 重啟。用 JSON 檔而非資料庫，理由：資料量極小，不值得為它在 jail 裡多裝一個服務 |
| 2-D | `main.js` 啟動時載入 state 並重新掛回未完成的排程 | 沒有這步，bot 一重啟所有計時就消失 |

**驗收**：
1. 升級後既有功能全部照舊（重跑 Phase 1 的四項驗收）
2. 排程器能觸發一個每分鐘印一行 log 的測試任務，時間為台北時間
3. 寫入 state 後重啟 bot，內容仍在

**Progress**
- [ ] 2-A 升級 discord.js（原因是原生 Poll API，Phase 4 已改為自建投票，此項不再必要）
- [x] 2-B `scheduler.js`（併入 Phase 4-A 完成）
- [ ] 2-C `state.js`
- [ ] 2-D 啟動時還原排程
- [ ] 2-E 驗收
- [ ] 2-F commit

---

## Phase 3 — 功能 2-1　語音暫時靜音

**需求**：把指定成員在語音頻道做**伺服器端靜音**，時間到自動解除。時間由指令參數選擇。

**設計**：
- 新增 `src/commands/vmute/index.js`
- 參數：`user`（必填，成員）、`duration`（必填，選單：60 / 120 / 180 / 360 秒）、`reason`（選填）
- 權限：`setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers)`，只有具備「靜音成員」權限的人看得到、用得到
- 實作：`await member.voice.setMute(true, reason)`；到期時 `setMute(false)`
- 到期時間寫進 Phase 2-C 的 state；bot 重啟時由 2-D 還原，已過期的立即解除
- 邊界處理：成員不在語音頻道 → 回覆提示不執行；已被靜音 → 覆蓋為新的到期時間；bot 權限不足（50013）→ 回覆友善訊息並寫 log

**注意**：這是伺服器靜音，不是 Discord 內建的 timeout。內建 timeout 會連文字訊息一起禁掉，且到期由 Discord 端處理；伺服器靜音只影響語音，但**到期解除得由我們自己記時**，所以才需要 Phase 2-C / 2-D。

**驗收**：
1. 對語音中的成員下 `/vmute 60` → 立刻靜音，60 秒後自動解除
2. 靜音期間重啟 bot → 剩餘時間到了仍會自動解除
3. 對不在語音頻道的人下指令 → 明確提示，bot 不下線
4. 無「靜音成員」權限的一般成員看不到這個指令

**待確認**
- 360 秒（6 分鐘）這個級距是不是筆誤？前三個是 1/2/3 分鐘，第四個跳到 6 分鐘。要 240 秒還是照 360？

**Progress**
- [ ] 3-A 指令骨架與參數
- [ ] 3-B setMute + 到期解除
- [ ] 3-C state 持久化與重啟還原
- [ ] 3-D 邊界處理與錯誤訊息
- [ ] 3-E 驗收
- [ ] 3-F commit

---

## Phase 4 — 功能 2-2　投票系統

> **2026-08-17 改寫。** 原設計是「用 discord.js 原生 Poll API 發每週時段投票」，**已作廢**：
> 原生 poll 不支援自訂的身分選單、不支援自訂結算格式，投票資料也不在我們手上，
> 無法滿足「以 JSON 維護、結算後整理到頻道並清空」的需求。改為元件式（選單／按鈕）自建投票，
> 方向與 `docs/Functions/Claude_Handover_Voting_System.md` 一致。

**需求**：兩個斜線指令。

1. `/poll` — 完整投票。可設定名稱、內容、選項、可否複選、是否附身分選單、是否每週重複。
2. `/quickpoll` — 語音頻道用的快速二／三／四選一，即時顯示百分比占比。

**身分選單的語意**：建立投票時綁定一個「身分群組」（楓之谷 / TRPG…），投票者就會在該場投票
看到那個群組的職業清單並選擇自己的職業。純字串紀錄，不碰 Discord 身分組 API。
表放在 `src/config/pollIdentities.js`，加職業或加群組只改這一個檔案。

**快速投票的顏色**：Discord 按鈕只有紅(`Danger`)、藍(`Primary`)、綠(`Success`)、灰(`Secondary`)
四種內建色，**沒有黃色**。經確認全部採用內建色，不掛 emoji：
二選一＝紅藍、三選一＝紅藍灰、四選一＝紅藍灰綠。

**資料**：`data/polls.json`（已在 `.gitignore`）。一場投票一個 key，結算後只刪該筆，
其他進行中的投票不受影響。

**設計（分三個子階段，一次做一個）**

| 子階段 | 內容 |
|---|---|
| 4-A 地基 | `src/config/pollIdentities.js` 身分表；`src/core/pollStore.js` JSON 持久化（單一 Promise 佇列串行化讀寫、暫存檔 + rename 原子寫入、壞檔備份）；`src/core/scheduler.js`（`node-cron`，時區 `Asia/Taipei`，一次性排程分段等待避開 setTimeout 32 位元上限）；導入 vitest |
| 4-B `/poll` | 指令與參數、Embed + 選項選單 + 身分選單、`interactionCreate` 分派、到期結算（貼結果、移除元件、刪該筆）、`weekly` 自動排下一輪、`main.js` 啟動時還原未結束的投票 |
| 4-C `/quickpoll` | `choices` 2/3/4 → 內建四色按鈕、即時更新百分比長條、同樣進 polls.json 撐過重啟 |

> 4-A 已含原 Phase 2-B（排程器）與 Phase T-6（vitest）的內容，那兩項不再另外做。

**Progress**
- [x] 4-A-1 `src/config/pollIdentities.js` 身分表 + 靜態檢查
- [x] 4-A-2 `src/core/pollStore.js` JSON 持久化與併發防護
- [x] 4-A-3 `src/core/scheduler.js` node-cron 排程器
- [x] 4-A-4 `package.json` 加 `node-cron`、`vitest` 與 `yarn test`
- [x] 4-A-5 `tests/` 三支單元測試
- [x] 4-A-6 測試 jail `yarn install` + `yarn test` 全數通過（42/42，2026-08-18）
- [x] 4-A-7 commit（`e0e0b15`、`981a098`、`e8f969d`）
- [x] 4-B-1 `src/core/pollRender.js` 投票訊息與結算報表
- [x] 4-B-2 `src/core/pollService.js` 發布／結算／每週續辦／開機還原
- [x] 4-B-3 `src/commands/poll/index.js` 指令與參數驗證
- [x] 4-B-4 `interactionCreate` 分派、`ready` 開機還原
- [x] 4-B-5 `tests/pollRender.test.js`、`tests/pollService.test.js`
- [x] 4-B-6 測試 jail `yarn test` 通過（`重複結算只會貼一次結果` 暫標 it.skip，見下）
- [x] 4-B-7 測試伺服器實機驗收：指令、選單、JSON 內容、時區換算皆正確（2026-08-18）
- [x] 4-B-8 commit（`6dc6232`、`b3249a9`）
- [x] 4-B-9 `peek` 參數 ＋ 查看按鈕、`/poll_peek`、`/poll_close`（`b3249a9`）

### 4-B-2a 資料層改為一場一檔 ＋ 歸檔

**為什麼改**：原本所有投票塞在單一 `polls.json`，結算後直接刪除。三個問題：查不到歷史、
單一檔案壞掉全部陪葬、所有投票共用一條寫入佇列。

| 項目 | 內容 |
|---|---|
| 檔案配置 | `data/polls/<id>.json` 進行中；`data/archive/YYYY-MM/<id>.json` 已結算 |
| 結算語意 | 從「刪除」改為「移出進行中」，並附上結果快照（票數、名單、職業統計） |
| 保留期限 | `ARCHIVE_RETENTION_DAYS = 90`（`src/config/polls.js`），開機時清理一次 |
| 舊資料 | 開機自動把舊 `polls.json` 拆成一場一檔，原檔改名為 `.migrated` 保留 |
| 併發 | 佇列改為「一場投票一條」，不同投票的寫入互不阻塞 |
| 安全 | 新增 `isValidPollId()`。id 會組成檔名，不驗格式的話 `/poll_close id:../../..` 就能讀寫任意路徑 |

**Progress**
- [x] 2a-1 `src/config/polls.js`
- [x] 2a-2 `pollStore.js` 改為一場一檔 ＋ id 驗證 ＋ 舊資料遷移
- [x] 2a-3 `pollArchive.js`：歸檔、查詢、過期清理
- [x] 2a-4 `pollService.closePoll` 改為歸檔
- [x] 2a-5 `ready` 事件：遷移 → 還原 → 清理
- [x] 2a-6 測試更新 ＋ `tests/pollArchive.test.js`
- [ ] 2a-7 jail `yarn test` 通過
- [ ] 2a-8 實機驗收：舊投票自動遷移、結算後出現在 `archive/`
- [ ] 2a-9 commit

### 4-B-2b 多角色 ＋ 歷史查詢

| 項目 | 內容 |
|---|---|
| 資料 | `votes[userId]` 由單一物件改為陣列，每個角色一筆 `{entryId, options, identity}` |
| 相容 | 舊的單一物件由 `normalizeEntries()` 即時轉成陣列，不改寫檔案；舊訊息的 customId 沒有 entryId，一律視為第一筆 |
| 介面 | 公開訊息只留按鈕，選單搬進個人面板。一則訊息最多五列元件，撐不住多角色 |
| 面板 | 一次編輯一個角色：選項選單 ＋ 身分選單 ＋ 角色切換選單 ＋ 新增/刪除按鈕（最多四列） |
| 上限 | 一人最多 10 個角色（`MAX_ENTRIES_PER_USER`），達上限時新增鈕停用 |
| 統計 | 票數單位是角色，百分比分母為角色數；報表同時顯示「N 人 / M 個角色」 |
| 名單 | 有身分時同一人的多隻角色各列一次；沒有身分時去重，否則看起來像壞掉 |
| 指令 | `/poll` 新增 `multi_char`；新增 `/poll_history`（清單 / id / keyword / `public`） |

**Progress**
- [x] 2b-1 `votes` 改為一人多筆 ＋ 舊格式相容
- [x] 2b-2 customId 格式改為 `poll:<動作>:<投票id>[:<角色id>]`
- [x] 2b-3 公開訊息改為按鈕、新增個人面板
- [x] 2b-4 統計與報表改為「人數 / 角色數」
- [x] 2b-5 `/poll` 的 `multi_char` 參數
- [x] 2b-6 `/poll_history`（含 `public` 公開貼出）
- [x] 2b-7 測試更新
- [ ] 2b-8 jail `yarn test` 通過
- [ ] 2b-9 實機驗收（見下）
- [ ] 2b-10 commit

**2b 實機驗收**
1. `/poll` 不帶 `multi_char` → 公開訊息只有按鈕；點按鈕出現面板，選項可選、可取消
2. 舊的那場投票（改版前發出的訊息）點下去仍然有反應，不會報錯
3. `/poll multi_char:true identity:楓之谷` → 面板有「新增角色」；登記兩隻不同職業，切換選單可來回切
4. 刪除其中一隻 → 只有那隻消失
5. `/poll_peek` → 報表顯示「N 人 / M 個角色」，名單按職業分組
6. `/poll_close` 後 `/poll_history` → 列得出該場；`/poll_history id:<id> public:true` → 公開貼到頻道

### 4-B-2c 管理面板 `/poll_admin`

**為什麼**：管理員原本得先知道投票 id 才能操作，而且只管得到「已結束」的，
每週投票排定的下一輪（`pending`）完全沒有介面可以看或改。

| 項目 | 內容 |
|---|---|
| 入口 | `/poll_admin`（限管理員），一則 ephemeral 面板，所有動作就地更新同一則訊息 |
| 清單 | 選單直接列出三類：🟢 進行中、🕒 排程中、📦 已結束（🚫 已取消另外標示），不必打 id |
| 進行中 | 查看目前結果、編輯、提早結算、取消 |
| 排程中 | 立即發布、編輯排程、刪除 |
| 已結束 | 查看完整結果、公開分享到頻道、刪除紀錄 |
| 編輯 | Modal 五格：標題、說明、截止時間、每週發起、每週結算。**選項不可改** —— 已投的票綁在選項編號上，改了會對不上 |
| 取消 | 不結算、不公布結果，但**仍然歸檔**並標記 `cancelled`，一樣受 90 天保留期限管理 |
| 上限 | 選單最多 25 項；超過時提示改用 `/poll_history keyword:` 搜尋 |

編輯後會做兩件收尾：重掛排程（時間可能改了）、更新頻道訊息（標題可能改了）。
少任何一件，畫面與實際行為就會對不上。

**Progress**
- [x] 2c-1 `src/core/pollAdmin.js`：清單、詳情、編輯視窗、欄位驗證
- [x] 2c-2 `pollArchive`：取消歸檔（`cancelled`）與 `deleteArchived()`
- [x] 2c-3 `pollService`：`cancelPoll()`、`applyPollEdit()`、動作分派
- [x] 2c-4 `/poll_admin` 指令與 `interactionCreate` 分派（含 Modal）
- [x] 2c-5 `scheduler`：台北時間的日期字串解析與格式化
- [x] 2c-6 測試（`tests/pollAdmin.test.js` 22 個案例 ＋ 時間轉換 6 個）
- [ ] 2c-7 jail `yarn test` 通過
- [ ] 2c-8 實機驗收（見下）
- [ ] 2c-9 commit

**2c 實機驗收**
1. `/poll_admin` → 列出所有投票，狀態圖示正確
2. 選一場進行中的 → 按「查看目前結果」→ 有結果與回列表按鈕
3. 按「編輯」→ Modal 帶出現有值 → 改標題與截止時間 → 頻道訊息跟著更新、排程時間也變了
4. 編輯時故意打錯時間格式 → 顯示錯誤且**沒有做任何修改**
5. 「取消投票」→ 原訊息變成已取消、選單消失；回列表後該場出現在 🚫 已取消
6. 每週投票結算後產生的 🕒 排程中 → 「立即發布」→ 立刻發到頻道
7. 已結束的場次 →「公開分享到頻道」→ 大家看得到

- [ ] 4-C `/quickpoll`

### 測試環境限制（踩過的坑，加測試前先看）

測試 jail 是 FreeBSD，vitest 在這裡有兩個必須繞開的地雷，兩個都已寫進 `vite.config.js`：

| 症狀 | 原因 | 對策 |
|---|---|---|
| 多支測試檔停在 `0/N` 不動，先跑完的那支正常 | 同時開多個 worker。推測 jail 內取到的 CPU 數是宿主機的 | `fileParallelism: false` |
| 有 import `discord.js` 的測試檔一跑就停住，CPU 全閒，`--testTimeout` 也攔不到 | 卡在 vite/esbuild 的轉換階段，測試根本還沒開始執行 | `server.deps.external: ['discord.js']` |

還有一個寫法上的禁忌，設定檔擋不掉：

- **不要在 `beforeEach` 裡用 `vi.resetModules()` + 動態 `import()`。** 只要那條 import 鏈上有 `discord.js`，每個案例都會把它整包重新載入，在這個環境會卡死到跑不完。要換設定就改成「換環境變數 + 清模組內的快取」，`pollStore.js` 的 `pollsFilePath()` 就是為此改成呼叫時才解析路徑。

`tests/example.test.js` 是可直接照抄的範本，涵蓋斷言、前後置、假物件、假計時器與上述禁忌。

**4-B 實機驗收**（測試伺服器）
1. `/poll title:測試 options:紅,藍,綠 hours:1` → 出現投票訊息與一列選單；選一項後只有自己看得到確認訊息
2. 加 `multi:true` → 選單可複選；取消全部勾選 → 回覆顯示「已取消你的投票」
3. 加 `identity:楓之谷` → 多出第二列職業選單；選完後確認訊息顯示身分
4. 把 `hours` 設成 1、手動把 `data/polls.json` 的 `closeAt` 改成過去時間並重啟 → 開機後立刻結算，貼出結果、原訊息元件消失、該筆從 JSON 消失
5. `weekly:true` + 四個時間參數 → 結算後 JSON 裡出現一筆 `status: "pending"` 的下一輪，票數為空

---

## Phase 5 — 功能 2-3　每日日文分享

**需求**：在 `日本語コーナー` 頻道每天九點發一則日文單字分享（含例句），或一則新聞。

**設計**：
- 新增 `src/jobs/dailyJapanese.js`，由排程器每天 09:00（台北時間）觸發
- 以 embed 發送，內容含單字、讀音、詞性、中文意思、例句與例句翻譯
- 記錄已發過的項目到 state，避免短期內重複

**待確認**（阻擋開工）
1. **內容從哪來？** 三種可能，需要你選一個：
   - 我建一份本地單字表（JSON），bot 每天輪流挑一則 — 內容可控、零外部相依，但要先有一份表
   - 抓 NHK「やさしい日本語」新聞 RSS，每天貼一則 — 零維護，但只有新聞、沒有單字例句
   - 呼叫外部 LLM API 產生 — 內容最豐富，但要 API key 與費用
2. 頻道 ID？
3. 九點是台北時間還是日本時間？

**Progress**
- [ ] 5-A 確認內容來源與頻道
- [ ] 5-B 內容取得
- [ ] 5-C 每日排程與 embed 發送
- [ ] 5-D 驗收
- [ ] 5-E commit

---

## Phase 6 — 功能 2-4　帳號管理指令（NAS API）

**需求**：透過 NAS 提供的 API，用兩個斜線指令完成帳號創立與更新。

**設計**：
- 新增 `src/core/nasApi.js` 統一封裝呼叫（base URL 與憑證放 `.env`，逾時與錯誤一律走 logger）
- `src/commands/account-create/index.js`、`src/commands/account-update/index.js`
- 權限：預設限管理員，避免任何人都能開帳號
- 回覆一律用 ephemeral，避免帳號資訊洩漏到頻道

**待確認**（阻擋開工，且是四個功能中資訊最少的）
1. 這裡的「帳號」是**哪個系統**的帳號？（TrueNAS 使用者？某個服務的會員？）
2. NAS 端的 API **已經存在**，還是也要一起做？若已存在，請給端點、方法、參數與認證方式。
3. 兩個指令各要帶哪些參數？
4. 誰可以用？（管理員限定，還是特定身分組）

**Progress**
- [ ] 6-A 確認 API 規格與權限
- [ ] 6-B `nasApi.js` 封裝
- [ ] 6-C 兩個指令
- [ ] 6-D 驗收
- [ ] 6-E commit

---

## Phase 7 — 指令部署分離 + pm2

新增四個指令後，M-01（每次啟動都重打指令註冊 API）的風險比之前更高，該處理了。

| 子步驟 | 對應 | 內容 |
|---|---|---|
| 7-A | M-01 | 新增 `src/scripts/deploy-commands.js` 與 `npm run deploy`；`loadCommands()` 改為只建立 action 對照表，不再呼叫 REST |
| 7-B | M-01 | 雜湊護欄：deploy 時把 payload 的 SHA-256 存進 `.commands-hash.json`（加入 `.gitignore`），內容未變就跳過 PUT |
| 7-C | M-08、E-01 | jail 內以 pm2 執行，`ecosystem.config.cjs` 指定絕對 `cwd`（避免 M-05 的 CWD 問題）、`exp_backoff_restart_delay`、`max_restarts`，並設定 jail 開機自啟 |
| 7-D | C-07 | pm2 上線後，`uncaughtException` 由「記錄後繼續跑」改為「記錄後 exit」，交給 pm2 重啟 |

**驗收**：
1. `npm run deploy` 正確註冊指令；第二次執行顯示「內容未變、跳過」
2. `npm run dev` 啟動時不再打 REST
3. 手動 kill 行程 → pm2 自動拉起
4. 連續崩潰時重啟間隔逐次拉長

**Progress**
- [ ] 7-A deploy-commands 腳本
- [ ] 7-B 雜湊護欄
- [ ] 7-C pm2 設定與開機自啟
- [ ] 7-D uncaughtException 改為 exit
- [ ] 7-E 驗收
- [ ] 7-F commit

---

## 待使用者決定的事項（彙整）

| # | 事項 | 阻擋 |
|---|---|---|
| 1 | GitHub repo 是 public 還是 private？ | T-2 |
| 2 | `yarn.lock` 是否納入版控？ | T-3 |
| 3 | 靜音的 360 秒是筆誤還是刻意？ | Phase 3 |
| 4 | TRPG 群組的角色清單內容（目前 `pollIdentities.js` 留空，空群組不會出現在指令選項裡） | Phase 4-B |
| 5 | 日文分享的內容來源（本地單字表 / NHK RSS / LLM API）、頻道 ID、九點的時區 | Phase 5 |
| 6 | 「帳號」是哪個系統的？NAS API 是否已存在、規格為何、誰可以用 | Phase 6 |
