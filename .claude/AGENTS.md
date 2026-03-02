# AGENTS.md — BIOS Code Visualizer
> Universal AI Agent Instructions | Compatible: Cursor · Windsurf · Cline · Claude Code · Copilot · RooCode
> Version: 2.0 | Updated: 2026-03-02

---

## 🎯 Project Mission

Build a **self-contained HTML visualization tool** for ASUS BIOS engineers:
- View function call graphs (who calls whom)
- View file dependency graphs (#include relationships)
- Navigate module → file → function with drill-down
- Handle **5,000+ files without lag** (v1 failed at 1GB RAM)

No build system required. Pure Python static analysis → single HTML file.

---

## 🏗️ Project Structure

```
bios-viz/
├── AGENTS.md                    ← You are here
├── BRAIN.md                     ← Project memory (READ FIRST every session)
├── SESSION.md                   ← Current session work log
├── analyze_bios.py              ← Python analyzer (v1 done, v2 needs rewrite)
├── BIOS_VIZ_WORKLOG.md          ← Full history & context
├── .cursor/rules/               ← Cursor MDC rules
│   ├── core.mdc
│   ├── python.mdc
│   └── html-viz.mdc
├── .cursorrules                 ← Cursor legacy
├── .clinerules                  ← Cline / RooCode
├── .windsurfrules               ← Windsurf Cascade
└── .github/copilot-instructions.md
```

---

## ⚡ Quick Start for Agent

**Every session, in order:**
1. Read `BRAIN.md` — get project state and architecture
2. Read `SESSION.md` — get current task and last actions
3. State your understanding before writing any code

---

## 🔧 Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Analysis | Python 3.x stdlib only | Zero pip install |
| Rendering | **cytoscape.js 3.28.1 CANVAS** | NOT SVG, NOT D3 |
| Layout L0 | cytoscape-cola | Module overview force layout |
| Layout L1 | cytoscape-dagre | File hierarchy layout |
| Layout L2 | Fixed positions | Sourcetrail-style caller/callee |
| UI | Vanilla HTML/CSS/JS | Single file, no frameworks |
| CDN | cdnjs + jsdelivr | See approved list in BRAIN.md |

---

## 🚨 CRITICAL PERFORMANCE RULES (P0 — never compromise)

These rules exist because **v1 caused 1GB RAM usage on 5,000 files and was unusable.**

1. **CANVAS ONLY** — cytoscape.js canvas renderer, never SVG, never D3 SVG
2. **MAX 200 VISIBLE NODES** at any time — hard limit, enforced in JS, no exceptions
3. **HIERARCHICAL DATA** — Python outputs 3 levels (module/file/func), HTML loads lazily
4. **NO RUNTIME CLUSTERING** — all grouping done in Python, not in browser
5. **REMOVE D3.js** from v2 entirely — not even as fallback
6. **LAZY LOADING** — Level 1 and Level 2 data must only load when user drills in

If any feature would violate these rules, redesign the feature, not the rules.

---

## 📋 Coding Rules

### Python (`analyze_bios.py`)
- stdlib only: `os`, `re`, `json`, `sys`, `pathlib`, `argparse`, `collections`
- Functions ≤ 50 lines, split aggressively
- All regex at module level with `RE_` prefix
- File encoding: `utf-8, errors='replace'` always
- Progress: `print(f"[{pct:3d}%] {i}/{total}", end='\r')`
- V2 output schema: hierarchical (modules → files → funcs) — see BRAIN.md
- SKIP_DIRS: `{'Build', 'build', '.git', '__pycache__', 'Conf', 'DEBUG', 'RELEASE'}`
- SCAN_EXT: `{'.c', '.cpp', '.h', '.hpp', '.asm', '.s', '.S'}`
- SKIP_EXT: `{'.veb', '.sdl', '.lib', '.obj', '.efi', '.rom', '.bin', '.log', '.map'}`

### HTML / JavaScript
- Single file, all CSS/JS inline, CDN only for libraries
- Data placeholder: `const DATA = /*DATA_PLACEHOLDER*/null;`
- No `localStorage`, no `<form>` tags, no React/Vue
- Dark theme only: bg `#050a0f`, panel `#090e14`, accent `#00d4ff`
- CSS variables in `:root` for every color and spacing value
- Keyboard shortcuts: `Escape` = back/deselect, `/` = focus search, `M` = module view

### V2 Three-Level Navigation
```javascript
// State machine — agent must implement this exactly
state = {
  level: 0 | 1 | 2,        // current drill level
  activeModule: string | null,  // which module is expanded
  activeFile: string | null,    // which file is expanded
  history: []               // for back button
}

// Transitions
moduleClick(id)  → level 1, load files_by_module[id]
fileClick(id)    → level 2, load funcs_by_file[path]
backButton()     → level - 1, restore previous state
breadcrumb(n)    → jump to level n
```

---

## 🎨 Visual Style Guide (v2 target)

### Level 0 — Module Overview
- Rounded rectangle nodes, color-coded border
- Module name + icon in header
- File count + func count as badges
- Cola force layout (spread out organically)
- Edge thickness = dependency weight

### Level 1 — File Cards (Sourcetrail-inspired, dark theme)
- Each file = compact dark card (180×80px)
- Header: filename, ext badge, size
- Body: function count, include count
- Dagre left-to-right hierarchical layout
- Arrows on include edges

### Level 2 — Function Detail (Sourcetrail exact style)
- **Central card** (selected function):
  - Dark card, 220px wide, auto-height
  - Header: function name
  - Section strip: `🔒 PRIVATE` or `🔓 PUBLIC`
  - Member pills: blue=function, yellow=EFIAPI, gray=static
- **Left side**: caller nodes (who calls this function)
- **Right side**: callee nodes (what this function calls)
- **Edges**: red=private, gray=public, bezier curves
- **Badges**: reference count circles on caller/callee nodes

---

## 🚫 Hard Constraints (NEVER violate)

1. Never `pip install` anything
2. Never require a web server — file:// URI must work
3. Never break single-file HTML output
4. Never touch `.veb` or `.sdl` files
5. Never index `Build/` directory
6. **Never render more than 200 nodes at once** ← new in v2
7. **Never use D3.js SVG for graph rendering** ← new in v2
8. **Never do graph clustering in browser** ← new in v2
9. Never write rule files longer than 500 lines

---

## 🎯 V2 Priority Tasks

### P0 — Performance (do first, nothing else matters until these are done)
- [ ] Rewrite `analyze_bios.py` to output hierarchical JSON (3 levels)
- [ ] Replace HTML renderer: D3 → cytoscape.js canvas
- [ ] Implement 3-level drill-down state machine
- [ ] Enforce 200-node hard limit
- [ ] Confirm < 50MB RAM on 5,000-file codebase

### P1 — Visual (do after P0 confirmed working)
- [ ] Level 0: module card nodes with cola layout
- [ ] Level 1: file cards with dagre layout
- [ ] Level 2: Sourcetrail-style compound function card
- [ ] Breadcrumb navigation bar
- [ ] Back button with history

### P2 — Features (do after P1)
- [ ] ASM file nodes in Level 1
- [ ] Right-click context menu
- [ ] Path finder: function A → function B
- [ ] Stats panel: top-10 headers, top-10 called functions
- [ ] Export SVG/PNG of current view

---

## 🏢 Domain Knowledge: ASUS AMI Aptio V

- **Project path**: `D:\Code\ADL\B1403CTA_SMR\`
- **Platform**: AlderLake (ADL), Intel 12th Gen
- **Build**: `mk.bat` → GNU Make Windows → WDK cl.exe
- **Key modules**: `AmiPkg/`, `AsusModulePkg/`, `AsusProjectPkg/`, `AmiChipsetPkg/`
- **UEFI Macros to filter** (not function names):
  `EFIAPI, EFI_STATUS, IN, OUT, OPTIONAL, VOID, UINTN, INTN,
   UINT8, UINT16, UINT32, UINT64, BOOLEAN, TRUE, FALSE, NULL,
   PEI_SERVICES, EFI_BOOT_SERVICES, EFI_RUNTIME_SERVICES, ASSERT_EFI_ERROR`
- **EFIAPI detection**: if `EFIAPI` appears before function name → `is_efiapi: true`

---

## 🔁 Session Protocol

**Start**: Read BRAIN.md + SESSION.md → state current task → confirm plan  
**During**: Update SESSION.md after each meaningful action  
**End**: Ensure SESSION.md has "next session" section  
**Compression**: If SESSION.md > 60 lines → compress decisions to BRAIN.md → reset SESSION.md  
**Refresh**: Re-read BRAIN.md every 10 prompts

---

## ✅ Definition of Done (v2)

1. `python analyze_bios.py D:\Code\ADL\B1403CTA_SMR\ -o bios_viz.html` runs without error
2. HTML opens in Chrome, Module view loads < 2 seconds
3. Drill-down works: module → files → function detail
4. RAM usage < 200MB at any view level (check Chrome Task Manager)
5. No console errors
6. SESSION.md + BRAIN.md updated
