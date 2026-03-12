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
| `server.py` | HTTP server。Serve static files，處理 `/file`, `/search`, `/search-stream`, `/analyze`, `/structure` API |
| `analyze_viz.py` | 掃描專案、建立 `DATA` (nodes + edges)。Entry: `build_graph(root)` |
| `viz.js` | 主前端邏輯 (~7600 行)。State, Cytoscape graph, code panel |
| `viz.css` | 主 stylesheet |
| `struct_view.js` | Structure View plugin (~2300 行)。獨立 `<script>` 載入 |
| `struct_view.css` | Structure View stylesheet |
| `i18n.js` | 中英雙語翻譯 |
| `launcher.html` | SPA shell，注入 DATA + 載入所有 scripts |
| `parsers/` | 獨立語言解析器: `bios_parser.py`, `python_parser.py`, `js_parser.py`, `go_parser.py` |
| `detector.py` | 專案類型自動偵測 |
| `vizcode.py` | CLI launcher + TUI 動畫 |

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
| G7 | **Symbol-Aware Search** | ⚠️ **已取消**。使用者決定維持現有的全文檢索，不需要針對 Symbol 類型做過濾或預覽。 |

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
        "kind": "class",          # class | function | method | variable | module | file | namespace
        "file": "mymodule/submod.py",
        "line": 42,
        "is_public": True,
        "parent": "sym_3",        
    },
    ...
}

DATA.symbol_edges = [
    { "from": "sym_1", "to": "sym_5", "type": "call" },
    { "from": "sym_0", "to": "sym_8", "type": "inheritance" },
    ...
]
```

**新增 `server.py` endpoint**：
- `GET /symbol-graph` (子圖，供 Structure View 連線使用)
- `GET /symbol-refs` (代碼片段，供 Phase 3 使用)

---

### Phase 2：Enhanced Grid View (Structure) ★★★★★

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

#### 2.1 前端 — 互動式全檔案 Grid
在一進入 Structure 面板（`#sv-view`）時，立刻顯示該檔案的所有 Class/Struct。**取消原本規劃的「左中右三欄式」導航**，改為：
- **全視圖佈局**：使用固定 Grid 或 `dagre` 佈局，一次呈現檔案內所有類別。
- **SVG/Spline Edges**：橘色 Bezier spline 曲線；edge 從具體的 member badge 出發，連到目標 member badge。
- **不需要 Pivot 模式**：使用者決定只需一個畫面，不需要像 Sourcetrail 那樣點擊後切換「中心點」子圖。

**節點外觀**：
- Class card = 帶圓角的白底矩形，內部區分 `🌐 PUBLIC` 與 `🏠 PRIVATE` 區塊。
- **Active member badge** 高亮顯示。

#### 2.2 Bundled Edges
當兩個節點之間有 N 條同類 edge 時，合併為一條粗邊，標示 `×N`。

---

### Phase 3：Multi-file Code Snippets ★★★★

> **核心目標**：選中 symbol 後，Code View 右側直接跳到/顯示該 member 的函式定義 snippet。

#### 3.1 後端 — `/symbol-refs` endpoint
回傳該 symbol 的定義與引用位置：
```json
{
  "definitions": [{ "file": "path/to/file.cpp", "line": 77, "snippet": "..." }],
  "references": [{ "file": "other/file.cpp", "line": 120, "snippet": "..." }]
}
```

#### 3.2 前端 — Snippet View
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

- `is_public` 永遠 `false` (Python)。
- Dotted import 解析失敗（`from a.b import c`）。
- 視窗 resize 後，Structure View 的跨 class 箭頭位置不會自動重繪。

---

## 六、本 Session 變更記錄

### 🔧 Session：Structure View 單一畫面 + 修正 3-column 規劃
- 更新 `VIZCODE_AGENT_BRIEF.md`：移除 Phase 2 的「三欄式佈局 (incoming/center/outgoing)」需求。
- 確認主題：Structure View 應維持「單一畫面的全檔案 Grid」，僅加強連線與互動。
