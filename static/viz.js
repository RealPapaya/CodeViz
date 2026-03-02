/* viz.js — BIOSVIZ Visualization Logic v3
   Sourcetrail-style: graph on left, live source code on right.
   Uses cytoscape.js (canvas). No D3. No SVG renderer.
*/

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
    level: 0,        // 0=modules 1=files 2=functions
    tab: 'files',    // 'files' | 'calls'
    activeModule: null,
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
                console.log(`JSON.parse: ${(performance.now()-t0).toFixed(0)}ms`);

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
        else if (codeState.currentFile) openCodePanel();
        else openCodePanel(); // will show empty state
    };
    document.getElementById('cp-prev-func').onclick = () => navigateFunc(-1);
    document.getElementById('cp-next-func').onclick = () => navigateFunc(1);

    // Resizer drag
    initResizer();
}

function initResizer() {
    const resizer = document.getElementById('resizer');
    const panel   = document.getElementById('code-panel');
    if (!resizer || !panel) return;
    let startX, startW;
    resizer.addEventListener('mousedown', e => {
        startX = e.clientX;
        startW = panel.offsetWidth;
        resizer.classList.add('dragging');
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', stopDrag);
        e.preventDefault();
    });
    function onDrag(e) {
        const delta = startX - e.clientX; // drag left = wider panel
        const newW = Math.max(200, Math.min(900, startW + delta));
        panel.style.width = newW + 'px';
        document.documentElement.style.setProperty('--code-panel', newW + 'px');
    }
    function stopDrag() {
        resizer.classList.remove('dragging');
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', stopDrag);
    }
}

function openCodePanel() {
    const panel = document.getElementById('code-panel');
    panel.classList.add('open');
    document.getElementById('code-toggle-btn').classList.add('active');
    codeState.isOpen = true;
}

function closeCodePanel() {
    const panel = document.getElementById('code-panel');
    panel.classList.remove('open');
    document.getElementById('code-toggle-btn').classList.remove('active');
    codeState.isOpen = false;
}

// Load a file into the code panel; optionally jump to a function
async function loadFileInPanel(filePath, funcName) {
    if (!filePath) return;

    openCodePanel();
    const fname = filePath.split('/').pop();
    const ext   = fname.includes('.') ? '.' + fname.split('.').pop().toLowerCase() : '';

    // Update header immediately
    document.getElementById('cp-filename').textContent = fname;
    document.getElementById('cp-filename').title       = filePath;
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
        '.c':   '#3b82f6', '.cpp': '#06b6d4', '.cc': '#06b6d4',
        '.h':   '#8b5cf6', '.hpp': '#7c3aed',
        '.asm': '#f59e0b', '.s':   '#f59e0b', '.S': '#f59e0b',
    };
    return map[ext] || '#64748b';
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
    const lines  = src.split('\n');
    const hlExt  = { '.c':'c', '.cpp':'cpp', '.cc':'cpp', '.h':'cpp', '.hpp':'cpp',
                     '.asm':'x86asm', '.s':'x86asm', '.S':'x86asm' };
    const lang   = hlExt[ext] || 'plaintext';

    // Build funcLineMap: scan for `funcName(` patterns
    codeState.funcLineMap = {};
    codeState.funcList    = [];
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
        } catch(_) {
            highlightedLines = lines.map(l => escapeHtml(l));
        }
    } else {
        highlightedLines = lines.map(l => escapeHtml(l));
    }

    const wrap = document.getElementById('cp-code-wrap');
    const lineDivs = highlightedLines.map((hl, i) =>
        `<div class="code-line" id="cl-${i}"><span class="line-num">${i+1}</span><span class="line-content">${hl}</span></div>`
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
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
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
    {
        selector: 'edge', style: {
            'width': 'data(w)',
            'line-color': '#1a2535',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#1a2535',
            'curve-style': 'bezier',
            'opacity': 0.55,
        }
    },
    { selector: '.faded', style: { 'opacity': 0.08 } },
    { selector: '.hl', style: { 'opacity': 1, 'border-width': 2.5, 'border-color': '#e2e8f0' } },
    {
        selector: '.hl-edge-out', style: {
            'line-color': '#f59e0b',
            'target-arrow-color': '#f59e0b',
            'opacity': 1, 'width': 3, 'z-index': 10,
        }
    },
    {
        selector: '.hl-edge-in', style: {
            'line-color': '#10b981',
            'target-arrow-color': '#10b981',
            'opacity': 1, 'width': 3, 'z-index': 10,
        }
    },
    { selector: '.hl-node-out', style: { 'border-color': '#f59e0b', 'border-width': 3, 'opacity': 1 } },
    { selector: '.hl-node-in',  style: { 'border-color': '#10b981', 'border-width': 3, 'opacity': 1 } },
];

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function buildSidebar() {
    const list = document.getElementById('module-list');
    list.innerHTML = '';
    DATA.modules.forEach(m => {
        const d = document.createElement('div');
        d.className = 'mod-item';
        d.id = `mi-${m.id}`;
        d.innerHTML = `<div class="mod-dot" style="background:${m.color}"></div>
      <div class="mod-name" title="${m.id}">${m.id}</div>
      <div class="mod-count">${m.file_count}</div>`;
        d.onclick = () => drillToModule(m.id);
        list.appendChild(d);
    });
}

// ─── L0: Module View ──────────────────────────────────────────────────────────
function loadLevel0() {
    showLoading(true, 'Rendering modules...');
    hideFuncView();
    state.level = 0; state.activeModule = null; state.activeFile = null;
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
    const edges = [...DATA.module_edges].sort((a,b) => b.weight - a.weight).slice(0, 300);
    edges.forEach((e, i) => {
        els.push({ data: { id: `me${i}`, source: e.s, target: e.t, w: Math.max(1, Math.min(6, e.weight/8)), wt: e.weight } });
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

// ─── L1: File View ────────────────────────────────────────────────────────────
function drillToModule(modId) {
    if (state.level === 0) state.history.push({ level: 0 });
    state.level = 1; state.activeModule = modId;
    showLoading(true, `Loading ${modId}...`);
    hideFuncView(); setSidebarActive(modId);

    const files = (DATA.files_by_module[modId] || []).slice(0, 200);
    const visIds = new Set(files.map(f => f.id));
    const edges = (DATA.file_edges_by_module[modId] || [])
        .filter(e => visIds.has(e.s) && visIds.has(e.t)).slice(0, 400);
    const EXT_COL = {
        '.c': '#3b82f6', '.h': '#8b5cf6', '.cpp': '#06b6d4',
        '.hpp': '#7c3aed', '.asm': '#f59e0b', '.s': '#f59e0b'
    };
    const els = [];
    files.forEach(f => {
        els.push({
            data: {
                id: `f${f.id}`, label: f.label,
                bg: '#0a1520', bc: EXT_COL[f.ext] || '#64748b',
                lvl: 1, w: 165, h: 50, sh: 'roundrectangle',
                tt: `${f.path}\n${f.ext.toUpperCase()} · ${fmtSize(f.size)} · ${f.func_count} funcs`,
                _t: 'file', _f: f,
            }
        });
    });
    edges.forEach((e, i) => {
        els.push({ data: { id: `fe${i}`, source: `f${e.s}`, target: `f${e.t}`, w: 1 } });
    });

    cy.elements().remove();
    cy.add(els);

    const lay = cy.layout({ name: 'dagre', rankDir: 'LR', animate: false, nodeSep: 28, rankSep: 80, padding: 40 });
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
    funcs.length === 0 ? showFuncViewEmpty(fileRel) : showFuncView(fileRel, funcs, edges, 0);

    // Always load file into code panel when drilling to L2
    loadFileInPanel(fileRel, funcs[0]?.label);
}

function showFuncView(fileRel, funcs, edges, centerIdx) {
    const center   = funcs[centerIdx];
    const callers  = dedupeBy(edges.filter(e => e.t === centerIdx).map(e => funcs[e.s]).filter(Boolean), 'label').slice(0, 8);
    const callees  = dedupeBy(edges.filter(e => e.s === centerIdx).map(e => funcs[e.t]).filter(Boolean), 'label').slice(0, 8);

    cy.elements().remove();
    document.getElementById('cy').style.display = 'none';

    const fv = document.getElementById('func-view');
    fv.classList.add('active');

    const accessCls = center.is_public ? 'access-public' : 'access-private';
    const accessLbl = center.is_public ? '🔓 PUBLIC' : '🔒 PRIVATE';

    let pillHtml = '';
    funcs.slice(0, 24).forEach((f, i) => {
        const cls = f.is_efiapi ? 'pill-yellow' : f.is_public ? 'pill-blue' : 'pill-gray';
        pillHtml += `<span class="pill ${cls}" onclick="focusFunc(${JSON.stringify(fileRel)},${i})">${f.label}</span>`;
    });

    fv.innerHTML = `
    <div class="fv-col">
      <div class="fv-col-label">◀ Callers</div>
      ${callers.map(f => fnCard(f, fileRel, funcs.indexOf(f))).join('') || '<div class="fv-empty">No callers</div>'}
    </div>
    <div class="fv-center">
      <div class="fv-center-header">${center.label}</div>
      <div class="fv-center-path">${fileRel}</div>
      <div class="access-strip ${accessCls}">${accessLbl}</div>
      <div class="fv-center-pills">${pillHtml}</div>
    </div>
    <div class="fv-col">
      <div class="fv-col-label">Callees ▶</div>
      ${callees.map(f => fnCard(f, fileRel, funcs.indexOf(f))).join('') || '<div class="fv-empty">No callees</div>'}
    </div>`;

    // Sync code panel to this function
    if (codeState.isOpen && codeState.currentFile === fileRel) {
        jumpToFunc(center.label);
    }
}

function fnCard(f, fileRel, idx) {
    const cls = f.is_efiapi ? 'pill-yellow' : f.is_public ? 'pill-blue' : 'pill-gray';
    const lbl = f.is_efiapi ? 'EFIAPI' : f.is_public ? 'public' : 'static';
    return `<div class="fv-node" onclick="focusFunc(${JSON.stringify(fileRel)},${idx})">
    <div class="fn-name">${f.label}</div>
    <span class="fn-badge ${cls}">${lbl}</span>
  </div>`;
}

function focusFunc(fileRel, idx) {
    const funcs = DATA.funcs_by_file[fileRel] || [];
    const edges = DATA.func_edges_by_file[fileRel] || [];
    if (funcs[idx]) {
        showFuncView(fileRel, funcs, edges, idx);
        // Sync code panel
        loadFileInPanel(fileRel, funcs[idx].label);
    }
}

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
}

// ─── Node Tap ─────────────────────────────────────────────────────────────────
function onNodeTap(node) {
    clearHighlight();
    const d = node.data();

    if (state.level === 0 && d._t === 'module') {
        drillToModule(d._m.id);
        return;
    }
    if (state.level === 1 && d._t === 'file') {
        // Single click: show code panel; double-click to drill to L2
        if (d._f?.path) loadFileInPanel(d._f.path);
        // Highlight node
        highlightNode(node);
        return;
    }

    // Persistent highlight on non-drillable tap
    cy.elements().addClass('faded');
    node.removeClass('faded').addClass('hl');
    const outEdges = node.outgoers('edge');
    outEdges.removeClass('faded').addClass('hl-edge-out');
    outEdges.targets().removeClass('faded').addClass('hl-node-out');
    const inEdges = node.incomers('edge');
    inEdges.removeClass('faded').addClass('hl-edge-in');
    inEdges.sources().removeClass('faded').addClass('hl-node-in');
}

// Double-tap to drill into file
cy && cy.on('dbltap', 'node', e => {
    const d = e.target.data();
    if (state.level === 1 && d._t === 'file') drillToFile(d._f.path);
});

// ─── Navigation ───────────────────────────────────────────────────────────────
function goBack() {
    const prev = state.history.pop();
    if (!prev) return;
    cy.elements().removeClass('faded hl');
    if (prev.level === 0) { loadLevel0(); }
    else if (prev.level === 1) {
        hideFuncView();
        const savedHistory = [...state.history];
        drillToModule(prev.activeModule);
        state.history = savedHistory;
    }
}

window.goLevel = function(n) {
    if (n === 0) { state.history = []; loadLevel0(); }
    else if (n === 1 && state.activeModule) {
        hideFuncView(); state.history = [{ level: 0 }]; drillToModule(state.activeModule);
    }
};

window.switchTab = function(tab) {
    state.tab = tab;
    document.getElementById('tab-files').classList.toggle('active', tab === 'files');
    document.getElementById('tab-calls').classList.toggle('active', tab === 'calls');
    state.history = []; loadLevel0();
};

window.goBack = goBack;

function updateBreadcrumb() {
    const show = (id, txt) => {
        const el = document.getElementById(id);
        el.style.display = txt ? '' : 'none';
        if (txt) el.textContent = txt;
    };
    show('bc-sep1', state.level >= 1 ? '›' : '');
    show('bc1',     state.level >= 1 ? state.activeModule : '');
    show('bc-sep2', state.level >= 2 ? '›' : '');
    show('bc2',     state.level >= 2 ? (state.activeFile || '').split('/').pop() : '');
    document.getElementById('back-btn').classList.toggle('visible', state.level > 0);
}

function setSidebarActive(modId) {
    document.querySelectorAll('.mod-item').forEach(el => el.classList.remove('active'));
    if (modId) { const el = document.getElementById(`mi-${modId}`); if (el) el.classList.add('active'); }
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
    if (e.key === 'ArrowLeft')  navigateFunc(-1);
    if (e.key === 'ArrowRight') navigateFunc(1);
}

// ─── Context Menu ─────────────────────────────────────────────────────────────
function onNodeRightClick(ev, node) {
    ev.originalEvent.preventDefault();
    const menu = document.getElementById('ctx-menu');
    menu.style.display = 'block';
    menu.style.left = ev.originalEvent.clientX + 'px';
    menu.style.top  = ev.originalEvent.clientY + 'px';

    document.getElementById('ctx-copy').onclick = () => {
        const d = node.data();
        navigator.clipboard?.writeText(d._f?.path || d._m?.id || d.label).catch(()=>{});
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
            const abs  = root.replace(/\//g,'\\') + '\\' + d._f.path.replace(/\//g,'\\');
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
function showTooltip(e) {
    const d = e.target.data();
    let tt = d.tt || '';
    if (!tt) return;
    if (e.target.isNode()) {
        const outCount = e.target.outgoers('edge').length;
        const inCount  = e.target.incomers('edge').length;
        if (outCount > 0 || inCount > 0) {
            tt += `\n\nDependencies:`;
            if (outCount > 0) tt += `\n• Calls: ${outCount} (Orange)`;
            if (inCount  > 0) tt += `\n• Called by: ${inCount} (Green)`;
        }
        tt += '\n\nClick → view code  |  Dbl-click → drill in';
    }
    const tip = document.getElementById('tooltip');
    tip.textContent = tt;
    tip.style.display = 'block';
    tip.style.left = (e.originalEvent.clientX + 14) + 'px';
    tip.style.top  = (e.originalEvent.clientY + 14) + 'px';
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
function dedupeBy(arr, key) { return [...new Map(arr.map(x=>[x[key],x])).values()]; }
function fmtSize(b) { return b>1e6?(b/1e6).toFixed(1)+'MB':b>1e3?(b/1e3).toFixed(0)+'KB':b+'B'; }
