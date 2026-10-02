# yeschef 子專案 B：右窗格瀏覽器工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓左窗格的 agent 透過八個程序內 MCP 工具操作右窗格瀏覽器，並在需要人時交接給使用者、再接回來。

**Architecture:** `src/main/view-tools/` 用 Agent SDK 的 `createSdkMcpServer` 建一個名為 `yeschef` 的程序內 MCP server，八個工具全部經 `webContents.debugger` 的 CDP 執行（不注入持久 JS）。純函式（snapshot 過濾與 ref 編號、ref 解析、按鍵表、網址檢查、插手摘要）與有狀態元件（settle 計數、插手監看、handoff 單一 pending、controller）分檔，server.ts 只做組裝與錯誤翻譯。左窗格用 `renderToolOverride` 把 `request_handoff` 的工具卡換成 HandoffCard，其餘工具卡沿用 Plan A 的 fold 與 ToolCall。

**Tech Stack:** Electron 44、`@anthropic-ai/claude-agent-sdk` 0.3.258（`createSdkMcpServer`、`tool`、`canUseTool`）、zod 4、`@modelcontextprotocol/sdk` 1.30.0、React、vitest。

**Spec:** `docs/specs/2026-09-03-yeschef-b-view-tools-design.md`
**Contract:** `docs/superpowers/plan-b/CONTRACT.md`（型別契約與裁決 1 到 37；程式碼註解引用「裁決 N」時指這份）

## Global Constraints

- Electron 44、Agent SDK 0.3.258、`@modelcontextprotocol/sdk` 1.30.0 不升版；zod 加為直接相依（`^4.0.0`，裁決 4）。
- MCP server 名稱 `yeschef`，工具全名 `mcp__yeschef__<name>`，八個工具名稱以 `src/shared/view-tools.ts` 的 `VIEW_TOOL_NAMES` 為準；八個工具都設 `alwaysLoad: true`（裁決 19）。
- 批准政策：七個工具 `allow`，`view_eval` 與任何未列名工具 `ask`（`policy.ts`）。
- 進門檢查順序：`isDestroyed()` → zod 參數驗證 → ref／網址等語意檢查 → CDP；所有錯誤都是 MCP `isError: true` 加一句繁體中文，字串以 `errors.ts` 的 `MSG` 表為準，逐字使用。
- 數值常數：`MAX_SNAPSHOT_NODES = 400`、`MAX_BOX_LOOKUPS = 1500`、`SETTLE_QUIET_MS = 500`、`SETTLE_TIMEOUT_MS = 5_000`、`NAVIGATE_TIMEOUT_MS = 8_000`、`HANDOFF_TIMEOUT_MS = 10 * 60_000`、`CDP_CALL_TIMEOUT_MS = 10_000`、`EVAL_MAX_CHARS = 8192`、`SCREENSHOT_MAX_WIDTH = 1280`。
- 網址只接受 `http:`、`https:`、`file:`；`file:` 必須在 `YESCHEF_PROJECT_DIR` 底下。
- `view_eval` 每次都走批准卡；工具內只用 CDP，不注入持久 JS；`persist:agent` partition 與 `setWindowOpenHandler` 行為不變。
- session 收尾時所有等待中的工具呼叫收到 `對話已結束`（`abortPending`，裁決 11）；handoff 逾時是狀態不是錯誤。
- `src/renderer/fold.ts` 不改；`request_handoff` 的卡片替換走 `renderToolOverride`（裁決 2）。
- 每個檔案不超過 400 行；純函式模組不 import Electron；`src/shared/` 不 import `src/main/` 或 `src/renderer/`。
- 時間相關程式碼全部經 `MergerClock` 注入，測試用 `tests/helpers/manual-clock.ts`（到期排序）。
- 測試：vitest；整體覆蓋率 Stmts ≥ 93、Branch ≥ 86；`tests/view-tools/<module>.test.ts` 一個模組一檔；`src/main/agent-view.ts` 維持排除並更新註解。
- 實機驗收 25 項至少 23 項 ✓，`view_click`、`view_type`、`request_handoff` 必須 ✓；結果寫 `docs/RESULTS-05-b-view-tools.md`，格式沿 `docs/RESULTS-04-*.md`。
- 使用者可見文案（工具描述、錯誤訊息、HandoffCard 文字、插手摘要）為繁體中文台灣用語，以契約 §10.1、§12、§9.3 的字串為準。
- commit 訊息 `<type>: <description>`，繁體中文，不加 Co-Authored-By 或任何 trailer；每個 task 至少一個 commit，`git add` 列精確檔名。
