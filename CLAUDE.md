# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**VIZCODE** is a local, zero-dependency code visualization tool. It scans a user's codebase and generates an interactive HTML dependency/call graph in the browser. The goal is to reach Sourcetrail-level code exploration (symbol-centric navigation, graph view, code snippets view).

The `Sourcetrail-master/` subdirectory is the upstream open-source reference project (C++/Qt) used as a design benchmark — it is **not** part of the active codebase.

## Running the App

```bash
# Start via CLI (interactive TUI)
python vizcode.py

# Or start directly (Windows batch)
launch.bat
```

Open `http://localhost:7777` in Chrome. No build step. Frontend changes take effect on hard-refresh (`Ctrl+Shift+R`).

If port 7777 is occupied:
```bash
# Windows
netstat -ano | findstr :7777
taskkill /PID <PID> /F
```

## Testing / Verification

There is no automated test runner. Use the `testproject/` directory as a smoke-test target — it's small, multilingual, and exercises all node/edge types.

**Headless API verification after triggering analysis via UI:**
```bash
# List active jobs
curl http://localhost:7777/jobs

# Check a job's progress
curl "http://localhost:7777/progress?job=<JID>"

# Validate result JSON keys
curl "http://localhost:7777/result?job=<JID>" | python -c "import json,sys; d=json.load(sys.stdin); print(list(d.keys()))"
# Expected keys include: nodes, edges, modules, stats, functions, ...
```

## Architecture

### Backend

| File | Role |
|------|------|
| `vizcode.py` | CLI launcher + TUI animation. Spawns `server.py` as subprocess. |
| `server.py` | HTTP server (port 7777, stdlib only). Serves static files and handles all API endpoints. Analysis runs in background thread via SSE. |
| `analyze_viz.py` | **Core engine.** `build_graph(root)` walks the directory, dispatches to parsers, assembles `DATA` (nodes, edges, symbol_index, symbol_edges, funcs_by_file, etc.) |
| `detector.py` | Detects project type (Python / JS / Go / BIOS) from characteristic files. |
| `parsers/bios_parser.py` | C/C++/UEFI/EDK2 parser |
| `parsers/python_parser.py` | Python parser |
| `parsers/js_parser.py` | JS/TS/JSX/TSX parser |
| `parsers/go_parser.py` | Go parser |

### Frontend (`static/`)

| File | Role |
|------|------|
| `viz.js` | Main frontend (~7600 lines). State management, Cytoscape graph, code panel, all interaction logic. |
| `viz.css` | Main stylesheet (~3000 lines). |
| `struct_view.js` | Structure View plugin (~2300 lines). Loaded as separate `<script>`. |
| `struct_view.css` | Structure View styles. |
| `i18n.js` | Chinese/English bilingual translation table. |
| `themes.css` | Theme styles. |
| `launcher.html` | SPA shell. Server injects `DATA` JSON directly into this HTML, then loads all scripts. |

### Navigation Levels (viz.js state machine)

- **L0** — Module overview (Cytoscape, `state.level = 0`)
- **L1** — File dependency graph (`state.level = 1`, `state.activeModule`)
- **L2** — Function call-flow (`state.level = 2`, `state.activeFile`, `l2State`)
- **sv-view** — Structure View overlay; shown over L1/L2, hides `#cy`

### Key Global State

```js
window.DATA            // Full graph payload injected by server into HTML
  .funcs_by_file       // { "rel/path.py": [ { label, is_public, is_efiapi }, ... ] }
  .func_edges_by_file  // { "rel/path.py": [ { s: callerIdx, t: calleeIdx }, ... ] }
  .files_by_module     // { modId: [ { id, path, label, ext, file_type, func_count }, ... ] }
  .symbol_index        // { "sym_0": { id, name, kind, file, line, parent, children, ... } }
  .symbol_edges        // [ { from, to, type }, ... ]  types: call|inheritance|type_usage|import

state          // { level, activeModule, activeFile, ... }
l2State        // { activeFile, activeFuncIdx, ... }
codeState      // { currentFile, funcLineMap, funcList, rawLines, isOpen, ... }
_sv            // struct_view.js internal state (window._sv)
```

### Cross-module Interface (viz.js ↔ struct_view.js)

```
viz.js  ──calls──►  struct_view.js:
    svUpdateStructureBtn(fileRel, ext)
    svAfterRenderCode(src, ext, fname)
    svHideStructureBtn()
    svToggleStructView()

struct_view.js  ──calls──►  viz.js:
    jumpToFunc(name)
    openCodePanel()
    focusFunc(fileRel, idx)
    drillToFile(fileRel)
    state.level / l2State.activeFile / DATA.*
```

## Server API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /analyze` | Start analysis job, returns `job_id` via SSE |
| `GET /progress?job=JID` | Job progress stream (SSE) |
| `GET /result?job=JID` | Full analysis result JSON |
| `GET /file?path=...` | Read a source file |
| `GET /search?job=JID&q=...` | Full-text search |
| `GET /search-stream?job=JID&q=...` | Streaming search (SSE) |
| `GET /structure?job=JID&file=...` | File structure for Structure View |
| `GET /symbol-graph?job=JID&sym=SID` | Symbol-centric subgraph |
| `GET /symbol-refs?job=JID&sym=SID` | All references to a symbol |
| `GET /symbols?job=JID&query=...&kind=...` | Fuzzy symbol search |

## Parser Interface Contract

All `parsers/*.py` scan functions **must** return this exact tuple:

```python
return (
    imports_or_refs,      # list[str]
    funcdefs,             # list[dict]: [{label, is_efiapi, is_static}, ...]
    funccalls,            # list[str]
    extra_dict,           # dict | None
    func_calls_by_func,   # list[list[str]]
)
```

Parsers are pure text transformers — they must not import or modify anything in `analyze_viz.py`. All I/O and regex inside parsers must be wrapped in `try/except`; on failure, return empty values silently (do not propagate exceptions).

## Code Style

- **Zero external dependencies**: No `pip install`. Python stdlib only. Frontend may only use libraries already loaded in `launcher.html` (currently Cytoscape.js, highlight.js).
- Python: `snake_case` functions, `UPPER_SNAKE_CASE` constants, `PascalCase` classes. Section dividers use `# ─── Title ───` (Unicode U+2500).
- JavaScript: `camelCase` functions, `UPPER_SNAKE_CASE` constants. No `var`. No raw `innerHTML` with user input. Section dividers use `// ── Title ───`.
- Functions over 60 lines should be split.

## Adding a New Language Parser

1. Create `parsers/<lang>_parser.py` with `scan_<lang>(content, filepath)` returning the tuple above.
2. Register in `analyze_viz.py`: add to `SCAN_EXT`, `FILE_TYPE_MAP`, and the dispatch in `scan_file()`.
3. Update `detector.py` with characteristic files for the new language.
4. Update `static/viz.js`: add color in `extColor()`, update `FILE_TYPE_SHAPE` and `FT_GROUPS`.

## Known Tech Debt

| Issue | File | Notes |
|-------|------|-------|
| `is_public` always `false` for Python | `python_parser.py` | `is_static=True` for all → `is_public = not is_static = False` |
| Dotted import resolution fails | `analyze_viz.py` / parsers | `from core.engine import Engine` → `file_edges_by_module` empty |
| Structure View arrows don't redraw on resize | `struct_view.js` | No ResizeObserver; arrows drawn once at render time |
| Phase 2 Symbol-Centric code dormant | `struct_view.js` | Code still present (~lines 1500–2200) but not triggered; can be re-enabled |

## Development Roadmap (VIZCODE V5)

- **Phase 1** ✅ Symbol Index — unified symbol table in `DATA.symbol_index` + `DATA.symbol_edges`
- **Phase 2** Symbol-Centric Graph — Cytoscape canvas inside `#sv-view`, dagre LR layout, bundled edges
- **Phase 3** Multi-file Code Snippets — symbol-aware code jump, snippet aggregation from multiple files
- **Phase 4** Class Hierarchy & Node Expansion
- **Phase 5** Overview Dashboard
- **Phase 6** Back/Forward navigation, animations, edge-type filters

Full design spec: `static/VIZCODE_AGENT_BRIEF.md`
