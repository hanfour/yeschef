# context 成本的兩條替代路徑

量測日期:2026-09-08
機器:macOS 26.6.2(Darwin 25.6.0)、arm64、16 GB
Node 24.18.0 / Electron 44.0.0 / Agent SDK 0.3.258 / headroom-ai 0.37.0

## 0. 為什麼做這次量測

已和使用者確認,子專案 E 要解的是成本:對話每多一輪,後續每次請求都要重送累積的 context。
E 的作法是換 session,代價是每次交接兩個額外的模型回合(規格 §9 已列)。
動手實作前先驗兩條更便宜的路:第三方內容壓縮,以及把內建 auto-compact 提早觸發。

第一條不成立,第二條可用。這份文件記結果與判斷依據,避免之後重跑。

## 1. 成本的實際結構

先量 yeschef 現況。fixture 專案跑一段 11 輪的對話,從 session jsonl 逐輪讀 usage:

| 項目 | 數值 |
|---|---|
| 未快取 input | 每輪 2 個 token |
| 快取讀取 | 佔總 input 90.5% |
| 快取寫入 | 首輪 15,922,之後每輪 57 到 185 |

另外兩場對照量到 94.0% 與 92.5%。

所以「舊 context 每一輪重送一次」在計費上不是全額,是快取價。成本的成長來自
快取讀取量隨 context 線性增加:context 到 400k 時,每輪光讀取就是 400k。

要壓這條曲線,只有把 context 變小這一種辦法。壓縮與換 session 都是在做這件事,
差別在代價。

## 2. 第三方內容壓縮(headroom):快取讀佔比下降,成本方向未定

headroom 在內容送進 LLM 前壓縮工具輸出、log、檔案與對話歷史,宣稱可讓 coding agent
的 token 用量減少 20%。依它的說明,CacheAligner 不會改寫 prompt,以免破壞 provider
的前綴快取。

接線可行:SDK 的 `Options.env`(`sdk.d.ts:1525`)可傳 `ANTHROPIC_BASE_URL`,
`claude.exe` 認這個變數;proxy 的 `headroom/proxy/auth_mode.py` 把 PAYG、OAuth、
Subscription 分成三種模式,訂閱有獨立的處理。本次量測直接用父程序的環境變數,
沒有改 yeschef 任何程式碼。

### 量測結果

同一組三則訊息、同一個 fixture 專案,加權 input 的算法是未快取 input 加上
快取讀取乘 0.1、快取寫入乘 1.25:

| 組別 | 呼叫 | 原始 input | 快取讀 | 快取寫 | 讀佔比 | 加權 input | output |
|---|---:|---:|---:|---:|---:|---:|---:|
| 直連 #1 | 6 | 115,854 | 108,944 | 6,898 | 94.0% | 19,529 | 831 |
| 直連 #2 | 8 | 138,213 | 127,895 | 10,302 | 92.5% | 25,683 | 2,338 |
| 壓縮 #1 | 8 | 69,132 | 40,950 | 28,166 | 59.2% | 39,318 | 1,579 |
| 壓縮 #2 | 8 | 81,042 | 67,574 | 13,452 | 83.4% | 23,588 | 1,158 |
| 直通(來源存疑) | 7 | 73,182 | 59,862 | 13,306 | 81.8% | 22,633 | 1,096 |

### 判讀

五組裡只有快取讀佔比沒有重疊:直連是 94.0% 與 92.5%,任何形式的 proxy 都掉到
59.2%、83.4%、81.8%。連 `--no-optimize` 直通模式都掉,代表繞這一層就會動到請求
形狀,讓前綴快取對不上。proxy 自己的 stats 顯示有一個請求被標記 `prefix_frozen`
而不壓縮,所以 CacheAligner 有在運作,但擋不住全部。

加權成本的方向分不出來:壓縮 #1 是 +101%,壓縮 #2 反而比直連 #2 低。直連與壓縮各
量兩次,四次的呼叫次數落在 6 到 8 次、output 落在 831 到 2,338,模型每次做的事不一樣,
n=2 的樣本被這個變異蓋過。原始 input 看起來降 40%,同樣被這個因素污染,也對不上 proxy 自己
回報的 5.1% 平均壓縮率。

### 結論

不採用。yeschef 的成本 94% 落在快取讀取,而快取讀取算 0.1 倍。壓縮換掉的是最便宜
的那部分 token,代價是動到前綴、把快取打散,換成 1.25 倍的快取寫入。這類工具適合
每次請求都是新前綴的場景,長對話高快取命中是它最不划算的情況。

要比較加權成本,得先固定每次量測的工具呼叫流程,再重複多次。以本次要回答的問題來說,
快取讀佔比這個比值型指標已經足以做決定,所以不追加量測。

## 3. 提早觸發內建 auto-compact:可用

`Settings` 有 `autoCompactWindow`(`sdk.d.ts:7831`,單位 token)與
`autoCompactEnabled`(`sdk.d.ts:8066`)。環境變數 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`
走同一條解析路徑。

### 先量門檻本身

用 `getContextUsage({ detail: 'summary' })` 直接讀 SDK 回報的值。探針要用串流輸入
讓 query 保持開啟,單次 prompt 在收到 result 後 transport 就關了,問不到:

| 設定 | `autoCompactThreshold` | `rawMaxTokens` | `autocompactSource` |
|---|---:|---:|---|
| 無 | 970,616 | 1,000,000 | auto |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW=20000` | 70,616 | 100,000 | env |
| 同上 `=40000` | 70,616 | 100,000 | env |
| 同上 `=60000` | 70,616 | 100,000 | env |
| 同上 `=200000` | 170,616 | 200,000 | env |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=0.2` | 970,616 | 1,000,000 | auto |

`isAutoCompactEnabled` 在所有組別都是 true,模型是 `claude-opus-5[1m]`。

三件事:環境變數有效,`autocompactSource` 會從 `auto` 變成 `env`;值被夾在下限
100,000,所以門檻的地板是 70,616;`threshold = rawMaxTokens − 29,384`,那 29,384
就是摘要緩衝。`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 在本機沒有作用。

### 實機驗證壓縮真的會執行

fixture 專案九個檔案,逐一 `cat` 進 context,`CLAUDE_CODE_AUTO_COMPACT_WINDOW=40000`
(門檻 70,616)。每次 API 呼叫的 context 總量:

```
15,912 → 26,784 → 37,657 → 48,530 → 59,403 → 70,276 → 70,354 → 27,777 → … → 60,593
```

在 70,354 觸發壓縮,掉到 27,777,對話繼續。逐字稿有 `compact_boundary`
「Conversation compacted」與五筆 `compact_file_reference`。

品質探針:第一則訊息種下「專案代號 ZANTHER-7719、負責人代稱白鹿」,壓縮發生之後
才問。回答是「專案代號:ZANTHER-7719;負責人代稱:白鹿」,兩項都正確。

### 壓縮之後對話裡看得到什麼

摘要不是被藏起來:SDK 把它當成一則 `role: user` 的訊息注入,所以它就在對話裡,
內容是英文的 `This session is being continued from a previous conversation…` 加一份
分段摘要。

兩條路徑的旗標名字不同,實測:live 串流是 `isSynthetic: true`,
`getSessionMessages()` 的歷史是 `isCompactSummary: true`。SDK 型別檔
(`SDKUserMessage`)只列了 `isSynthetic`,沒有 `isCompactSummary`。

`isSynthetic` 的語意比「壓縮摘要」寬,SDK 之後若注入別種 user 訊息也會落到同一類。
目前只觀察到壓縮摘要一種。

### 判讀

這條路可用。一個環境變數就能把穩定狀態的 context 從 97 萬壓到 7 萬,
之後每一輪的快取讀取量跟著降一個數量級,而且不必新增任何子系統。

限制有三個:門檻的地板是 70,616,想要更低做不到;摘要由模型在壓縮當下生成,
使用者在它生效前不能編輯(生成後看得到,見上一節);本次品質探針只驗過一個種下的
事實,不足以說明複雜工作狀態(改到一半的重構、未完成的推論)在壓縮後保存得如何。

### 先前的錯誤結論

初次量測的三組都沒有觸發壓縮,當時據此判斷「這個旋鈕在 SDK 這條路上沒有作用」。
那是錯的。實際原因是門檻在 70,616,而那三組的 context 尖峰分別是 30,105、70,500、
33,830。第二組差 116 個 token 沒跨過去。

教訓不是「要多跑幾次」,是不該用「沒有觀察到現象」去推論機制。門檻的值一直可以
直接讀,先讀值再設計實驗,四場對話都不用跑。

## 4. 兩個操作上的教訓

第 3 組的 context 尖峰只到 33,830,是因為換 fixture 時把函式內容改短,檔案小很多,
每輪只長 2,874 而不是 10,800。量測中途改 fixture 會讓那一組失去比較基礎。

headroom 的 proxy 用 `pkill -f "headroom proxy"` 殺不掉,實際指令列是
`Python -m headroom.c...`。因此「直通」那一組走了哪一個 proxy 無法確認,標為存疑。
之後起背景服務要記錄 pid,不要靠指令列比對。

## 5. 對規劃的影響

- 暫不導入 headroom。判準是快取讀佔比,不是原始 token 數。
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 可用,門檻地板 70,616。這是目前成本問題最便宜
  的解法:一個環境變數,不新增子系統。穩定狀態的 context 從 97 萬降到 7 萬,E 的成本動機因此不再成立。
- E 若要繼續,它要解的是壓縮給不了的東西:交接檔可改、跨模型可攜、分段歷史。
  「可讀」不在其中:摘要本來就在對話裡。這幾項使用者都表示不是主要需求,
  所以 E 的範圍要重新談。
- E 規格 §1 說「看得見、能編輯這個需求在壓縮路線上做不到」,前半要更正:
  看得見做得到,做不到的只有「用之前能編輯」。
- E 規格 §7 的理由要照第 3 節更正:那兩個環境變數並非沒有意義,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 確實會把門檻拉下來。
- yeschef 目前完全沒有處理 `autocompact_state` 訊息。若 E 要用 auto-compact
  當保護層(規格 §1),要先接這個訊息才看得到 SDK 回報的啟用狀態。
