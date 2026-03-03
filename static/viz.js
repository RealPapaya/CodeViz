/* viz.js — BIOSVIZ Visualization Logic v3
   Sourcetrail-style: graph on left, live source code on right.
   Uses cytoscape.js (canvas). No D3. No SVG renderer.
*/

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
    level: 0,        // 0=modules 1=files(subdirs) 1.5=files(subdir expanded) 2=functions
    tab: 'files',    // 'files' | 'calls'
    activeModule: null,
    activeSubDir: null,   // null = showing folder overview; string = inside a sub-folder
    activeFile: null,
    history: [],
    pinnedNodes: new Set(),
};

// Code panel state
const codeState = {
    jobId: window.JOB_ID || null,
    currentFile: null,
    currentFunc: null,
    funcLineMap: {},   // funcName -> lineIndex (0-based)
    funcList: [],      // list of {name, line} for current file
    funcIdx: 0,        // current func index in funcList
    isOpen: false,
};

let cy = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            try {
                const el = document.getElementById('viz-data');
                if (!el) { showMsg('Error: no data element found'); return; }

                document.getElementById('loading-msg').textContent = '🔍 Parsing graph data...';
                const t0 = performance.now();
                window.DATA = JSON.parse(el.textContent);
                console.log(`JSON.parse: ${(performance.now() - t0).toFixed(0)}ms`);

                if (!window.DATA?.stats) { showMsg('Error: invalid data format'); return; }

                const s = DATA.stats;
                document.getElementById('st-files').textContent = s.files.toLocaleString();
                document.getElementById('st-mods').textContent = s.modules;
                document.getElementById('st-funcs').textContent = s.functions.toLocaleString();

                buildSidebar();
                initCy();
                loadLevel0();

                document.getElementById('search').addEventListener('input', onSearch);
                document.addEventListener('keydown', onKey);
                document.addEventListener('click', () => hideCtxMenu());

                // Code panel init
                initCodePanel();
            } catch (e) {
                showMsg('Error: ' + e.message + '\n' + (e.stack || ''));
            }
        });
    });
});

function showMsg(msg) {
    const el = document.getElementById('loading');
    el.classList.add('show');
    document.querySelector('#loading .spinner').style.display = 'none';
    document.getElementById('loading-msg').textContent = msg;
}

// ─── Code Panel ──────────────────────────────────────────────────────────────
function initCodePanel() {
    document.getElementById('cp-close').onclick = closeCodePanel;

    document.getElementById('code-toggle-btn').onclick = () => {
        if (codeState.isOpen) closeCodePanel();
        else openCodePanel();
    };

    // Graph button: drill to caller/callee or go back to graph
    document.getElementById('graph-toggle-btn').onclick = () => {
        if (state.level === 2) {
            goBack();
        } else {
            drillCurrentFileToL2();
        }
    };

    document.getElementById('cp-prev-func').onclick = () => navigateFunc(-1);
    document.getElementById('cp-next-func').onclick = () => navigateFunc(1);

    // Resizer drag
    initResizer();
    initSidebarResizer();
}

// Drill the currently active file (code panel or selected node) to L2 caller/callee
function drillCurrentFileToL2() {
    // Priority: use code panel's current file if open
    const filePath = codeState.currentFile
        || (cy?.nodes(':selected').first().data('_f')?.path)
        || null;

    if (!filePath) {
        // Highlight the button to signal "select a file first"
        const btn = document.getElementById('graph-toggle-btn');
        btn.style.borderColor = '#f87171';
        btn.style.color = '#f87171';
        setTimeout(() => {
            btn.style.borderColor = '';
            btn.style.color = '';
        }, 900);
        return;
    }

    // If we're already at L2 for this file, just bring it into focus
    if (state.level === 2 && state.activeFile === filePath) return;

    // Need to be in L1 context first — find which module this file belongs to
    if (state.level < 1) {
        // Find module
        for (const m of DATA.modules) {
            const files = DATA.files_by_module[m.id] || [];
            if (files.some(f => f.path === filePath)) {
                drillToModule(m.id);
                break;
            }
        }
    }
    drillToFile(filePath);
    document.getElementById('graph-toggle-btn').classList.add('active');
}

function initResizer() {
    const resizer = document.getElementById('resizer');
    const panel = document.getElementById('code-panel');
    if (!resizer || !panel) return;
    let startX, startW;
    resizer.addEventListener('mousedown', e => {
        startX = e.clientX;
        startW = panel.offsetWidth;
        resizer.classList.add('dragging');
        panel.style.transition = 'none';
        document.getElementById('graph-wrap').style.pointerEvents = 'none'; // prevent iframe/canvas drag lag
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', stopDrag);
        e.preventDefault();
    });
    function onDrag(e) {
        const delta = startX - e.clientX; // drag left = wider panel
        const newW = Math.max(200, Math.min(1200, startW + delta));
        panel.style.width = newW + 'px';
        document.documentElement.style.setProperty('--code-panel', newW + 'px');
    }
    function stopDrag() {
        resizer.classList.remove('dragging');
        panel.style.transition = '';
        document.getElementById('graph-wrap').style.pointerEvents = '';
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', stopDrag);
        if (window.cy) cy.resize();
    }
}

function initSidebarResizer() {
    const resizer = document.getElementById('sidebar-resizer');
    const panel = document.getElementById('sidebar');
    if (!resizer || !panel) return;
    let startX, startW;
    resizer.addEventListener('mousedown', e => {
        startX = e.clientX;
        startW = panel.offsetWidth;
        resizer.classList.add('dragging');
        panel.style.transition = 'none';
        document.getElementById('graph-wrap').style.pointerEvents = 'none';
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', stopDrag);
        e.preventDefault();
    });
    function onDrag(e) {
        const delta = e.clientX - startX; // drag right = wider panel
        const newW = Math.max(150, Math.min(800, startW + delta));
        panel.style.width = newW + 'px';
        document.documentElement.style.setProperty('--sidebar', newW + 'px');
    }
    function stopDrag() {
        resizer.classList.remove('dragging');
        panel.style.transition = '';
        document.getElementById('graph-wrap').style.pointerEvents = '';
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', stopDrag);
        if (window.cy) cy.resize();
    }
}

function openCodePanel() {
    const panel = document.getElementById('code-panel');
    panel.classList.add('open');
    document.getElementById('code-toggle-btn').classList.add('active');
    codeState.isOpen = true;
    const resizer = document.getElementById('resizer');
    if (resizer) resizer.style.display = 'flex';
}

function closeCodePanel() {
    const panel = document.getElementById('code-panel');
    panel.classList.remove('open');
    document.getElementById('code-toggle-btn').classList.remove('active');
    codeState.isOpen = false;
    const resizer = document.getElementById('resizer');
    if (resizer) resizer.style.display = 'none';
}

// Load a file into the code panel; optionally jump to a function
async function loadFileInPanel(filePath, funcName) {
    if (!filePath) return;

    openCodePanel();
    const fname = filePath.split('/').pop();
    const ext = fname.includes('.') ? '.' + fname.split('.').pop().toLowerCase() : '';

    // Update header immediately
    document.getElementById('cp-filename').textContent = fname;
    document.getElementById('cp-filename').title = filePath;
    document.getElementById('cp-ext-badge').textContent = ext.toUpperCase() || 'FILE';
    document.getElementById('cp-ext-badge').style.background = extColor(ext);
    document.getElementById('cp-ext-badge').style.color = '#000';
    hideFuncBar();
    showCpLoading(true);

    // Fetch from server only if JOB_ID is available; else try file:// or show error
    if (!codeState.jobId) {
        showCpError('No job ID — code preview only available via the local server (launch.bat).');
        return;
    }

    if (filePath === codeState.currentFile) {
        // File already loaded — just scroll to function
        showCpLoading(false);
        if (funcName) jumpToFunc(funcName);
        return;
    }

    try {
        const url = `/file?job=${encodeURIComponent(codeState.jobId)}&path=${encodeURIComponent(filePath)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) {
            showCpError('Could not load file: ' + data.error);
            return;
        }
        codeState.currentFile = filePath;
        renderCode(data.content, ext, fname);
        showCpLoading(false);
        if (funcName) {
            setTimeout(() => jumpToFunc(funcName), 80);
        }
    } catch (e) {
        showCpError('Fetch error: ' + e.message);
    }
}

function extColor(ext) {
    const map = {
        // C/C++ / ASM
        '.c': '#3b82f6', '.cpp': '#06b6d4', '.cc': '#06b6d4',
        '.h': '#8b5cf6', '.hpp': '#7c3aed',
        '.asm': '#f59e0b', '.s': '#f59e0b', '.S': '#f59e0b', '.nasm': '#f59e0b',
        // UEFI / EDK2
        '.inf': '#ffd700', '.dec': '#00d4ff', '.dsc': '#e2e8f0', '.fdf': '#c084fc',
        // AMI 特有
        '.sdl': '#34d399', '.cif': '#60a5fa', '.mak': '#94a3b8',
        // HII (UEFI 標準 + AMI 擴充)
        '.vfr': '#f472b6',  // UEFI HII Form
        '.hfr': '#e940a0',  // AMI HII Form Resource (較深的籉红)
        '.uni': '#fb923c',  // Unicode 字串包
        // ACPI
        '.asl': '#a78bfa',
    };
    return map[ext] || '#64748b';
}

// ─── BIOS file type → cytoscape node shape ────────────────────────────────────
const FILE_TYPE_SHAPE = {
    'c_source': { sh: 'ellipse', w: 160, h: 48 },
    'header': { sh: 'round-rectangle', w: 155, h: 44 },
    'assembly': { sh: 'triangle', w: 120, h: 56 },
    'module_inf': { sh: 'diamond', w: 190, h: 60 },
    'package_dec': { sh: 'hexagon', w: 190, h: 58 },
    'platform_dsc': { sh: 'star', w: 160, h: 60 },
    'flash_desc': { sh: 'vee', w: 160, h: 56 },
    'ami_sdl': { sh: 'octagon', w: 170, h: 56 },
    'ami_cif': { sh: 'barrel', w: 160, h: 56 },
    'makefile': { sh: 'tag', w: 150, h: 46 },
    // HII ecosystem
    'hii_vfr': { sh: 'round-tag', w: 165, h: 50 },  // UEFI 標準 VFR 表單
    'hii_hfr': { sh: 'round-tag', w: 165, h: 50 },  // AMI HFR 擴充 (相同形狀但較深籉红色)
    'hii_form': { sh: 'round-tag', w: 165, h: 50 },  // backward compat
    'hii_string': { sh: 'round-rectangle', w: 155, h: 44 },  // UNI 字串包
    'acpi_asl': { sh: 'pentagon', w: 160, h: 56 },
    'other': { sh: 'round-rectangle', w: 155, h: 46 },
};

// ─── Edge type → color + style ───────────────────────────────────────────────
const EDGE_TYPE_STYLE = {
    'include': { color: '#c084fc', style: 'solid', label: 'Inc' },
    'sources': { color: '#ffd700', style: 'solid', label: 'Src' },
    'package': { color: '#00d4ff', style: 'dashed', label: 'Pkg' },
    'library': { color: '#a78bfa', style: 'dashed', label: 'Lib' },
    'elink': { color: '#ff6b35', style: 'dotted', label: 'ELINK' },
    'cif_own': { color: '#34d399', style: 'solid', label: 'owns' },
    'component': { color: '#60a5fa', style: 'solid', label: 'Comp' },
    'depex': { color: '#f472b6', style: 'dotted', label: 'Depex' },
    'guid_ref': { color: '#fb923c', style: 'dashed', label: 'GUID' },
    'str_ref': { color: '#e879f9', style: 'dashed', label: 'Strings' },
    'asl_include': { color: '#818cf8', style: 'solid', label: 'ASL' },
    'callback_ref': { color: '#f87171', style: 'dotted', label: 'Callback' },
    'hii_pkg': { color: '#94a3b8', style: 'solid', label: 'HII-Pkg' },
};

function fileNodeData(f, modColor) {
    const ft = f.file_type || 'other';
    const shape = FILE_TYPE_SHAPE[ft] || FILE_TYPE_SHAPE['other'];
    const baseColor = extColor(f.ext);

    // Build tooltip with BIOS metadata
    const bm = f.bios_meta || {};
    let ttLines = [`${f.path}`, `${f.ext.toUpperCase()} · ${fmtSize(f.size)}`];
    if (f.func_count > 0) ttLines.push(`${f.func_count} funcs`);
    if (bm.MODULE_TYPE || bm.module_type) ttLines.push(`Type: ${bm.MODULE_TYPE || bm.module_type}`);
    if (bm.BASE_NAME || bm.base_name) ttLines.push(`Module: ${bm.BASE_NAME || bm.base_name}`);
    if (bm.ENTRY_POINT || bm.entry_point) ttLines.push(`Entry: ${bm.ENTRY_POINT || bm.entry_point}`);
    if (bm.FILE_GUID || bm.file_guid) ttLines.push(`GUID: ${bm.FILE_GUID || bm.file_guid}`);

    return {
        id: `f${f.id}`, label: f.label,
        bg: '#0a1520', bc: baseColor,
        lvl: 1, w: shape.w, h: shape.h, sh: shape.sh,
        ft,
        tt: ttLines.join('\n'),
        _t: 'file', _f: f,
    };
}

function edgeTypeStyle(type) {
    return EDGE_TYPE_STYLE[type] || EDGE_TYPE_STYLE['include'];
}

function showCpLoading(v) {
    document.getElementById('cp-loading').classList.toggle('hidden', !v);
    document.getElementById('cp-empty').style.display = 'none';
    if (!v) document.getElementById('cp-code-wrap').style.display = '';
    else document.getElementById('cp-code-wrap').style.display = 'none';
}

function showCpError(msg) {
    document.getElementById('cp-loading').classList.add('hidden');
    document.getElementById('cp-code-wrap').style.display = 'none';
    const empty = document.getElementById('cp-empty');
    empty.style.display = '';
    empty.innerHTML = `<div class="cp-empty-icon">⚠</div><p>${msg}</p>`;
}

function renderCode(src, ext, fname) {
    const lines = src.split('\n');
    const hlExt = {
        // C / ASM
        '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.h': 'cpp', '.hpp': 'cpp',
        '.asm': 'x86asm', '.s': 'x86asm', '.S': 'x86asm',
        // UEFI module metadata — ini-like sections
        '.inf': 'ini', '.dec': 'ini', '.dsc': 'ini', '.fdf': 'ini',
        // AMI specific — ini-like
        '.sdl': 'ini', '.cif': 'ini', '.mak': 'makefile',
        // HII / ACPI
        '.vfr': 'c',       // VFR syntax is closest to C
        '.uni': 'plaintext', // UNI is custom; plaintext is safest
        '.asl': 'c',       // ASL/ACPI looks like C braces
    };
    const lang = hlExt[ext] || 'plaintext';

    // Build funcLineMap: scan for `funcName(` patterns
    codeState.funcLineMap = {};
    codeState.funcList = [];
    const funcDefs = DATA.funcs_by_file[codeState.currentFile] || [];
    funcDefs.forEach(f => {
        const pattern = new RegExp('\\b' + escapeRe(f.label) + '\\s*\\(');
        for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
                codeState.funcLineMap[f.label] = i;
                codeState.funcList.push({ name: f.label, line: i });
                break;
            }
        }
    });

    // Syntax-highlight with highlight.js if available
    let highlightedLines;
    if (window.hljs) {
        try {
            const result = hljs.highlight(src, { language: lang, ignoreIllegals: true });
            highlightedLines = result.value.split('\n');
        } catch (_) {
            highlightedLines = lines.map(l => escapeHtml(l));
        }
    } else {
        highlightedLines = lines.map(l => escapeHtml(l));
    }

    const wrap = document.getElementById('cp-code-wrap');
    const lineDivs = highlightedLines.map((hl, i) =>
        `<div class="code-line" id="cl-${i}"><span class="line-num">${i + 1}</span><span class="line-content">${hl}</span></div>`
    ).join('');

    wrap.innerHTML = `<pre><code class="hljs language-${lang}">${lineDivs}</code></pre>`;
    wrap.style.display = '';
}

function jumpToFunc(funcName) {
    const lineIdx = codeState.funcLineMap[funcName];
    if (lineIdx === undefined) return;

    // Update func bar
    const funcDefs = DATA.funcs_by_file[codeState.currentFile] || [];
    const fDef = funcDefs.find(f => f.label === funcName);
    if (fDef) {
        showFuncBar(fDef);
        codeState.currentFunc = funcName;
        const idx = codeState.funcList.findIndex(f => f.name === funcName);
        if (idx >= 0) codeState.funcIdx = idx;
    }

    // Highlight line
    document.querySelectorAll('.code-line.fn-highlight').forEach(el => el.classList.remove('fn-highlight'));
    const lineEl = document.getElementById(`cl-${lineIdx}`);
    if (lineEl) {
        lineEl.classList.add('fn-highlight');
        lineEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
}

function showFuncBar(fDef) {
    const bar = document.getElementById('cp-func-bar');
    bar.classList.add('visible');
    document.getElementById('cp-func-name').textContent = fDef.label + '()';
    const badge = document.getElementById('cp-func-badge');
    if (fDef.is_efiapi) {
        badge.className = 'cp-func-badge cp-func-efiapi';
        badge.textContent = 'EFIAPI';
    } else if (fDef.is_public) {
        badge.className = 'cp-func-badge cp-func-public';
        badge.textContent = 'PUBLIC';
    } else {
        badge.className = 'cp-func-badge cp-func-private';
        badge.textContent = 'STATIC';
    }
}

function hideFuncBar() {
    document.getElementById('cp-func-bar').classList.remove('visible');
    codeState.currentFunc = null;
}

function navigateFunc(dir) {
    const list = codeState.funcList;
    if (!list.length) return;
    codeState.funcIdx = (codeState.funcIdx + dir + list.length) % list.length;
    jumpToFunc(list[codeState.funcIdx].name);
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Cytoscape ────────────────────────────────────────────────────────────────
function initCy() {
    cy = cytoscape({
        container: document.getElementById('cy'),
        style: CY_STYLE,
        elements: [],
        minZoom: 0.04, maxZoom: 5,
        wheelSensitivity: 0.3,
        boxSelectionEnabled: false,
    });
    cy.on('tap', 'node', e => onNodeTap(e.target));
    cy.on('cxttap', 'node', e => onNodeRightClick(e, e.target));
    cy.on('mouseover', 'node', e => { showTooltip(e); highlightNode(e.target); });
    cy.on('mouseout', 'node', () => { hideTooltip(); clearHighlight(); });
    cy.on('tap', e => { if (e.target === cy) clearSelection(); });
    // // Double-tap a file node → drill to L2 (disabled per request)
    // cy.on('dbltap', 'node', e => {
    //     const d = e.target.data();
    //     if (d._t === 'file' && d._f?.path) drillToFile(d._f.path);
    // });
    document.getElementById('cy').addEventListener('contextmenu', e => e.preventDefault());
}

function clearSelection() {
    clearHighlight();
    document.querySelectorAll('.code-line.fn-highlight').forEach(el => el.classList.remove('fn-highlight'));
}

function highlightNode(node) {
    cy.elements().addClass('faded');
    node.removeClass('faded').addClass('hl');
    const outEdges = node.outgoers('edge');
    outEdges.removeClass('faded').addClass('hl-edge-out');
    outEdges.targets().removeClass('faded').addClass('hl-node-out');
    const inEdges = node.incomers('edge');
    inEdges.removeClass('faded').addClass('hl-edge-in');
    inEdges.sources().removeClass('faded').addClass('hl-node-in');
}

function clearHighlight() {
    cy.elements().removeClass('faded hl hl-edge-out hl-edge-in hl-node-out hl-node-in');
}

const CY_STYLE = [
    {
        selector: 'node', style: {
            'background-color': 'data(bg)',
            'border-width': 2, 'border-color': 'data(bc)',
            'label': 'data(label)',
            'color': '#e2e8f0', 'font-size': 11,
            'text-valign': 'center', 'text-halign': 'center',
            'text-wrap': 'wrap', 'text-max-width': 160,
            'width': 'data(w)', 'height': 'data(h)',
            'shape': 'data(sh)',
        }
    },
    { selector: 'node[lvl=0]', style: { 'font-size': 12, 'font-weight': 'bold' } },
    { selector: 'node[lvl=1]', style: { 'font-size': 10 } },
    { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#00d4ff', 'overlay-opacity': 0.12 } },
    // BIOS file type — highlighted border tint
    { selector: 'node[ft="module_inf"]', style: { 'border-width': 2.5 } },
    { selector: 'node[ft="package_dec"]', style: { 'border-width': 2.5 } },
    { selector: 'node[ft="ami_cif"]', style: { 'border-width': 2.5 } },
    { selector: 'node[ft="ami_sdl"]', style: { 'border-width': 2.5 } },
    // Default edge
    {
        selector: 'edge', style: {
            'width': 'data(w)',
            'line-color': 'data(ec)',
            'line-style': 'data(es)',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': 'data(ec)',
            'curve-style': 'bezier',
            'opacity': 0.75,
            // Edge label — floating badge, readable on dark background
            'label': 'data(el)',
            'font-size': 10,
            'font-weight': '700',
            'font-family': 'monospace',
            'color': 'data(ec)',
            'text-opacity': 1,
            'text-rotation': 'autorotate',
            'text-margin-y': -11,
            'text-background-color': '#020509',
            'text-background-opacity': 0.92,
            'text-background-padding': '3px',
            'text-background-shape': 'round-rectangle',
            'text-border-width': 1.5,
            'text-border-color': 'data(ec)',
            'text-border-opacity': 0.8,
        }
    },
    { selector: '.faded', style: { 'opacity': 0.06 } },
    { selector: '.hl', style: { 'opacity': 1, 'border-width': 2.5, 'border-color': '#e2e8f0' } },
    {
        selector: '.hl-edge-out', style: {
            'opacity': 1, 'width': 3, 'z-index': 10,
        }
    },
    {
        selector: '.hl-edge-in', style: {
            'opacity': 1, 'width': 3, 'z-index': 10,
        }
    },
    { selector: '.hl-node-out', style: { 'border-width': 3, 'opacity': 1 } },
    { selector: '.hl-node-in', style: { 'border-width': 3, 'opacity': 1 } },
];

// ─── File Type Filter ────────────────────────────────────────────────────────
const FT_GROUPS = [
    { key: 'c_source', label: '.c/.cpp', exts: ['.c', '.cpp', '.cc'] },
    { key: 'header', label: '.h/.hpp', exts: ['.h', '.hpp'] },
    { key: 'assembly', label: '.asm/.s', exts: ['.asm', '.s', '.S', '.nasm'] },
    { key: 'module_inf', label: '.inf', exts: ['.inf'] },
    { key: 'package_dec', label: '.dec', exts: ['.dec'] },
    { key: 'platform_dsc', label: '.dsc', exts: ['.dsc'] },
    { key: 'flash_desc', label: '.fdf', exts: ['.fdf'] },
    { key: 'ami_sdl', label: '.sdl', exts: ['.sdl'] },
    { key: 'ami_cif', label: '.cif', exts: ['.cif'] },
    { key: 'makefile', label: '.mak', exts: ['.mak'] },
    { key: 'hii_vfr', label: '.vfr', exts: ['.vfr'] },
    { key: 'hii_hfr', label: '.hfr', exts: ['.hfr'] },
    { key: 'hii_string', label: '.uni', exts: ['.uni'] },
    { key: 'acpi_asl', label: '.asl', exts: ['.asl'] },
];
// 預設全部勾選顯示
const ftActiveFilter = new Set([
    'c_source', 'header', 'assembly', 'module_inf', 'package_dec',
    'platform_dsc', 'flash_desc', 'ami_sdl', 'ami_cif', 'makefile',
    'hii_vfr', 'hii_hfr', 'hii_string', 'acpi_asl'
]);

function buildFtFilter() {
    const wrap = document.getElementById('ft-filter');
    if (!wrap) return;

    // Detect which types actually exist in data
    const presentTypes = new Set();
    Object.values(DATA.files_by_module).forEach(files =>
        files.forEach(f => presentTypes.add(f.file_type || 'other'))
    );

    const groups = FT_GROUPS.filter(g => presentTypes.has(g.key));
    if (!groups.length) return;

    wrap.innerHTML = '<div class="ft-filter-title">File Types</div>' +
        groups.map(g => {
            const col = extColor(g.exts[0]);
            const checked = ftActiveFilter.has(g.key) ? 'checked' : '';
            return `<label class="ft-chip" style="--ft-col:${col}">
  <input type="checkbox" data-ft="${g.key}" ${checked}>
  <span class="ft-dot" style="background:${col}"></span>
  <span>${g.label}</span>
</label>`;
        }).join('');

    wrap.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', () => {
            if (cb.checked) ftActiveFilter.add(cb.dataset.ft);
            else ftActiveFilter.delete(cb.dataset.ft);
            // Re-render current view
            if (state.level === 1 && state.activeModule) {
                const allFiles = DATA.files_by_module[state.activeModule] || [];
                const filtered = state.activeSubDir
                    ? allFiles.filter(f => f.path.startsWith(state.activeModule + '/' + state.activeSubDir + '/'))
                    : allFiles;
                renderFilesFlat(state.activeModule, filtered);
            }
        });
    });
}

// ─── Sidebar tree ─────────────────────────────────────────────────────────────
// Builds a tree in the sidebar: Module → sub-folders (expandable)
// Graph always shows file nodes only.

function buildSidebar() {
    const list = document.getElementById('module-list');
    list.innerHTML = '';
    buildFtFilter();
    DATA.modules.forEach(m => {
        const allFiles = DATA.files_by_module[m.id] || [];
        const tree = buildFileTree(allFiles, m.id);
        const hasSubdirs = tree.children.length > 0;

        // ── Module row ──
        const modRow = document.createElement('div');
        modRow.className = 'tree-row mod-row';
        modRow.id = `mi-${m.id}`;
        modRow.innerHTML =
            `<span class="tree-arrow ${hasSubdirs ? '▶' : 'leaf'}">▶</span>` +
            `<span class="mod-dot" style="background:${m.color}"></span>` +
            `<span class="mod-name" title="${m.id}">${m.id}</span>` +
            `<span class="mod-count">${m.file_count}</span>`;

        // ── Sub-folder children container ──
        const children = document.createElement('div');
        children.className = 'tree-children';

        if (hasSubdirs) {
            buildTreeRows(children, tree, m.id, m.color, 0);
        }

        // Module click → show ALL files for this module (no filter)
        modRow.addEventListener('click', () => {
            const arrow = modRow.querySelector('.tree-arrow');
            const isOpen = children.classList.contains('open');

            if (hasSubdirs) {
                children.classList.toggle('open', !isOpen);
                arrow.classList.toggle('open', !isOpen);
            }
            // Always render all files in graph when clicking module name
            drillToModule(m.id);
        });

        list.appendChild(modRow);
        list.appendChild(children);
    });
}

// Recursively build a virtual tree node from flat file list
// Returns { name, path, files:[], children:[] }
function buildFileTree(files, modId) {
    const root = { name: modId, path: '', files: [], children: [] };
    const nodeMap = { '': root };

    function ensureNode(parts, upTo) {
        const key = parts.slice(0, upTo + 1).join('/');
        if (!nodeMap[key]) {
            const parent = nodeMap[parts.slice(0, upTo).join('/') || ''];
            const node = { name: parts[upTo], path: key, files: [], children: [] };
            parent.children.push(node);
            nodeMap[key] = node;
        }
        return nodeMap[key];
    }

    files.forEach(f => {
        // Path relative to module: strip "ModuleId/"
        const prefix = modId + '/';
        const rel = f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path;
        const parts = rel.split('/');
        if (parts.length === 1) {
            // root-level file
            root.files.push(f);
        } else {
            // Walk every directory part
            for (let i = 0; i < parts.length - 1; i++) {
                ensureNode(parts, i);
            }
            const dirKey = parts.slice(0, -1).join('/');
            nodeMap[dirKey].files.push(f);
        }
    });
    return root;
}

// Recursively create sidebar rows for a tree node's children
function buildTreeRows(container, node, modId, modColor, depth) {
    node.children.forEach(child => {
        const fileCount = countFiles(child);
        const hasKids = child.children.length > 0;
        const indent = 20 + depth * 14; // px left indent

        // Sub-folder row
        const row = document.createElement('div');
        row.className = 'tree-row subdir-row';
        row.dataset.modId = modId;
        row.dataset.subPath = child.path;
        row.innerHTML =
            `<span style="flex-shrink:0;width:${indent}px"></span>` +
            `<span class="tree-arrow ${hasKids ? '' : 'leaf'}">▶</span>` +
            `<span class="subdir-icon">📁</span>` +
            `<span class="subdir-name" title="${modId}/${child.path}">${child.name}</span>` +
            `<span class="subdir-count">${fileCount}</span>`;

        const subChildren = document.createElement('div');
        subChildren.className = 'tree-children';

        if (hasKids) {
            buildTreeRows(subChildren, child, modId, modColor, depth + 1);
        }

        row.addEventListener('click', e => {
            e.stopPropagation();
            const arrow = row.querySelector('.tree-arrow');
            const isOpen = subChildren.classList.contains('open');

            if (hasKids) {
                subChildren.classList.toggle('open', !isOpen);
                arrow.classList.toggle('open', !isOpen);
            }
            // Show files under this path in graph
            filterGraphToSubPath(modId, child.path);
            setSubdirActive(modId, child.path);
        });

        container.appendChild(row);
        container.appendChild(subChildren);
    });
}

function countFiles(node) {
    return node.files.length + node.children.reduce((s, c) => s + countFiles(c), 0);
}

function setSubdirActive(modId, subPath) {
    document.querySelectorAll('.subdir-row').forEach(el => el.classList.remove('active'));
    const row = document.querySelector(`.subdir-row[data-mod-id="${modId}"][data-sub-path="${subPath}"]`);
    if (row) row.classList.add('active');
}

// Show files under a given sub-path (all depths) in the graph
function filterGraphToSubPath(modId, subPath) {
    state.activeSubDir = subPath;
    const prefix = modId + '/' + subPath + '/';
    const allFiles = DATA.files_by_module[modId] || [];
    // Include files directly in this dir AND in any nested dirs
    const filtered = allFiles.filter(f => f.path.startsWith(prefix) || f.path === modId + '/' + subPath);
    renderFilesFlat(modId, filtered);
    updateBreadcrumb();
}

// ─── L0: Module View ──────────────────────────────────────────────────────────
function loadLevel0() {
    showLoading(true, 'Rendering modules...');
    hideFuncView();
    state.level = 0; state.activeModule = null; state.activeFile = null; state.activeSubDir = null;
    updateBreadcrumb(); setSidebarActive(null);

    const els = [];
    DATA.modules.forEach(m => {
        els.push({
            data: {
                id: m.id, label: `${m.id}\n${m.file_count} files`,
                bg: m.color + '18', bc: m.color, lvl: 0,
                w: 190, h: 68, sh: 'roundrectangle',
                tt: `${m.id}\nFiles: ${m.file_count} | Funcs: ${m.func_count}`,
                _t: 'module', _m: m,
            }
        });
    });
    const edges = [...DATA.module_edges].sort((a, b) => b.weight - a.weight).slice(0, 300);
    edges.forEach((e, i) => {
        els.push({
            data: {
                id: `me${i}`, source: e.s, target: e.t,
                w: Math.max(1, Math.min(6, e.weight / 8)), wt: e.weight,
                ec: '#2a3a55', es: 'solid', el: '',
            }
        });
    });

    cy.elements().remove();
    cy.add(els);

    const lay = cy.layout({
        name: 'cose', animate: false, randomize: true,
        nodeRepulsion: 10000, idealEdgeLength: 200, nodeOverlap: 20, padding: 60,
    });
    lay.one('layoutstop', () => showLoading(false));
    lay.run();
}

// ─── L1: Module → show ALL files flat (no folder nodes ever) ─────────────────
function drillToModule(modId) {
    if (state.level === 0) state.history.push({ level: 0 });
    state.level = 1; state.activeModule = modId; state.activeSubDir = null;
    showLoading(true, `Loading ${modId}...`);
    hideFuncView(); setSidebarActive(modId);
    // Clear sub-dir active highlight
    document.querySelectorAll('.subdir-row').forEach(el => el.classList.remove('active'));

    const allFiles = DATA.files_by_module[modId] || [];
    renderFilesFlat(modId, allFiles);
}

// Render flat file nodes in graph — the only graph view for L1
function renderFilesFlat(modId, files) {
    // Apply File Type Filter
    const visible = files.filter(f => ftActiveFilter.has(f.file_type || 'other') || ftActiveFilter.size === 0);
    const capped = visible.slice(0, 250);
    const visIds = new Set(capped.map(f => f.id));
    const allEdges = DATA.file_edges_by_module[modId] || [];
    const edges = allEdges
        .filter(e => visIds.has(e.s) && visIds.has(e.t)).slice(0, 600);

    const els = [];
    capped.forEach(f => {
        els.push({ data: fileNodeData(f) });
    });
    edges.forEach((e, i) => {
        const es = edgeTypeStyle(e.type);
        els.push({
            data: {
                id: `fe${i}`,
                source: `f${e.s}`, target: `f${e.t}`,
                w: e.type === 'include' ? 1 : 1.5,
                ec: es.color, es: es.style, el: es.label,
                etype: e.type || 'include',
            }
        });
    });

    cy.elements().remove();
    cy.add(els);

    const lay = cy.layout({ name: 'dagre', rankDir: 'LR', animate: false, nodeSep: 30, rankSep: 90, padding: 40 });
    lay.one('layoutstop', () => { updateBreadcrumb(); showLoading(false); });
    lay.run();
}

// ─── L2: Function View ────────────────────────────────────────────────────────
function drillToFile(fileRel) {
    state.history.push({ level: 1, activeModule: state.activeModule });
    state.level = 2; state.activeFile = fileRel;
    updateBreadcrumb();

    const funcs = DATA.funcs_by_file[fileRel] || [];
    const edges = DATA.func_edges_by_file[fileRel] || [];
    // showFuncView handles code panel sync — do NOT call loadFileInPanel separately
    funcs.length === 0 ? showFuncViewEmpty(fileRel) : showFuncView(fileRel, funcs, edges, 0);
}

// Dedicated code-panel sync — called only from showFuncView to avoid race conditions
async function _syncCodePanel(fileRel, funcName) {
    if (!fileRel) return;
    openCodePanel();

    const fname = fileRel.split('/').pop();
    const ext = fname.includes('.') ? '.' + fname.split('.').pop().toLowerCase() : '';

    document.getElementById('cp-filename').textContent = fname;
    document.getElementById('cp-filename').title = fileRel;
    document.getElementById('cp-ext-badge').textContent = ext.toUpperCase() || 'FILE';
    document.getElementById('cp-ext-badge').style.background = extColor(ext);
    document.getElementById('cp-ext-badge').style.color = '#000';
    hideFuncBar();

    if (!codeState.jobId) {
        showCpError('No job ID — code preview only available via the local server (launch.bat).');
        return;
    }

    if (fileRel === codeState.currentFile) {
        // File already rendered — just jump to function
        if (funcName) {
            // Use a small delay to ensure DOM is stable after showFuncView re-render
            requestAnimationFrame(() => jumpToFunc(funcName));
        }
        return;
    }

    // New file — fetch and render
    showCpLoading(true);
    try {
        const url = `/file?job=${encodeURIComponent(codeState.jobId)}&path=${encodeURIComponent(fileRel)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) { showCpError('Could not load file: ' + data.error); return; }
        codeState.currentFile = fileRel;
        renderCode(data.content, ext, fname);
        showCpLoading(false);
        if (funcName) requestAnimationFrame(() => jumpToFunc(funcName));
    } catch (e) {
        showCpError('Fetch error: ' + e.message);
    }
}

function showFuncView(fileRel, funcs, edges, centerIdx) {
    hideTooltip(); // ensure tooltip is cleared when entering func view
    const center = funcs[centerIdx];
    const callers = dedupeBy(edges.filter(e => e.t === centerIdx).map(e => funcs[e.s]).filter(Boolean), 'label').slice(0, 8);
    const callees = dedupeBy(edges.filter(e => e.s === centerIdx).map(e => funcs[e.t]).filter(Boolean), 'label').slice(0, 8);

    cy.elements().remove();
    document.getElementById('cy').style.display = 'none';

    const fv = document.getElementById('func-view');
    fv.classList.add('active');

    const accessCls = center.is_public ? 'access-public' : 'access-private';
    const accessLbl = center.is_public ? '🔓 PUBLIC' : '🔒 PRIVATE';

    const fileName = fileRel.split('/').pop();   // just the filename, e.g. "Dhcp4Driver.c"

    // Store fileRel on the container to avoid inline-JS quoting issues
    fv.dataset.fileRel = fileRel;

    let pillHtml = '';
    funcs.slice(0, 24).forEach((f, i) => {
        const baseCls = f.is_efiapi ? 'pill-yellow' : f.is_public ? 'pill-blue' : 'pill-gray';
        const activeCls = i === centerIdx ? ' pill-active' : '';
        pillHtml += `<span class="pill ${baseCls}${activeCls}" id="pill-${i}" data-func-idx="${i}">${f.label}</span>`;
    });

    fv.innerHTML = `
    <div class="fv-col">
      <div class="fv-col-label">◀ Callers</div>
      ${callers.map(f => fnCard(f, funcs.indexOf(f))).join('') || '<div class="fv-empty">No callers</div>'}
    </div>
    <div class="fv-center">
      <div class="fv-center-header">${fileName}</div>
      <div class="access-strip ${accessCls}">${accessLbl}</div>
      <div class="fv-center-pills">${pillHtml}</div>
    </div>
    <div class="fv-col">
      <div class="fv-col-label">Callees ▶</div>
      ${callees.map(f => fnCard(f, funcs.indexOf(f))).join('') || '<div class="fv-empty">No callees</div>'}
    </div>`;

    // Re-attach dataset after innerHTML wipe
    fv.dataset.fileRel = fileRel;

    // Sync code: load file and jump to selected function
    _syncCodePanel(fileRel, center.label);
}

function fnCard(f, idx) {
    const cls = f.is_efiapi ? 'pill-yellow' : f.is_public ? 'pill-blue' : 'pill-gray';
    const lbl = f.is_efiapi ? 'EFIAPI' : f.is_public ? 'public' : 'static';
    // Use data-func-idx; fileRel is read from fv.dataset.fileRel in the click handler
    return `<div class="fv-node" data-func-idx="${idx}">
    <div class="fn-name">${f.label}</div>
    <span class="fn-badge ${cls}">${lbl}</span>
  </div>`;
}

function focusFunc(fileRel, idx) {
    const funcs = DATA.funcs_by_file[fileRel] || [];
    const edges = DATA.func_edges_by_file[fileRel] || [];
    if (funcs[idx]) {
        showFuncView(fileRel, funcs, edges, idx);
        // _syncCodePanel is called inside showFuncView
    }
}

// Event delegation for fv-node and pill clicks (avoids inline-JS quoting issues)
document.addEventListener('click', e => {
    const fv = document.getElementById('func-view');
    if (!fv) return;
    const fileRel = fv.dataset.fileRel;
    if (!fileRel) return;

    const target = e.target.closest('[data-func-idx]');
    if (target && fv.contains(target)) {
        const idx = parseInt(target.dataset.funcIdx, 10);
        focusFunc(fileRel, idx);
    }
});

function showFuncViewEmpty(fileRel) {
    cy.elements().remove();
    document.getElementById('cy').style.display = 'none';
    const fv = document.getElementById('func-view');
    fv.classList.add('active');
    fv.innerHTML = `<div style="text-align:center;color:var(--muted);padding:60px">
    <div style="font-size:48px;margin-bottom:16px">📄</div>
    <div style="font-size:14px">${fileRel.split('/').pop()}</div>
    <div style="font-size:12px;margin-top:8px">No functions found</div>
  </div>`;
}

function hideFuncView() {
    const fv = document.getElementById('func-view');
    fv.classList.remove('active');
    fv.innerHTML = '';
    document.getElementById('cy').style.display = '';
    // Clear graph-toggle active state when leaving L2
    document.getElementById('graph-toggle-btn')?.classList.remove('active');
}

// ─── Node Tap ─────────────────────────────────────────────────────────────────
function onNodeTap(node) {
    clearHighlight();
    const d = node.data();

    if (state.level === 0 && d._t === 'module') {
        drillToModule(d._m.id);
        return;
    }

    if (d._t === 'file') {
        // Single click → code panel preview
        if (d._f?.path) loadFileInPanel(d._f.path);
        highlightNode(node);
        return;
    }

    // Persistent highlight for other node types
    cy.elements().addClass('faded');
    node.removeClass('faded').addClass('hl');
    const outEdges = node.outgoers('edge');
    outEdges.removeClass('faded').addClass('hl-edge-out');
    outEdges.targets().removeClass('faded').addClass('hl-node-out');
    const inEdges = node.incomers('edge');
    inEdges.removeClass('faded').addClass('hl-edge-in');
    inEdges.sources().removeClass('faded').addClass('hl-node-in');
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function goBack() {
    const prev = state.history.pop();
    if (!prev) return;
    cy.elements().removeClass('faded hl');
    hideFuncView();
    if (prev.level === 0) {
        loadLevel0();
    } else if (prev.level === 1) {
        const savedHistory = [...state.history];
        drillToModule(prev.activeModule);
        state.history = savedHistory;
    }
}

window.goLevel = function (n) {
    if (n === 0) { state.history = []; loadLevel0(); }
    else if (n === 1 && state.activeModule) {
        hideFuncView(); state.history = [{ level: 0 }]; drillToModule(state.activeModule);
    }
};

window.switchTab = function (tab) {
    state.tab = tab;
    document.getElementById('tab-files').classList.toggle('active', tab === 'files');
    document.getElementById('tab-calls').classList.toggle('active', tab === 'calls');
    state.history = []; loadLevel0();
};

window.goBack = goBack;

function updateBreadcrumb() {
    const container = document.getElementById('bc-items');
    container.innerHTML = '';

    function addSeg(label, clickFn, isCurrent) {
        if (container.children.length > 0) {
            const sep = document.createElement('span');
            sep.className = 'bc-sep';
            sep.textContent = '›';
            container.appendChild(sep);
        }
        const seg = document.createElement('span');
        seg.className = 'bc-item' + (isCurrent ? ' bc-current' : '');
        seg.textContent = label;
        if (clickFn) seg.onclick = clickFn;
        container.appendChild(seg);
    }

    // Level 0: always show Modules
    addSeg('Modules', () => { state.history = []; loadLevel0(); }, state.level === 0);

    if (state.level >= 1 && state.activeModule) {
        const isModActive = state.level === 1 && !state.activeSubDir;
        addSeg(state.activeModule,
            isModActive ? null : () => {
                if (state.level >= 2) {
                    const h = [...state.history]; drillToModule(state.activeModule); state.history = h;
                } else {
                    drillToModule(state.activeModule);
                }
            },
            isModActive);
    }

    // Level 1: Sub-directory
    if (state.level === 1 && state.activeSubDir) {
        const parts = state.activeSubDir.split('/');
        parts.forEach((part, i) => {
            const isLast = i === parts.length - 1;
            const subPath = parts.slice(0, i + 1).join('/');
            addSeg(part,
                isLast ? null : () => {
                    filterGraphToSubPath(state.activeModule, subPath);
                    setSubdirActive(state.activeModule, subPath);
                },
                isLast);
        });
    }

    // Level 2: File (functions)
    if (state.level >= 2 && state.activeFile) {
        // Build all path segments between module and filename
        const modId = state.activeModule || '';
        const full = state.activeFile;              // e.g. "AmiNetworkPkg/Dhcp4Dxe/Dhcp4Driver.c"
        const prefix = modId ? modId + '/' : '';
        const rel = full.startsWith(prefix) ? full.slice(prefix.length) : full;
        // rel = "Dhcp4Dxe/Dhcp4Driver.c"
        const parts = rel.split('/');              // ["Dhcp4Dxe", "Dhcp4Driver.c"]

        parts.forEach((part, i) => {
            const isLast = i === parts.length - 1;
            const subPath = parts.slice(0, i + 1).join('/');
            addSeg(part,
                isLast ? null : () => {
                    state.level = 1;
                    hideFuncView();
                    filterGraphToSubPath(state.activeModule, subPath);
                    setSubdirActive(state.activeModule, subPath);
                },
                isLast);
        });
    }

    document.getElementById('back-btn').classList.toggle('visible', state.level > 0);

    // Update graph-toggle-btn text depending on whether we are in Call Graph (level 2) or File Graph (level 1)
    const graphBtn = document.getElementById('graph-toggle-btn');
    if (graphBtn) {
        const isLevel2 = state.level >= 2;
        const newHtml = isLevel2 ? '⬡ Dependency Map' : '⬡ Call Graph';
        const newTitle = isLevel2 ? 'Back to Dependency Map' : 'View Call Graph for Selected File';

        if (graphBtn.innerHTML !== newHtml) {
            // Trigger flip animation
            graphBtn.classList.remove('flip-animate');
            void graphBtn.offsetWidth; // trigger reflow
            graphBtn.innerHTML = newHtml;
            graphBtn.title = newTitle;
            graphBtn.classList.add('flip-animate');
        }
    }
}

function setSidebarActive(modId) {
    document.querySelectorAll('.mod-row').forEach(el => el.classList.remove('active'));
    if (modId) {
        const el = document.getElementById(`mi-${modId}`);
        if (el) el.classList.add('active');
    }
}

// ─── Search ───────────────────────────────────────────────────────────────────
function onSearch(e) {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { cy.elements().removeClass('faded hl'); return; }
    cy.elements().addClass('faded');
    cy.nodes().forEach(n => { if (n.data('label').toLowerCase().includes(q)) n.removeClass('faded').addClass('hl'); });
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────
function onKey(e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === '/') { e.preventDefault(); document.getElementById('search').focus(); }
    if (e.key === 'Escape') {
        document.getElementById('search').value = '';
        cy.elements().removeClass('faded hl');
        goBack();
    }
    if (e.key === 'm' || e.key === 'M') { state.history = []; loadLevel0(); }
    if (e.key === 'c' || e.key === 'C') { document.getElementById('code-toggle-btn').click(); }
    if (e.key === 'g' || e.key === 'G') { drillCurrentFileToL2(); }
    if (e.key === 'ArrowLeft') navigateFunc(-1);
    if (e.key === 'ArrowRight') navigateFunc(1);
}

// ─── Context Menu ─────────────────────────────────────────────────────────────
function onNodeRightClick(ev, node) {
    ev.originalEvent.preventDefault();
    const menu = document.getElementById('ctx-menu');
    menu.style.display = 'block';
    menu.style.left = ev.originalEvent.clientX + 'px';
    menu.style.top = ev.originalEvent.clientY + 'px';

    document.getElementById('ctx-copy').onclick = () => {
        const d = node.data();
        navigator.clipboard?.writeText(d._f?.path || d._m?.id || d.label).catch(() => { });
        hideCtxMenu();
    };
    document.getElementById('ctx-open-code').onclick = () => {
        const d = node.data();
        if (d._f?.path) loadFileInPanel(d._f.path);
        else if (d._t === 'module') drillToModule(d._m.id);
        hideCtxMenu();
    };
    document.getElementById('ctx-vscode').onclick = () => {
        const d = node.data();
        if (d._f?.path) {
            const root = DATA.stats.root;
            const abs = root.replace(/\//g, '\\') + '\\' + d._f.path.replace(/\//g, '\\');
            window.open(`vscode://file/${abs}`);
        }
        hideCtxMenu();
    };
    document.getElementById('ctx-module-only').onclick = () => {
        const d = node.data();
        if (d._t === 'module') drillToModule(d._m.id);
        hideCtxMenu();
    };
    document.getElementById('ctx-pin').onclick = () => {
        const id = node.id();
        if (state.pinnedNodes.has(id)) { state.pinnedNodes.delete(id); node.unlock(); }
        else { state.pinnedNodes.add(id); node.lock(); }
        hideCtxMenu();
    };
}

function hideCtxMenu() { document.getElementById('ctx-menu').style.display = 'none'; }

// ─── Tooltip ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function (m) {
        switch (m) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#039;';
            default: return m;
        }
    });
}

function showTooltip(e) {
    const d = e.target.data();
    if (!d || !d.tt) return;

    let html = '';

    if (e.target.isNode()) {
        const outCount = e.target.outgoers('edge').length;
        const inCount = e.target.incomers('edge').length;

        // 取得 tooltip 原文字的第一行 (標題/路徑) 和剩餘內容
        const lines = d.tt.split('\n');
        const titleRaw = lines[0] || '';
        const bodyLines = lines.slice(1).join('<br>').trim();

        // 1. 處理檔名過長 (使用 css ellipsis 或截斷)
        // 這裡加上 max-width 強制斷掉加上 '...'
        html += `<div style="font-weight:bold; max-width:280px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(titleRaw)}">${escapeHtml(titleRaw)}</div>`;

        if (bodyLines) {
            html += `<div style="margin-top:6px; font-size:11px; color:#cbd5e1;">${bodyLines}</div>`;
        }

        // 2. 處理 dependencies 文字和顏色
        if (outCount > 0 || inCount > 0) {
            html += `<div style="margin-top:10px; border-top:1px solid #334155; padding-top:6px;">`;
            html += `<div style="font-weight:bold; margin-bottom:4px">Dependencies:</div>`;

            const OUT_MAP = {
                'Inc': 'Include', 'owns': 'owns', 'Src': 'sources', 'Pkg': 'package', 'Lib': 'library',
                'ELINK': 'elink', 'Comp': 'component', 'GUID': 'guid ref',
                'Strings': 'strings', 'ASL': 'asl include', 'Callback': 'callback',
                'HII-Pkg': 'hii pkg', 'Depex': 'depex',
                '': state.level === 2 ? 'calls' : 'includes'
            };
            const IN_MAP = {
                'Inc': 'Included by', 'owns': 'owned by', 'Src': 'source of', 'Pkg': 'packaged in', 'Lib': 'used as lib by',
                'ELINK': 'elink parent of', 'Comp': 'used as comp by', 'GUID': 'referenced guid by',
                'Strings': 'referenced as string by', 'ASL': 'included by asl', 'Callback': 'triggered by',
                'HII-Pkg': 'packaged in hii', 'Depex': 'depended by',
                '': state.level === 2 ? 'called by' : 'included by'
            };

            const outGroups = {};
            e.target.outgoers('edge').forEach(edge => {
                const lbl = edge.data('el') || '';
                const col = edge.data('ec') || '#f59e0b';
                const outTxt = OUT_MAP[lbl] || lbl || 'outgoing';
                const key = outTxt + '|' + col;
                outGroups[key] = (outGroups[key] || 0) + 1;
            });

            const inGroups = {};
            e.target.incomers('edge').forEach(edge => {
                const lbl = edge.data('el') || '';
                const col = edge.data('ec') || '#10b981';
                const inTxt = IN_MAP[lbl] || lbl || 'incoming';
                const key = inTxt + '|' + col;
                inGroups[key] = (inGroups[key] || 0) + 1;
            });

            for (const [key, count] of Object.entries(outGroups)) {
                const [lbl, col] = key.split('|');
                html += `<div style="color:${col}">• ${lbl}: ${count}</div>`;
            }
            for (const [key, count] of Object.entries(inGroups)) {
                const [lbl, col] = key.split('|');
                html += `<div style="color:${col}">• ${lbl}: ${count}</div>`;
            }

            html += `</div>`;
        }
    } else {
        // Edge tooltip
        html = escapeHtml(d.tt).replace(/\n/g, '<br>');
    }

    const tip = document.getElementById('tooltip');
    tip.innerHTML = html;
    tip.style.display = 'block';
    tip.style.left = (e.originalEvent.clientX + 14) + 'px';
    tip.style.top = (e.originalEvent.clientY + 14) + 'px';
}
function hideTooltip() { document.getElementById('tooltip').style.display = 'none'; }

// ─── Loading ──────────────────────────────────────────────────────────────────
function showLoading(v, msg) {
    const el = document.getElementById('loading');
    const sp = document.querySelector('#loading .spinner');
    el.classList.toggle('show', v);
    if (v && msg) document.getElementById('loading-msg').textContent = msg;
    if (sp) sp.style.display = '';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function dedupeBy(arr, key) { return [...new Map(arr.map(x => [x[key], x])).values()]; }
function fmtSize(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + 'MB' : b > 1e3 ? (b / 1e3).toFixed(0) + 'KB' : b + 'B'; }

// ─── Graph Legend ─────────────────────────────────────────────────────────────
// Edge types shown in legend
const LEGEND_EDGES = [
    { type: 'include', label: 'Include', color: '#c084fc', style: 'solid' },
    { type: 'sources', label: 'Src', color: '#ffd700', style: 'solid' },
    { type: 'package', label: 'Pkg', color: '#00d4ff', style: 'dashed' },
    { type: 'library', label: 'Lib', color: '#a78bfa', style: 'dashed' },
    { type: 'cif_own', label: 'owns', color: '#34d399', style: 'solid' },
    { type: 'component', label: 'Comp', color: '#60a5fa', style: 'solid' },
    { type: 'guid_ref', label: 'GUID', color: '#fb923c', style: 'dashed' },
    { type: 'elink', label: 'ELINK', color: '#ff6b35', style: 'dotted' },
    { type: 'str_ref', label: 'Strings', color: '#e879f9', style: 'dashed' },
    { type: 'hii_pkg', label: 'HII-Pkg', color: '#94a3b8', style: 'solid' },
    { type: 'callback_ref', label: 'Callback', color: '#f87171', style: 'dotted' },
    { type: 'asl_include', label: 'ASL', color: '#818cf8', style: 'solid' },
    { type: 'depex', label: 'Depex', color: '#f472b6', style: 'dotted' },
];
const LEGEND_NODES = [
    { shape: '◆', label: '.inf', color: '#ffd700' },
    { shape: '⬡', label: '.dec', color: '#00d4ff' },
    { shape: '⬟', label: '.sdl', color: '#34d399' },
    { shape: '▣', label: '.cif', color: '#60a5fa' },
    { shape: '●', label: '.c/.h', color: '#3b82f6' },
    { shape: '▲', label: '.asm', color: '#f59e0b' },
    { shape: '⬠', label: '.dsc', color: '#e2e8f0' },
    { shape: '‣', label: '.vfr', color: '#f472b6' },  // UEFI HII Form
    { shape: '‣', label: '.hfr', color: '#e940a0' },  // AMI HII Form Resource
    { shape: '□', label: '.uni', color: '#fb923c' },  // Unicode 字串包
    { shape: '▷', label: '.asl', color: '#a78bfa' },  // ACPI
];

function buildLegend() {
    const wrap = document.getElementById('graph-wrap');
    if (!wrap || document.getElementById('graph-legend')) return;

    const leg = document.createElement('div');
    leg.id = 'graph-legend';
    leg.className = 'legend-collapsed';  // start collapsed

    // Build SVG line dash preview
    function edgeLine(col, style) {
        const dash = style === 'dashed' ? '6,4' : style === 'dotted' ? '2,3' : 'none';
        const strokeDash = dash !== 'none' ? `stroke-dasharray="${dash}"` : '';
        return `<svg width="32" height="10" style="vertical-align:middle;overflow:visible">
            <line x1="0" y1="5" x2="32" y2="5" stroke="${col}" stroke-width="2" ${strokeDash}/>
            <polygon points="28,2 34,5 28,8" fill="${col}"/>
        </svg>`;
    }

    leg.innerHTML = `
<div id="legend-title" class="legend-title" onclick="this.parentElement.classList.toggle('legend-collapsed')">
  <span>⬡</span> Legend <span class="legend-toggle">▾</span>
</div>
<div class="legend-body">
  <div class="legend-section-label">Edge Types</div>
  ${LEGEND_EDGES.map(e => `
  <div class="legend-row">
    ${edgeLine(e.color, e.style)}
    <span class="legend-label" style="color:${e.color}">${e.label}</span>
  </div>`).join('')}
  <div class="legend-section-label" style="margin-top:8px">Node Shapes</div>
  ${LEGEND_NODES.map(n => `
  <div class="legend-row">
    <span class="legend-shape" style="color:${n.color}">${n.shape}</span>
    <span class="legend-label" style="color:${n.color}">${n.label}</span>
  </div>`).join('')}
</div>`;

    wrap.appendChild(leg);
}

// Call on init
document.addEventListener('DOMContentLoaded', buildLegend);