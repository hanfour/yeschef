# RESULTS-29:手機 SSH 接同一個 tmux session 與遠端連線擋睡眠

- 日期:2026-09-15
- 分支:`sleep-guard-remote`(codex gpt-6-astra 實作,sonnet 審查通過)
- 規格:`docs/specs/2026-09-07-yeschef-roadmap.md` §4 第 4 項的手機那半
- 前置:使用者開啟「系統設定 → 一般 → 共享 → 遠端登入」

## 1. 手機接續(使用者真機操作,iPhone、Termius)

| # | 做什麼 | 實際 |
|---|---|---|
| 1 | SSH 到 `192.168.1.61` | 第一次失敗:把整串 `ssh user@host` 填進主機欄,app 拿去查 DNS。分開填 Address/Username 後成功。連線在主機上是 `ttys004`,來源 192.168.1.65 |
| 2 | `tmux list-sessions` | 看到 yeschef 的三個 `sp-*` |
| 3 | `tmux attach -t sp-c5500795` | 接上;`tmux list-clients` 多一個 `xterm-256color`、54×23 的 client |
| 4 | 在手機打 `echo FROM-PHONE` | 主機 `capture-pane` 看到;同一個 session |
| 5 | 離開 | `Ctrl-b d`:app 的 Ctrl 鍵怎麼按都沒送出;改打 `tmux detach` 成功。session 三個都還在 |

尺寸:tmux 3.6a 預設 `window-size latest`,視窗跟著最近有動作的 client。手機打字後 session 變 54×22,
yeschef 那側 59×48 的畫面多出來的區域填「·」;手機離開、桌面再有輸入就回 59×47。這是 tmux 使用者預期的行為,不改。

沒驗到的:手機答權限與 Ctrl-C(分頁裡當時沒有跑 agent)、橫直向切換。

## 2. 遠端連線擋睡眠(roadmap 第 4 項的第二個訊號)

訊號:每 15 秒 `tmux list-clients -F '#{session_name} #{client_pid}'`,session 以 `sp-` 開頭、pid 不在 yeschef 自己
node-pty 起的 tmux 程序 pid 集合裡的,就是遠端 client。

| # | 做什麼 | 實際 |
|---|---|---|
| 1 | 手機 attach,對話全部閒置 | 15 秒內 log「擋睡眠:有遠端連線」,`pmset` 出現 Electron 的 assertion ✓ |
| 2 | 手機 `tmux detach` | 16 秒內 log「放行睡眠:全部閒置」,assertion 消失 ✓ |

自動測試:1944 全過;Stmts 94.45%、Branch 90.47%。

## 3. 記下來的

- 手機 app 的 Ctrl 鍵不可靠,離開 tmux 要靠 `tmux detach`。roadmap 第 6 項手機網頁版若做,特殊鍵要自己畫。
- 手機 SSH 是密碼登入(主機沒有 authorized_keys)。要更安全就放金鑰,那是使用者的事。
