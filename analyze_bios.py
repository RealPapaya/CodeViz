#!/usr/bin/env python3
"""
analyze_bios.py V2 — BIOS Code Visualizer
Hierarchical JSON output + cytoscape.js canvas renderer
Performance target: <50MB RAM at any zoom level
"""

import os, re, json, sys, argparse
from pathlib import Path
from collections import defaultdict

# ─── Constants ───────────────────────────────────────────────────────────────
SKIP_DIRS  = {'Build','build','.git','__pycache__','Conf','DEBUG','RELEASE','.claude'}
SCAN_EXT   = {'.c','.cpp','.h','.hpp','.asm','.s','.S'}
SKIP_EXT   = {'.veb','.sdl','.lib','.obj','.efi','.rom','.bin','.log','.map'}

C_KEYWORDS = {
    'if','else','while','for','do','switch','case','return','sizeof','typeof',
    'EFIAPI','EFI_STATUS','IN','OUT','OPTIONAL','VOID','UINTN','INTN',
    'UINT8','UINT16','UINT32','UINT64','BOOLEAN','TRUE','FALSE','NULL',
    'PEI_SERVICES','EFI_BOOT_SERVICES','EFI_RUNTIME_SERVICES','ASSERT_EFI_ERROR',
    'static','inline','extern','const','struct','union','enum','typedef',
    'printf','sprintf','memset','memcpy','strlen','strcmp','malloc','free',
}

MODULE_COLORS = [
    '#00d4ff','#00ff9f','#ff6b35','#ffd700','#a78bfa',
    '#f472b6','#34d399','#fb923c','#60a5fa','#e879f9',
    '#4ade80','#facc15','#f87171','#38bdf8','#c084fc',
]

# ─── Regex ────────────────────────────────────────────────────────────────────
RE_INCLUDE  = re.compile(r'#\s*include\s+["<]([^">]+)[">]')
RE_FUNCDEF  = re.compile(
    r'^(?:(?:static|inline|extern|EFIAPI|EFI_STATUS|VOID|UINTN|INTN|UINT8|UINT16|UINT32|UINT64|BOOLEAN)\s+)*'
    r'(EFIAPI\s+)?'
    r'[\w\s\*]+\b(\w+)\s*\([^)]*\)\s*(?://[^\n]*)?\s*\{',
    re.MULTILINE
)
RE_FUNCCALL = re.compile(r'\b([A-Za-z_]\w+)\s*\(')
RE_STATIC   = re.compile(r'\bstatic\b')
RE_ASM_INC  = re.compile(r'%include\s+["\']([^"\']+)["\']|EXTERN\s+(\w+)', re.IGNORECASE)

# ─── strip_comments ───────────────────────────────────────────────────────────
def strip_comments(src: str) -> str:
    result, i, n = [], 0, len(src)
    while i < n:
        if src[i:i+2] == '//':
            while i < n and src[i] != '\n':
                i += 1
        elif src[i:i+2] == '/*':
            i += 2
            while i < n and src[i-1:i+1] != '*/':
                i += 1
            i += 1
        elif src[i] in '"\'':
            q = src[i]; result.append(src[i]); i += 1
            while i < n and src[i] != q:
                if src[i] == '\\': result.append(src[i]); i += 1
                result.append(src[i]); i += 1
            if i < n: result.append(src[i]); i += 1
        else:
            result.append(src[i]); i += 1
    return ''.join(result)

# ─── scan_file ────────────────────────────────────────────────────────────────
def scan_file(filepath: str, root: str):
    try:
        src = Path(filepath).read_text(encoding='utf-8', errors='replace')
    except Exception:
        return [], [], []

    rel = os.path.relpath(filepath, root).replace('\\', '/')
    ext = Path(filepath).suffix.lower()

    if ext in ('.asm', '.s'):
        includes = [m.group(1) or m.group(2) for m in RE_ASM_INC.finditer(src)]
        return includes, [], []

    clean = strip_comments(src)
    includes = RE_INCLUDE.findall(clean)

    funcdefs, funccalls = [], []
    for m in RE_FUNCDEF.finditer(clean):
        is_efiapi = bool(m.group(1))
        name = m.group(2)
        if name in C_KEYWORDS or len(name) < 2:
            continue
        line_before = clean[:m.start()].rstrip()
        is_static = bool(RE_STATIC.search(line_before.split('\n')[-1] if '\n' in line_before else line_before))
        funcdefs.append({'label': name, 'is_efiapi': is_efiapi, 'is_static': is_static})

    for m in RE_FUNCCALL.finditer(clean):
        name = m.group(1)
        if name not in C_KEYWORDS and len(name) >= 2:
            funccalls.append(name)

    return includes, funcdefs, funccalls

# ─── get_module ───────────────────────────────────────────────────────────────
def get_module(rel_path: str) -> str:
    parts = rel_path.replace('\\', '/').split('/')
    return parts[0] if len(parts) > 1 else '_root'

# ─── build_graph ─────────────────────────────────────────────────────────────
def build_graph(root_dir: str, progress_cb=None) -> dict:
    def _cb(pct, msg):
        print(f'[{pct:3d}%] {msg}', end='\r')
        if progress_cb: progress_cb(pct, msg)
    root = os.path.abspath(root_dir)
    all_files = []

    _cb(0, 'Scanning files...')
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fname in filenames:
            ext = Path(fname).suffix.lower()
            if ext in SCAN_EXT and ext not in SKIP_EXT:
                all_files.append(os.path.join(dirpath, fname))

    total = len(all_files)
    _cb(0, f'Found {total} files, analyzing...')

    # file metadata + raw analysis
    file_meta  = {}   # rel_path -> {label, ext, size, module}
    file_incs  = {}   # rel_path -> [include strings]
    file_defs  = {}   # rel_path -> [{label, is_efiapi, is_static}]
    file_calls = {}   # rel_path -> [call names]

    for i, fp in enumerate(all_files):
        if i % 50 == 0:
            pct = int(i / total * 60) if total else 0
            _cb(pct, f'{i}/{total} files analyzed')
        rel = os.path.relpath(fp, root).replace('\\', '/')
        inc, defs, calls = scan_file(fp, root)
        file_meta[rel]  = {
            'label':  os.path.basename(fp),
            'ext':    Path(fp).suffix.lower(),
            'size':   os.path.getsize(fp),
            'module': get_module(rel),
        }
        file_incs[rel]  = inc
        file_defs[rel]  = defs
        file_calls[rel] = calls

    _cb(60, 'Building module index...')

    # module index + colors
    all_modules = sorted(set(m['module'] for m in file_meta.values()))
    module_color = {}
    fixed = {'AmiPkg':'#00d4ff','AsusModulePkg':'#00ff9f',
             'AsusProjectPkg':'#ff6b35','AmiChipsetPkg':'#ffd700'}
    color_idx = 0
    for mod in all_modules:
        if mod in fixed:
            module_color[mod] = fixed[mod]
        else:
            module_color[mod] = MODULE_COLORS[color_idx % len(MODULE_COLORS)]
            color_idx += 1

    # resolve includes → file-level edges (by rel path)
    _cb(65, 'Resolving includes...')
    label_to_paths = defaultdict(list)
    for rel in file_meta:
        label_to_paths[os.path.basename(rel)].append(rel)

    # assign integer IDs per file
    rel_to_id = {rel: i for i, rel in enumerate(file_meta)}

    # build per-module file lists + edges
    files_by_module      = defaultdict(list)
    file_edges_by_module = defaultdict(list)   # within & cross
    
    for rel, meta in file_meta.items():
        fid  = rel_to_id[rel]
        mod  = meta['module']
        files_by_module[mod].append({
            'id':         fid,
            'label':      meta['label'],
            'path':       rel,
            'ext':        meta['ext'],
            'size':       meta['size'],
            'func_count': len(file_defs.get(rel, [])),
        })

    _cb(70, 'Resolving file edges...')
    module_edge_counts = defaultdict(int)
    seen_file_edges    = set()

    for src_rel, incs in file_incs.items():
        src_id  = rel_to_id[src_rel]
        src_mod = file_meta[src_rel]['module']
        for inc in incs:
            inc_base = os.path.basename(inc)
            candidates = label_to_paths.get(inc_base, [])
            for tgt_rel in candidates:
                tgt_id  = rel_to_id[tgt_rel]
                tgt_mod = file_meta[tgt_rel]['module']
                if src_id == tgt_id:
                    continue
                # cross-module edge for module graph weight
                if src_mod != tgt_mod:
                    key = (min(src_mod, tgt_mod), max(src_mod, tgt_mod))
                    module_edge_counts[key] += 1
                # store edge in source module bucket
                ekey = (src_id, tgt_id)
                if ekey not in seen_file_edges:
                    seen_file_edges.add(ekey)
                    file_edges_by_module[src_mod].append({'s': src_id, 't': tgt_id})

    _cb(80, 'Building function index...')
    # global function name → file path (first occurrence)
    func_name_to_file = {}
    for rel, defs in file_defs.items():
        for d in defs:
            if d['label'] not in func_name_to_file:
                func_name_to_file[d['label']] = rel

    # assign function IDs per file
    funcs_by_file      = {}
    func_edges_by_file = {}

    _cb(85, 'Resolving call edges...')
    for rel, defs in file_defs.items():
        if not defs:
            continue
        fid_map = {d['label']: i for i, d in enumerate(defs)}
        funcs_by_file[rel] = [
            {
                'id':        i,
                'label':     d['label'],
                'is_public': not d['is_static'],
                'is_efiapi': d['is_efiapi'],
            }
            for i, d in enumerate(defs)
        ]
        # Only intra-file edges; deduplicate call sites first
        intra_calls = set(file_calls.get(rel, [])) & fid_map.keys()
        edges = []
        seen_edge = set()
        for caller_idx, d in enumerate(defs):
            for callee in intra_calls:
                callee_idx = fid_map[callee]
                if callee_idx == caller_idx:
                    continue
                key = (caller_idx, callee_idx)
                if key not in seen_edge:
                    seen_edge.add(key)
                    edges.append({'s': caller_idx, 't': callee_idx,
                                  'p': int(d['is_static'])})
                    if len(edges) >= 300:
                        break
            if len(edges) >= 300:
                break
        func_edges_by_file[rel] = edges

    # module-level nodes
    _cb(95, 'Assembling output...')
    modules = [
        {
            'id':         mod,
            'label':      mod,
            'color':      module_color[mod],
            'file_count': len(files_by_module[mod]),
            'func_count': sum(len(file_defs.get(f['path'], []))
                              for f in files_by_module[mod]),
        }
        for mod in all_modules
    ]
    module_edges = [
        {'s': a, 't': b, 'weight': w}
        for (a, b), w in module_edge_counts.items()
    ]

    total_funcs = sum(len(v) for v in file_defs.values())
    total_calls = sum(len(v) for v in file_calls.values())

    _cb(100, 'Done!')
    print()
    return {
        'modules':              modules,
        'module_edges':         module_edges,
        'files_by_module':      dict(files_by_module),
        'file_edges_by_module': dict(file_edges_by_module),
        'funcs_by_file':        funcs_by_file,
        'func_edges_by_file':   func_edges_by_file,
        'stats': {
            'files':     total,
            'modules':   len(modules),
            'functions': total_funcs,
            'calls':     total_calls,
            'root':      root.replace('\\', '/'),
        }
    }


# ─── HTML Skeleton (CSS/JS loaded from static/) ───────────────────────────────
HTML_SKELETON = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BIOSVIZ — {root_name}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.js"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/c.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/cpp.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/x86asm.min.js"></script>
<style>{CSS}</style>
</head>
<body>

<script>window.JOB_ID = {JOB_ID_JSON};</script>

<div id="topbar">
  <div class="logo">BIOS<span>VIZ</span></div>
  <div class="tabs">
    <button class="tab active" id="tab-files" onclick="switchTab('files')">File Dependencies</button>
    <button class="tab" id="tab-calls"  onclick="switchTab('calls')">Call Graph</button>
  </div>
  <div class="stats-bar">
    <div class="stat">Files <strong id="st-files">0</strong></div>
    <div class="stat">Modules <strong id="st-mods">0</strong></div>
    <div class="stat">Functions <strong id="st-funcs">0</strong></div>
  </div>
  <div id="search-wrap">
    <span class="search-icon">🔍</span>
    <input id="search" type="text" placeholder="Search... (/)">
  </div>
</div>

<div id="breadcrumb">
  <span id="bc-items" style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;overflow:hidden"></span>
  <button id="back-btn" onclick="goBack()">← Back</button>
  <button id="graph-toggle-btn" title="Caller / Callee view (same as double-click)">⬡ Graph</button>
  <button id="code-toggle-btn" title="Toggle Code Panel (C)">&#60;&#47;&#62; Code</button>
</div>

<div id="layout">
  <div id="sidebar">
    <div id="sidebar-title">Modules</div>
    <div id="module-list"></div>
  </div>
  <div id="sidebar-resizer"></div>
  <div id="graph-wrap">
    <div id="cy"></div>
    <div id="func-view"></div>
    <div id="loading"><div class="spinner"></div><span id="loading-msg">Loading...</span></div>
  </div>
  <!-- Resizer handle -->
  <div id="resizer" style="display:none"></div>
  <!-- Code Panel (Sourcetrail-style) -->
  <div id="code-panel">
    <div id="cp-header">
      <div id="cp-file-bar">
        <span id="cp-ext-badge">.C</span>
        <span id="cp-filename">No file selected</span>
        <button id="cp-close" title="Close">✕</button>
      </div>
      <div id="cp-func-bar">
        <span id="cp-func-name"></span>
        <span id="cp-func-badge" class="cp-func-badge cp-func-public">PUBLIC</span>
        <div id="cp-func-nav">
          <button class="cp-nav-btn" id="cp-prev-func" title="Prev function (←)">‹</button>
          <button class="cp-nav-btn" id="cp-next-func" title="Next function (→)">›</button>
        </div>
      </div>
    </div>
    <div id="cp-body">
      <div id="cp-loading">
        <div class="spinner"></div>
        <span style="font-size:12px;color:var(--muted)">Loading source...</span>
      </div>
      <div id="cp-empty" style="display:none">
        <div class="cp-empty-icon">📁</div>
        <p>Click a file node to view source</p>
        <small>Single-click → preview · Double-click → drill in</small>
      </div>
      <div id="cp-code-wrap" style="display:none"></div>
    </div>
  </div>
</div>

<!-- Old info-panel (hidden, kept for JS compat) -->
<div id="info-panel" style="display:none">
  <div id="info-inner"><div id="info-title"></div><div id="info-sub"></div></div>
</div>

<div id="ctx-menu">
  <div class="ctx-item" id="ctx-copy">📋 Copy path</div>
  <div class="ctx-item" id="ctx-open-code">📄 View source</div>
  <div class="ctx-item" id="ctx-vscode">↗ Open in VS Code</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" id="ctx-module-only">🔍 Only this module</div>
  <div class="ctx-item" id="ctx-pin">📌 Pin node</div>
</div>
<div id="tooltip"></div>

<!-- Data embedded as JSON text — parsed by JSON.parse(), not JS engine (10x faster) -->
<script type="application/json" id="viz-data">{DATA}</script>
<script>(function(){{
  var l=document.getElementById('loading');
  var m=document.getElementById('loading-msg');
  if(l){{l.className='show';}}
  if(m){{m.textContent='⏳ Parsing graph data...'}}
  // Show resizer when code panel opens (handled by JS)
  document.getElementById('cp-loading').classList.add('hidden');
  document.getElementById('cp-empty').style.display='';
}})();</script>
<script>{JS}</script>
</body>
</html>"""

# Keep HTML_TEMPLATE as alias for backward compat (server.py uses it)
HTML_TEMPLATE = HTML_SKELETON


# ─── build_html ───────────────────────────────────────────────────────────────
def build_html(data: dict, job_id: str = None) -> str:
    """Read static/viz.{css,js} and embed them inline into the HTML skeleton."""
    base  = Path(__file__).parent / 'static'
    css_p = base / 'viz.css'
    js_p  = base / 'viz.js'

    if not css_p.exists() or not js_p.exists():
        raise FileNotFoundError(
            f'Missing static files. Expected:\n  {css_p}\n  {js_p}')

    css = css_p.read_text(encoding='utf-8')
    js  = js_p.read_text(encoding='utf-8')

    json_str     = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    root_name    = Path(data['stats']['root']).name or 'BIOS'
    job_id_json  = json.dumps(job_id)   # "null" or '"abc1234"'

    return HTML_SKELETON.format(
        CSS=css, JS=js,
        DATA=json_str,
        root_name=root_name,
        JOB_ID_JSON=job_id_json,
    )


# ─── inject_data (legacy, used by server.py) ─────────────────────────────────
def inject_data(html: str, data: dict) -> str:
    """Legacy helper — now calls build_html() directly."""
    return build_html(data, job_id=None)


# ─── main ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='BIOS Code Visualizer V2')
    parser.add_argument('root', help='Root directory of BIOS codebase')
    parser.add_argument('-o', '--output', default='bios_viz.html',
                        help='Output HTML file (default: bios_viz.html)')
    args = parser.parse_args()

    if not os.path.isdir(args.root):
        print(f'Error: "{args.root}" is not a directory', file=sys.stderr)
        sys.exit(1)

    print(f'BIOSVIZ V2 — analyzing: {args.root}')
    data = build_graph(args.root)

    s = data['stats']
    print(f'\nAnalysis complete:')
    print(f'  Modules:   {s["modules"]}')
    print(f'  Files:     {s["files"]}')
    print(f'  Functions: {s["functions"]}')
    print(f'  Calls:     {s["calls"]}')

    try:
        html = build_html(data)
    except FileNotFoundError as e:
        print(f'\nWarning: {e}')
        print('Falling back to embedded template...')
        json_str = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
        html = HTML_SKELETON\
            .replace('{DATA}', json_str)\
            .replace('{CSS}', '')\
            .replace('{JS}', '')\
            .replace('{root_name}', 'BIOS')\
            .replace('{JOB_ID_JSON}', 'null')

    out = args.output
    Path(out).write_text(html, encoding='utf-8')
    size = Path(out).stat().st_size
    print(f'\nOutput: {out} ({size/1024:.0f} KB)')
    print(f'Open in Chrome: file:///{Path(out).absolute().as_posix()}')


if __name__ == '__main__':
    main()