# BRAIN.md — Project Memory
> Auto-managed by AI Agent | Last updated: 2026-03-02 (v2 update)
> ⚠️ Read this at the start of EVERY session. Do not skip.

---

## 🧠 Project State

**Status**: `V1 SHIPPED ✅ — V2 architecture designed, ready to build`

**V1 what exists**:
- `analyze_bios.py` — Python static analyzer (working)
- Output: single HTML with D3.js force-directed graph
- Features: file dep view, call graph view, module filter, search, zoom
- **User confirmed working on real BIOS codebase** ✅

**V1 Critical Problems** (must fix in v2):
- 🔴 **5,000 files → 1GB+ RAM, severe lag** — D3 DOM rendering collapses
- 🔴 D3 force layout freezes at 800+ nodes
- 🟡 ASM files (.asm .s .S) not shown at all
- 🟡 No right-click context menu
- 🟡 No Sourcetrail-style compound node cards
- 🟡 No drill-down navigation

---

## 🚨 PERFORMANCE CRISIS — Root Cause & V2 Solution

### Why V1 uses 1GB RAM
D3.js SVG = one DOM element per node AND per edge.
5,000 files + 30,000 edges = **35,000 DOM nodes**.
Each DOM node = ~30KB RAM (event listeners + style + layout).
35,000 × 30KB = **~1GB RAM** before simulation even starts.

### V2 Mandatory Architecture: Hierarchical Drill-Down + Canvas

```
PYTHON OUTPUT (hierarchical, 3 levels)
├── Level 0: module_graph     (~20–50 nodes)   ← always in memory
├── Level 1: files_by_module  (~100–300/module) ← loaded on drill-in
└── Level 2: funcs_by_file    (~5–50/file)      ← loaded on drill-in

HTML RENDERER (cytoscape.js CANVAS mode)
├── Default view: Level 0 (modules) — always fast
├── Click module → Level 1 (files in that module)
└── Click file   → Level 2 (Sourcetrail-style function card)

MAX VISIBLE NODES AT ANY TIME: 200
TARGET RAM: < 50MB at any zoom level
```

### V2 Performance Rules (NEVER violate)
1. **Canvas renderer only** — cytoscape.js default canvas, NEVER SVG
2. **Max 200 visible nodes** at any time — hard limit enforced in JS
3. **Lazy loading** — Level 1 and Level 2 data loaded only on user interaction
4. **No D3.js in v2** — remove entirely, use cytoscape.js only
5. **Viewport culling** — cytoscape handles this automatically in canvas mode
6. **JSON pre-clustered by Python** — never cluster in browser at runtime

---

## 🎨 Visual Style Specs

### V1 Current Style (confirmed working, user saw this)
- Dark bg: `#050a0f`, accent: `#00d4ff` (cyan)
- Nodes: filled circles colored by module
- D3 force layout, labels as SVG text
- Top bar: BIOSVIZ logo, tab buttons, stats counters
- Left sidebar: module list with color dots
- Bottom panel: caller/callee chip list on node click

### V2 Target Style: Dark Sourcetrail (new)
**Reference**: Sourcetrail graph view adapted to dark theme

#### Level 0 — Module Overview
- Large rounded rectangle per module
- Header strip with module name + icon
- Member count badges (files: N, funcs: N)
- Thick curved edges between modules, weight = dependency count
- Color border per module (existing palette)

#### Level 1 — File Drill-In (Sourcetrail card style)
- Selected module expands into file cards
- Each file = compact card with:
  - File name as header
  - Extension badge (.c / .h / .asm)
  - Size and function count
- Cards arranged in dagre hierarchical layout
- Edges = #include relationships with arrows

#### Level 2 — Function View (Sourcetrail exact style)
```
[Caller A] ──────────────────────────────┐
[Caller B] ──→  [SELECTED FUNCTION CARD] ──→ [Callee X]
[Caller C] ──────────────────────────────┘    [Callee Y]
                                               [Callee Z]
```
- Central card: function name, file path, signature
- Card sections: PUBLIC / PRIVATE access level strips
- Each related symbol = colored pill chip
  - Blue pill = regular function call
  - Yellow pill = EFIAPI exported function
  - Gray pill = static/internal function
- Edges: red for private access, gray for public
- Callers fan LEFT, callees fan RIGHT
- Reference count badge on each side node
- Bezier curves connecting everything

---

## 📐 Architecture Decisions

| Decision | Rationale |
|---------|-----------|
| Static analysis only | WDK/AMI cl.exe can't be intercepted by Bear on Windows |
| Single HTML output | No install, no server, works offline, sharable |
| Canvas renderer (cytoscape) | D3 SVG = 1GB RAM at 5k files. Canvas = <50MB |
| Hierarchical 3-level drill-down | Can't show 5k nodes at once; Sourcetrail approach |
| Max 200 visible nodes | Hard limit prevents memory death |
| Color by top-level module folder | Matches ASUS AMI directory conventions |
| Skip ASM in call graph | Too complex; show as file nodes only |
| Filter Build/, .git/, Conf/ | Generated/config, not source code |

---

## 🗂️ Module Color Map
- AmiPkg → `#00d4ff`
- AsusModulePkg → `#00ff9f`
- AsusProjectPkg → `#ff6b35`
- AmiChipsetPkg → `#ffd700`
- Others → PALETTE array in order

---

## 📊 Real Data Scale (user-confirmed)
| Metric | V1 actual | V2 target |
|--------|-----------|-----------|
| Files | ~5,000 | Same |
| File deps | ~30,000 | Same |
| Functions | ~10,000–15,000 | Same |
| Call edges | ~50,000–80,000 | Same |
| **RAM usage** | **1GB+ 🔴** | **< 50MB 🟢** |
| **Max visible nodes** | 5,000 🔴 | 200 🟢 |

---

## 🔧 Key Implementation Details

### V2 Python Output Schema (NEW — breaking change from v1)
```python
{
  # Level 0: always loaded (~20-50 items)
  "modules": [
    {"id": "AmiPkg", "label": "AmiPkg", "color": "#00d4ff",
     "file_count": 342, "func_count": 1823}
  ],
  "module_edges": [
    {"s": "AmiPkg", "t": "AsusModulePkg", "weight": 45}
  ],

  # Level 1: lazy — only load when module is clicked
  "files_by_module": {
    "AmiPkg": [
      {"id": 0, "label": "Main.c", "path": "AmiPkg/Core/Main.c",
       "ext": ".c", "size": 12345, "func_count": 12}
    ]
  },
  "file_edges_by_module": {
    "AmiPkg": [{"s": 0, "t": 5}]
  },

  # Level 2: lazy — only load when file is clicked
  "funcs_by_file": {
    "AmiPkg/Core/Main.c": [
      {"id": 0, "label": "AmiEntryPoint", "is_public": true,
       "is_efiapi": false, "caller_count": 3, "callee_count": 7}
    ]
  },
  "func_edges_by_file": {
    "AmiPkg/Core/Main.c": [
      {"s": 0, "t": 3, "cross_file": true, "is_private": false}
    ]
  },

  "stats": {
    "files": 5000, "modules": 23,
    "functions": 12000, "calls": 60000, "root": "D:/Code/ADL/..."
  }
}
```

### Python Regex (unchanged)
```python
RE_INCLUDE  = re.compile(r'#\s*include\s+["<]([^">]+)[">]')
RE_FUNCDEF  = re.compile(r'^[\w\s\*]+\b(\w+)\s*\([^)]*\)\s*(?:\/\/[^\n]*)?\s*\{', re.MULTILINE)
RE_FUNCCALL = re.compile(r'\b([A-Za-z_]\w+)\s*\(')
```

### CDN for V2
```
cytoscape: https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js
dagre:     https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js
cy-dagre:  https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.js
❌ d3.js — REMOVE ENTIRELY from v2
```

---

## ✅ Completed Work Log

| Date | What |
|------|------|
| 2026-03-02 | Initial design, researched tools |
| 2026-03-02 | Built analyze_bios.py v1 (D3.js) |
| 2026-03-02 | Created full agent toolkit |
| 2026-03-02 | **User tested v1 on real 5k-file codebase — 1GB RAM confirmed** |
| 2026-03-02 | User shared Sourcetrail screenshot as v2 visual target |
| 2026-03-02 | V2 architecture designed: canvas + hierarchical drill-down |
| 2026-03-02 | BRAIN.md updated with full v2 spec |

---

## ⚠️ Gotchas & Lessons Learned

1. `-Rebuild` is NOT a GNU Make flag — it's AMI mk.bat custom arg
2. WDK compiler at `d:\bios\AmiEfiTools\WDK_7600_16385_AMD64` — not in PATH
3. Use system Python 3.11, not AMI Python 3.8
4. `.veb` = AMI binary SDL — never parse
5. `Build/` = generated artifacts — always skip
6. **D3 SVG = memory death at 5k+ files** — NEVER use for main graph
7. Cytoscape canvas mode is its default — don't override to SVG renderer
8. The `is_efiapi` flag needs detecting `EFIAPI` keyword before function name

---

## 🔮 V2 Build Agenda (next session)

```
Step 1: Rewrite analyze_bios.py — hierarchical JSON output
Step 2: Rewrite HTML_TEMPLATE — cytoscape.js canvas, 3-level nav
Step 3: Level 0 (module view) — cola layout, colored module cards
Step 4: Level 1 (file drill-in) — dagre layout, file cards
Step 5: Level 2 (function view) — Sourcetrail-style compound cards
Step 6: Add ASM nodes to Level 1
Step 7: Right-click context menu
Step 8: Performance test on 5k-file codebase — confirm < 50MB RAM
```
