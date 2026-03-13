# VIZCODE — AI 核心記憶與快速上手指南

> ⚠️ **所有 AI Agent 注意** ⚠️
> 這是一份幫助你快速理解專案的指南。每次重大架構修改後，**必須**同步更新此檔案，以確保給下一位 AI 接手時資訊是最新的。

---

## 🚀 系統概覽 (System Overview)

- **專案名稱**: VIZCODE V4
- **專案用途**: 本地端 (Local) 的程式碼視覺化工具。掃描使用者的 codebase 並產生互動式的 HTML 關聯圖 (Dependency Graph / Call Graph)。
- **啟動方式**: 執行 `launch.bat` → 自動開啟互動式終端機 CLI `vizcode.py` → 啟動本地伺服器 `server.py` → 在 Chrome 打開 `http://localhost:7777`。
- **核心特色**: 完全依賴 Python 標準函式庫 (無 pip 安裝需求)、支援多語言 (Pluggable Parser)、前後端分離架構。

---

## 📂 核心檔案地圖與相依關係

為了方便人類與 AI 快速閱讀，請參考以下結構化的檔案樹狀圖設計：

### 🟢 啟動與伺服器 (Entry & Server)
- 📄 **`launch.bat`** (腳本)
  - **用途**: Windows 專屬啟動腳本。設定 UTF-8 環境。
  - **👉 觸發**: `vizcode.py`
- 🐍 **`vizcode.py`** (後端)
  - **用途**: 互動式終端機介面 (TUI)，供使用者選擇歷史紀錄與目錄。
  - **👉 觸發**: 以子程序 (Subprocess) 啟動 `server.py`
- 🌐 **`server.py`** (後端)
  - **用途**: HTTP 伺服器 (Port 7777)，負責處理網頁請求與 `/analyze` 背景任務。
  - **👉 觸發**: 載入 `analyze_viz.py` 進行分析，發送 `launcher.html` 給瀏覽器。

### 🔴 核心分析引擎 (Backend Analysis)
- 🧠 **`analyze_viz.py`** (後端)
  - **用途**: **系統的大腦與心臟**。遍歷資料夾、建立專案依賴圖表 (Nodes & Edges)、產出最終 JSON。
  - **🔄 依賴**: `detector.py` 以及所有的 `parsers/*.py`
- 🕵️ **`detector.py`** (後端)
  - **用途**: 掃描資料夾內的特徵檔案，判斷目前的專案類型 (Python, JS, Go 或 BIOS)。
- 🧩 **`parsers/`** (後端)
  - **用途**: 各獨立語言的解析器，只負責將原始碼轉為統一格式的資料 (Tuple) 交還給 `analyze_viz.py`。
  - `bios_parser.py`: 解析 BIOS 相關檔案 (C/C++, ASM, EDK2, INF, SDL 等)
  - `python_parser.py`: 解析 `.py`
  - `js_parser.py`: 解析 `.js`, `.ts`, `.jsx`, `.tsx`
  - `go_parser.py`: 解析 `.go`

### 🔵 前端視覺化 (Frontend UI)
- 🖥️ **`launcher.html`** (前端)
  - **用途**: 單頁應用 (SPA) 介面。顯示讀取進度條，並作為畫布的容器。
  - **🔄 依賴**: 載入 `static/` 下的靜態資源。
- 🎨 **`static/viz.js`** (前端)
  - **用途**: **前端的心臟**。解析 JSON 資料，處理 Cytoscape 繪圖、佈局、點擊事件與過濾器邏輯 (L0/L1/L2)。
  - **⚠️ Structure 按鈕**: 優先呼叫 `symViewOpen()`，若檔案無 symbol 才 fallback 到 `svToggleStructView()`。
- 💅 **`static/viz.css`** (前端)
  - **用途**: 所有介面的視覺外觀定義。
- 🌍 **`static/i18n.js`** (前端)
  - **用途**: 管理中英雙語的翻譯對照表。
- 🔮 **`static/struct_view.js`** (前端)
  - **用途**: Structure View 插件，提供 class-grid 視圖。Entry points: `svToggleStructView()`, `svUpdateStructureBtn()`, `svAfterRenderCode()`。
- 🌐 **`static/symbol_view.js`** (前端) ← **Phase 1–5**
  - **用途**: Sourcetrail 風格的 Symbol-Centric Graph（compound class card + PUBLIC/PRIVATE section + TrailLayouter + snippet panel）。
  - **Entry points**: `symViewOpen(fileRel)` / `symViewActivate(symId)` / `symViewClose()`。
  - **節點互動**: 不可拖曳。click center → Code Panel；click neighbor → 重新導航；click member badge → `_symShowSnippets(symId)` 顯示右側 snippet panel；click edge → tooltip edgeType + ×N。
  - **⚠️ DOM**: `#sym-body` 包含 `#sym-cy`（flex:1）和 `#sym-snippet-panel`（360px，預設隱藏）。Edge curve-style = `taxi`（正交折線）。
- 🎨 **`static/symbol_view.css`** (前端) ← **Phase 1–5**
  - **用途**: Symbol View 專用樣式。含 `#sym-snippet-panel`（definition 黃色邊框、reference 灰色邊框、高亮行、行號）以及 `.sym-edge-tooltip`。

---

## 🔄 系統核心資料流 (Data Flow Workflow)

當使用者在網頁上輸入路徑並點擊「Analyze」時，整個系統的資料流向如下：

1. **Frontend Request**: 使用者在 `launcher.html` 點擊分析，網頁發送 POST 請求至 `http://localhost:7777/analyze`。
2. **Server Handling**: `server.py` 接收到請求，開啟一個子線程 (Thread)，開始 Server 端的事件串流 (SSE)。
3. **Core Engine Starts**: `server.py` 呼叫 `analyze_viz.py` 的主函式，開始掃描指定的目錄。
4. **Project Detection**: `analyze_viz.py` 先呼叫 `detector.py` 判定專案類型 (如 Python 或 BIOS)。
5. **File Parsing (Dispatch)**: `analyze_viz.py` 讀取每一個檔案，並根據副檔名分發 (Dispatch) 給對應的 `parsers/` 下的模組。
    - 各個 Parser (`xxx_parser.py`) 只需要負責把程式碼轉成統一格式的 Tuple (Imports, FuncDefs, Calls)。
6. **Graph Building**: `analyze_viz.py` 統整所有 Parser 的結果，建立 Nodes (檔案/函式) 和 Edges (依賴/呼叫關係)，轉換成巨大的 JSON 物件。
7. **Frontend Rendering**: `server.py` 將包含 JSON 的 HTML 結果發送回瀏覽器。`launcher.html` 載入後，`static/viz.js` 接手，將 JSON 物件渲染成視覺化的關聯圖。

---

## 🛠️ AI 擴充與修改指南 (Extensibility Guide)

如果你需要新增或修改功能，請嚴格遵守以下對應位置，**不要改錯檔案**：

### 情境 1：新增一種新的程式語言支援 (例如：Java)
1. **建立 Parser**: 在 `parsers/` 資料夾下新增 `java_parser.py`，實作 `scan_java(content, filepath)` 並回傳規定的 Tuple 格式。
2. **註冊 Parser**: 修改 `analyze_viz.py`，在 `scan_file()` 中匯入你的 parser 並新增附檔名判斷 (`.java`)，呼叫 `scan_java()`。並在頂部 `SCAN_EXT` 和 `FILE_TYPE_MAP` 註冊。
3. **專案偵測**: 修改 `detector.py`，加入識別 Java 專案的特徵 (例如 `pom.xml`, `build.gradle`)。
4. **前端樣式**: 修改 `static/viz.js`，在 `extColor()` 設定 Java 檔案的顏色，並在 `FILE_TYPE_SHAPE`、`FT_GROUPS` 等常數表增加 Java 類別的顯示。

### 情境 2：修改或修復 BIOS (C/C++/EDK2) 的解析邏輯
- **唯一需要修改的地方**: `parsers/bios_parser.py`。
- `analyze_viz.py` 和 `detector.py` 完全**不需要碰**。BIOS 所有的正規表示式與邊界案例都在這個 parser 裡面。

### 情境 3：修改畫面上節點的顏色、形狀或連線的外觀
- 只需要修改 **`static/viz.css`** (靜態外觀) 或 **`static/viz.js`** (畫布算圖邏輯、點擊高亮邏輯)。

### 情境 4：修改伺服器機制、增加 API Endpoints
- 修改 **`server.py`** 下的 `Handler` class (`do_GET`, `do_POST`)。

### 情境 5：修改終端機操作畫面 (CLI/TUI)
- 修改 **`vizcode.py`** 裡面的 `TUI` 類別 (包含 Banner、動畫、按鍵回應)。

---

## 💡 統一的 Parser 介面規範

任何在 `parsers/` 下的模組，其 `scan_xxx()` 函式回傳格式：

**標準 5-tuple** (BIOS/JS/Go parsers):
```python
return (
    imports_or_refs,      # list[str]: 這個檔案依賴的外部模組/檔案/字串
    funcdefs,             # list[dict]: [{label, is_efiapi, is_static}, ...]
    funccalls,            # list[str]: 這個檔案呼叫了哪些外部函式
    extra_dict,           # dict | None: 額外 Metadata (BIOS 用，通常 None)
    func_calls_by_func,   # list[list[str]]: 每個 funcdef 對應的呼叫陣列
)
```

**擴充 6-tuple** (全部 4 個 parser 均已實作 ✅):
```python
return (
    imports_or_refs,
    funcdefs,
    funccalls,
    extra_dict,
    func_calls_by_func,
    symbol_defs,          # list[dict]: [{kind, name, line, end_line, bases, parent, is_public}, ...]
                          # kind: 'class'|'method'|'function'
                          # bases: 繼承的父類名稱 (for inheritance edges)
                          # parent: 所屬的 class 名稱 (None = top-level)
)
```

`analyze_viz.py` 的 `scan_file()` 會偵測 tuple 長度，6-tuple 時自動提取 `symbol_defs` 並存入 `file_symdefs`。`build_graph()` 在 Phase F 統一將所有 `symbol_defs` 組合為 `symbol_index` (dict) 和 `symbol_edges` (list)，注入最終 JSON。

## 🔮 Symbol View 架構備忘 (Phase 1–5)

- **資料來源**: `DATA.symbol_index` (build_graph Phase F 建立) + API `/symbol-graph?job=JID&sym=SID`
- **`/symbol-graph` 回應格式**:
  ```json
  {
    "center": { "id", "name", "kind", "file", "line", "is_public",
                "children": [{id, name, kind, line, end_line, is_public, access_level}] },
    "incoming": [{ "sym": {...}, "edge_type": "call|inheritance|import", "count": N }],
    "outgoing": [{ "sym": {...}, "edge_type": "...", "count": N }]
  }
  ```
- **Compound node 層次**: class card → PUBLIC group → member badges；member 有 `access_level` 分 public/private。
- **Edge 線寬**: `lineWidth = min(1.5 + log2(count), 6)`；count=1 時 1.5px，多條合併時自動加粗。
- **不可拖曳**: `cy.nodes().ungrabify()` 在每次 render 後呼叫。
- **Edge curve**: `taxi`（正交折線，`taxi-turn: 60%`）。
- **Snippet panel** (`#sym-snippet-panel`): click member badge → `/symbol-refs` → 右側 360px 欄；definition 黃框，reference 灰框；navigate 時自動關閉。
- **Symbol edge types**: `call` (橘 #fb923c), `inheritance` (藍 #60a5fa), `import` (綠 #34d399), `member` (紫 #c084fc), `override` (粉 #f472b6), `type_usage` (黃 #fbbf24), `include` (灰 #94a3b8)
- **`build_html()` 載入順序**: `viz.css` → `themes.css` → `struct_view.css` → **`symbol_view.css`** → `i18n.js` → `viz.js` → `struct_view.js` → `trail_layouter.js` → **`symbol_view.js`**

---

## 📜 備忘：BIOS 的 Edge Type 與顏色定義
(保留這部分是因為 BIOS 結構過於龐大，常需要除錯)
- Includes (`#include`): `#c084fc` (紫色)
- Sources (`[Sources]`): `#ffd700` (金色)
- Packages (`[Packages]`): `#00d4ff` (青色)
- LibraryClasses: `#a78bfa` (淺紫)
- Components: `#60a5fa` (藍色)
- Guid/Protocol Ref: `#fb923c` (橘色)
- String Ref (`.uni`): `#e879f9` (粉紅)
- VFR/HFR Callbacks: `#f87171` (紅色)
