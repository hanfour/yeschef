# 測試機設定與 `view_login`

- 日期:2026-09-22
- 狀態:已實作,驗收見 docs/RESULTS-35-test-machines.md
- 依據:`docs/specs/2026-09-21-per-conversation-browser-design.md`(每個對話一個瀏覽器;本規格用它的獨立 partition 與每 session 的工具組)
- 後續:Apple design 全面審視(另一份規格)

## 1. 要解決什麼

agent 驗收時常要登入測試機。現在的做法只有兩種:人先在右窗格手動登入,或把帳密寫進對話讓 agent 自己用 `view_type` 填。
前者背景 agent 做不到,後者帳密會進模型的 context、對話紀錄與 log。

這份規格讓人把測試機的網址與帳密設定在專案裡,密碼經 Electron `safeStorage` 加密後存檔,agent 只能呼叫
`view_login(machine, …)`,由主行程取出帳密填表。模型從頭到尾看不到帳密。

## 2. 已決定的事

| 題目 | 決定 |
|---|---|
| 密碼放哪 | `safeStorage.encryptString()` 的密文存在 `userData` 底下的專案檔;macOS 上金鑰在 Keychain。密碼不進模型、不進對話紀錄、不進 log |
| 測試機屬於誰 | 屬於專案。每個專案一份清單,agent 只查得到自己專案的測試機 |
| `view_login` 怎麼知道欄位 | agent 先 `view_snapshot`,把帳號欄、密碼欄(與送出鈕)的 ref 交給主行程。沿用 `view_type` 的 ref 檢查,不另外找欄位、不記 selector;主行程另外用 CDP 查節點型別,確認三個 ref 真的分別是文字欄、密碼欄、按鈕,擋掉模型指錯欄位 |
| 批准規則 | `allow`,跟 `view_type` 相同 |
| codex | 跟另外八個工具一樣走 `dynamicTools`,規則相同 |
| Keychain 不可用 | 拒絕儲存密碼並顯示原因,不退回明文存檔 |

## 3. 資料

### 3.1 檔案

每個專案一個檔:`<userData>/test-machines/<projectId>.json`,權限 0600,原子寫入(先寫暫存檔再 rename,
沿用 `permissions/service.ts` 的寫法)。

```
{
  revision: number,
  machines: [ { id, name, url, username, password } ]
}
```

| 欄位 | 內容 |
|---|---|
| `id` | UUID |
| `name` | 人取的名字,同一個專案內不重複,`view_login` 用它查 |
| `url` | 完整網址,例如 `https://staging.example.com/login`。比對只用 origin |
| `username` | 明文 |
| `password` | `safeStorage.encryptString()` 回傳的 Buffer 轉 base64;沒設密碼是 `null` |

專案被移除(`projects:remove`)時一併刪掉這個檔,不留孤兒帳密。

### 3.2 主行程的 service

新檔 `src/main/test-machines/service.ts`:

| 操作 | 行為 |
|---|---|
| `list(projectId)` | 回清單,每筆是 `{ id, name, url, username, hasPassword }`,沒有密碼欄位、不解密;`hasPassword` 只代表有沒有存密文,密文解不開時仍是 `true` |
| `upsert(projectId, revision, machine)` | `machine.password` 是字串就加密後存;是 `undefined` 就保留原本的密文;`revision` 對不上回錯誤,跟 `permissions` 的樂觀鎖相同;加密失敗或寫檔失敗都回 `{ kind: 'error', message: '測試機設定儲存失敗,請檢查主程序紀錄' }`,`handle()` 不會 reject。寫檔失敗時另外清掉暫存檔(加密失敗發生在寫檔之前,沒有暫存檔可清);清暫存檔本身若也失敗不會蓋掉原本的寫檔錯誤 |
| `remove(projectId, revision, id)` | 刪一筆 |
| `removeProject(projectId)` | 刪整個檔 |
| `credentialsFor(projectId, name)` | 只給主行程用。回 `{ username, password, passwordUnreadable, origin }`;查不到回 `undefined`;沒設密碼時 `password` 是 `null`、`passwordUnreadable` 是 `false`;密文解不開(換了 build 或金鑰)時 `password` 是 `null`、`passwordUnreadable` 是 `true`,並 `logError` 一次,密文不會被改寫 |

`safeStorage` 透過介面注入(`{ isEncryptionAvailable(), encryptString(), decryptString() }`),測試用假的。
`isEncryptionAvailable()` 回 false 時,`upsert` 帶密碼一律拒絕,回 `MSG.keychainUnavailable`;不帶密碼的更新(改名、改網址)照常。

## 4. 設定畫面

### 4.1 IPC

新頻道 `testMachines:manage`(invoke),形狀照 `PERMISSIONS_CHANNEL`:

```
請求 = { action: 'list', projectId }
     | { action: 'upsert', projectId, revision, machine: { id?, name, url, username, password? } }
     | { action: 'remove', projectId, revision, id }
回應 = { kind: 'state', revision, machines: [{ id, name, url, username, hasPassword }] }
     | { kind: 'error', message }
```

zod schema 放 `src/shared/test-machines.ts`。請求與回應都 `.strict()`。回應永遠沒有 `password` 欄位;
schema 上直接不宣告,renderer 拿不到。

`url` 在 schema 層驗:能被 `new URL()` 解析,且協定是 `http:` 或 `https:`。`name` 1 到 100 字元,去頭尾空白後不可為空。
`username` 1 到 200 字元,不可為空;`password` 給了就不可為空,空字串由 renderer 端改成不送這個欄位
(`MachineInputSchema.password` 是 `min(1)`)。

`ipcMain.handle` 的處理器獨立成 `src/main/test-machines/ipc.ts` 的 `createTestMachinesIpcHandler`,做法跟
`browser-ipc-handlers.ts` 一樣:來源不是可信 sender 時直接回 `{ kind: 'error', message: '不接受此來源的測試機請求' }`,
不呼叫 `handle()`。

### 4.2 元件

新元件 `src/renderer/components/TestMachinesManager.tsx`,跟 `SkillsManager`、`PermissionManager` 同一種對話框,
入口按鈕放在「授權」旁邊,文字「測試機」。列的是目前 active 專案的測試機。對話框以 `key={專案 id}` 掛載,
專案切換時整個重新掛載,元件內部的 effect 只在掛載時跑一次。active 專案消失(被移除,或切到還沒載入完成)時
`App.tsx` 跟著把對話框關掉。

- 清單:每筆顯示名稱、網址、帳號、密碼狀態(已設定 / 未設定),有「編輯」「刪除」。
- 表單:名稱、網址、帳號、密碼四欄。密碼欄 `type="password"`,永遠不會被回填;編輯既有的測試機時留空表示
  保留原本的密碼,placeholder 寫「留空表示不變」。密碼欄留空送出時,請求裡直接不帶 `password` 這個欄位
  (`MachineInputSchema.password` 是 `min(1)`,空字串過不了驗證)。
- 儲存失敗的訊息顯示在表單下方,用主行程回的 `message`。

## 5. `view_login` 工具

### 5.1 定義

第九個瀏覽器工具。`VIEW_TOOL_NAMES` 加 `view_login`,`tool-defs.ts` 加定義,Claude 的 MCP server 與 codex 的
`dynamicTools` 都由同一份定義產生,不用各自處理。

```
view_login(machine: string, usernameRef: string, passwordRef: string, submitRef?: string)
```

描述(給模型看的):「用專案裡設定好的測試機帳密登入。先 view_snapshot 找到帳號欄與密碼欄的 ref。
帳密由主行程填入,不會回傳給你。」

### 5.2 主行程的步驟

新檔 `src/main/view-tools/controller-login.ts`。步驟順序固定,任何一步失敗就回對應訊息並停止:

1. 用這個 session 的 `credentials(machine)` 查帳密。查不到回 `MSG.machineUnknown(machine)`;沒設密碼回
   `MSG.machineNoPassword(machine)`;密文解不開(`passwordUnreadable`)回 `MSG.machinePasswordUnreadable(machine)`。
2. 目前頁面的 origin(`new URL(webContents.getURL()).origin`)要等於測試機的 origin,不同回 `MSG.originMismatch(expected)`。
   這一步在任何輸入動作之前。
3. 三個 ref 先走 `refs.ts` 現有的檢查(格式、過期、不存在、脫離頁面)。ref 的 `sessionId` 有值(跨站 iframe)一律回
   `MSG.loginRefInFrame`:登入表單放在跨站 iframe 裡的測試機很少見,為它處理跨框架的 origin 不值得。通過後用
   CDP `DOM.describeNode` 檢查節點型別:`usernameRef` 要是 `INPUT` 且沒有 `type` 屬性或 `type` 是
   `text`／`email`／`tel`／`search`,不是回 `MSG.loginNotUsernameField(ref)`;`passwordRef` 要是 `INPUT` 且
   `type=password`,不是回 `MSG.loginNotPasswordField(ref)`;有給 `submitRef` 的話要是 `BUTTON`,或
   `INPUT` 且 `type` 是 `submit`／`button`／`image`,不是回 `MSG.loginNotSubmitButton(ref)`。這一步防的是
   模型把 `passwordRef` 指到隨便一個同站欄位,騙主行程把密碼打進去再讀出來。
4. 帳號填進 `usernameRef`(先清空),密碼填進 `passwordRef`(先清空)。填法沿用 `controller-input.ts` 的
   `type(ref, value, clear=true, submit=false)`。
5. 有 `submitRef` 就 `click` 它,沒有就 `press('Enter')`;兩者都會等頁面靜默。
6. 清空密碼欄:`passwordRef` 指向的 ref 表若不是因為頁面跳轉(`invalidatedBy === 'navigated'`)而失效,就嘗試用
   `type(passwordRef, '', clear=true, submit=false)` 清掉;是因為頁面跳轉就安靜略過,不記錯誤(欄位已經不在
   頁面上)。是其他原因(例如 `userInput`)讓 ref 已經過期,這次嘗試會因為 ref 檢查失敗而丟例外;不論是這種
   ref 失效還是清空本身的 CDP 指令失敗,都要 `logError` 記下「view_login 清空密碼欄失敗，密碼可能還留在
   欄位裡」。這一步不分登入成功失敗,回傳前一定做。
7. 回 `MSG.loggedIn(machine, url)`,`url` 只留 origin 與路徑(見 §5.3)。第 6 步的清空失敗時,回傳文字加第二行
   `MSG.loginClearFailed`。

第 4 步之後的任何失敗(包含 signal 中止)都要先做第 6 步再回傳。用 `try / finally` 寫,不要每個失敗點各寫一次。

### 5.3 為什麼要第 6 步

密碼填進欄位之後,agent 用 `view_eval` 讀 `input.value` 就拿得到。登入成功時頁面通常會跳轉,欄位消失;
但單頁應用登入不跳轉,失敗時欄位也還在。一律清空,成功與失敗不用分開處理。

其他看得到密碼的路徑:

| 路徑 | 狀況 |
|---|---|
| `view_snapshot` | Chromium 的無障礙樹對密碼欄回的是遮罩後的值;用假 CDP 的單元測試驗不到這件事,由 §8.2 第 4 項在真的 Electron 裡確認 |
| `view_screenshot` | 密碼欄畫面上是遮罩 |
| 頁面自己的 JavaScript | 頁面本來就拿得到使用者輸入的東西,不在防護範圍 |
| 工具呼叫紀錄 | 參數只有測試機名稱與三個 ref |
| 模型把非密碼欄位當成 `passwordRef` | 第 3 步的節點型別檢查擋下,回 `MSG.loginNotPasswordField` |
| 回傳文字與 log | 只有測試機名稱與網址,不含帳號;網址只留 origin 與路徑,不含查詢字串與 hash,GET 登入表單或帶 token 的轉址常把密碼或 token 放在那兩段裡 |

### 5.4 每個 session 怎麼拿到帳密

`ViewToolDeps` 加 `credentials: (machine: string) => Promise<Credentials | undefined>`,
`Credentials = { username, password, passwordUnreadable, origin }`。跟 `projectDir` 一樣是 session 建立時給的閉包,每次呼叫才用
conversationId 查目前所屬的專案,再轉呼叫 `service.credentialsFor(projectId, machine)`;專案被重新指定資料夾不用另外同步。
對話已不在任何專案裡時回 `undefined`,`view_login` 回 `MSG.machineUnknown`。

`browser-sessions.ts` 的 `StartToolsArgs`、`view-tools/server.ts` 的 `ViewToolDeps`、
`view-tools/controller-types.ts` 的 `ControllerDeps`、`view-tools/startup.ts` 的 deps 各多傳一個 `credentials`
欄位,其餘不動。

### 5.5 批准

`policy.ts` 的放行表由 `VIEW_TOOL_NAMES` 產生,`view_login` 加進名單後自動是 `allow`。codex 一樣。

## 6. 錯誤與訊息

`src/main/view-tools/errors.ts` 的 `MSG` 新增:

| 名稱 | 文字 |
|---|---|
| `machineUnknown(name)` | `沒有叫 ${name} 的測試機，請到專案的測試機設定新增` |
| `machineNoPassword(name)` | `測試機 ${name} 沒有設定密碼` |
| `machinePasswordUnreadable(name)` | `測試機 ${name} 的密碼解不開，請到測試機設定重新輸入密碼` |
| `originMismatch(origin)` | `目前頁面不是 ${origin}，不會填入帳密` |
| `loginRefInFrame` | `帳密欄位必須在主框架，不能在跨站 iframe 裡` |
| `loginNotUsernameField(ref)` | `${ref} 不是文字輸入欄位，不會填入帳號` |
| `loginNotPasswordField(ref)` | `${ref} 不是密碼欄位（input type=password），不會填入密碼` |
| `loginNotSubmitButton(ref)` | `${ref} 不是按鈕，不會用它送出` |
| `keychainUnavailable` | `這台電腦的鑰匙圈不可用，無法儲存密碼` |
| `loggedIn(machine, url)` | `已用 ${machine} 的帳密送出登入，目前網址 ${url}`;`url` 已經被裁成只剩 origin 與路徑(C2) |
| `loginClearFailed` | `密碼欄可能沒有清空，請勿在這個頁面上呼叫 view_eval 讀取欄位內容，並回報使用者` |

「送出登入」而不是「已登入」:主行程只知道表單送出去了,登入有沒有成功要 agent 自己 snapshot 確認。
`MSG` 裡所有訊息句內逗號都是全形「，」,跟 `errors.ts` 既有訊息的標點一致。

## 7. 不會變的東西

- 另外八個工具的名稱、參數、回傳格式。
- `view_eval` 與 codex `view_navigate` 的批准規則。
- `refs.ts`、`controller-input.ts`、`settle.ts` 的實作:`controller-login.ts` 只呼叫它們。
- 每對話瀏覽器規格定的 session 生命週期。

## 8. 測試

### 8.1 單元測試(先寫)

- service:假的 `safeStorage`。加密存檔後 `list` 沒有 `password` 欄位;`credentialsFor` 解回明文;
  `upsert` 不帶密碼保留原密文;`isEncryptionAvailable()` 回 false 時帶密碼的 `upsert` 被拒、不帶密碼的照常;
  `revision` 對不上被拒;`removeProject` 後檔案不存在;檔案損毀時 `list` 回錯誤、不清空;同一個專案的兩個
  `upsert` 同時送達依序套用兩筆都在;把測試機改名成它自己原本的名字要成功;存檔裡的網址壞掉時 `list` 回
  錯誤、`credentialsFor` 回 `undefined`;加密或寫檔失敗時 `upsert` 回 error、檔案不變。
- schema:回應 schema 遇到含 `password` 的物件會拒絕(`.strict()`);`url` 協定不是 http/https 被拒;`name` 空白被拒。
- `test-machines/ipc.ts`:`createTestMachinesIpcHandler` 的來源檢查(I5)。不可信的 sender 回 error、不呼叫
  `handle()`;可信的 sender 原樣轉給 `handle()` 並回它的結果。
- `controller-login`:用現有的 controller 測試 harness(假 CDP)。七步的每個失敗點各一條;
  origin 不符時沒有任何 `Input.*` 指令送出;`usernameRef`／`passwordRef`／`submitRef` 指到型別不對的節點各回
  對應的 `MSG.loginNotXxx`(C1);節點型別檢查時 `DOM.describeNode` 失敗回 `refDetached`;`submitRef` 有無兩種
  送出方式;第 4 步之後失敗(含 signal 中止)密碼欄仍被清空;成功後密碼欄被清空;ref 表因使用者輸入
  (`userInput`)而非頁面跳轉失效時,清空仍要嘗試,嘗試失敗要記錯誤、回傳文字加 `MSG.loginClearFailed`(I3);
  清空本身因 CDP 失敗時同樣要記錯誤、加這行警告;送出後網址帶查詢字串或 hash 時回傳文字只留 origin 與路徑
  (C2);回傳文字不含帳號與密碼。
- policy:`view_login` 的全名回 `allow`,codex 也是。
- 元件:清單、表單、留空保留密碼、錯誤訊息顯示。
- 每對話瀏覽器規格 §9.1 的 `browser-sessions` 測試補一條:`startTools` 收到 `credentials`。

### 8.2 實機驗收

1. 開發模式(`npm run dev`)下存一組密碼,記下 macOS 的 Keychain 授權提示出現幾次;重啟 app 再讀一次,再記一次。
2. 在測試機的登入頁叫 agent「用 staging 登入」,agent 只呼叫 `view_snapshot` 與 `view_login`,登入成功。
3. 登入後叫 agent 用 `view_eval` 讀密碼欄的 `value`,回傳是空字串。
4. `view_snapshot` 與 `view_screenshot` 的輸出都看不到密碼。
5. 把頁面導到另一個網站,再叫 `view_login`,回「目前頁面不是 …」,頁面上沒有任何欄位被填。
6. 移除專案後,`<userData>/test-machines/` 底下對應的檔案消失。
7. 對話紀錄與 `logError` 的輸出裡 grep 不到密碼。

### 8.3 風險

開發模式的 app 沒有簽章,`safeStorage` 在 macOS 上可能每次啟動都跳 Keychain 授權提示,或是換一次 build 就要重新授權
(密文用舊金鑰加密,新 build 解不開)。這兩件事這一輪還沒量測,待驗收的問題與量法見
docs/RESULTS-35-test-machines.md 第 2 節。密文解不開時的處理已定案:`list` 仍顯示「已設定」,`credentialsFor`
回 `password: null` 與 `passwordUnreadable: true`,`view_login` 回 `MSG.machinePasswordUnreadable`,不會讓
`list` 整個失敗。

設定檔本身損毀或格式不對時(`StoredFileSchema` 驗不過),`list`、`upsert`、`remove` 都回 `TEXT.unreadable`
這個錯誤,沒有從畫面上提供修復路徑,要靠人手動刪除 `<userData>/test-machines/<projectId>.json` 之後才能重建
(I2,裁決保留現狀,不修)。
