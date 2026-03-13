# VIZCODE V5 — Agent Briefing（Sourcetrail 移植版）

> **目標：直接移植 Sourcetrail 的 UI 邏輯，使 CodeViz 的 Structure 功能與 Sourcetrail 完全一致。**
> 不是「重新詮釋」，而是把 `Sourcetrail-master/` 的渲染邏輯、佈局算法、節點結構翻譯成 JS。

---

## 一、系統概覽

- **啟動方式**：`launch.bat` → `vizcode.py` → `server.py` → 瀏覽器 `http://localhost:7777`
- **零外部依賴**：Python stdlib only；前端僅用 `launcher.html` 已載入的函式庫
- **核心特色**：多語言 Parser (Python/JS/TS/Go/C/C++/BIOS)、Symbol Index、Symbol-Centric Graph

---

## 二、檔案清單

### 後端
| 檔案 | 角色 |
|------|------|
| `vizcode.py` | CLI launcher + TUI 動畫 |
| `server.py` | HTTP server (port 7777)，所有 API endpoints |
| `analyze_viz.py` | 核心引擎：`build_graph(root)` 產出 DATA JSON；`build_html()` 載入並內嵌所有靜態資產 |
| `detector.py` | 專案類型自動偵測 |
| `parsers/bios_parser.py` | C/C++/UEFI/EDK2 parser |
| `parsers/python_parser.py` | Python parser |
| `parsers/js_parser.py` | JS/TS/JSX/TSX parser |
| `parsers/go_parser.py` | Go parser |

### 前端（`static/`）— 全部由 `analyze_viz.py` 的 `build_html()` 內嵌至 HTML
| 檔案 | 角色 |
|------|------|
| `viz.js` | 主前端 (~7600 行)。L0/L1/L2 Cytoscape 圖、code panel、所有互動邏輯 |
| `viz.css` | 主 stylesheet |
| `struct_view.js` | Structure View plugin（class-grid + SVG 箭頭）|
| `struct_view.css` | Structure View styles |
| `symbol_view.js` | **Sourcetrail 風格的 Symbol-Centric Graph**（Phase 1–3+）|
| `symbol_view.css` | Symbol View styles |
| `trail_layouter.js` | **Sugiyama layout engine**（Phase 3）— 移植自 Sourcetrail `TrailLayouter.cpp` |
| `i18n.js` | 中英雙語翻譯 |
| `themes.css` | 主題樣式 |
| `launcher.html` | SPA shell（server 直接 serve，非 build_html 產出）|

> **載入順序**（`build_html()` 的 `js_assets` list）：
> `i18n.js` → `viz.js` → `struct_view.js` → `trail_layouter.js` → `symbol_view.js`

---

## 三、已完成的 Phase

### Phase 1：Symbol Index ✅

`analyze_viz.py` 的 `build_graph()` 輸出：

```python
DATA.symbol_index = {
    "sym_0": {
        "id": "sym_0", "name": "MyClass", "kind": "class",
        "file": "path/to/file.py", "line": 42,
        "is_public": True, "parent": None, "children": ["sym_1", "sym_2"],
        "module": "module_id",
    },
    "sym_1": {
        "id": "sym_1", "name": "do_work", "kind": "method",
        "file": "path/to/file.py", "line": 55, "parent": "sym_0",
    },
}

DATA.symbol_edges = [
    { "from": "sym_1", "to": "sym_5",  "type": "call" },
    { "from": "sym_0", "to": "sym_8",  "type": "inheritance" },
    { "from": "sym_1", "to": "sym_12", "type": "type_usage" },
    { "from": "sym_0", "to": "sym_20", "type": "import" },
]
# Edge types: call, inheritance, type_usage, import, override, file_include, member
```

所有 4 個 parser 回傳 **6-tuple**（含 `symbol_defs`）。

Server endpoints（Phase 1 新增）：
- `GET /symbols?job=JID&query=...&kind=...` — fuzzy symbol 搜尋
- `GET /symbol-graph?job=JID&sym=SID` — 以 SID 為中心的子圖
- `GET /symbol-refs?job=JID&sym=SID` — 該 symbol 的所有引用位置

### Phase 2：基礎 Symbol-Centric Graph ✅

`symbol_view.js` 入口點：
- `symViewOpen(fileRel)` — 找到檔案內最重要的 symbol 開啟
- `symViewActivate(symId)` — 導航到指定 symbol
- `symViewClose()` — 關閉，恢復 `#cy`

`viz.js` 在 Structure 按鈕點擊時：若 `DATA.symbol_index` 存在則呼叫 `symViewOpen()`，否則 fallback 到 `svToggleStructView()`。

已實作功能：Cytoscape dagre LR、center node、incoming/outgoing 鄰居節點、Back 導航歷史、symbol search 欄、code panel 整合（click center → `loadFileInPanel`）。

### Phase 3：Compound Class Card Nodes + TrailLayouter ✅

**Compound Class Card Nodes（`symbol_view.js`）**：
- Class/struct 節點改為 Cytoscape **compound node**，內部分 PUBLIC / PRIVATE 兩個 section
- 每個 member（method/field）是 section 內的子節點（120×24px badge）
- Center class 展開所有 members；neighbor class 只展開與本圖有邊的 members
- 點擊 member badge → code panel 跳到該行（`loadFileInPanel + jumpToLine`）
- 移除左側 sidebar（`#sym-member-panel`）

**TrailLayouter（`trail_layouter.js`）**：
- 移植自 Sourcetrail `TrailLayouter.cpp` 的 Sugiyama 佈局算法
- API：`TrailLayouter.layout(nodes, edges, options) → {id: {x, y}}`
- 8 個 stage：buildGraph → makeAcyclic → assignLevels → assignRemainingLevels → insertVirtualNodes → buildColumns → reduceCrossings → computePositions
- 取代 dagre，用於 class-level 節點的位置計算

---

## 四、Sourcetrail 功能對照表

| # | Sourcetrail 功能 | CodeViz 狀態 |
|---|-----------------|-------------|
| S1 | Symbol Index（統一 symbol table） | ✅ Phase 1 完成 |
| S2 | Symbol-Centric Graph（以 symbol 為中心重新佈局） | ✅ Phase 2 完成 |
| S3 | Compound Class Card（PUBLIC/PRIVATE section 在節點內） | ✅ Phase 3 完成 |
| S4 | Sugiyama Layout Engine（TrailLayouter 移植） | ✅ Phase 3 完成 |
| S5 | Bundled Edges（多條同類 edge 合併為帶數字的粗邊） | ✅ Phase 4 完成 |
| S6 | Multi-file Code Snippets（右側 Code View 顯示跨檔案片段） | ✅ Phase 5 完成 |
| S7 | Node Expand/Collapse（class 節點可折疊，顯示 hidden count） | ✅ Phase 6 完成 |
| S8 | Edge Type Filtering（toggle 隱藏/顯示特定 edge 類型） | ✅ Phase 7 完成 |
| S9 | Back/Forward 全域導航 + 動畫過渡 | ✅ Phase 8 完成 |
| S10 | 21+ Node Types（NAMESPACE, ENUM_CONSTANT, TYPEDEF, MACRO, ...） | ✅ Phase 9 完成（struct/interface/enum/typedef 全部區分） |
| S11 | Template/Generic 關係（TYPE_ARGUMENT, SPECIALIZATION） | ❌ 未實作 |

---

### Phase 9：擴充 Node Types ✅

已實作：
- `go_parser.py`：Go struct → kind `'struct'`，Go interface → kind `'interface'`
- `bios_parser.py`：`typedef struct` → kind `'typedef'`；新增 `RE_C_ENUM` / `RE_C_ENUM_TYPEDEF` → kind `'enum'`
- `js_parser.py`：新增 `RE_TS_INTERFACE` / `RE_TS_ENUM` / `RE_TS_TYPE` → kind `'interface'` / `'enum'` / `'typedef'`
- `symbol_view.js`：`_symNodesForSym` 中 `isCard` 條件擴充為 `['class','struct','interface','enum']`；`kindPriority` 更新；`isClassHdr` header node 對非 class 種類加入 `«stereotype»` 前綴（`«interface»`, `«struct»`, `«enum»`, `«type»`）；header node 改用 `height: label` 自動高度
- `symbol_view.css`：新增 `.kind-interface` (綠)、`.kind-typedef` (粉)、`.kind-enum_constant` (橘半透明)

---

## 五、接下來的 Phase 路線圖

### Phase 4：Bundled Edges ✅

已實作：
- edge `lineWidth = min(1.5 + log2(count), 6)px`，count=1 時 1.5px
- edge label 顯示 `×N`
- 點擊 edge → fixed-position tooltip 顯示 edgeType（帶顏色）+ ×N
- 節點不可拖曳：`cy.nodes().ungrabify()`（Sourcetrail 行為）

### Phase 5：Multi-file Code Snippets ✅

已實作：
- member badge click → fetch `/symbol-refs` → `#sym-snippet-panel`（`#sym-body` 右側 360px 固定欄）
- Definition snippets 黃色左邊框；Reference snippets 灰色左邊框
- 行號 + context（前後 3 行）+ 高亮目標行（`item.highlight` 0-based offset）
- 點擊 file label → 呼叫 viz.js `loadFileInPanel + jumpToLine`（完整檔案模式）
- 導航到新 symbol 時自動關閉 snippet panel（`_symCloseSnippets()`）
- Edge curve style 改為 `taxi`（正交折線，更接近 Sourcetrail 視覺）

### Phase 6：Node Expand/Collapse ✅

已實作：
- 每個 class card 右上角有 `isToggle: true` 小按鈕（▼ 展開 / ▲ 折疊）
- 收疊整個 class（public + private 一起），折疊後 card 只顯示 class 名稱 + 按鈕
- 點擊 toggle → `_sym.collapsed` Set（以 nodeId 為 key）→ 重繪（`_symFetchAndRender`）
- 折疊時成員 badge 完全不加入 elements，class card 自動縮小
- 導航到新 symbol 時自動 reset collapsed state（`_sym.collapsed.clear()`）

### Phase 7：Edge Type Filtering ✅

已實作：
- Toolbar 中央加入 edge type filter pills（call / inheritance / import / type_usage / include / override / member）
- 每個 pill 有對應顏色圓點（同 `_SYM_EDGE_COLORS`）
- 點擊 pill → toggle `_sym.hiddenEdgeTypes` Set → `edge.style('display', 'none'/'element')`
- Filter state 在導航時**保留**（不 reset）；re-render 後自動重新套用（`_symApplyEdgeFilters()`）
- 關閉的 pill 顯示 dashed border + 降低 opacity

### Phase 8：全域 Back/Forward + 動畫 ✅

已實作：
- `_sym.future` stack 補完雙向導航（Back pop history → future；Forward pop future → history）
- Toolbar 新增 `↪ Back` + `↩ Forward` 兩顆按鈕（disabled 自動更新）
- 從 history 導航（`_fromHistory=true`）時不清除 future stack
- 每次 render 後呼叫 `cy.animate({ fit }, { duration: 280, easing: 'ease-out-cubic' })` 做 zoom-to-fit 動畫

---

## 六、關鍵全域狀態

```js
window.DATA            // 完整 graph payload（server 注入 HTML）
  .symbol_index        // { symId: { id, name, kind, file, line, is_public, parent, children, module } }
  .symbol_edges        // [ { from, to, type }, ... ]
  .funcs_by_file       // { "rel/path.py": [ { label, is_public, is_efiapi }, ... ] }
  .func_edges_by_file  // { "rel/path.py": [ { s: callerIdx, t: calleeIdx }, ... ] }
  .files_by_module     // { modId: [ { id, path, label, ext, file_type, func_count }, ... ] }

// symbol_view.js internal state
const _sym = {
    active:  null,   // current center symbol id
    history: [],     // navigation stack [symId, ...]
    cy:      null,   // Cytoscape instance inside #sym-cy
    jobId:   null,
    ready:   false,
};

state          // viz.js: { level, activeModule, activeFile, ... }
l2State        // viz.js: { activeFile, activeFuncIdx, ... }
codeState      // viz.js: { currentFile, funcLineMap, funcList, rawLines, isOpen }
```

---

## 七、Symbol View 架構（Phase 3 後）

### DOM 結構
```
#sym-view (position: absolute; inset: 0; display: none → .active = display: flex)
  #sym-toolbar
    #sym-back-btn
    #sym-breadcrumb
    #sym-search-wrapper
      #sym-search-input
      #sym-search-results
    #sym-close-btn
  #sym-body (flex-row)
    #sym-cy (flex: 1)  ← Cytoscape canvas，compound nodes 在這裡渲染
```

### Cytoscape 節點層次（class 的 compound node）

```
node { id: "sym_0", isClassCard: true }          ← class compound（dagre 定位）
  node { id: "sym_0__public",  isGroup: true }   ← PUBLIC section
    node { id: "sym_1", line: 55 }               ← method badge（120×24px）
    node { id: "sym_2", line: 60 }
  node { id: "sym_0__private", isGroup: true }   ← PRIVATE section
    node { id: "sym_3", line: 70 }
```

### TrailLayouter API
```js
// trail_layouter.js
TrailLayouter.layout(
    nodes,   // [{id, width, height}]
    edges,   // [{source, target}]
    options  // { rankDir: 'LR'|'TB', rankSep: 200, nodeSep: 80 }
) → { symId: {x, y}, ... }
```

### 跨模組呼叫介面

```
viz.js  ──calls──►  symbol_view.js:
    symViewOpen(fileRel)
    symViewActivate(symId)
    symViewClose()

symbol_view.js  ──calls──►  viz.js:
    loadFileInPanel(filePath, funcName)
    jumpToLine(lineNo)
    codeState.currentFile
    DATA.symbol_index
    JOB_ID
```

---

## 八、Server API Endpoints

| Endpoint | 說明 |
|----------|------|
| `POST /analyze` | 開始分析，SSE 回傳 job_id |
| `GET /progress?job=JID` | 分析進度串流（SSE） |
| `GET /result?job=JID` | 完整分析結果 JSON |
| `GET /file?path=...` | 讀取原始碼檔案 |
| `GET /search?job=JID&q=...` | 全文搜尋 |
| `GET /search-stream?job=JID&q=...` | 串流搜尋（SSE） |
| `GET /structure?job=JID&file=...` | 檔案結構（供 struct_view.js） |
| `GET /symbol-graph?job=JID&sym=SID` | Symbol-centric 子圖 |
| `GET /symbol-refs?job=JID&sym=SID` | Symbol 引用位置 |
| `GET /symbols?job=JID&query=...&kind=...` | Fuzzy symbol 搜尋 |

`/symbol-graph` 回應格式：
```json
{
  "center":   { "id", "name", "kind", "file", "line", "is_public", "module",
                "children": [{ "id", "name", "kind", "line", "end_line",
                               "is_public", "access_level" }] },
  "incoming": [{ "sym": {...}, "edge_type": "call|inheritance|...", "count": N }],
  "outgoing": [{ "sym": {...}, "edge_type": "...", "count": N }],
  "total_in":  N,
  "total_out": N
}
```

---

## 九、Parser 介面規範

所有 `parsers/*.py` 的 `scan_xxx()` 回傳 **6-tuple**：

```python
return (
    imports_or_refs,      # list[str]
    funcdefs,             # list[dict]: [{label, is_efiapi, is_static}, ...]
    funccalls,            # list[str]
    extra_dict,           # dict | None
    func_calls_by_func,   # list[list[str]]
    symbol_defs,          # list[dict]: [{name, kind, line, end_line, parent, bases,
                          #               is_public}, ...]
                          # kind: 'class'|'method'|'function'|'field'|'struct'|'enum'
)
```

---

## 十、已知 Tech Debt

| 問題 | 檔案 | 說明 |
|------|------|------|
| `is_public` 永遠 false (Python) | `python_parser.py` | `is_static=True` for all → `is_public = False` |
| Dotted import 解析失敗 | `analyze_viz.py` / parsers | `from core.engine import Engine` → `file_edges_by_module` 空 |
| Structure View arrows 不重繪 | `struct_view.js` | resize 後箭頭位置不更新，無 ResizeObserver |
| symbol_view compound sizing | `symbol_view.js` | Cytoscape compound 可能自動 expand；需 `compound-sizing-wrt-labels: exclude` |
| TrailLayouter 大圖 stack overflow | `trail_layouter.js` | DFS 若用 recursive 會 overflow；應用 iterative stack |

---

## 十一、Sourcetrail 參考資料

| 參考目標 | Sourcetrail 檔案 |
|----------|----------------|
| 佈局算法 | `src/lib/component/controller/helper/TrailLayouter.cpp` |
| Edge type 定義 | `src/lib/data/graph/Edge.h` |
| Node type 定義 | `src/lib/data/NodeKind.h` |
| Graph 渲染 | `src/lib_gui/qt/graphics/graph/` |
| Access level | `src/lib/data/AccessKind.h` |
| DummyNode（佈局資料結構）| `src/lib/component/controller/helper/DummyNode.h` |
