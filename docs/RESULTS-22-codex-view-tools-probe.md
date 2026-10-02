# 右窗格八工具接上 codex dynamicTools 之前的協定探測

量測日期:2026-09-12
codex-cli 0.154.0 / macOS 26.6.2(Darwin 25.6.0)/ Node 24.18.0 / 模型 gpt-6-astra
探針目錄:`/tmp/probe-c`

yeschef 要把右窗格瀏覽器的八個工具經 `dynamicTools` 交給 codex 對話。寫規格前有九件
協定行為不能猜,用獨立探針直接對 `codex app-server` 說話,每件至少實跑一次。
協定 schema 由 `codex app-server generate-json-schema --out ./schema` 產生。

## 結論表

| # | 問題 | 結論 | 一句話證據 |
|---|---|---|---|
| 1 | `inputImage` 吃哪種 URL? | `data:` 吃、`file://` 吃、`https://` **被伺服器擋掉** | https 那次 stderr 直接說 `remote image URLs are not supported; use an inline data URL instead`,item 變 `failed` |
| 2 | 一次回 `inputText` + `inputImage`,兩項都進模型? | 都進 | 模型同時答出 `(a) 關鍵字：ZEBRA` 與 `(b) 圖中的英文字母：Z` |
| 3 | 同一 thread 內 dynamic tool 會併發嗎? | 不會,app-server 串起來一顆一顆發 | 兩顆呼叫同 turnId,第一顆 `+7.61→+10.61`、第二顆 `+11.10→+14.10`,零重疊 |
| 4 | 兩個 thread 搶同一個瀏覽器,`threadId` 夠分辨嗎?輸家重試嗎? | `threadId` 夠(兩支子程序的 UUID 不同,`callId` 也不同)。輸家會不會重試**看提示怎麼寫**:要求「原樣貼回原文」時直接放棄;要求「想辦法拿到」時約 15 秒後重試成功,但中間會跑去下 shell 指令亂找 | 變體一 B 只呼叫 1 次、最終答案就是「瀏覽器正被別的對話使用」;變體二 B 呼叫 2 次,失敗後夾了 `pwd`、`rg --files` 兩條 commandExecution |
| 5 | 一次送 10 個工具?`deferLoading`?`NamespaceDynamicToolSpec`? | 10 個平鋪工具照單全收,模型十個全列得出來。`deferLoading:true` **平鋪時會被拒**(`deferred dynamic tool must include a namespace`),放進 namespace 才合法。namespace 形狀接受,對模型露出的名字是 `view__click` 這種雙底線拼接 | 5a 模型列出全部 10 個;5b `thread/start` 回 `-32600`;5c 模型列出 `view__click`…;5b2 deferred 的不出現在清單但叫得動 |
| 6 | 60 秒不回,codex 會自己取消嗎?未決時 `turn/interrupt` 呢? | 60 秒**不會**自己取消,壓滿 60 秒後回覆照樣被採用(`durationMs: 60023`)。`turn/interrupt` 會立刻結束 turn(`status: "interrupted"`),未決的 call 變 `failed` 且 `contentItems: []`;**遲到的回覆被靜默丟棄**,無錯誤、無 crash,thread 之後還能正常開新 turn | 6a `+6.54` 發出、`+66.61` 完成,最終答案 `標題是 SLOW-60`;6b interrupt 後 stderr 印 `dynamic tool call was cancelled before receiving a response`,遲到回覆送出後 8 秒內零反應,下一輪答出 `標題是 AFTER-INTERRUPT` |
| 7 | `thread/resume` 帶 8 個 `dynamicTools` 之後工具還在嗎? | 在。換一支新的 app-server 子程序 resume,8 個全在,叫得動 | resume 後模型列出 8 個 `view_*`(外加 codex 內建的 `view_image`),呼叫 `view_console` 拿到 `RESUME-OK-777` |
| 8 | 工具壓 8 秒,`item/started` 有先送嗎?turn 會被別的事件推進嗎? | `item/started`(`status: "inProgress"`)與 `item/tool/call` **同一刻送出**,`item/started` 在前。壓住的 8 秒內 turn 完全靜止,沒有任何 item 事件 | `+22.63s item/started dynamicToolCall` → `+22.63s item/tool/call` → 中間空白 → `+30.64s item/completed` |
| 9 | `DynamicToolCallParams.callId` 與 `item/started` 的 `item.id` 同值嗎? | 同一個值,逐字相同,格式 `exec-<uuid>` | `callId = "exec-5c9e214a-c893-499e-ac2b-c81854674923"`,同刻的 `item/started` 的 `item.id` 一字不差 |

---

## 各項證據

探針原始碼與完整 log 都在探針目錄:
`probe1.mjs`/`p1.log`(1、2、9)、`probe38.mjs`/`p38.log`(3、8)、
`probe57.mjs`/`p57.log`(5a5c、7)、`probe5b2.mjs`/`p5b2.log`(5 補測)、
`probe6.mjs`/`p6.log`(6)、`probe4.mjs`/`p4.log` 與 `probe4b.mjs`/`p4b.log`(4)。
共用底座 `lib.mjs`。所有 thread 都用 `approvalPolicy: 'never'`、`sandbox: 'read-only'`。

### 1. `inputImage` 的三種 URL

怎麼探:註冊一個假的 `view_screenshot`,呼叫時回不同形式的 `imageUrl`,問「圖裡畫的是哪個
英文字母」。`z.png` 是 120×40 的粗體 Z。三種各開一個新 thread,避免前一輪的答案污染。

**1a `data:image/png;base64,…` — 吃。**

```json
// 宿主回覆
{"success":true,"contentItems":[{"type":"inputImage","imageUrl":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAAAoCAIAAAC6iKly…"}]}
// item/completed
{"type":"dynamicToolCall","id":"exec-5c9e214a-…","status":"completed","success":true,"durationMs":36}
```

模型最終答案原文:`Z`

**1b `file:///…/z.png` — 吃,而且走的是另一條路。**

```json
{"success":true,"contentItems":[{"type":"inputImage","imageUrl":"file:///private/tmp/…/probe-c/z.png"}]}
```

`item/completed` 是 `completed / success:true`,但 5 秒後通知流多冒出一顆**不是我們發的** item:

```json
{"type":"imageView","id":"exec-15811b3a-9e73-4d4d-8972-bed10866d122",
 "path":"/private/tmp/…/probe-c/z.png"}
```

也就是 codex 把 `file://` 轉成它自己的內建 `view_image` 去讀本機檔(第 7 項的工具清單裡
確實看得到 codex 內建的 `view_image`)。模型最終答案原文:`Z`。

意義:`file://` 能用,但圖有沒有真的進模型取決於 codex 自己讀得到那個路徑,而且會多跑一顆
item、多一次來回;`data:` 是同一顆 item 內直接帶圖。

**1c `https://placehold.co/240x80/000000/FFFFFF/png?text=Z` — 被擋。**

stderr:

```
ERROR codex_app_server::dynamic_tools: dynamic tool response was invalid
remote image URLs are not supported; use an inline data URL instead
```

宿主明明回了 `success: true`,伺服器仍把 item 改成:

```json
{"type":"dynamicToolCall","status":"failed","success":false,
 "contentItems":[{"type":"inputText","text":"remote image URLs are not supported; use an inline data URL instead"}]}
```

模型最終答案原文:
`看不到圖。工具回覆：「remote image URLs are not supported; use an inline data URL instead」。`

### 2. 一次回兩項

宿主回:

```json
{"success":true,"contentItems":[
  {"type":"inputText","text":"關鍵字是 ZEBRA"},
  {"type":"inputImage","imageUrl":"data:image/png;base64,…"}]}
```

模型最終答案原文:

```
(a) 關鍵字：`ZEBRA`
(b) 圖中的英文字母：`Z`
```

兩項都進到模型。`item/completed` 的 `contentItems` 原樣保留兩項、順序不變。

### 3. 同 thread 併發

怎麼探:`view_slow` 宿主端 sleep 3 秒才回,提示明寫「同時發出兩次,不要一個做完再做另一個」。

```
+7.61s  item/started + item/tool/call  callId=exec-93473baa… which=bottom
+10.61s 宿主回覆 bottom          (item/completed durationMs 3011)
+10.78s item/started + item/tool/call  callId=exec-4f0ce3ea… which=top
+14.10s 宿主回覆 top             (item/completed durationMs 3324)
```

兩顆的 `turnId` 相同(`01a0939f-f46c-7f23-9a51-3f10be642724`),但第二顆的 `item/tool/call`
在第一顆回覆之後 0.17 秒才進來。第二顆進來前沒有任何 agentMessage / reasoning item,
也就是中間沒有模型的額外來回 ── 兩顆是同一次模型輸出裡的兩顆 call,由 app-server 串成序列
一顆一顆發給宿主。

結論:同一 thread 內宿主**不會**同時收到兩顆未決的 dynamic tool call。宿主端不需要為同
thread 做重入處理;但宿主阻塞多久,就把整個 turn 卡多久。

### 4. 兩個 thread 搶同一個瀏覽器

怎麼探:開兩支 app-server 子程序 A、B,各自 `thread/start` 同名工具 `view_screenshot`。
宿主端維護一把鎖,先到者拿鎖並壓 12 秒,後到者收 `success:false` +「瀏覽器正被別的對話使用」。

`threadId` 分不分得出來 ── 分得出來:

```json
{"threadId":"01a093a5-296c-76d0-b705-fc065157150b","callId":"exec-74d41506-…","tool":"view_screenshot"}  // A
{"threadId":"01a093a5-29b1-78f1-a4b4-e6b020a5197e","callId":"exec-6734397a-…","tool":"view_screenshot"}  // B
```

兩支子程序的 `threadId` 與 `callId` 都不同,宿主單靠 `threadId` 就能判斷鎖主。

輸家的反應分兩種,取決於提示:

**變體一**(`probe4.mjs`,提示「把它回給你的原文原樣貼給我」):B 只呼叫一次就放棄,
`dynamicToolCall` 次數 = 1,最終答案原文就是 `瀏覽器正被別的對話使用`。

**變體二**(`probe4b.mjs`,提示「我需要知道…請想辦法拿到並告訴我」):B 呼叫兩次。
失敗後 `+14.28s` 有一段 reasoning,接著跑去下了兩條 shell 指令:

```json
{"type":"commandExecution","command":"/bin/zsh -lc pwd","status":"completed"}
{"type":"commandExecution","command":"/bin/zsh -lc \"rg --files -g '!node_modules' …\"","status":"completed"}
```

`+23.17s` 才重試 `view_screenshot`,這時鎖已放掉,拿到 `畫面標題是 OWNER-OK`,
最終答案 `右窗格瀏覽器目前顯示的畫面標題是 **OWNER-OK**。`(A 那邊同一句)。

意義:一句乾巴巴的「正被別的對話使用」不足以指導模型 ── 它可能直接放棄,也可能跑去下 shell
指令另闢蹊徑。錯誤訊息要明講「請稍後重試,不要改用其他方式」。

### 5. 十個工具 / deferLoading / namespace

八個 view 名稱:`view_screenshot`、`view_read_text`、`view_click`、`view_type`、
`view_scroll`、`view_navigate`、`view_console`、`view_network`;
兩個 peer 名稱:`peer_ask`、`peer_answer`。提示要求「不要呼叫任何工具,逐行列出名字」。

**5a 十個平鋪 `FunctionDynamicToolSpec` — 接受,模型十個全看得到。**
`thread/start` 正常回 thread,模型答案原文:

```
view_click
view_console
view_navigate
view_network
view_read_text
view_screenshot
view_scroll
view_type
peer_answer
peer_ask
```

**5b 十個平鋪 + `deferLoading: true` — `thread/start` 直接被拒。**

```json
{"code":-32600,"message":"deferred dynamic tool must include a namespace: view_screenshot"}
```

**5c `NamespaceDynamicToolSpec` — 接受。** 一個 `namespace` 名叫 `view`、底下八個工具
(名字去掉 `view_` 前綴)加上兩個平鋪的 peer。模型答案原文:

```
view__click
view__console
view__navigate
view__network
view__read_text
view__screenshot
view__scroll
view__type
peer_answer
peer_ask
```

露給模型的名字是 `<namespace>__<tool>`(雙底線)。

**5b2 補測:`deferLoading` 放進 namespace 裡(合法形狀)。** `thread/start` 接受。
先問清單,模型只答得出沒被 defer 的三個:

```
peer_answer
peer_ask
view_image
```

(`view_image` 是 codex 內建的,不是我們送的。)但要它「呼叫右窗格的 screenshot 工具」時
它仍然叫得動,`item/tool/call` 的形狀是 `namespace` 與 `tool` 分開兩欄:

```json
{"threadId":"01a093a2-0ff9-73f3-a248-71f6eef4cdc0","turnId":"01a093a2-35a5-…",
 "callId":"exec-ad31e75b-7d77-4e4d-82d0-7a01b21570cc",
 "namespace":"view","tool":"screenshot","arguments":{"arg":""}}
```

拿到 `NS-OK-555`。所以 `deferLoading` 的語意是「不在開場的工具清單裡,但需要時展得開」。
代價是 5b2 這一顆從提示到發出呼叫花了約 6 秒(`+13.98` reasoning → `+20.26` 呼叫),
比 5a 的平鋪多一段摸索。

### 6. 逾時與 interrupt

**6a 壓 60 秒。** 沒有任何取消。

```
+6.54s  item/started dynamicToolCall + item/tool/call
+37.52s thread/tokenUsage/updated        ← 壓住期間只有這類計量通知
+55.29s thread/tokenUsage/updated
+66.61s item/completed dynamicToolCall   durationMs: 60023, status: "completed"
+72.47s turn/completed
```

最終答案原文:`標題是 SLOW-60`。整整 60 秒之後回的內容照樣被採用,codex 端沒有自帶逾時。

**6b 未決時 `turn/interrupt`。** 收到 `item/tool/call` 後刻意不回,2 秒後送:

```json
{"method":"turn/interrupt","params":{"threadId":"01a093a4-43b7-…","turnId":"01a093a4-441b-…"}}
```

回應是 `{}`。同一刻(20 毫秒內):

```json
// turn/completed
{"turn":{"id":"01a093a4-441b-…","status":"interrupted"}}
// item/completed,注意 contentItems 是空的
{"type":"dynamicToolCall","id":"exec-f6d09de8-…","status":"failed","success":false,
 "contentItems":[],"durationMs":2393}
```

stderr:`ERROR codex_core::tools::router: error=dynamic tool call was cancelled before receiving a response`

5 秒後宿主才把遲到的回覆送出去(`標題是 LATE-REPLY`)。接下來 8 秒:**零反應**。
沒有 JSON-RPC 錯誤回應、沒有通知、沒有 stderr、子程序沒死
(`killed=false exitCode=null`)。遲到的回覆被靜默丟棄。

thread 之後完全正常:同一個 threadId 再開一輪,呼叫成功,答案 `標題是 AFTER-INTERRUPT`。

注意 `turn/interrupt` 的兩個必填欄位都要:`threadId` 與 `turnId`。`turnId` 從
`item/tool/call` 的 params 或 `turn/started` 通知裡拿。

### 7. resume 之後工具還在不在

怎麼探:A 子程序 `thread/start` 帶 8 個 `view_*`,跑一輪確認叫得動(拿到 `RESUME-OK-777`);
SIGKILL 掉 A,另開 B 子程序 `thread/resume` 帶同樣 8 個工具(模擬重開 app)。

```json
{"method":"thread/resume","params":{"threadId":"01a093a1-52b0-7470-b6ed-22145ebd5c84",
 "approvalPolicy":"never","sandbox":"read-only","dynamicTools":[…8 個…]}}
```

resume 成功,回的 `thread.id` 與原本同值。接著問清單,模型答案原文:

```
view_click
view_console
view_image
view_navigate
view_network
view_read_text
view_screenshot
view_scroll
view_type
```

我們送的 8 個全在(`view_image` 是 codex 內建的)。再要它呼叫 `view_console`,
`item/tool/call` 正常進來,拿到 `RESUME-OK-777`。

這與 RESULTS-16 的結論一致,這次把工具數從 2 個拉到 8 個仍然成立。

### 8. 批准時序(壓 8 秒)

壓住期間的完整事件序(擷自 `p38.log`,已濾掉 delta 與 hook):

```
+22.63s item/started dynamicToolCall   {"status":"inProgress","contentItems":null,"success":null,"durationMs":null}
+22.63s item/tool/call                 ← 同一刻,item/started 在前
        ── 這裡是壓住的 8 秒,一顆事件都沒有 ──
+30.64s item/completed dynamicToolCall {"status":"completed","durationMs":8004}
+30.67s thread/tokenUsage/updated
+32.75s item/started agentMessage
+33.27s turn/completed
```

兩點:
1. `item/started` 帶 `status: "inProgress"` 在宿主回覆**之前**就送出去了,和 `item/tool/call`
   同一刻。UI 可以在批准對話框還開著的時候就把這顆工具畫成「進行中」。
2. 壓住期間 turn 完全靜止,沒有任何其他 item 被推進。宿主慢一秒,整個回合就慢一秒。

### 9. `callId` 與 `item.id`

同一顆呼叫的兩份全文(`p1.log` 第一輪):

```json
// item/started 的 item
{"type":"dynamicToolCall","id":"exec-5c9e214a-c893-499e-ac2b-c81854674923",
 "namespace":null,"tool":"view_screenshot","arguments":{},"status":"inProgress",
 "contentItems":null,"success":null,"durationMs":null}

// item/tool/call 的 params
{"threadId":"01a0939e-3301-7493-993a-4d46ae5b8849","turnId":"01a0939e-33b1-7112-b210-4576fe80d6c1",
 "callId":"exec-5c9e214a-c893-499e-ac2b-c81854674923","namespace":null,
 "tool":"view_screenshot","arguments":{}}
```

`item.id === callId === "exec-5c9e214a-c893-499e-ac2b-c81854674923"`。
四輪四顆呼叫全部對得上,格式一律 `exec-<uuid v4>`。`item/completed` 的 `item.id` 也是同值。

宿主可以直接拿 `callId` 當 UI 上那顆 item 的 key,不必另建對照表。

---

## 對接線的意義

- **圖只能用 `data:` URL。** `https://` 被伺服器層擋死,而且擋掉之後宿主回的 `success:true`
  會被改寫成 `failed`,模型看到的是英文錯誤句。右窗格截圖要在宿主端轉成 base64 內嵌。
  `file://` 雖然能用,但會繞到 codex 內建的 `view_image` 去讀本機檔,多一顆 item、多一次來回,
  而且要求那個路徑對 codex 程序可讀 ── 不建議。
- **八個工具直接平鋪送就好。** 10 個平鋪模型全看得到、名字原樣。`deferLoading` 必須配
  namespace,而 namespace 會把名字改成 `view__screenshot` 這種雙底線形,對 UI 顯示與
  RESULTS-16 既有的 mapper 都是額外的轉換。八個工具不多,不值得為省 context 換來改名。
- **宿主阻塞就是 turn 阻塞。** 同 thread 不會併發,壓住期間 turn 完全靜止,codex 端沒有自帶
  逾時(60 秒照收)。逾時要宿主自己做:壓太久就自己回 `success:false` 附人話,不要讓使用者
  對著不動的 turn 乾等。
- **`turn/interrupt` 之後遲到的回覆是安全的。** 靜默丟棄,不報錯不 crash。宿主不必為
  「使用者按了停止、瀏覽器操作還在跑」設計取消協定,但要記得那顆 call 的 `contentItems` 是空的,
  UI 上要自己補一句「已取消」。
- **`thread/resume` 一定要重帶 `dynamicTools`。** 8 個照樣接受、照樣叫得動。
- **跨對話搶瀏覽器的錯誤訊息要寫得夠具體。** 只說「正被別的對話使用」時,模型可能直接放棄,
  也可能跑去下 shell 指令自己找答案(實測跑了 `pwd` 與 `rg --files`)。訊息要明講
  「請等幾秒後重試同一個工具,不要改用其他方式」。
- **`callId` 可以直接當 key**,與 `item/started` 的 `item.id` 同值;`threadId` 足以分辨
  是哪個對話在呼叫,多專案共用一個瀏覽器的鎖可以只靠它。
