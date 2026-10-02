# Spike 3 結果：跨站 iframe 的 CDP 覆蓋率

## 現行結論（最終，「修正輪 2」，2026-09-01）

跨站 iframe CDP 附著覆蓋率：**加權平均 16/16 = 100.0%，通過 95% 判準**。

| 站點 | 跨站 frame（分母） | 附著（分子） | 深度分佈 |
|---|---:|---:|---|
| MDN iframe 元素參考頁 | 5 | 5 | 深度1: 3/3，深度2: 2/2 |
| Stripe checkout quickstart | 9 | 9 | 深度1: 2/2，深度2: 5/5，深度3: 2/2 |
| Google Identity configurator | 2 | 2 | 深度1: 1/1，深度2: 1/1（即 SSO 登入框） |
| **加權平均** | 16 | 16 | **100.0%** |

分母與分子都來自 CDP `Target.getTargets()` 重建的 frame 樹（跟直接父層比 eTLD+1 判定跨站），不是頁面內 JS DOM 計數；reviewer 已用獨立探針重建 16 個 frame 的父子鏈逐一核對過這三個數字。統計揭露：16/16 全中，rule of three 上界約 19%，樣本量本身仍分不出「100%」與「略低於 95%」，但這次是分母正確涵蓋深度 1～3（含 SSO 登入框）之後的真實觀測，不是量測方法盲點造成的假象——完整推理與驗證過程見下方「修正輪 2」。

**這是最終結論。下方「第一輪」與「修正輪」兩節裡出現的判準結論（含各自的「## 結論」段落）都已失效，只保留排查過程本身的參考價值；讀到裡面的「通過」或「未通過」一律不要採信，只採信本節與「修正輪 2」一節。**

---

量測日期：2026-08-31（第一輪）／2026-09-01（修正輪、修正輪 2）
Electron 版本：44.0.0
Chromium 版本：152.0.7977.54

## 第一輪（2026-08-31）

> **本節結論已失效**（分母當時靠頁面內 JS DOM 計數，穿不透巢狀跨站 iframe，見「修正輪」的推翻理由）。
> 保留本節是因為排查過程本身仍然成立（兩個真正的計數錯誤修正：`attached` 篩選、shadow DOM 穿透），
> 但下面的判準行不要採信，最終結論在文件最上方。

## 結果

| 站點 | 頁面內跨站 iframe | 附著 target | 覆蓋率 |
|---|---:|---:|---:|
| MDN iframe 元素參考頁 | 3 | 3 | 100% |
| Stripe checkout quickstart | 12 | 12 | 100% |
| Google Identity 登入按鈕 configurator | 1 | 1 | 100% |
| Cloudflare Turnstile demo | 0 | 1 | n/a |
| Facebook Page Plugin 文件頁 | 0 | 0 | n/a |
| **加權平均**（僅計入有量到跨站 iframe 的站） | 16 | 16 | **100.0%** |

判準 95%：**通過**（加權平均 100.0%，n=3 個有效樣本站）**（已失效，見文件最上方「現行結論」；本節的 100% 是分子分母對巢狀內容同時隱形、剛好互相抵銷造成的假象，見「修正輪」）**

兩次獨立重跑（`npm run spike:oopif` 連續執行兩次）數字完全一致，不是單次僥倖。

## 換過的站與理由

brief 原列的 5 站，有 2 站換過，換的過程與判準見下面「排查過程」：

- **`https://www.google.com/recaptcha/api2/demo` → 換成 MDN iframe 元素參考頁保留原位、另補 2 站**：這個 demo 頁是 Google 自己架在 `www.google.com` 上，widget iframe 的 src 也是 `www.google.com`（同一個 origin）。同源代表 JS 端 `contentDocument` 讀得到，不會被判成跨站，Chromium 也沒有理由把它切成獨立 OOPIF——這根本不是一個跨站 iframe 案例，留著只會製造「0/0 判成 n/a」的假象。換成 **Cloudflare Turnstile demo**（`demo.turnstile.workers.dev`，widget 來自 `challenges.cloudflare.com`，兩個不同 eTLD+1，是真正跨站）。
- **`https://www.w3schools.com/html/html_iframe.asp` → 換成 Facebook Page Plugin 文件頁**：這頁的跨站 iframe 幾乎全是廣告網路的即時競價（RTB）cookie 同步 pixel（criteo、pubmatic、rubicon、richaudience……），數量會隨每次載入的廣告拍賣結果劇烈浮動且和 CDP 是否附著無關。兩次獨立試跑同一個 URL，`Target.getTargets()` 抓到的 iframe target 數從 39 到 43 不等，頁面內偵測到的數量從 6 到 11 不等——這種店家式廣告雜訊不是「金流、SSO 登入框」這個 spike 真正關心的風險類型，留著只會讓覆蓋率數字忽高忽低、失去判準意義。換成 **Facebook Page Plugin 文件頁**（`developers.facebook.com/docs/plugins/page-plugin/`）嘗試量測社群外掛類的跨站 iframe；實測這頁重導到一個純文件頁、沒有現場渲染 widget，結果是 n/a（見下方判定），沒有引入新的雜訊，量測依然乾淨。

兩次替換都不是為了讓覆蓋率好看而挑好測的站——事實上兩個新選的站裡有一個（Turnstile）雖然附著成功（見下方「已知盲點」），另一個（Facebook）根本沒量到東西，兩者都被 n/a 正確排除，沒有虛報。

## 排查過程：兩個真正的計數錯誤

第一次完整跑五站（brief 原始腳本邏輯）就發現數字荒謬：Stripe 覆蓋率 164%、Google Identity configurator 200%、w3schools 717%——覆蓋率不可能超過 100%，這代表分子分母根本沒有量同一件事。深入排查找到兩個獨立的錯誤，都修正了：

### 錯誤 1：`Target.getTargets()` 回傳整個 browser context 的 target，不是只有目前這一頁的

用 `OOPIF_DEBUG=1 npm run spike:oopif` 印出每個 target 的 `type`／`attached`／`url` 後看到：Stripe 頁面除了頁面本身真正用到的 hCaptcha／Google Tag Manager／Stripe Elements iframe（都是 `attached: true`）之外，還混了一批 `attached: false` 的殘留 target（例如 `newassets.hcaptcha.com` 的舊 challenge frame、`pay.google.com` 的 payframe）。原始程式只用 `type === 'iframe'` 篩選，沒管 `attached` 欄位，等於把「這個 target 曾經存在過」跟「我這個 CDP session 真的附著上了」混為一談。

w3schools 那頁把這個問題放到最大：畫面上根本沒有付款或登入 iframe，但廣告網路的 RTB cookie 同步 pixel 動態開關大量隱藏 iframe，`Target.getTargets()` 把整個 browser context 曾經出現過的這些 iframe target 全部列出來，跟頁面內容完全對不上。

**修正**：篩選條件改成 `t.type === 'iframe' && t.attached === true`。修正後 Stripe 從 164% 變成乾淨的 12/12＝100%，Google Identity configurator 從 200% 變成 1/1＝100%。

這個發現同時解釋了另一個現象：在同一次程序執行中依序切換到不同站點時，`Target.getTargets()` 有時會混進**上一站殘留**的 target（例如切到 Cloudflare Turnstile demo 那一輪，還看到 `developers.google.com/sw.js` 這個上一站 Google Identity 頁面註冊的 service worker）。這類殘留全部是 `service_worker`／`worker` 型別，本來就不在 `type === 'iframe'` 篩選範圍內，不影響覆蓋率計算，但證實了 `Target.getTargets()` 確實是整個 browser context 範圍，不是單頁範圍。

### 錯誤 2：`document.querySelectorAll('iframe')` 穿不透 shadow DOM，不是時機問題

MDN 的 iframe 參考頁最初量到「頁面內跨站 iframe 0，附著 target 6」——兩個數字互相矛盾：附著了 6 個 iframe target，頁面裡不可能真的沒有 iframe。

排查過程：
1. 先假設是時機問題，把 `LOAD_SETTLE_MS` 從 4000 提高到 9000，問題依舊，`document.querySelectorAll('iframe').length` 仍然是 0。排除時機。
2. 加一段用 `TreeWalker` 手動穿透 `shadowRoot` 遞迴計數 iframe 的除錯程式，結果找到 **3** 個——跟 `Target.getTargets()` 裡 `attached: true` 的 3 個 mdnplay.dev 互動範例 iframe 完全對上。

結論：MDN 的「Try it」互動範例是包在一個 web component 的 **shadow DOM** 裡渲染的，標準的 `document.querySelectorAll('iframe')`（不穿透 shadow boundary）在光是 DOM 上完全查不到它們，等多久都一樣——這不是非同步載入的時機問題，是查詢方法本身的盲點。

**修正**：`COUNT_CROSS_ORIGIN` 改寫成遞迴 `TreeWalker`，遇到 `node.shadowRoot` 就往下穿透繼續數。修正後 MDN 從「0 / 6，n/a」變成乾淨的 3/3＝100%。

**已知殘留限制**：這個穿透法只能看到 **open** shadow root——`element.shadowRoot` 對 `attachShadow({mode:'closed'})` 建立的 shadow root，從頁面 JS 端本來就回傳 `null`，這是 JS 語言層級的限制，CDP 之外的一般網頁腳本無法繞過。這解釋了 Cloudflare Turnstile demo 的異常：`Target.getTargets()` 附著了 1 個 `challenges.cloudflare.com` 的 turnstile iframe（`attached: true`，附著本身沒問題），但頁面內偵測（含 shadow 穿透）找到 0 個，該站因此被判定 n/a、不計入加權平均。這反而是一個旁證：**CDP 的附著本身在這個案例是成功的，只是本測試用來當分母的「頁面內跨站 iframe 數」偵測法本身有 closed shadow root 這個已知盲點**，不是 flatten 附著失敗。要完整涵蓋 closed shadow root，需要改用 CDP 的 `DOM.getFlattenedDocument`（`pierce: true`）之類的瀏覽器端 API 取代頁面內 JS 查詢，這超出本次 spike 的範圍，留給後續需要更精確覆蓋率量測時再做。

## 結論（已失效，見文件最上方「現行結論」）

跨站 iframe 的 CDP target 附著覆蓋率：**加權平均 100.0%（16/16），通過 95% 判準**。三個真正量到跨站 iframe 的站（MDN 互動範例、Stripe 付款流程含巢狀 hCaptcha、Google 登入按鈕）覆蓋率全部 100%，且兩次獨立重跑數字一致。`Target.setAutoAttach` 搭配 `flatten: true` 在這三種真實跨站 iframe 場景下，確實讓單一 CDP session 完整看到所有子層 OOPIF target。

樣本數（n=3 個有效測站）不大，且排查過程中發現的兩個計數盲點（closed shadow root、廣告網路動態 iframe 造成的分子分母不對稱）代表這個量測方法本身仍有已知限制，不是萬用的覆蓋率量測工具。但就這次驗到的三個真實金流／SSO／互動內容跨站 iframe 場景而言，數字是乾淨、可重現、通過判準的。

未通過情境的處置（規格 §8，本次未觸發，附此供對照）：E2E 情境明確排除跨站金流與 SSO 頁，並在 `view_snapshot` 的回傳中固定標出「有 N 個 iframe 未附著」，讓 agent 知道自己看不到。

## 附註

- 原始（未修正）腳本第一次完整跑五站的數字，僅供對照，不能用於判準：
  - `https://www.google.com/recaptcha/api2/demo`：0 / 0，n/a（後確認同源，非跨站案例）
  - `https://docs.stripe.com/payments/quickstart`：11 / 18，164%
  - `https://developers.google.com/identity/gsi/web/tools/configurator`：1 / 2，200%
  - `https://www.w3schools.com/html/html_iframe.asp`：6 / 43，717%（另一次重跑量到 11 / 39，355%，兩次不一致）
  - `https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe`：0 / 6，n/a（後確認為 shadow DOM 盲點，非真的 n/a）
- 最終腳本的 `attached` 篩選（`type === 'iframe' && attached === true`）與 `COUNT_CROSS_ORIGIN` 的 shadow-piercing 寫法，都是本次排查後對 `spikes/probe-oopif.ts` 的修正，不是 brief 原始版本。
- Google Identity configurator 頁面裡其實還有一個第二層巢狀跨站 iframe（`accounts.google.com/gsi/button`，是 `developers-dot-devsite-v2-prod.appspot.com` 的 configurator iframe 內部再包一層），這個巢狀 iframe 的 target 是 `attached: false`——它在本次量測中沒有被計入分子（因為篩選了 `attached === true`），也沒被計入分母（因為它是巢狀在另一個跨站 iframe 內部，`document.querySelectorAll` 這種只查頂層 light DOM 的寫法本來就看不到它，跟 shadow DOM 盲點是類似但不同的限制：這裡不是 shadow DOM，是「巢狀在別的跨站 iframe 裡面」，JS 端本來就無法穿透 cross-origin iframe 的 `contentDocument` 往下查）。這個巢狀 iframe 究竟是否真的需要被涵蓋在覆蓋率判準內，取決於它是否是使用者真正會操作的內容；本次量測範圍只涵蓋「頂層文件直接查得到的跨站 iframe」，巢狀跨站 iframe 的覆蓋率是本次未涵蓋的已知範圍限制。

---

## 修正輪（2026-09-01）

> **本節結論已失效**（分母當時改用 CDP 附著集合，但仍以頁面內 JS DOM 計數當分母，
> 一樣穿不透巢狀跨站 iframe，見「修正輪 2」的推翻理由）。保留本節是因為它記錄了遞迴
> re-arm 修好的第一手證據（深度 2 附著的 frame tree 直接證據）與 same-site 覆蓋率
> 缺口的發現過程，兩者現在仍然成立；但下面的判準行不要採信，最終結論在文件最上方。

### Review 推翻第一輪結論

第一輪自己在附註記錄了 `accounts.google.com/gsi/button`（Google Identity configurator 頁面裡第二層巢狀的 SSO 登入框）`attached: false`。Review 指出：這筆同時從分子（被 `attached === true` 篩掉）與分母（`document.querySelectorAll` 穿不透跨來源 `contentDocument`，看不到巢狀在另一個跨站 iframe 內部的 iframe）消失，該站因此被算成 1/1=100%，實際上應是 1/2。計入後加權平均變成 16/17 ≈ 94.1%，跌破 95% 判準。

根因在產品程式碼，不在這支量測腳本：`src/main/cdp.ts` 的 `Target.setAutoAttach` 在 flat 模式下**不遞迴**——對根 session 發一次只會附著到直接子代，孫代（巢狀在另一個跨站 iframe 內部的跨站 iframe）需要對每個新附著的子 session 再發一次 `setAutoAttach` 才會被附著。這是產品缺陷：agent 會看不到使用者正在操作的巢狀 SSO 登入框，不只是量測腳本算錯。

### 產品修正：`cdp.ts` 遞迴 re-arm

修法：監聽 `Target.attachedToTarget`，每收到一個新子 session 就對那個 session 再發一次 `Target.setAutoAttach`（`getAttachedTargets()`／`getRearmErrors()` 兩個新方法讓呼叫端看得到目前已知附著的 target 與 re-arm 失敗紀錄）。`CdpSession.send<T>(method, params?)` 與 `detach()` 的對外簽章未變，Task 7 的既有腳本與 3 個 cdp 單元測試不受影響（`npm test` 45/45 仍過）。

**深度 2 附著的直接證據**（`OOPIF_FRAMETREE=1 OOPIF_DEBUG=1` 對 Google Identity configurator 單站量測，`Target.getTargets()` 回傳的完整 frame tree）：

```
depth 1: developers-dot-devsite-v2-prod.appspot.com/.../configurator_....frame
         targetId=8AB86A02...  attached=true  parentFrameId=<top page>
depth 2: accounts.google.com/gsi/button?...
         targetId=3C4D5831...  attached=true  parentFrameId=8AB86A02...(depth 1 的 targetId)
```

`parentFrameId` 鏈確認：`accounts.google.com/gsi/button` 是深度 2 的巢狀 target，且 `attached: true`。**修正前（未遞迴）這筆是 `attached: false`；修正後在同一次量測、同一個未延長的 `ATTACH_SETTLE_MS=2000` 內就已附著**——不是要等更久，是根本沒有 re-arm 這回事。這直接回答了本輪最重要的問題：**遞迴 re-arm 之後，深度 2 的 SSO 登入框附著成功。**

### 新發現：遞迴修好之後，「頁面內 JS 計數」這個量測方法本身大範圍失準

修好遞迴之後重新量測 MDN、Stripe、Google Identity 三站（第一輪認證過的「乾淨 100%」站），三站全部變成 `attached > inPage`（`detector-blind`）：

| 站點 | 修正前（未遞迴） | 修正後（遞迴 re-arm） |
|---|---:|---:|
| MDN iframe 元素參考頁 | 3 / 3（100%） | inPage 3／attached 6（偵測失準） |
| Stripe checkout quickstart | 12 / 12（100%） | inPage 12～13／attached 19～20（偵測失準） |
| Google Identity configurator | 1 / 1（100%，即 C1 指出的錯誤值） | inPage 1／attached 2（偵測失準） |

原因：修好之後，CDP 現在看得到之前看不到的巢狀 target（例如 MDN 某個互動範例內部其實還嵌了一層 `openstreetmap.org` 的地圖 iframe；Stripe 的 hCaptcha 挑戰框本身還會再開一層 challenge iframe）。但這些巢狀 target **本來就不在頁面內 JS 查詢的能力範圍內**——`document.querySelectorAll`／`TreeWalker` 只能查到頂層文件直接可達的節點與 open shadow root，沒有辦法穿透另一個跨站 iframe 的 `contentDocument` 往下查它內部的子節點，這是 JS 同源政策的語言層級限制，不是這支腳本可以修的。

換句話說：**這個 spike 的第一輪「100%」之所以乾淨，正是因為遞迴 re-arm 還沒修好，深層 target 對分子分母同時隱形，兩邊剛好互相抵銷而不出錯。把 CDP 那側修對之後，量測方法本身反而在多數真實站點上失去了驗證能力**——這正是 `detector-blind` 狀態要抓的訊號：`attached > inPage` 代表分母本身失準，不能佯裝成一個乾淨的百分比（也不能像修正前那樣，讓分子分母同時漏記而看起來乾淨）。三站都正確排除出加權平均，並印出警告而非安靜的 n/a。

**這是一個方法論結論，不是 bug**：要用「頁面內 JS 計數」當分母驗證覆蓋率，前提是跨站內容只有一層巢狀；一旦巢狀達兩層，這個方法會系統性判定為 detector-blind。要繼續驗證更深層的覆蓋率，需要改用 CDP 端的 DOM 列舉（例如 `DOM.getFlattenedDocument` 加 `pierce: true`）取代頁面內 JS 查詢，這超出本次 spike 範圍。

### 換站：拿掉 Turnstile 與 Facebook，換上 Google Maps Embed

第一輪的 Cloudflare Turnstile demo 與 Facebook Page Plugin 文件頁兩站都是零貢獻（見上方第一輪結果，皆為 n/a）：

- **Facebook**：確認頁面重導到純文件頁，沒有現場渲染 widget。找不到能直接渲染 widget 的替代網址（需要頁面 URL 參數且多數第三方嵌入範例已停用/改版），拿掉。
- **Turnstile**：附著本身成功（`attached=1`），但頁面內偵測到 0——這是 Cloudflare Turnstile 用 **closed shadow root** 渲染 widget 導致，`element.shadowRoot` 對 closed shadow root 從頁面 JS 端本來就回傳 `null`，任何 Turnstile demo 網址都會撞到同一個結構性盲點，換 URL 沒有用。拿掉，不是因為它「零貢獻」而回頭調計數口徑去湊，是因為找不到能讓它變成可信 `measured` 的做法。

換成 **Google Maps Embed API 文件頁**（`developers.google.com/maps/documentation/embed/get-started`）：頁面內嵌一個真正會渲染的 `<iframe src="https://www.google.com/maps/embed/...">`（用 `curl` 直接抓頁面原始碼確認過 src）。這站沒有被挑進來是因為它「好測」，而是它揭露了一個全新、與遞迴 re-arm 無關的覆蓋率缺口（見下段）。

### 新發現：same-site 但 cross-origin 的 iframe，CDP 根本不會建立獨立 target

Google Maps Embed 頁面量到 `頁面內跨站 iframe 1，附著 target 0，覆蓋率 0%`。排查方法比照第一輪對 MDN shadow DOM 那次的做法——先假設是時機問題再證偽：

1. 把 `ATTACH_SETTLE_MS` 從 2000ms 暫時提高到 9000ms 重跑，`attached` 仍是 0。
2. 用 `OOPIF_FRAMETREE=1` 印出 `Target.getTargets()` 的**全域**（整個 browser context，不只本 session）target 清單：只有 2 筆，`type: 'page'`（頁面本身）與 `type: 'service_worker'`，完全沒有任何 `type: 'iframe'` 的 target。

結論：不是時機問題，是 Chromium 從頭到尾就沒有為這個 iframe 建立獨立 Target。`curl` 確認該 iframe 的 `src` 是 `www.google.com/maps/embed/...`，頂層文件是 `developers.google.com`——兩者 eTLD+1 都是 `google.com`，是**同一個「site」但不同 origin**。Chromium 預設的 site isolation 是以 site（eTLD+1）為粒度，不是以 origin 為粒度；只有少數 Google 自己列入「isolated origins」硬編碼清單的敏感網域（例如 `accounts.google.com`，這也是為什麼 Google Identity configurator 裡巢狀的 `accounts.google.com/gsi/button` 真的會拿到獨立 target）才會用 origin 級隔離。`www.google.com/maps/embed` 不在那份清單裡，所以即使頁面內 JS 因為同源政策擋下 `contentDocument`、判定它是跨站，Chromium 本身並不會把它切成 OOPIF——`flatten: true` 加遞迴 re-arm 對這種情況無能為力，因為根本沒有 target 可以附著。

這是一個**新的、與本輪要修的遞迴 re-arm bug完全不同類型**的覆蓋率缺口：不是「target 存在但沒 re-arm」，是「target 從未存在」。分子分母都是真的（頁面內確實有 1 個跨站 iframe，CDP 確實附著 0 個），沒有計數錯誤，是 `measured` 狀態下如實量到的 0%。

### 最終結果（4 站，2 次獨立重跑數字一致）

| 站點 | 頁面內跨站 iframe | 附著 target | 狀態 |
|---|---:|---:|---|
| MDN iframe 元素參考頁 | 3 | 6 | 偵測失準（排除） |
| Stripe checkout quickstart | 12～13 | 19～20 | 偵測失準（排除） |
| Google Identity configurator | 1 | 2 | 偵測失準（排除） |
| Google Maps Embed 文件頁 | 1 | 0 | **measured，0%** |
| **加權平均**（僅計入 measured） | 1 | 0 | **0.0%**，n=1 有效樣本站 |

判準 95%：**未通過**。**（已失效，見文件最上方「現行結論」；分母當時仍是頁面內 JS DOM 計數，穿不透巢狀內容，見「修正輪 2」）**

兩次獨立重跑（`npm run spike:oopif` 連續執行）中，四站的**分類**（`measured` / `detector-blind`）完全一致；Stripe 的絕對計數因頁面上動態載入的追蹤／控制器 iframe 數量本來就會隨每次載入浮動（12～13 / 19～20），但這不影響它被排除出加權平均的結論。

### 統計揭露（實際樣本，取代第一輪原本 16/16 的框架）

第一輪 16/16 全中時，依 rule of three，可以說樣本量分不出「100%」與「略低於 95%」。但修正輪的實際結果不是「全中」，而是**只有 1 個有效樣本，且那 1 個樣本是 miss（0/1）**。n=1 的單一觀測本身不足以估計母體覆蓋率的信賴區間，但這不是「樣本太小所以看不出通過或不通過」——這裡不需要信賴區間就能下結論：0% 遠低於 95%，且成因（same-site cross-origin iframe 不會建立獨立 target）是 Chromium 架構層級的決定論行為，不是機率性的量測雜訊，重跑一萬次都會是同一個結果。

真正該揭露的統計限制是另一件事：**加權平均這個量測方法本身，在遞迴 re-arm 修好之後，對任何有 2 層以上巢狀跨站內容的站點都會系統性判定為 detector-blind，導致「有效樣本數」的上限被這個方法論本身壓得極低**（4 站裡只有 1 站能給出百分比）。要提高有效樣本數，不能靠多找幾個站——只要那個站有巢狀跨站內容就會被排除——必須先換掉分母的量測方法（改用 CDP 端 DOM 列舉），這超出本次 spike 範圍。

這一段分析本身沒有錯——它正確指出了「頁面內 JS DOM 計數」這個分母方法論的死路，也正是「修正輪 2」改用 CDP frame 樹當分母的直接理由。已失效的只是「0/1=0%，未通過」這個數字，不是這裡對方法論限制的診斷。

### 結論（已失效，見文件最上方「現行結論」）

跨站 iframe CDP 覆蓋率的加權平均量測（頁面內 JS 計數版本）：**0/1 = 0.0%，未通過 95% 判準**，有效樣本僅 1 站。但這個「未通過」主要反映的是一個新發現、與本輪要修的 bug 無關的架構限制（same-site cross-origin iframe 不會被 Chromium 建立成獨立 OOPIF target），不是遞迴 re-arm 沒修好。

分開看兩件事：

1. **本輪要修的 bug（巢狀 SSO/金流 iframe 因為 `setAutoAttach` 不遞迴而附著不到）已修復，且有直接證據**（`Target.getTargets()` 的 frame tree parentFrameId 鏈，見上方「深度 2 附著的直接證據」）：Google Identity configurator 頁面裡巢狀的 `accounts.google.com/gsi/button` 現在 `attached: true`，Stripe 巢狀的 hCaptcha challenge iframe 現在也附著得到。這是本輪修正的核心目標，達成了。
2. **加權平均量測方法本身，在遞迴修好後於多數真實站點上失去驗證能力**（因為分母的頁面內 JS 計數穿不透巢狀跨站 iframe），且唯一能給出乾淨百分比的站點揭露了一個新的、Chromium site-isolation 粒度造成的覆蓋率缺口（same-site cross-origin iframe 無 target 可附著）。這個缺口不是本輪能修的：`flatten: true` 加遞迴 re-arm 只能附著到 Chromium 已經建立的 target，管不到 Chromism 決定不建立 target 的情況。

未通過情境的處置（規格 §8）：E2E 情境明確排除跨站金流與 SSO 頁，並在 `view_snapshot` 的回傳中固定標出「有 N 個 iframe 未附著」，讓 agent 知道自己看不到。本輪的兩個新發現都指向同一個處置方向——agent 不能假設自己看得到頁面上所有跨站內容，snapshot 必須誠實揭露未附著數，尤其是同站不同源（如 Google 自家網域下的第三方內嵌）與深度 2 以上巢狀內容這兩種本輪才發現的額外盲點。

---

## 修正輪 2（2026-09-01）

### 指示：分母分子都改由 CDP frame 樹計算，不要用頁面內 DOM

修正輪的結論指出這個 spike 量不出可用數字（有效樣本只剩 1 站，0/1=0%），而 95% 判準是整份計畫的閘門，閘門開不了。協調者要求只改一件事：分母不再靠頁面內 JS 查 DOM，改成分子分母都從 CDP 的 frame 樹算，理由是頁面內 JS 天生有兩個量不到的缺陷（穿不透巢狀跨站 iframe、無法區分跨 origin 與跨 site），這兩個缺陷用同一個修法解決。

### 實作：`Page.getFrameTree` 測過不可行，改用 `Target.getTargets()` 的 parentId 鏈

先實測 `Page.getFrameTree`（用 `OOPIF_PAGEFRAMETREE` 暫時加的除錯分支，對 Google Identity configurator 頁面呼叫）：在根 session 呼叫這個指令，只回傳頂層文件自己這一個 frame，完全沒有 `childFrames`——證實它不會跨行程遞迴進 OOPIF 子代。`CdpSession.send<T>(method, params?)` 的對外簽章不能加 `sessionId` 參數（本輪禁止動 `cdp.ts`），所以也沒有辦法對每個子 session 個別呼叫 `Page.getFrameTree`。

改用上一輪已經用過的 `Target.getTargets()` 全域清單：每個 target 的 `parentId`／`parentFrameId` 欄位就是完整的 frame 樹（含跨行程的巢狀 OOPIF），瀏覽器行程層級知道整個結構，不受頁面 JS 的同源限制。從頂層 `type === 'page'` 的 target 開始，沿 `parentId` 鏈遞迴走訪，蒐集所有 `type === 'iframe'` 的子代，同時算出每個的巢狀深度。

### eTLD+1 比較：跟「直接父層」比，不是跟「頂層文件」比

分母的跨站判定改成比較 eTLD+1（用 hostname 最後兩段近似，未引入 public suffix 套件）。已知誤差：對 `co.uk`、`appspot.com` 這種本身就是（或近似）public suffix 的兩段式網域，「取最後兩段」會把整個 `appspot.com` 當成一個 site，不是正確的 `X.appspot.com`——這個誤差不是假設情境，測站清單裡就有一個真實案例：Google Identity configurator 頁面裡巢狀的 configurator iframe 就在 `developers-dot-devsite-v2-prod.appspot.com` 上。誤差方向對本次判準是**有利通過**的：這個規則比真正的 eTLD+1 更粗（會把更多東西判成「同站」），只會讓分母變小、覆蓋率看起來更高，不會漏算成更低。就本次三站量測而言，這個誤差沒有實際改變任何一個 frame 的分類——`appspot.com` 跟頂層 `developers.google.com`（site=`google.com`）本來就不同，簡化規則跟真正的 eTLD+1 在這個案例上判斷一致，reviewer 已逐 frame 核對過——但這是巧合，不是這個簡化規則本身可靠的保證。

另一個沒有寫進分母判定但同樣屬於「保守排除」的情況：`about:srcdoc`、`about:blank`、`data:` 這類 URL 本來就解析不出 hostname，`isCrossSite()` 保守地當同站處理，不計入分母（`spikes/probe-oopif.ts` 裡 `approximateSite()` 的行為）。MDN 頁面實際有一個這樣的 frame——Chromium 給了它獨立 target 且已附著，但因為是 `about:srcdoc` 被排除出分母。這個方向一樣是有利通過：少算一個分母，不會把覆蓋率往下拉。這兩個排除項（同站不同源、URL 解析不出 hostname）現在都有一條獨立的一致性檢查在跑，見「修正輪 3」。

第一版照協調者原文「跟頂層 frame 的 URL 比」實作，跑出來 Google Identity configurator 只量到 1 個跨站 frame（深度 1 的 `appspot.com`），深度 2 的 SSO 登入框 `accounts.google.com/gsi/button` 從分母裡消失了——因為它的 eTLD+1（`google.com`）跟頂層文件（`developers.google.com`，也是 `google.com`）相同，被判成同站。但它是本輪從頭到尾要驗證「遞迴 re-arm 附不附著得到」的那個真實案例：深度 1 是 `appspot.com`（跟頂層跨站），深度 2 是 `accounts.google.com`（跟頂層同站，但跟它的直接父層 `appspot.com` 跨站）。Chromium 確實把它獨立成一個 target（上一輪已用 frame tree 的 parentFrameId 鏈證實），跟頂層比會把這個 target 判成「不用管」，反而讓分母漏掉本輪最關鍵的驗證對象。

改成跟「直接父層」比 eTLD+1（隔離邊界發生在相鄰兩層之間，不是每一層都跟最外層比，這跟 Chromium 實際的 site-per-process 判斷基準一致）之後，這個 SSO 登入框正確進了分母。這是本輪對協調者原始指示的一處技術性偏離，原因與驗證過程如上，改動範圍只有 `spikes/probe-oopif.ts` 的比較基準，不影響「分子分母都來自 CDP」這個核心修法。

### 最終結果（3 站，2 次獨立重跑數字結構完全一致）

```
$ npm run spike:oopif

https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe
  跨站 frame 5，附著 target 5，覆蓋率 100%（深度1: 3/3 附著，深度2: 2/2 附著）
https://docs.stripe.com/payments/quickstart
  跨站 frame 9，附著 target 9，覆蓋率 100%（深度1: 2/2 附著，深度2: 5/5 附著，深度3: 2/2 附著）
https://developers.google.com/identity/gsi/web/tools/configurator
  跨站 frame 2，附著 target 2，覆蓋率 100%（深度1: 1/1 附著，深度2: 1/1 附著）
========================================
3 站中 3 站量到跨站 iframe、0 站 n/a（無跨站 iframe）、0 站偵測失準（已排除）、0 站載入失敗
加權平均：附著 16 / 跨站 frame 16 = 100.0%
判準 95%：通過
========================================
$ echo $?
0
```

| 站點 | 跨站 frame（分母） | 附著（分子） | 深度分佈 |
|---|---:|---:|---|
| MDN iframe 元素參考頁 | 5 | 5 | 深度1: 3/3，深度2: 2/2 |
| Stripe checkout quickstart | 9 | 9 | 深度1: 2/2，深度2: 5/5，深度3: 2/2 |
| Google Identity configurator | 2 | 2 | 深度1: 1/1，深度2: 1/1（深度2 即 SSO 登入框） |
| **加權平均** | 16 | 16 | **100.0%** |

判準 95%：**通過**。三站都乾淨落在 `measured`，連續 4 次獨立重跑（含本節與探索過程中的重跑）數字結構完全一致（唯一浮動的是 URL 裡的 request id／session token 這類每次載入都會變的參數，不影響 frame 數量與附著結果）。分母正確與否的證據是 reviewer 的獨立對照實驗與逐 frame 核對（見下方「### 結論」），不是 `detector-blind` 有沒有觸發——那個分支的觸發條件（`attachedCount > crossSiteCount`）結構上不可能成立，詳見「修正輪 3」。

Google Maps Embed API 文件頁（上一輪加進來的站）沒有列入這一輪的測站：它唯一的 iframe（`www.google.com/maps/embed`）跟頂層文件（`developers.google.com`）eTLD+1 都是 `google.com`，用新分母定義量出來會是 0 個跨站 frame，如協調者所預期，沒有測試價值，拿掉。

### 統計揭露

16/16（分母 16 攤在 3 站上）全中，依 rule of three，真實 miss rate 的 95% 信賴上界約 3/16 ≈ 19%；真實覆蓋率若是 85%，量到 16/16 全中的機率約 7%。這個樣本量仍然分不出「100%」與「略低於 95%」，但這次的性質跟第一輪不同：第一轮的 16/16 是分子分母同時對巢狀內容隱形、剛好互相抵銷造成的假象；這一輪的 16/16 是分母正確涵蓋深度 1～3 的巢狀跨站 frame（含本輪要驗證的 SSO 登入框）之後，逐一比對出來的真實附著結果，且三站都有多層深度、都是 100%，不是靠單一淺層樣本撐出來的。樣本數仍然不大（3 站、16 個跨站 frame），但這次的 100% 是有方法論支撐的觀測值，不是量測方法的盲點造成的假象。

### 結論

- **`detector-blind` 三站都沒觸發**，但這不是分母正確的證據——`attachedCount` 的算法是 `crossSiteFrames.filter(附著)`，結構上永遠是 `crossSiteCount` 的子集，`attachedCount > crossSiteCount` 這個分支本來就不可能觸發，跟分母算得對不對無關（詳見「修正輪 3」對這個死分支的說明）。真正驗證分母正確的證據是 reviewer 的獨立對照實驗：拿掉遞迴 re-arm 重跑一次，深度 2 的 SSO 登入框變回 `attached:false` 但仍留在分母裡，證實分母沒有隨附著結果變動；reviewer 也從原始 target 資料獨立重建了 16 個 frame 的父子鏈，逐一核對過 5／9／2 這三個數字。
- **深度分佈直接證明遞迴 re-arm 涵蓋任意深度**：Stripe 量到深度 3——實際的父子鏈是 `js.stripe.com/hcaptcha-invisible`（深度1）→ `b.stripecdn.com/HCaptchaInvisible`（深度2）→ `newassets.hcaptcha.com`（深度3，hCaptcha 挑戰框本體）；另外一個深度 1 的 `b.stripecdn.com/GoogleTagManager` target 沒有子代，是獨立的一支，不是深度 3 那條鏈的一部分。Google Identity configurator 量到深度 2（SSO 登入框），兩者都 100% 附著。
- **加權平均 16/16 = 100.0%，通過 95% 判準**，且這次的分母是原則正確的（CDP frame 樹 + eTLD+1，不是頁面 JS DOM 計數），閘門可以評估。

未通過情境的處置（規格 §8）維持不變：E2E 情境排除跨站金流與 SSO 頁，snapshot 固定回報未附著數。這次判準通過，不代表這個處置就不需要——3 站 16 個 frame 的樣本量仍然不足以排除生產環境遇到更深、更複雜巢狀結構時附著失敗的可能，snapshot 的未附著揭露仍是必要的防線。

---

## 修正輪 3（2026-09-01，文件與診斷修正）

### 背景：review「有條件可信」，只剩文件與一個不可達分支

Reviewer 寫了一支獨立探針做對照實驗（拿掉遞迴 re-arm 重跑），證實分母確實會包含本 session 沒附著的 frame（深度 2 的 SSO 登入框在對照組裡 `attached:false` 仍留在分母，該站算成 1/2）；也從原始 target 資料獨立重建了 16 個 frame 的父子鏈，逐一核對過 5／9／2 這三個數字。**這一輪的 16/16=100% 不是抵銷造成的假象，分母修法是對的。** 找到的問題全部是文件與一處不可達的程式分支，量測邏輯、分母定義、站點清單都不動。

### 修 1：文件有三條互相矛盾的判準行

文件依序含第一輪「通過」、修正輪「未通過」、修正輪 2「通過」三條判準行，且開頭 banner 指向的正是那個「未通過」的章節——拿這份文件做 go/no-go 判斷的人有實際機會讀到錯的一行。

修法：現行結論搬到文件最前面（標題後 20 行內），第一輪與修正輪的判準行與「## 結論」段落都加上「已失效」標記並註明被哪一節取代，原本的 banner 拿掉（結論已經在最上面了）。

### 修 2：`detector-blind` 分支不可達，卻被文件當成「分母修對了」的證據

`spikes/probe-oopif.ts` 的 `attachedCount` 算法是 `crossSiteFrames.filter(附著)`，結構上永遠是 `crossSiteCount` 的子集，`classifySiteStatus()` 裡 `attachedCount > crossSiteCount` 這個分支因此不可能觸發。但修正輪 2 的文件拿「`detector-blind` 完全消失、三站全部 measured」當成分母修對的證據——這是循環論證，因為它在新分母下本來就不可能觸發，不管分母算得對不對都一樣不會觸發。

兩個選項裡選了**第一個**：改成真的能觸發的一致性檢查，但**不接進 `classifySiteStatus`／加權平均**。理由：

- 協調者提議的檢查——「`getAttachedTargets()` 裡屬於本頁 frame 樹、卻不在 `crossSiteFrames` 裡的 iframe target 數」——實測會在 MDN 上觸發（1 個 `about:srcdoc` frame，Chromium 給了它獨立 target 且已附著，但因為 URL 解析不出 hostname 被 `isCrossSite()` 保守排除）。這是預期會發生的情況，不是 bug。
- 若把這個檢查接進 `classifySiteStatus`（讓 `attachedCount > crossSiteCount` 的觸發條件換成這個），MDN 會因為那個 `about:srcdoc` frame 被改判成 `detector-blind`，從加權平均裡消失，16/16 會變成別的數字——這正是「不要動量測邏輯」跟「reviewer 已經逐 frame 核對過 5/9/2」這兩條線劃的界，不能碰。
- 所以做法是：新增 `findExcludedButAttached()`，算出「同站被排除但已附著」的 iframe target 數，印在 `printSiteResult()` 裡當一條獨立的診斷資訊，`OOPIF_DEBUG=1` 可以看到完整 URL；`SiteStatus`／`classifySiteStatus`／加權平均完全不變。

實測這條新診斷在 MDN 量到 1 個（`about:srcdoc`，預期情況），在 Stripe 量到 **10 個**——而且不是 `about:srcdoc` 這類無法解析的 URL，是真實的 `js.stripe.com/...` frame：Stripe 的 controller／payment-request 系列 iframe 是 `js.stripe.com` 直接子代，跟頂層 `docs.stripe.com` 同 eTLD+1（都是 `stripe.com`），因此被排除出分母，但 Chromium 仍然把它們各自獨立成 target 並附著（Stripe 的這些 iframe 可能設了 Origin-Agent-Cluster 之類的標頭要求 origin 級隔離，不受預設 site-per-process 政策管轄，本次沒有進一步查證原因）。這 10 個 frame 不算進分母的理由跟上一輪 Google Maps Embed 案例是同一類（同站不同源，不是本 spike 判準關心的跨站風險），reviewer 對 Stripe=9 的核對也已經把它們排除在外，所以這條新診斷是**確認**既有排除是對的，不是發現新的分母錯誤。

`classifySiteStatus` 裡 `attachedCount > crossSiteCount` 那個分支保留原樣（防禦性斷言，防的是萬一日後 `attachedCount` 的算法不再保證是 `crossSiteCount` 子集），程式註解已更新說明它現在是不可達的，真正會觸發的訊號是 `excludedButAttached`。

### 修 3：文件四處事實錯誤，已在原節內就地修正

- **eTLD+1 簡化的免責說明**：原文寫「本次測站清單全部是 .com/.dev 網域不受影響」，但 `appspot.com`（Google Identity configurator 頁面裡巢狀的 configurator iframe 就在這個網域上）正是兩段式近似 public suffix 的網域。已改寫成如實描述誤差存在、誤差方向對本次判準有利通過（規則比真 eTLD+1 更粗，只會縮小分母、抬高覆蓋率），並說明本次三站實際沒受影響是巧合、不是規則本身可靠。`spikes/probe-oopif.ts` 裡 `approximateSite()` 上方同一段錯誤說明也一併修正（同一個錯誤同時存在於程式註解與結果文件）。
- **`about:srcdoc`／`about:blank`／`data:` 的排除**：原本只在程式碼註解裡提過，沒有列進結果文件。已在「eTLD+1 比較」一節補上，並用修 2 新診斷實測到的真實案例（MDN 的 `about:srcdoc` frame）具體說明。
- **「16/17」殘留錯字**：統計揭露段落原寫「16/17（分母 16 攤在 3 站上）」，這一輪分母就是 16、沒有 17，已改成「16/16」。
- **深度 3 父鏈描述錯誤**：原文寫「Stripe 量到深度 3（hCaptcha 巢狀在 GoogleTagManager iframe 裡再巢狀一層 hCaptcha）」，實際父子鏈是 `js.stripe.com/hcaptcha-invisible` → `b.stripecdn.com/HCaptchaInvisible` → `newassets.hcaptcha.com`；`b.stripecdn.com/GoogleTagManager` 是另一支深度 1 的 target，沒有子代。數字（深度3: 2/2 附著）本身沒有錯，只有敘述錯，已在「### 結論」段落改寫。

### 修 4：`task-8-report.md` 的測試數量錯字

上一輪報告寫「既有 3 個 cdp 單元測試」，實際是 4 個（`toCdpError` 4 個案例）。已在附加報告裡寫對。

### 補充：加了 `attachCdp()` 遞迴 re-arm 的單元測試

`tests/cdp.test.ts` 原本 4 個測試全部針對 `toCdpError`，遞迴 re-arm——這一輪改動最大也最關鍵的邏輯——沒有任何單元測試。找到一個不需要碰 `src/main/cdp.ts` 的切入點：`cdp.ts` 對 `electron` 只用 `import type`，執行期不依賴真的 Electron，所以可以造一個假的 `wc.debugger`（`isAttached`／`attach`／`sendCommand`／`on`／`removeListener`／`detach`），透過 `attachCdp()` 這個公開介面直接測。

新增 6 個測試（`tests/cdp.test.ts`，總數 4→10）：初始附著對根 session 發一次 `setAutoAttach`、收到 `attachedToTarget` 後對新子 session 再發一次、巢狀到孫代一樣會 re-arm、`detachedFromTarget` 後從 `getAttachedTargets()` 移除、re-arm 失敗記進 `getRearmErrors()` 且不擋下其他子代、`detach()` 之後即使監聽器仍被呼叫也不再 re-arm（這條特別繞過假的 `removeListener`，直接呼叫監聽器本體，測的是 `cdp.ts` 內部 `detached` 旗標本身，不只是「監聽器有沒有被移除」）。全部通過，`npm test` 45→51。

### 結論

文件現在的判準行結構：全文只有一條「現行結論」（文件最上方，16/16=100%，通過），第一輪與修正輪各自的判準行與結論段落都標了「已失效」並指向現行結論；四處事實錯誤與 `detector-blind` 循環論證已修正；新增的 `excludedButAttached` 診斷是這一輪唯一新增的量測輸出，只印不影響分類。`src/main/cdp.ts` 未動，量測邏輯、分母定義、站點清單維持上一輪 review 通過的版本。
