# VIZCODE V5 — Agent Briefing

> **目標：做到 Sourcetrail 等級的開源程式碼探索器。**
> 本文件是 AI Agent 的快速上手指引 + 階段式實作路線圖。

---

## 一、Sourcetrail 是什麼？我們要對標的功能

Sourcetrail 是一個以 **Symbol 為中心** 的程式碼探索工具，核心 UI 由三個同步面板組成：

| 面板 | Sourcetrail 功能 | CodeViz 現狀 |
|------|-----------------|-------------|
| **Search Bar** | Fuzzy symbol search (函式、類別、檔案、變數)、autocompletion、搜尋結果即時預覽 | ✅ 全文搜尋 `/search` + 串流 `/search-stream`，但只搜文字、**不搜 symbol index** |
| **Graph View** | 以目前 active symbol 為中心，顯示其所有 incoming / outgoing 依賴的互動式圖形。支援 **bundled edges**（多條邊整合為一條帶數字）、**node expansion**（class 展開看 members）、**edge activation**（點邊展開看細節） | ✅ Cytoscape L0 模組總覽 / L1 檔案依賴 / L2 function call-flow。但無 symbol-centric 圖、無 bundled edges、無 class 展開 |
| **Code View** | 顯示 active symbol 在所有檔案中的 **code snippets**（只顯示相關片段，非整個檔案）。snippet 可展開、可折疊、可跳到定義 | ✅ 右側 code panel 顯示整個檔案 + 高亮行。但無 **多檔 snippet 聚合**、無 context-aware 片段 |

### Sourcetrail 關鍵特性清單

1. **Symbol-Centric Navigation** — 任何 symbol (函式/類別/變數/namespace) 都能被 activate，三個面板同步更新
2. **Graph Node Types** — 不同 symbol 類型有不同圖形（函式=圓角、類別=矩形+成員列表、檔案=六角形、namespace=包圍框）
3. **Bundled Edges** — 多條同類 edge 合併為一條粗邊，標示數量，hover 顯示細節，click 展開
4. **Class Hierarchy** — 繼承鏈 (base ↔ derived) 在 graph 中直接可見
5. **Node Expansion** — class 節點可以展開顯示所有 members (methods + fields)
6. **Code Snippets** — 選中 symbol 後，Code View 從多個檔案收集 snippet，每個 snippet 只顯示相關的幾行 + context
7. **Overview Screen** — 專案載入後顯示所有 indexed symbols 的統計 + 圓餅圖
8. **Back/Forward Navigation** — 類似瀏覽器的歷史導航

---

## 二、CodeViz 現有架構

### 檔案對照表

| 檔案 | 角色 |
|------|------|
| `server.py` | HTTP server。Serve static files，處理 `/file`, `/search`, `/search-stream`, `/analyze`, `/structure` API |
| `analyze_viz.py` | 掃描專案、建立 `DATA` (nodes + edges)。Entry: `build_graph(root)` |
| `viz.js` | 主前端邏輯 (~7600 行)。State, Cytoscape graph, code panel |
| `viz.css` | 主 stylesheet |
| `struct_view.js` | Structure View plugin (~1100 行)。獨立 `<script>` 載入 |
| `struct_view.css` | Structure View stylesheet |
| `i18n.js` | 中英雙語翻譯 |
| `launcher.html` | SPA shell，注入 DATA + 載入所有 scripts |
| `parsers/` | 獨立語言解析器: `bios_parser.py`, `python_parser.py`, `js_parser.py`, `go_parser.py` |
| `detector.py` | 專案類型自動偵測 |
| `vizcode.py` | CLI launcher + TUI 動畫 |

### 前端架構

```
browser
  ├─ #graph-wrap                    ← 主容器
  │    ├─ #cy                       ← Cytoscape canvas (L2/sv-view 時隱藏)
  │    ├─ #func-view                ← L2 call-graph overlay (3-column Callers | Func | Callees)
  │    └─ #sv-view                  ← Structure View overlay
  ├─ #code-panel                    ← 可調寬度的右側 source panel
  └─ breadcrumb toolbar             ← Back / ⬡ Call Graph / 🏗 Structure / 📝 Code 按鈕
```

### 導航層級

- **L0** — 模組總覽 (Cytoscape, `state.level = 0`)
- **L1** — 檔案依賴圖 (`state.level = 1`, `state.activeModule`)
- **L2** — 函式 call-flow (`state.level = 2`, `state.activeFile`, `l2State`)
- **sv-view** — Structure View overlay；在 L1 或 L2 開啟，隱藏 `#cy`

### Key Global State

```js
window.DATA            // 完整 graph payload (server 注入 HTML)
  .funcs_by_file       // { "rel/path.py": [ { label, is_public, is_efiapi }, ... ] }
  .func_edges_by_file  // { "rel/path.py": [ { s: callerIdx, t: calleeIdx }, ... ] }
  .files_by_module     // { modId: [ { id, path, label, ext, file_type, func_count }, ... ] }

state          // { level, activeModule, activeFile, ... }
l2State        // { activeFile, activeFuncIdx, ... }
codeState      // { currentFile, funcLineMap, funcList, rawLines, isOpen, ... }
_sv            // struct_view.js internal state (window._sv)
```

### 重要函式

```js
// viz.js
drillToFile(fileRel)              // L2 導航
focusFunc(fileRel, idx)           // 顯示某函式的 func-view
showFuncView(fileRel, funcs, edges, centerIdx)  // 3-col callers/callees UI
jumpToFunc(funcName)              // code panel 跳到函式定義
loadFileInPanel(filePath, funcName)  // 載入檔案到 code panel
renderCode(src, ext, fname, langHint)  // 語法高亮渲染

// struct_view.js
svUpdateStructureBtn(fileRel, ext)  // viz.js 呼叫，更新按鈕狀態
svAfterRenderCode(src, ext, fname)  // viz.js 呼叫，renderCode 後
svShowSvView() / svHideSvView()     // 顯示/隱藏 sv-view
_svRender(src, ext, fname)          // 解析 + 建構 grid
_svParseClasses(src, ext)           // 分發到各語言 parser
_svFetchAndApplyCrossFile(...)      // async 取 /structure 資料
```

---

## 三、與 Sourcetrail 的差距分析 (Gap Analysis)

### ❌ 完全缺失的核心功能

| # | 功能 | 說明 |
|---|------|------|
| G1 | **Symbol Index / Database** | Sourcetrail 有 SQLite 索引庫儲存每個 symbol 的 type、定義位置、所有引用位置。CodeViz 只有 `funcs_by_file` 和 `func_edges_by_file` — 沒有統一的 symbol table |
| G2 | **Symbol-Centric Graph** | 點擊任何 symbol 後，Graph 以該 symbol 為中心重新佈局，顯示所有 incoming/outgoing 關係。CodeViz 的 graph 是固定的 module→file→function 層級式導航 |
| G3 | **Bundled Edges** | 多條 edge 合併為帶數字的粗邊，click 展開。CodeViz 的 Cytoscape 每條 edge 獨立繪製 |
| G4 | **Multi-file Code Snippets** | 選中 symbol 後，Code View 聚合 N 個檔案中該 symbol 的所有出現位置為 snippet。CodeViz 只顯示一個完整檔案 |
| G5 | **Class Hierarchy Visualization** | 繼承鏈 (base → derived) 在 graph 中視覺化。CodeViz 完全沒有繼承關係解析 |
| G6 | **Node Expansion (Class Members)** | Graph 中 class 節點可展開顯示 methods + fields。CodeViz 沒有 |
| G7 | **Symbol-Aware Search** | 搜尋結果按 symbol type 分類（函式、類別、namespace），fuzzy match。CodeViz 只有純文字全文搜尋 |

### 🟡 部分實現

| # | 功能 | 現狀 |
|---|------|------|
| P1 | **Cross-file Dependencies** | Structure View 有 ghost box + 跨檔箭頭，但精度不足（箭頭起點不從 field badge 出發） |
| P2 | **Navigation History** | Structure View 有 Prev/Next 按鈕，但只限 sv-view 內部，不跨 L0/L1/L2 |
| P3 | **External Dependencies Toggle** | Structure View 有 toggle，但未整合到主圖 |

### ✅ 已完備

| # | 功能 |
|---|------|
| D1 | 多語言解析 (Python, JS/TS, Go, C/C++/BIOS) |
| D2 | 模組→檔案→函式三層 Cytoscape 圖 |
| D3 | 全文搜尋 + SSE 串流 |
| D4 | Code Panel 語法高亮 |
| D5 | Structure View (class/method/field badge grid) |
| D6 | Focus Panel (Callers/Callees inline) |
| D7 | i18n 中英切換 |

---

## 四、階段式實作路線圖

### Phase 1：Symbol Index 基礎建設 ★★★★★ (最高優先)

> **核心目標**：建立統一的 Symbol Table，為所有後續功能打下基礎。

#### 1.1 後端 — Symbol Table 建構

**修改 `analyze_viz.py`**：在 `build_graph()` 輸出中新增 `symbol_index`

```python
DATA.symbol_index = {
    "sym_0": {
        "id": "sym_0",
        "name": "MyClass",
        "qualified_name": "mymodule.submod.MyClass",
        "kind": "class",          # class | function | method | variable | module | file | namespace
        "file": "mymodule/submod.py",
        "line": 42,
        "end_line": 120,
        "is_public": True,
        "parent": "sym_3",        # 所屬 class/module 的 symbol id
        "children": ["sym_1", "sym_2"],   # methods/fields
    },
    "sym_1": {
        "id": "sym_1",
        "name": "do_work",
        "qualified_name": "mymodule.submod.MyClass.do_work",
        "kind": "method",
        "file": "mymodule/submod.py",
        "line": 55,
        "parent": "sym_0",
    },
    ...
}

DATA.symbol_edges = [
    { "from": "sym_1", "to": "sym_5", "type": "call" },
    { "from": "sym_0", "to": "sym_8", "type": "inheritance" },
    { "from": "sym_1", "to": "sym_12", "type": "type_usage" },
    { "from": "sym_0", "to": "sym_20", "type": "import" },
    ...
]

# Edge types: call, inheritance, type_usage, import, override, file_include
```

**修改 `parsers/*.py`**：每個 parser 回傳 symbol 資訊

- `python_parser.py`: 解析 class 定義、method 定義、繼承關係 (`class Foo(Bar)`)、import 來源
- `js_parser.py`: 解析 class, extends, React component, export
- `go_parser.py`: 解析 struct, interface, method receiver
- `bios_parser.py`: 解析 struct/typedef, PROTOCOL_INTERFACE

**新增 `server.py` endpoint**：

```
GET /symbols?job=JID&query=foo&kind=function&limit=50
→ 回傳 fuzzy-matched symbols (支援 camelCase splitting)

GET /symbol-graph?job=JID&sym=sym_0
→ 回傳以目標 symbol 為中心的子圖 (鄰居 symbols + edges)

GET /symbol-refs?job=JID&sym=sym_0
→ 回傳該 symbol 在所有檔案中的出現位置 [{file, line, snippet, context}]
```

#### 1.2 前端 — Symbol-Aware Search

**修改 `viz.js`**：搜尋框增加 symbol 模式

- 輸入時打 `/symbols` endpoint，autocomplete 下拉按 **kind** 分組 (🔵 class / 🟢 function / 🟡 variable / 📁 file)
- 每個結果顯示 `qualified_name` + `file:line`
- 選中後 → 觸發 `activateSymbol(symbolId)`

---

### Phase 2：Symbol-Centric Graph ★★★★★

> **核心目標**：點擊任何 symbol，Graph 以該 symbol 為中心重新繪製。

#### 2.1 前端 — Graph Mode 重構

新增 **L3 Symbol Graph** 層級 (`state.level = 3`)：

```
選中 symbol → fetch /symbol-graph → 渲染 Cytoscape:
  - 中央大節點 = active symbol
  - 左側 = incoming edges (callers, base classes, importers)
  - 右側 = outgoing edges (callees, derived classes, imported)
  - Edge label = edge type (call, import, inherit...)
```

**節點外觀區分**：
- `class` → 矩形 + 可展開 member list
- `function/method` → 圓角矩形
- `file` → 六角形
- `variable` → 菱形
- `namespace/module` → 虛線邊框包圍

**互動**：
- Single click node → activate (成為新的中心，graph 重新佈局)
- Double click class node → toggle expand/collapse members
- Hover edge → tooltip 顯示 edge type + count
- Right click → context menu (Go to definition, Find all references, Show in code)

#### 2.2 Bundled Edges

當兩個節點之間有 N 條同類 edge 時：
- 合併為一條粗邊，標示 `×N`
- Hover → tooltip 列出每條 edge 的來源行
- Click → 展開為 N 條細邊（或 side panel 列表）

**實作方式**：
- `symbol_edges` 回傳時附加 `bundle_key = from+to+type`
- 前端 group by `bundle_key`，如果 count > 1 則 render bundle

---

### Phase 3：Multi-file Code Snippets ★★★★

> **核心目標**：選中 symbol 後，Code View 聚合多個檔案的 snippet。

#### 3.1 後端 — `/symbol-refs` endpoint

回傳格式：
```json
{
  "definitions": [
    { "file": "core/engine.py", "line": 42, "snippet": "class Engine:\n    ...", "context_before": 3, "context_after": 5 }
  ],
  "references": [
    { "file": "api/handler.py", "line": 15, "snippet": "engine = Engine(config)", "context_before": 2, "context_after": 2 },
    { "file": "tests/test_engine.py", "line": 8, "snippet": "e = Engine()", "context_before": 1, "context_after": 1 }
  ]
}
```

#### 3.2 前端 — Code View 改版

- **定義片段** 顯示在最上方（黃色左邊框）
- **引用片段** 按檔案分組，每個可折疊
- 每個 snippet 有 `↗ 開啟完整檔案` 按鈕
- snippet 內的 symbol 可點擊 → 觸發 `activateSymbol()`
- 保留原本的「完整檔案模式」作為 toggle 選項

---

### Phase 4：Class Hierarchy & Node Expansion ★★★

> **核心目標**：在 Graph 中視覺化繼承鏈 + class 成員。

#### 4.1 繼承關係解析

**修改 Parsers**：

- Python: `class Foo(Bar, Baz)` → `inheritance` edges
- JS/TS: `class Foo extends Bar` + `implements Iface` → edges  
- C++: `class Foo : public Bar, protected Baz` → edges
- Go: struct embed → `composition` edge

**Graph 繪製**：
- inheritance edge 用 **空心三角箭頭**（UML 風格）
- base class 在上方，derived 在下方
- 點擊 class → 顯示完整繼承鏈（上下幾層）

#### 4.2 Class Node Expansion

當 graph 中出現 class 節點時：
- 預設收合：只顯示 class 名稱 + member 計數
- 展開後：顯示 methods (🟢 public / 🔴 private) + fields 列表
- 展開的 method 可直接 click → activateSymbol

---

### Phase 5：Overview Dashboard ★★★

> **核心目標**：專案載入後顯示統計與全局視圖。

- Symbol 統計圓餅圖 (classes / functions / files / variables by module)
- 每個模組的 card：檔案數、函式數、複雜度指標
- 「Most connected symbols」top-list
- 點擊任何項目 → 直接進入 Symbol Graph
- 取代目前的 L0 Cytoscape 模組圈圈圖（或共存為 tab）

---

### Phase 6：精緻化 ★★

#### 6.1 全域 Back/Forward

統一所有 view 的 navigation history：
```js
navHistory = [
  { type: 'module', id: 'core' },
  { type: 'file', path: 'core/engine.py' },
  { type: 'symbol', symId: 'sym_0' },
  ...
]
```
按 `Alt+← / Alt+→` 或 toolbar 按鈕切換。

#### 6.2 Graph 動畫過渡

View 切換時 Cytoscape 使用 `animate()` 做節點位移、淡入淡出過渡，而非瞬間跳轉。

#### 6.3 Code View 互動增強

- Code snippet 內的任何 symbol 可 hover 顯示 tooltip (type, file, referece count)
- Click symbol → activateSymbol
- Ctrl+Click → 在新 tab 打開 (if we add tabs)

#### 6.4 Edge Type 篩選

Graph toolbar 增加 edge type filter checkboxes：
`☑ calls ☑ imports ☐ inheritance ☐ type_usage`
切換即時重新篩選 graph edges。

---

## 五、已知 Bugs / Tech Debt

| Bug | 檔案 | 說明 |
|-----|------|------|
| `is_public` 永遠 `false` (Python) | `python_parser.py` | `is_static=True` for all → `is_public = not is_static = False`。Workaround 在 `/structure` 使用全部 funcs |
| Dotted import 解析失敗 | `analyze_viz.py` / parsers | `from core.engine import Engine` → `file_edges_by_module` 空。Strategy B workaround |
| `file_to_module` 可能不存在 | `server.py` | `/structure` endpoint 使用 `graph_data.get('file_to_module', {})`。需確認 `build_graph` 有輸出 |
| Cross-file 箭頭起點不精確 | `struct_view.js` | 箭頭應從 field badge 出發，但落回 box bottom-center。`data-sv-name` DOM selector mismatch |

---

## 六、Integration Points

```
viz.js  ──calls──►  struct_view.js exposed globals:
    svUpdateStructureBtn(fileRel, ext)
    svAfterRenderCode(src, ext, fname)
    svHideStructureBtn()
    svToggleStructView()

struct_view.js  ──calls──►  viz.js globals:
    jumpToFunc(name)
    openCodePanel()
    focusFunc(fileRel, idx)
    drillToFile(fileRel)
    state.level / l2State.activeFile / DATA.*
```

---

## 七、Parser 介面規範

所有 `parsers/*.py` 的 `scan_xxx()` 必須回傳：

```python
return (
    imports_or_refs,      # list[str]
    funcdefs,             # list[dict]: [{label, is_efiapi, is_static}, ...]
    funccalls,            # list[str]
    extra_dict,           # dict | None
    func_calls_by_func,   # list[list[str]]
)
```

Phase 1 後，新增回傳（backward compatible）：

```python
return (
    imports_or_refs,
    funcdefs,
    funccalls,
    extra_dict,
    func_calls_by_func,
    symbol_defs,          # list[dict]: 完整 symbol 定義 [{name, kind, line, end_line, parent, bases, fields, methods}, ...]
)
```

---

## 八、Dev Setup

```bash
# 啟動 server
python vizcode.py /path/to/your/project

# 瀏覽器開 http://localhost:7777
# 前端檔案在 static/ 目錄，修改後 Ctrl+Shift+R 硬重整
# 無 build step
```

---

## 九、檔案清單

```
vizcode.py          CLI launcher + TUI 動畫
server.py           HTTP server (stdlib only)
analyze_viz.py      Graph builder — dispatches to parsers/
parsers/
  bios_parser.py    C/C++/UEFI parser
  python_parser.py  Python parser
  js_parser.py      JS/TS parser
  go_parser.py      Go parser
detector.py         專案類型自動偵測
static/
  viz.js            主前端 (~7600 行)
  viz.css           主 stylesheet (~3000 行)
  struct_view.js    Structure View plugin (~1100 行)
  struct_view.css   Structure View styles
  i18n.js           中英翻譯
  themes.css        主題樣式
launcher.html       Shell HTML (注入 DATA + 載入 scripts)
```