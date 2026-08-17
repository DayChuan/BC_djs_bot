# 測試 jail 建置與 git 同步

對象：TrueNAS CORE 的 iocage jail `DiscordBot-Test`
目的：讓測試 bot 用 git 從 GitHub 的 `test` 分支抓程式碼，每天自動更新，也可隨時手動更新。

## 流程總覽

```
NAS 工作目錄 BC_djs_bot_test  ──push──▶  GitHub  test 分支
（只編輯，不執行）                            │
                                            │ git fetch + reset --hard
                                            ▼
                         jail DiscordBot-Test:/root/BC_djs_bot_test
                                （pm2 process「discord-bot」）
```

驗證通過後才把 `test` 合併回 `main`，正式站依既有方式部署。

## 現況（2026-08-17）

- jail 內 `/root/BC_djs_bot_test` 已存在，是從 Windows 複製過來的工作目錄，`.git` 有效，
  `origin` 指向 `https://github.com/DayChuan/BC_djs_bot.git`，目前在 `main` 分支。
- `node_modules` 已在 jail 內重裝過（`.bin/vite-node` 是正確的 JS 入口）。
- pm2 process `discord-bot` 執行中，登入身分 `Test_bot#9562`，自 08-14 起穩定運行。
- **所以不需要重新 clone**，只要把這個 repo 切到 `test` 分支即可。

## 切到 test 分支（一次性）

```sh
cd /root/BC_djs_bot_test
git fetch origin
git reset --hard origin/test
git branch --set-upstream-to=origin/test test 2>/dev/null || git checkout -B test origin/test
yarn install          # yarn.lock 這次進了版控，版本會被對齊
pm2 restart discord-bot --update-env
pm2 logs discord-bot
```

`.env` 不在版控內，切分支不會動到它，測試 bot 的 token 會原樣保留。

順手把複製過來的 Windows git 設定修掉（不影響運作，但會讓 git 行為怪異）：

```sh
git config core.symlinks true
git config core.filemode true
git config core.ignorecase false
```

## 更新腳本 `/root/update.sh`

放在 repo 外面，避免腳本執行到一半把自己覆蓋掉。

```sh
#!/bin/sh
set -e
cd /root/BC_djs_bot_test
git fetch origin test
before=$(git rev-parse HEAD)
git reset --hard origin/test
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then echo "no change"; exit 0; fi
if ! git diff --quiet "$before" "$after" -- package.json yarn.lock; then yarn install; fi
pm2 restart discord-bot --update-env
echo "updated: $before -> $after"
```

```sh
chmod +x /root/update.sh
sh /root/update.sh     # 手動更新隨時可跑
```

用 `reset --hard` 而非 `pull`：jail 端永遠不改檔案，硬對齊遠端才不會因為衝突讓 cron 默默卡住。
相依套件只在 `package.json` / `yarn.lock` 真的變動時才重裝。

## 每日自動更新

jail 內 `crontab -e`：

```
0 5 * * * /bin/sh /root/update.sh >> /root/update.log 2>&1
```

每天 05:00 更新一次。確認：`crontab -l`，隔天看 `/root/update.log`。

## 日常流程

1. 在 NAS 的工作目錄改檔
2. `git commit` → `git push origin test`
3. jail 內 `sh /root/update.sh`（或等隔天 cron）
4. `pm2 logs discord-bot` 看啟動結果，在測試伺服器驗證
5. 驗證通過 → `git checkout main && git merge test && git push` → 正式站依既有方式部署

## 環境差異

| 項目 | 測試 jail `DiscordBot-Test` | 正式 jail `DiscordBot` |
|---|---|---|
| 路徑 | `/root/BC_djs_bot_test` | `/root/BC_djs_bot` |
| 部署 | git（`test` 分支）+ `update.sh` | 手動複製 |
| 啟動 | pm2（`discord-bot`） | `yarn dev`（Phase 7-C 改 pm2） |
| `.env` | 測試 bot token、測試伺服器 | 正式 bot token、正式伺服器 |
| Node | v24.14.1 | v24.14.1 |

> Node 版本兩邊一致（2026-08-17 由使用者確認，正式站已非早期紀錄的 v20）。

## 建置新 jail 時的坑（供日後重建參考）

- **`bpf=1` 一定要開。** iocage 的 DHCP 靠 jail 內的 `dhclient`，沒有 bpf 就拿不到位址，
  症狀是任何連線都回 `Network is unreachable`，且 `/etc/resolv.conf` 會停在基礎映像的 `8.8.8.8`。
- **`vnet0_mac` 不可與其他 jail 相同。** 從既有 jail clone 出來的會沿用同一組 MAC，兩個 jail 同時
  在同一個 bridge 上會互相干擾。設 `vnet0_mac=none` 讓 iocage 重新產生。
- **`resolver=none`** 把 `/etc/resolv.conf` 交給 DHCP 產生，與正式 jail 一致，不必手動維護。
- **`node_modules` 一定要在 jail 內 `yarn install`，不能從 Windows 複製。**
  esbuild（vite-node 的相依）是平台原生執行檔，複製過來的是 `@esbuild/win32-*`，FreeBSD 執行不了；
  連 `node_modules/.bin/` 底下的項目都會變成 Windows 版的 `#!/bin/sh` wrapper，pm2 用 node 去執行它
  會得到 `SyntaxError: missing ) after argument list`。在 jail 內正常安裝後就不會有這問題。
- **pm2 的 `--cwd` 不能省。** `src/core/loader.js` 用相對路徑 `./src/**` 掃檔，工作目錄不對會靜默
  載不到任何指令與事件，而且不會報錯（ISSUES.md 的 M-05）。

## 已知待清理

- jail 內 `/root/node_modules`（8/14 誤裝在家目錄的那份），確認沒東西依賴後可刪。
- pm2 裡若還留著 `bc-djs-bot` / `bc-test` 這些舊項目，`pm2 delete <name> && pm2 save` 清掉。
