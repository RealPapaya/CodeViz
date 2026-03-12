# VIZCODE V5 — Agent Briefing

> **目標：做到 Sourcetrail 等級的開源程式碼探索器。**
> 本文件是 AI Agent 的快速上手指引 + 階段式實作路線圖。

---

## 一、Sourcetrail 是什麼？我們要對標的功能

Sourcetrail 是一個以 **Symbol 為中心** 的程式碼探索工具，核心 UI 由三個同步面板組成：

| 面板 | Sourcetrail 功能 | CodeViz 現狀 |
|------|-----------------|-------------|
| **Search Bar** | 全文檢索 | ✅ 全文搜尋 `/search` + 串流 `/search-stream`。符合現狀需求。 |
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
| `server.py` | HTTP server。Serve static files，處理 `/file`, `/search`, `/search-stream`, `/analyze`, `/structure`, `/symbol-graph`, `/symbol-refs`, `/symbol-file` API |
| `analyze_viz.py` | 掃描專案、建立 `DATA` (nodes + edges)。Entry: `build_graph(root)` |
| `viz.js` | 主前端邏輯 (~7600 行)。State, Cytoscape graph, code panel |
| `viz.css` | 主 stylesheet |
| `struct_view.js` | Structure View plugin (~2600 行)。獨立 `<script>` 載入 |
| `struct_view.css` | Structure View stylesheet |
| `i18n.js` | 中英雙語翻譯 |
| `launcher.html` | SPA shell，注入 DATA + 載入所有 scripts |
| `parsers/` | 獨立語言解析器: `bios_parser.py`, `python_parser.py`, `js_parser.py`, `go_parser.py` |
| `detector.py` | 專案類型自動偵測 |
| `vizcode.py` | CLI launcher + TUI 動畫 |

### Parser 回傳值規格（統一 6-tuple）

所有 parser 的 entry point 現在均回傳相同格式：

```python
(refs, funcdefs, funccalls, extra_dict, func_calls_by_func, symbol_defs)
# symbol_defs: List[{ kind, name, line, end_line, bases, parent, is_public }]
# kind: 'class' | 'function' | 'method'
```

| Parser | Entry point | symbol_defs 支援 |
|--------|-------------|-----------------|
| `python_parser.py` | `scan_python(src)` | ✅ class / method / function |
| `js_parser.py` | `scan_js(src)` / `scan_ts(src)` | ✅ class / method / function |
| `go_parser.py` | `scan_go(src)` | ✅ struct / interface / method / function |
| `bios_parser.py` | `scan_bios(src, ext)` | ✅ C/C++ class / struct / method / function（本 session 新增） |

---

## 三、與 Sourcetrail 的差距分析 (Gap Analysis)

### ❌ 完全缺失的核心功能

| # | 功能 | 說明 | 狀態 |
|---|------|------|------|
| G1 | **Symbol Index / Database** | Sourcetrail 有 SQLite 索引庫儲存每個 symbol 的 type、定義位置、所有引用位置。CodeViz 只有 `funcs_by_file` 和 `func_edges_by_file` — 沒有統一的 symbol table | ✅ 後端已有 `symbol_index` + `symbol_edges`，`/symbols`、`/symbol-refs`、`/symbol-graph`、`/symbol-file` 端點已實作 |
| G2 | **Symbol-Centric Graph** | 點擊任何 symbol 後，Graph 以該 symbol 為中心重新佈局，顯示所有 incoming/outgoing 關係 | ✅ `svShowSymbol()` + `/symbol-graph` 已實作三欄式符號圖 |
| G3 | **Bundled Edges** | 多條 edge 合併為帶數字的粗邊，click 展開 | ⚠️ Symbol-centric 圖中已有 `×N` bundle 標記；Structure Grid 中尚未實作 |
| G4 | **Multi-file Code Snippets** | 選中 symbol 後，Code View 聚合 N 個檔案中該 symbol 的所有出現位置為 snippet | ✅ `/symbol-refs` 端點已實作 |
| G5 | **Class Hierarchy Visualization** | 繼承鏈 (base → derived) 在 graph 中視覺化 | ⚠️ Structure Grid 中有繼承箭頭；Symbol-centric 圖中尚未用 UML 空心三角 |
| G6 | **Node Expansion (Class Members)** | Graph 中 class 節點可展開顯示 methods + fields | ❌ 尚未實作 |
| G7 | **Symbol-Aware Search** | ⚠️ **已取消**。使用者決定維持現有的全文檢索 | — |

---

## 四、階段式實作路線圖

### Phase 1：Symbol Index 基礎建設 ★★★★★ ✅ 已完成

> **核心目標**：建立統一的 Symbol Table，為所有後續功能打下基礎。

#### 1.1 後端 — Symbol Table 建構 ✅

`analyze_viz.py` 的 `build_graph()` 輸出已包含：

```python
DATA.symbol_index = {
    "sym_0": {
        "id": "sym_0",
        "name": "MyClass",
        "kind": "class",          # class | function | method | variable | module | file | namespace
        "file": "mymodule/submod.py",
        "line": 42,
        "is_public": True,
        "parent": "sym_3",
        "module": "mymodule",
    },
    ...
}

DATA.symbol_edges = [
    { "from": "sym_1", "to": "sym_5", "type": "call" },
    { "from": "sym_0", "to": "sym_8", "type": "inheritance" },
    ...
]
```

#### 1.2 Server API 端點 ✅

| 端點 | 說明 |
|------|------|
| `GET /symbols?job=&q=&kind=&limit=` | Fuzzy 符號搜尋 |
| `GET /symbol-refs?job=&sym=` | 符號的定義 + 所有引用位置（snippet） |
| `GET /symbol-graph?job=&sym=` | 符號中心圖（incoming/outgoing bundled edges） |
| `GET /symbol-file?job=&file=` | **（本 session 新增）** 單一檔案的所有 symbol + intra-file edges |

#### 1.3 C/C++ Parser 補齊 ✅（本 session 完成）

`bios_parser.py` 的 `scan_bios()` / `scan_c()` 現在回傳 **6-tuple**，新增 `symbol_defs`：

- **新增** `_parse_c_symbol_defs(src, clean)` — 解析 class/struct 宣告、C++ 作用域方法 `Foo::Bar()`、`typedef struct`
- **新增** `RE_C_CLASS`、`RE_C_METHOD`、`RE_C_TYPEDEF` 三個 regex
- 非 C/C++ 格式（`.inf`、`.sdl` 等）回傳空 `[]` 作為 `symbol_defs`

---

### Phase 2：Enhanced Grid View (Structure) ★★★★★ 🔄 進行中

> **核心目標**：強化目前的 Structure View，使其成為一個支援「全屏網格（Grid Layout）」與「跨類別連線（SVG Arrows）」的互動圖表，**完全取代舊版的靜態列表**。

> ⚠️ **目標 UI（全屏單一畫面，不使用三欄式佈局）**：
> ```
> [ ArtificialPlayer ]       [ Field         ]             code panel
>  ┌─────────────────┐       ┌──────────────────────┐      ┌──────────────────────────────┐
>  │ 🌐 PUBLIC       │ ──→   │ 🌐 PUBLIC            │      │ 77  int Field::SameInRow(...){│
>  │  [Evaluate]     │       │   [Token]            │      │ 78    int sum = amount*token; │
>  │ 🏠 PRIVATE      │       │ 🏠 PRIVATE           │      │ ...                          │
>  │  [m_name]       │       │  ▶[SameInRow]◀       │      │ 89  if (grid_[0][0]+...)    │
>  └─────────────────┘       └──────────────────────┘      └──────────────────────────────┘
> ```

#### 2.1 已完成（本 session）

**Canvas 獨立 Pan / Zoom**（`struct_view.js`）：
- 移除對 Cytoscape 的 transform 同步（`cy.on('pan zoom', ...)` 已解除）
- 改為獨立狀態 `_sv._panX / _sv._panY / _sv._scale`
- 滾輪縮放：以游標位置為中心，範圍 0.12x ～ 6.0x
- 背景拖曳：空白區域拖曳平移畫布，游標顯示 `grabbing`
- 所有 transform 寫入 `tGroup.style.transform`，`_svMakeCoordMapper()` 座標換算持續正確

**Per-node Drag**（`struct_view.js`）：
- `_svConvertToAbsolute(localArea)` — flex 佈局快照後切換成 `position:absolute`，各 box 維持原視覺位置
- `_svInitNodeDrag(localArea, svg, scroll)` — 每個 class card 可自由拖曳，移動量除以 `_sv._scale` 補償縮放
- 節點移動時立即觸發 `_svRedrawAll()` 重繪箭頭
- 每次 `_svRender()` 前呼叫 `_nodeDragCleanup()` 移除舊的 document 事件監聽器，防止 ghost listener 堆積

**統一重繪入口 `_svRedrawAll(svg, scroll)`**：
- Local arrows（intra-file）同步重繪
- Cross-file arrows 防抖 12ms 重繪
- 由 pan / zoom / node drag 三者共用

**CSS 新增**（`struct_view.css`）：
- `.sv-scroll { cursor: grab }` — 背景平移游標提示
- `.sv-class-hdr { cursor: grab }` — 節點拖曳游標提示
- `.sv-box-dragging` — 拖曳中：z-index 提升 + accent 邊框陰影

#### 2.2 待完成

- **Bundled Edges in Grid** — 兩節點間多條同類 edge 合併為一條粗邊 + `×N` 標籤
- **`/symbol-file` 整合** — struct_view.js 拉取後端 symbol_defs 補充 C/C++ badge（目前純靠前端 regex parse）

---

### Phase 3：Multi-file Code Snippets ★★★★

> **核心目標**：選中 symbol 後，Code View 右側直接跳到/顯示該 member 的函式定義 snippet。

#### 3.1 後端 — `/symbol-refs` endpoint ✅

回傳該 symbol 的定義與引用位置：
```json
{
  "definitions": [{ "file": "path/to/file.cpp", "line": 77, "snippet": "..." }],
  "references": [{ "file": "other/file.cpp", "line": 120, "snippet": "..." }]
}
```

#### 3.2 前端 — Snippet View ❌ 待實作

- **Symbol-aware jump**：點擊 Graph badge 不再只是捲動整個檔案，而是顯示縮減後的 snippet。
- **Context 顯示**：顯示定義前後各 5 行的 context。
- **多檔聚合**：如果該 symbol 在多處被引用，Code Panel 會按檔案顯示多個可摺疊的 snippets。

---

### Phase 4：Class Hierarchy & Node Expansion ★★★

> **核心目標**：在 Graph 中視覺化繼承鏈 + class 成員擴展。

- **繼承連線**：使用 UML 風格的空心三角箭頭表示繼承關係。
- **成員收合**：Class card 預設可以收合，僅顯示類別名稱；點擊展開按鈕後顯示 members。
- **自動展開**：當作為中心節點或被連線引用時，自動展開相關的成員區塊。

---

### Phase 5：Overview Dashboard ★★★

> **核心目標**：專案進入後的數據儀表板。

- **符號統計**：顯示 Class、Function、File 的數量比例。
- **複雜度排行**：列出最長檔案或連線最多的 Symbol。
- **快速跳轉**：點擊 Dashboard 上的熱門 Symbol 直接進入 Structure View。

---

### Phase 6：精緻化 ★★

- **全域 Back/Forward**：實作像瀏覽器一樣的導航歷史。
- **動畫過渡**：節點佈局切換時增加彈性動畫。
- **濾鏡功能**：選單勾選隱藏/顯示特定的連線類型（如隱藏 Import 關係）。

---

## 五、已知 Bugs / Tech Debt

- `is_public` 永遠 `false` (Python parser)。
- Dotted import 解析失敗（`from a.b import c`）。
- ~~視窗 resize 後，Structure View 的跨 class 箭頭位置不會自動重繪。~~ ✅ 已修（ResizeObserver + `_svRedrawAll`）
- Structure Grid 中 `_svConvertToAbsolute` 若在 flex reflow 完成前呼叫，座標快照可能不準確（目前用雙層 `requestAnimationFrame` 緩解，極端情況下仍可能發生）。
- `bios_parser.py` 的 `RE_FUNCDEF` 在 template function（`template<T> void Foo<T>::Bar()`）上無法正確解析 parent。

---

## 六、Session 變更記錄

### 🔧 Session 1：Structure View 單一畫面 + 修正 3-column 規劃
- 更新 `VIZCODE_AGENT_BRIEF.md`：移除 Phase 2 的「三欄式佈局 (incoming/center/outgoing)」需求。
- 確認主題：Structure View 應維持「單一畫面的全檔案 Grid」，僅加強連線與互動。

### 🔧 Session 2：Phase 1 基礎設施補齊 + Phase 2 互動強化（已驗證 ✅）

#### `bios_parser.py`
- **新增** `_parse_c_symbol_defs(src, clean)` 函數
- **新增** 三個 regex：`RE_C_CLASS`、`RE_C_METHOD`、`RE_C_TYPEDEF`
- `scan_c()` 回傳值從 5-tuple 升級為 **6-tuple**（新增 `symbol_defs`）
- `scan_bios()` 所有分支統一回傳 **6-tuple**（非 C/C++ 格式的 `symbol_defs` 為 `[]`）
- 可解析：`class Foo : public Base`、`void Foo::Bar()`、`typedef struct { } TypeName`

#### `server.py`
- **新增** `GET /symbol-file?job=&file=` 端點
  - 回傳指定檔案的所有 `symbol_index` entries
  - 回傳兩端均在該檔案內的 `symbol_edges`（intra-file edges）
  - 供前端 struct_view 強化 C/C++ class card badge

#### `struct_view.js`
- **移除** Cytoscape pan/zoom 同步（`cy.on('pan zoom', ...)` 解除耦合）
- **新增** `_svInitPanZoom(scroll, tGroup, svg)` — 獨立 canvas pan/zoom
- **新增** `_svConvertToAbsolute(localArea)` — flex → absolute 佈局轉換
- **新增** `_svInitNodeDrag(localArea, svg, scroll)` — 每節點自由拖曳
- **新增** `_svRedrawAll(svg, scroll)` — 統一箭頭重繪入口
- **修正** `_svRender()` 每次呼叫前執行 `_nodeDragCleanup()` 防止事件監聽器洩漏

#### `struct_view.css`
- **新增** `.sv-scroll`、`.sv-class-hdr`、`.sv-box-dragging` 的 cursor 與視覺狀態樣式
