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
| `server.py` | HTTP server. Serves static files, handles `/file`, `/search`, `/analyze` API |
| `analyze_viz.py` | Walks the project, builds `DATA` (nodes + edges). Entry: `build_graph(root)` |
| `viz.js` | Main frontend logic (~7600 lines). State, Cytoscape graph, code panel |
| `viz.css` | Main stylesheet |
| `struct_view.js` | Structure View plugin (~700 lines). Loaded as a separate `<script>` |
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
_svShowFocusPanel(name, line, ci) // ← NEW (v2.1) — shows inline Callers/Callees panel
_svHideFocusPanel(immediate?)     // ← NEW
_svHighlightBadgeByName(name)     // ← NEW
```

---

## What Was Just Implemented (Diff #2 — Focus Panel)

### Problem (Gap #2)
Clicking a method badge in Structure View only jumped the code panel to the line.
There was no "who calls this / what does it call" information inline — the core
Sourcetrail interaction was missing.

### Solution
When a **`.sv-method`** badge is clicked:
1. Code panel jumps to line (existing).
2. A **Focus Panel** slides up from the bottom of `#sv-view`.

The Focus Panel shows:
```
┌──────────────────────────────────────────────────────────┐
│ ⬡ methodName  [PUBLIC]                              [✕] │
├─────────────────────────┬────────────────────────────────┤
│ ◀ CALLERS  (N)          │ CALLEES ▶  (N)                 │
│  ◀ callerFunc1          │ calleeFunc1 ▶                  │
│  ◀ callerFunc2          │ calleeFunc2 ▶                  │
└─────────────────────────┴────────────────────────────────┘
```

**Clicking a card** → jumps code panel to that function + recursively updates the
Focus Panel to show *that* function's callers/callees (depth-first browse).

The Focus Panel is **fully self-contained** inside Structure View. It does NOT touch
`drillToFile`, `focusFunc`, or any L2/Call Graph state — those are completely separate.
The existing Call Graph button in the breadcrumb toolbar remains the only entry point
to the L2 call-graph view.

**Graceful degradation**: if `window.DATA.funcs_by_file` is absent (no server, or
file has no parsed functions) the panel shows an info strip instead of crashing.

### Files Changed

- **`struct_view.js`**: 3 surgical edits + ~130 lines appended
  - `svUpdateStructureBtn` — now stores `_sv._fileRel = fileRel`
  - `svHideSvView` — calls `_svHideFocusPanel(true)` before clearing innerHTML
  - `_svAttachBadgeHandlers` — `.sv-method` clicks trigger `_svShowFocusPanel()`; field/class-header clicks only jump (no panel)
  - Appended: `_svShowFocusPanel`, `_svHideFocusPanel`, `_svOpenInCallGraph`, `_svHighlightBadgeByName`

- **`struct_view.css`**: ~130 lines appended
  - All new selectors are prefixed `sv-fp-*`
  - The existing `.sv-jump-highlight` / `.sv-active-badge` etc. are untouched

No changes to `viz.js`, `server.py`, or `analyze_viz.py`.

---

## Remaining Gaps (from original analysis)

### Gap #1 — Cross-file arrows in Structure View (Priority ★★★)

**Problem**: `struct_view.js` re-parses the current file with regex, completely ignoring
the cross-file import/inheritance edges that `analyze_viz.py` already computed.

**What to build**:
1. Add `GET /structure?job=JOB_ID&file=REL_PATH` endpoint in `server.py`.
   Query `JOBS[jid]['data']` for `funcs_by_file[file]`, `func_edges_by_file[file]`,
   and any edges in `data['edges']` where source or target is this file.
2. In `struct_view.js`, after opening sv-view, fetch this endpoint.
   Merge the returned cross-file class references into the arrow-drawing pass
   (`_svDrawArrows`), adding a new arrow type `sv-arrow-cross-file`.
3. Add a `sv-arrow-cross-file` style in `struct_view.css` (e.g. orange dashed).

**Data available in `JOBS[jid]['data']`** (produced by `build_graph`):
```python
data = {
  'funcs_by_file': { rel_path: [{ 'label', 'is_public', ... }] },
  'func_edges_by_file': { rel_path: [{ 's': int, 't': int }] },
  'edges': [ { 'source': file_id, 'target': file_id, 'type': edge_type } ],
  'files_by_module': { mod_id: [{ 'id', 'path', 'label', ... }] },
}
```

### Gap #3 — Layer navigation breadcrumb in Structure View (Priority ★★)

**Problem**: There's no way to navigate from a class box up to "which files import
this file" or down to the file-level import graph.

**What to build**: A mini breadcrumb in `.sv-header` showing
`project → filename → [selected class]`. Clicking `filename` fires
`loadFileInPanel(fileRel)` to re-sync the code panel. No new API needed.

### Gap #4 — Clickable symbols in code panel → highlight badge (Priority ★★)

**Problem**: The reverse direction (Code → Structure) only works at the line level.
Identifiers in the rendered code aren't individually clickable.

**What to build**:
1. After `renderCode()` runs, iterate `codeState.funcList` and wrap each
   matching identifier `<span>` in the code with `data-sym-name`.
2. Add a delegated `click` listener on `#cp-code-wrap` that calls
   `svHighlightBadgeByName(name)` (already exists in struct_view.js).

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
    drillToFile(fileRel)                 // navigates to L2
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
server.py           HTTP server (stdlib only, no Flask)
analyze_viz.py      Graph builder — dispatches to parsers/
parsers/
  bios_parser.py    C/C++/UEFI parser
  python_parser.py  Python parser
  js_parser.py      JS/TS parser
  go_parser.py      Go parser
detector.py         Project type auto-detection
viz.js              Main frontend (~7600 lines)
viz.css             Main stylesheet (~3000 lines)
struct_view.js      Structure View plugin (~700 lines)  ← recently modified
struct_view.css     Structure View styles (~250 lines)  ← recently modified
launcher.html       Shell HTML that injects DATA + loads all scripts
```
