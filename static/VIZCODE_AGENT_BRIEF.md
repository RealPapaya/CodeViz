# VIZCODE V4 — Agent Briefing

This document is the fast-onboarding brief for the next AI agent working on VIZCODE.
Read this first before touching any file.

---

## What Is VIZCODE?

A local-server code visualization tool. The user runs `python vizcode.py` which starts
`server.py` on port 7777 and opens a browser. The browser renders an interactive
dependency/call-graph. Key files:

| File | Role |
|------|------|
| `server.py` | HTTP server. Serves static files, handles `/file`, `/search`, `/analyze`, `/structure` API |
| `analyze_viz.py` | Walks the project, builds `DATA` (nodes + edges). Entry: `build_graph(root)` |
| `viz.js` | Main frontend logic (~7600 lines). State, Cytoscape graph, code panel |
| `viz.css` | Main stylesheet |
| `struct_view.js` | Structure View plugin (~1100 lines). Loaded as a separate `<script>` |
| `struct_view.css` | Structure View stylesheet. Loaded as a separate `<link>` |

---

## Architecture at a Glance

```
browser
  ├─ #graph-wrap                    ← main container
  │    ├─ #cy                       ← Cytoscape canvas (hidden in L2 / sv-view)
  │    ├─ #func-view                ← L2 call-graph overlay (3-column Callers | Func | Callees)
  │    └─ #sv-view                  ← Structure View overlay (added in v2)
  ├─ #code-panel                    ← resizable right-hand source panel
  └─ breadcrumb toolbar             ← Back / ⬡ Call Graph / 🏗 Structure buttons
```

### Navigation levels

- **L0** — module overview (Cytoscape, `state.level = 0`)
- **L1** — file dependency map (`state.level = 1`, `state.activeModule`)
- **L2** — function call-flow (`state.level = 2`, `state.activeFile`, `l2State`)
- **sv-view** — Structure View overlay; can be opened at L1 or L2, hides `#cy` like `#func-view` does

---

## Key Global State Objects

```js
window.DATA            // full graph payload injected by server into the HTML
  .funcs_by_file       // { "rel/path.py": [ { label, is_public, is_efiapi }, ... ] }
  .func_edges_by_file  // { "rel/path.py": [ { s: callerIdx, t: calleeIdx }, ... ] }
  .files_by_module     // { modId: [ { id, path, label, ext, file_type, func_count }, ... ] }

state          // { level, activeModule, activeFile, ... }
l2State        // { activeFile, activeFuncIdx, ... }
codeState      // { currentFile, funcLineMap, funcList, rawLines, isOpen, ... }
               //   funcLineMap[funcName] = 0-based line index (populated by renderCode())
_sv            // struct_view.js internal state (window._sv)
  ._fileRel    // rel path of currently rendered file
  ._src        // raw source text
  ._ext        // e.g. ".py"
  ._fname      // filename
  .active      // true when sv-view is showing
  .classes     // last parsed class list
  ._renderToken // increments on each render to cancel stale async fetches
```

---

## Important viz.js Functions

```js
drillToFile(fileRel)              // navigate to L2 for a file (sets state.level = 2)
focusFunc(fileRel, idx)           // show func-view for funcs_by_file[fileRel][idx]
showFuncView(fileRel, funcs, edges, centerIdx)  // renders 3-col callers/callees UI
jumpToFunc(funcName)              // scrolls code panel to function definition
loadFileInPanel(filePath, funcName)  // fetch + render a file in the code panel
openCodePanel() / closeCodePanel()
renderCode(src, ext, fname, langHint)  // renders syntax-highlighted code
```

## Important struct_view.js Functions

```js
window.svUpdateStructureBtn(fileRel, ext)  // called by viz.js when file is selected
window.svAfterRenderCode(src, ext, fname)  // called by viz.js after renderCode()
window.svShowSvView()                      // show sv-view (hides cy)
window.svHideSvView()                      // hide sv-view (restores cy)
window.svToggleStructView()                // button click handler

// Internal
_svRender(src, ext, fname)        // top-level renderer — parses + builds the grid
_svParseClasses(src, ext)         // dispatches to _parsePython / _parseCpp / etc.
_svShowFocusPanel(name, line, ci) // shows inline Callers/Callees panel
_svHideFocusPanel(immediate?)
_svHighlightBadgeByName(name)
_svFetchAndApplyCrossFile(token, classes, svg, scroll, grid)  // async, fetches /structure
_svApplyCrossFileData(crossData, classes, svg, scroll, grid)  // renders ghost boxes + arrows
_svDrawArrows(classes, svg, scroll)  // draws local class-to-class arrows
```

---

## What Was Implemented — Session 3 (Gap #1: Cross-file Arrows)

### What works ✅

**`server.py` — new `/structure` endpoint**

`GET /structure?job=JID&file=rel/path.py` returns:
```json
{
  "funcs": [...],
  "func_edges": [...],
  "imports":     [{ id, path, label, ext, edge_type, ... }],
  "imported_by": [{ id, path, label, ext, edge_type, ... }],
  "class_map":   { "ClassName": { path, label, edge_type, direction } }
}
```

**Neighbour discovery — two strategies:**
- **Strategy A**: pre-computed `file_edges_by_module` (works when Python dotted imports resolve)
- **Strategy B**: cross-reference `func_calls_by_file[rel]` vs `funcs_by_file[other]` — counts how many function names in this file match functions defined in each other file. Accepts a neighbour only if `count >= MIN_CALLS` (default 2). **This is the main strategy for Python projects** because dotted imports (`from core.engine import Engine`) often fail to resolve in Strategy A.

**Anti-false-positive filters:**
- `is_public` fallback: Python parser marks all functions `is_public=False` (known `is_static` bug in `python_parser.py`). If a file has zero public funcs, the endpoint uses ALL its funcs instead.
- Same-module filter: only files in the **same top-level module** as the current file are considered (uses `file_to_module` map). This prevents VIZCODE's own static files (`viz.js`, `analyze_viz.py`) from appearing as ghost boxes.
- Reverse direction uses `MIN_CALLS_REVERSE = 3` (higher threshold) to reduce noise.

**Class detection regex** (scans neighbour source files):
```python
_CLASS_RE = re.compile(
    r'^[ \t]*(?:export\s+)?(?:abstract\s+)?(?:default\s+)?class\s+(\w+)'  # JS/TS
    r'|^class\s+(\w+)'                                                      # Python
    r'|^[ \t]*(?:class|struct)\s+(\w+)\b'                                  # C/C++
    r'|^type\s+(\w+)\s+struct\b',                                           # Go
    re.MULTILINE,
)
```

**`struct_view.js` — ghost boxes + cross-file arrows**

- After local render, fetches `/structure` async (with `_renderToken` race protection).
- Shows pulse loading pill in sv-header during fetch.
- Renders "↗ External Dependencies" separator + ghost boxes below the local class grid.
- Ghost box shows: direction badge (`→ imports` / `← imported by`), filename, detected class badges, `↗ open file` button.
- `open file` button calls `loadFileInPanel(path)` + `openCodePanel()` — does NOT call `drillToFile` (which would exit Structure View).

**Arrow geometry:**
- Field badge → ghost box (same row): horizontal S-curve from badge right-center
- Field badge → ghost box (different row): elbow curve down then across
- Box → ghost box: vertical waterfall curve (bottom-center → top-center)

**`struct_view.css`** — new selectors (all prefixed `sv-ghost-` or `sv-cf-`):
- `.sv-cf-loading` — pulse pill during fetch
- `.sv-ghost-separator` — "↗ External Dependencies" divider
- `.sv-ghost-box` — orange dashed ghost file box
- `.sv-ghost-hdr`, `.sv-ghost-dir-badge`, `.sv-ghost-class-badge`, `.sv-ghost-nav-btn`
- `.sv-arrow-cross-file` — orange dashed SVG path

---

### What does NOT work yet ⚠️

**Cross-file arrow precision (Sourcetrail-style field-badge origins)**

The goal was: arrow starts from the specific **field badge** whose name matches the
ghost class (e.g. `cache` field → `LRUCache` ghost box).

**The matching logic is implemented** in `_svApplyCrossFileData` using fuzzy substring
matching (`_findClassMatch`):
- Exact: `cache == cache`
- Class contains field: `LRUCache`.includes(`cache`) ✅
- Field contains class: `scheduler_instance`.includes(`scheduler`)

**But the arrows are still drawing from the box bottom-center, not from field badges.**

Root cause not yet confirmed. Two likely suspects:

1. **`data-sv-name` attribute mismatch** — the field badge query is:
   ```js
   boxEl.querySelector(`.sv-field[data-sv-name="${esc}"]`)
   ```
   The field name stored in `cls.fields[].name` might differ from what was rendered
   (e.g. `_cache` vs `cache` after stripping, or HTML-escaped vs raw).
   **Debug step**: `console.log` the `f.name` values from `cls.fields` and check
   what `data-sv-name` values actually exist in the DOM.

2. **`isField` flag not propagating** — `_addArrow` stores `isField`, but the arrow
   drawing code branches on it. If `fieldBadge` querySelector returns null, `isField`
   is `false` and it falls back to box geometry.

**To verify**: open browser DevTools → Console, add after the ghost box render:
```js
document.querySelectorAll('.sv-field').forEach(b => console.log(b.dataset.svName));
```
Compare those values to `cls.fields[].name` from `_sv.classes`.

---

## Remaining Gaps

### Gap #1 — Cross-file arrow precision (Partially done, arrow origin not from badge)
See "What does NOT work yet" above. Core logic is correct, debug needed on DOM selector.

### Gap #2 — Focus Panel ✅ DONE (previous session)
Clicking `.sv-method` badge opens inline Callers/Callees panel at bottom of sv-view.

### Gap #3 — Breadcrumb navigation in Structure View (Priority ★★)

**Problem**: No way to navigate from class box → file-level import graph.

**What to build**: Mini breadcrumb in `.sv-header`:
`project → module → filename → [selected class]`
Clicking `filename` fires `loadFileInPanel(fileRel)`. No new API needed.

### Gap #4 — Clickable symbols in code panel → highlight badge (Priority ★★)

**Problem**: Code → Structure direction only works at line level. Individual identifiers
in the rendered code are not clickable.

**What to build**:
1. After `renderCode()`, iterate `codeState.funcList`, wrap matching `<span>` with `data-sym-name`.
2. Delegated click on `#cp-code-wrap` → `svHighlightBadgeByName(name)`.

---

## Known Bugs / Tech Debt

| Bug | File | Notes |
|-----|------|-------|
| `is_public` always `false` for Python | `python_parser.py` | `is_static=True` for all Python funcs → `is_public = not is_static = False`. Workaround in `/structure`: use all funcs if none are public. Real fix: patch `python_parser.py` |
| Dotted import resolution fails | `analyze_viz.py` / parsers | `from core.engine import Engine` → `file_edges_by_module` empty. Strategy B works around this but is heuristic. |
| `file_to_module` may not exist | `server.py` | `/structure` endpoint uses `graph_data.get('file_to_module', {})`. If this key is absent, same-module filter is skipped (silent degradation). Verify key exists in `build_graph` output. |

---

## Calling Conventions / Integration Points

```
viz.js  ──calls──►  struct_view.js exposed globals:
    svUpdateStructureBtn(fileRel, ext)   // at end of loadFileInPanel + _syncCodePanel
    svAfterRenderCode(src, ext, fname)   // at end of renderCode()
    svHideStructureBtn()                 // when navigating away from a file
    svToggleStructView()                 // Structure button onclick

struct_view.js  ──calls──►  viz.js globals (checked with typeof guard):
    jumpToFunc(name)                     // jumps code panel
    openCodePanel()                      // ensures panel is open
    focusFunc(fileRel, idx)              // shows func-view
    drillToFile(fileRel)                 // navigates to L2  ← NOT used by ghost open-file
    state.level                          // read-only navigation level check
    l2State.activeFile                   // read-only
    DATA.funcs_by_file[fileRel]          // function list for focus panel
    DATA.func_edges_by_file[fileRel]     // edge list for focus panel
```

---

## Dev Setup

```bash
# Run the server
python vizcode.py /path/to/your/project

# The browser opens http://localhost:7777
# struct_view.js and struct_view.css are loaded as static files from the same dir
# Edit → hard-refresh browser (Ctrl+Shift+R) — no build step needed
```

---

## File Inventory

```
vizcode.py          CLI launcher + TUI animation
server.py           HTTP server (stdlib only, no Flask)  ← modified session 3
analyze_viz.py      Graph builder — dispatches to parsers/
parsers/
  bios_parser.py    C/C++/UEFI parser
  python_parser.py  Python parser  ← is_public bug lives here
  js_parser.py      JS/TS parser
  go_parser.py      Go parser
detector.py         Project type auto-detection
viz.js              Main frontend (~7600 lines)
viz.css             Main stylesheet (~3000 lines)
struct_view.js      Structure View plugin (~1100 lines)  ← modified session 3
struct_view.css     Structure View styles (~380 lines)   ← modified session 3
launcher.html       Shell HTML that injects DATA + loads all scripts
```