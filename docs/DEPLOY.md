# 推版與 jail 端指令

更新日期：2026-08-20

我（Claude）只做到 **commit**，`push` 之後的每一步都由你手動執行。
本目錄是 NAS SMB 共用資料夾，**禁止在這裡執行任何 process**；下面標「NAS 端」的都是純 git 操作，可以在這裡跑。

---

## 完整流程

```
NAS 編輯 ──commit──> unit/UXX 分支 ──merge──> test 分支 ──push──>
   測試 jail 抓下來驗證 ──通過──> test 快轉到 main ──> 正式 jail git pull
```

---

## 1. NAS 端：直接在 `test` 上做

```powershell
cd \\fongxiang.duckdns.org\admin_only\Program\Discord_bot\BC_djs_bot_test
git status --short          # 先看有沒有別條線正在改的檔案
git pull origin test
```

**不要開分支、不要切換分支。** 整個專案只有這一份工作目錄，分支是綁在工作目錄上的：
切走的瞬間，另一條平行作業腳下的檔案也跟著被切走，而且它不會知道，
後續的 commit 會全部落在你的分支上（2026-08-21 發生過一次）。

平行作業的隔離靠的是**各單元宣告的「檔案領域」不重疊**，不是分支。

## 2. NAS 端：commit 並推上去

```powershell
git status --short          # 確認要 commit 的都是自己的檔案
git add <檔案>              # 具名 add，不要用 -A 或 .
git commit
git push origin test
```

推之前確認一下分支沒有被切走：

```powershell
git rev-parse --abbrev-ref HEAD    # 應該是 test
```

`push` 出現 `Everything up-to-date` 但你確定有 commit 過，就是分支被切走了。
用 `git log --oneline --all -5` 找到那個 commit，再 `git branch -f test <commit>`。

## 3. 測試 jail `DiscordBot_test`：抓下來驗證

```sh
sh /root/update.sh
```

這支腳本做四件事：`git fetch origin test` → `reset --hard origin/test` → `package.json` 或 `yarn.lock` 有變動才 `yarn install` → `pm2 restart discord-bot --update-env`。
用 `reset --hard` 而不是 `pull`，是因為 jail 端永遠不改檔案，硬對齊遠端才不會因衝突讓 cron 默默卡住。

cron 每天會自動跑一次，需要時直接手動執行同一支腳本。

驗證：

```sh
cd /root/BC_djs_bot_test
git log -1 --oneline                      # 確認抓到的是預期的 commit
yarn test                                 # 單元測試
tail -30 logs/$(date +%Y-%m-%d).log       # 有 Ready! 且沒有 unhandledRejection
pm2 logs discord-bot --lines 50           # 或看 pm2 這邊
```

**U01 完成後**，指令有增減時要多跑一步（否則 Discord 端看不到新指令）：

```sh
cd /root/BC_djs_bot_test && yarn deploy
```

內容沒變會自己印「內容未變、跳過」，所以每次部署都跑也沒關係。

再到**測試 Discord 伺服器**做該單元檔裡列的實機驗收。

## 4. NAS 端：驗收通過，推上正式站

```powershell
git push origin test:main
```

`test` 一定是 `main` 的直接後裔（正式站不會有自己的 commit），所以這是快轉，不會產生合併節點。

## 5. 正式 jail `DiscordBot`：部署

```sh
cd /root/BC_djs_bot
git log -1 --oneline          # 先記下目前的 commit，回滾要用
git pull origin main
yarn install                  # 相依有變動時必須跑
yarn deploy                   # U01 完成後才有；指令有增減時必跑
pm2 restart bc-djs-bot
tail -30 logs/$(date +%Y-%m-%d).log
```

---

## 回滾

```sh
cd /root/BC_djs_bot
git reset --hard <先前的 commit>
yarn install
yarn deploy                   # 指令定義有變過的話要一起退回去
pm2 restart bc-djs-bot
```

`.env`、`data/`、`logs/` 都不在版控，git 操作不會動到它們，所以回滾很乾淨。

**唯一要注意的**：若回滾前已有人用新指令發過投票，`data/polls/` 會留下沒人管的檔案——不會出錯，但那些投票不會結算。用 `/poll_admin` 手動取消掉。

---

## 兩個 jail 的對照

| | 測試 jail `DiscordBot-Test` | 正式 jail `DiscordBot` |
|---|---|---|
| 目錄 | `/root/BC_djs_bot_test` | `/root/BC_djs_bot` |
| pm2 程序名 | `discord-bot` | `bc-djs-bot` |
| 分支 | `test` | `main` |

## 常用的 jail 指令

以下用測試站示範，正式站把目錄換成 `/root/BC_djs_bot`、程序名換成 `bc-djs-bot`。

| 目的 | 指令 |
|---|---|
| 看程序狀態 | `pm2 list` |
| 看即時 log | `pm2 logs discord-bot` |
| 重啟 | `pm2 restart discord-bot --update-env` |
| 停掉 | `pm2 stop discord-bot` |
| 開機自啟（設定過就不用再跑） | `pm2 save` |
| 看當天的檔案 log | `tail -f /root/BC_djs_bot_test/logs/$(date +%Y-%m-%d).log` |
| 只看錯誤 | `grep -i "error\|rejection" /root/BC_djs_bot_test/logs/$(date +%Y-%m-%d).log` |
| 跑測試 | `cd /root/BC_djs_bot_test && yarn test` |
| 跑單一支測試 | `yarn test tests/pollStore.test.js` |
| 確認目前版本 | `cd /root/BC_djs_bot_test && git log -1 --oneline` |

`--update-env` 是必要的：改過 `.env` 之後不加這個參數，pm2 會沿用舊的環境變數。

---

## 出事時要撈給我的東西

不做觀察期，掛掉時直接撈這三樣：

1. `pm2 list`（看重啟次數）
2. `tail -100 logs/<當天>.log`
3. `git log -1 --oneline`（確認跑的是哪一版）

jail 檔案也可以從 Windows 唯讀查看，不用 SSH：
`\\fongxiang.duckdns.org\mnt\iocage\jails\<jail>\root\root\BC_djs_bot\logs\`
