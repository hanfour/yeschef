# 共用 Skills：一份原始碼，三個執行者

日期：2026-10-02。狀態：已確認，待實作。

## 1. 目的

共用 Skills 目前只送到兩個執行者：Claude 透過 plugin（`revisions/<rev>` 加上產生的 `.claude-plugin/plugin.json`），Codex 透過 `skills/extraRoots/set` 指向 `revisions/<rev>/skills`。Grok 完全沒有接上，在 Grok 對話裡用不到任何共用 Skill。

另外，同一份 SKILL.md 原封不動給每個執行者，寫法沒辦法依執行者調整。例如叫用另一個 skill 時，Claude 寫 `/name`、Codex 寫 `$name`；描述工具時，Claude 叫 `Bash`，Codex 叫 `shell`。作者只能挑一種寫法，或寫成三者都通的模糊說法。

這份規格做兩件事：

1. Grok 也收到共用 Skills。
2. Skill 作者寫一份原始碼，可以用少數幾個固定變數，YesChef 在產生快照時替每個執行者各產生一份。

## 2. Grok 怎麼接

Grok 支援用設定檔的 `[skills] paths` 掃描額外目錄，也支援用 `GROK_CONFIG` 環境變數傳入只對這次啟動生效的設定（疊加在 `~/.grok/config.toml` 之上，不寫入檔案）。YesChef 啟動 Grok 對話時，在環境變數加上：

```
GROK_CONFIG={"skills":{"paths":["<revisions/<rev>/grok/skills>"]}}
```

不改使用者的 `~/.grok/config.toml`。

待實測（實作第一步）：`GROK_CONFIG` 的陣列是與使用者原本的 `skills.paths` 合併，還是取代。

- 合併：直接用上面的寫法。
- 取代：啟動前讀 `~/.grok/config.toml` 的 `skills.paths`，把使用者原本的路徑與 YesChef 的路徑一起放進去，避免使用者自己的 Skills 在 YesChef 裡消失。讀不到或格式不對時，只放 YesChef 的路徑，並在 log 記一筆。

這一步完成前，畫面上的說明維持「Codex 與 Claude」；完成後改成三個執行者。

## 3. 變數

SKILL.md 與 skill 目錄內的其他 `.md` 檔可以使用以下變數，其他檔案（腳本、圖片、JSON）原樣複製：

| 變數 | Claude | Codex | Grok |
| --- | --- | --- | --- |
| `{{provider}}` | `claude` | `codex` | `grok` |
| `{{skill_prefix}}` | `/` | `$` | `/` |
| `{{shell_tool}}` | `Bash` | `shell` | `run_terminal_command` |
| `{{skill_dir}}` | 該執行者那份 skill 目錄的絕對路徑 | 同左 | 同左 |

`{{shell_tool}}` 的 Grok 名稱以實作時查到的實際工具名稱為準。

規則：

- 只認上表四個變數，大小寫要完全相同。
- 安裝時掃描 `.md` 檔，出現 `{{` 加上不在表內的名稱時，安裝預覽列出警告（可能是作者寫錯，也可能是 skill 本身就要輸出雙大括號）。這類文字原樣保留，不替換、不擋安裝。
- 沒用任何變數的 skill，三份內容完全相同，與現在的行為一致。

## 4. 快照的目錄結構

現在：

```
revisions/<rev>/
  .claude-plugin/plugin.json
  skills/<name>/...
```

改成：

```
revisions/<rev>/
  claude/.claude-plugin/plugin.json
  claude/skills/<name>/...
  codex/skills/<name>/...
  grok/skills/<name>/...
```

- Claude 的 plugin 路徑改成 `revisions/<rev>/claude`，Codex 的 extraRoots 改成 `revisions/<rev>/codex/skills`，Grok 用 `revisions/<rev>/grok/skills`。
- 快照仍然不可變：執行中的對話繼續用自己那份，與現在相同。
- 舊格式的快照（沒有 `claude/` 子目錄）照常可用：讀取時判斷 `revisions/<rev>/.claude-plugin` 是否存在，存在就用舊路徑。下一次安裝、啟用或移除時會產生新格式的快照。

## 5. 畫面

Skills 管理畫面：

- 每個 skill 顯示會收到它的執行者（目前三個都會收到）。
- 說明文字列出三個執行者，並用各自的寫法示範如何叫用：`/yeschef-shared:<name>`（Claude）、`$<name>`（Codex）、Grok 的寫法以實測為準。
- 安裝預覽列出第 3 節的未知變數警告。

這次不做「某個 skill 只給某個執行者」的開關。需要時另外規劃。

## 6. 相容性

- 現有的 `index.json`、`packages/` 不變。
- 舊快照照常可用（第 4 節）。
- 既有 skill 沒用變數，產出的三份內容與原本相同。
- 使用者自己的 Grok skills 不受影響（第 2 節）。

## 7. 驗收

- 單元測試：變數替換（四個變數、未知變數保留並警告、非 `.md` 檔不替換）、新舊快照路徑判斷、Grok 環境變數的組成（合併與取代兩種情況）。
- 實機：安裝一個用到 `{{skill_prefix}}` 與 `{{shell_tool}}` 的測試 skill，分別在 Claude、Codex、Grok 對話裡請執行者列出可用的 skills 並叫用它，確認三者都收到、內容是各自的版本。各跑兩次。
- 實機：在 `~/.grok/config.toml` 設定一個自己的 `skills.paths`，確認 YesChef 裡的 Grok 對話同時看得到使用者的與共用的 skills。
