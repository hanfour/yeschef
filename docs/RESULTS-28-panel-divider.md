# RESULTS-28:左欄與主分頁區之間的分隔條 實機驗收

- 日期:2026-09-13
- 分支:`panel-divider`,三個實作 commit(codex gpt-6-astra 實作,sonnet 審查)
- 規格:`docs/specs/2026-09-11-shell-regions-design.md` 增量 3a 那段「3a 不做寬度拖曳」底下的 spike 結論
- 計畫:`docs/superpowers/plans/2026-09-12-panel-divider.md`

## 1. 設計前的量測(`spike-divider`,2026-09-12)

疑慮是分界線緊貼右邊的原生瀏覽器 view,滑鼠越過分界後 renderer 收不收得到事件。用 cliclick 做真實滑鼠拖曳量過:
越過分界後 renderer 一個 `pointermove`/`pointerup` 都收不到,pointer capture 無效;把右邊 view 藏掉或縮成 0 也沒用,
因為 spike 裡那塊區域底下沒有任何 view。macOS 依「游標當下在哪個原生 view 上」路由事件,不依誰收到 mousedown。
但 yeschef 的 renderer 本來就佔滿整個視窗、瀏覽器只是疊在上面,所以拖曳期間把瀏覽器藏起來,游標底下就只有 renderer。
分隔條依此做。

## 2. 自動測試

typecheck 0 error;1925 測試全過;Stmts 94.44%、Branch 90.34%;build 成功。

## 3. 實機驗收(cliclick 真滑鼠;視窗在 (51,30),1600×900)

| # | 做什麼 | 應該看到 | 實際 |
|---|---|---|---|
| 1 | 按住分隔條往右拖 200px | 主分頁區變窄 200;拖曳期間瀏覽器藏著;放開後回到新位置 | 801→601;按下 20ms 後 `visible=false`;放開後 `x=1000, w=600`,等於新的 `.panel-body` ✓ |
| 2 | 往左拖到超過上限、放開在最左邊 | 停在左欄剩 480,存檔,瀏覽器回來 | 主 1121 / 左 479,存 1120,`visible=true` ✓ |
| 3 | 視窗縮到 1200 寬 | 主分頁區夾成 1200−480 | 721 / 479,瀏覽器寬 720;存的值不動(只改畫面)✓ |
| 4 | 關 app 重開 | 寬度還在 | 1121 ✓ |
| 5 | 收起再展開 | 展開後是上次的寬度 | 1121 ✓ |

## 4. 真滑鼠抓到、合成事件沒抓到的

**收尾不跑。** 第一版只靠元素上的 `onPointerUp`。真滑鼠的事件序列是
`pointerdown → pointermove ×N → lostpointercapture → pointermove → pointerup`:capture 在 `pointerup` 之前掉了,
之後的 `pointerup` 送到游標底下的元素,不是分隔條;寬度不存、瀏覽器一直藏著。往右拖有時成功是運氣。
`Sidebar` 的把手是同一個寫法,jsdom 的合成事件不會發 `lostpointercapture`,所以先前沒撞到。
修法兩個把手一致:`onLostPointerCapture` 也收尾;`pointerdown` 時在 window 掛一次性的 `pointerup`/`pointercancel`;
收尾冪等。先寫了六條會失敗的測試才改。

## 5. 審查抓到的

- 按下到瀏覽器真正藏起之間隔一次 render 加一次 IPC。實測 cliclick 每 50ms 一個 move 沒撞到,但沒封死:
  改成 `pointerdown` 當下同步送 `setBrowserBounds(null)`,`useReportBounds` 的去重知道已送過。
- 視窗縮小後已套用的寬度不會重新夾限,左欄會被壓到 480 以下:`usePanelWidth` 監聽 resize 重新夾限,只改畫面不存
  (存的是使用者的意圖,視窗變回來就恢復),`aria-valuemax` 跟著 `innerWidth`。
