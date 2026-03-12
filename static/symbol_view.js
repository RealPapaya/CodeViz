// ── Symbol View — Sourcetrail-style, embedded in #graph-wrap ─────────────────
// Behaves like #func-view: position:absolute inside #graph-wrap, hides #cy.
//
// Entry points (called from viz.js):
//   symViewOpen(fileRel)   — find primary symbol in file and open
//   symViewActivate(symId) — navigate to a specific symbol
//   symViewClose()         — hide, restore #cy

'use strict';

const _sym = {
    active:  null,   // current center symbol id
    history: [],     // [symId, ...] navigation stack
    cy:      null,   // Cytoscape instance inside #sym-cy
    jobId:   null,   // cached job id
    ready:   false,  // DOM has been populated
};

// ── Edge colors ───────────────────────────────────────────────────────────────
const _SYM_EDGE_COLORS = {
    call:        '#fb923c',
    inheritance: '#60a5fa',
    import:      '#34d399',
    member:      '#c084fc',
    override:    '#f472b6',
    type_usage:  '#fbbf24',
    include:     '#94a3b8',
};

// ── Cytoscape stylesheet ──────────────────────────────────────────────────────
const _SYM_CY_STYLE = [
    {
        selector: 'node',
        style: {
            'label':            'data(label)',
            'text-valign':      'center',
            'text-halign':      'center',
            'color':            '#e2e8f0',
            'background-color': '#1e293b',
            'border-color':     '#334155',
            'border-width':     1.5,
            'font-size':        11,
            'padding':          '10px',
            'width':            'label',
            'height':           'label',
            'text-wrap':        'wrap',
            'text-max-width':   140,
            'shape':            'roundrectangle',
        },
    },
    {
        selector: 'node[?isCenter]',
        style: {
            'background-color': '#0d2137',
            'border-color':     '#00d4ff',
            'border-width':     2,
            'color':            '#cbd5e1',
            'font-size':        11,
            'font-family':      'JetBrains Mono, monospace',
            'text-wrap':        'wrap',
            'text-max-width':   220,
            'text-valign':      'center',
            'text-halign':      'center',
            'width':            'label',
            'height':           'label',
            'padding':          '16px',
            'shape':            'roundrectangle',
        },
    },
    {
        selector: 'node[kind="class"]',
        style: { 'shape': 'roundrectangle', 'border-color': '#60a5fa' },
    },
    {
        selector: 'node[kind="struct"]',
        style: { 'shape': 'roundrectangle', 'border-color': '#fbbf24' },
    },
    {
        selector: 'node[kind="function"]',
        style: { 'shape': 'ellipse', 'border-color': '#34d399' },
    },
    {
        selector: 'node[kind="method"]',
        style: { 'shape': 'ellipse', 'border-color': '#a78bfa' },
    },
    {
        selector: 'node[kind="enum"]',
        style: { 'shape': 'diamond', 'border-color': '#fb923c' },
    },
    {
        selector: 'edge',
        style: {
            'width':                   1.5,
            'line-color':              '#334155',
            'target-arrow-color':      '#334155',
            'target-arrow-shape':      'triangle',
            'curve-style':             'bezier',
            'label':                   'data(label)',
            'font-size':               9,
            'color':                   '#64748b',
            'text-background-color':   '#050a0f',
            'text-background-opacity': 0.8,
            'text-background-padding': '2px',
        },
    },
    {
        selector: 'edge[edgeType="call"]',
        style: { 'line-color': '#fb923c', 'target-arrow-color': '#fb923c' },
    },
    {
        selector: 'edge[edgeType="inheritance"]',
        style: {
            'line-color':         '#60a5fa',
            'target-arrow-color': '#60a5fa',
            'target-arrow-shape': 'triangle-backcurve',
        },
    },
    {
        selector: 'edge[edgeType="import"]',
        style: {
            'line-color':         '#34d399',
            'target-arrow-color': '#34d399',
            'line-style':         'dashed',
        },
    },
    {
        selector: 'edge[edgeType="override"]',
        style: {
            'line-color':         '#f472b6',
            'target-arrow-color': '#f472b6',
            'line-style':         'dotted',
        },
    },
    {
        selector: 'edge[edgeType="type_usage"]',
        style: {
            'line-color':         '#fbbf24',
            'target-arrow-color': '#fbbf24',
            'line-style':         'dashed',
        },
    },
    {
        selector: 'node:selected',
        style: { 'border-color': '#fbbf24', 'border-width': 3 },
    },
];

// ── Entry Points ──────────────────────────────────────────────────────────────

function symViewOpen(fileRel) {
    if (!window.DATA || !DATA.symbol_index) return;
    _sym.jobId = window.JOB_ID || null;

    const allSymbols = Object.values(DATA.symbol_index);
    const inFile     = allSymbols.filter(s => s.file === fileRel);
    if (!inFile.length) return;

    const kindPriority = ['class', 'struct', 'function', 'method', 'enum'];
    inFile.sort((a, b) => {
        const pa = kindPriority.indexOf(a.kind);
        const pb = kindPriority.indexOf(b.kind);
        const pa2 = pa === -1 ? 99 : pa;
        const pb2 = pb === -1 ? 99 : pb;
        return pa2 !== pb2 ? pa2 - pb2 : (a.line || 0) - (b.line || 0);
    });

    _sym.history = [];
    _sym.active  = null;
    symViewActivate(inFile[0].id);
}

function symViewActivate(symId) {
    if (_sym.active && _sym.active !== symId) {
        _sym.history.push(_sym.active);
    }
    _sym.active = symId;
    _sym.jobId  = window.JOB_ID || _sym.jobId || null;

    _symShow();
    _symFetchAndRender(symId);
}

function symViewClose() {
    const panel = document.getElementById('sym-view');
    if (panel) panel.classList.remove('active');

    // Restore #cy
    const cyEl = document.getElementById('cy');
    if (cyEl) cyEl.style.display = '';

    if (_sym.cy) {
        _sym.cy.destroy();
        _sym.cy = null;
    }
    _sym.active  = null;
    _sym.history = [];
}

// ── Show / setup panel ────────────────────────────────────────────────────────

function _symShow() {
    // Hide #cy (like showFuncView does)
    const cyEl = document.getElementById('cy');
    if (cyEl) cyEl.style.display = 'none';

    // Also hide func-view if active
    const fv = document.getElementById('func-view');
    if (fv) fv.classList.remove('active');

    const panel = document.getElementById('sym-view');
    if (!panel) return;

    // Populate DOM once
    if (!_sym.ready) {
        panel.innerHTML = `
            <div id="sym-toolbar">
                <div id="sym-toolbar-left">
                    <button id="sym-back-btn" onclick="_symBack()" title="Back">&#x21A9; Back</button>
                    <span id="sym-breadcrumb"></span>
                </div>
                <div id="sym-search-wrapper">
                    <input id="sym-search-input" type="text" placeholder="Search symbols…" autocomplete="off" spellcheck="false">
                    <div id="sym-search-results"></div>
                </div>
                <button id="sym-close-btn" onclick="symViewClose()" title="Close Symbol View">✕</button>
            </div>
            <div id="sym-body">
                <div id="sym-member-panel"></div>
                <div id="sym-cy"></div>
            </div>
        `;

        const si = panel.querySelector('#sym-search-input');
        si.addEventListener('input', _symDebounce(e => _symSearch(e.target.value), 300));
        si.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                document.getElementById('sym-search-results').innerHTML = '';
                si.value = '';
                si.blur();
            }
        });

        _sym.ready = true;
    }

    panel.classList.add('active');
    _symUpdateBack();
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function _symFetchAndRender(symId) {
    const jid = _sym.jobId || '';
    const url  = `/symbol-graph?job=${encodeURIComponent(jid)}&sym=${encodeURIComponent(symId)}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        _symRender(data);
    } catch (e) {
        console.error('[sym-view] Fetch error:', e);
    }
}

// ── Graph rendering ───────────────────────────────────────────────────────────

function _symRender(data) {
    const { center, incoming, outgoing } = data;
    if (!center) return;

    // Breadcrumb
    const bc = document.getElementById('sym-breadcrumb');
    if (bc) bc.textContent = `${center.kind}: ${center.name}`;

    // Build Cytoscape elements
    const elements = _symBuildElements(data);

    if (_sym.cy) { _sym.cy.destroy(); _sym.cy = null; }

    const cyContainer = document.getElementById('sym-cy');
    if (!cyContainer) return;

    _sym.cy = cytoscape({
        container:           cyContainer,
        elements,
        style:               _SYM_CY_STYLE,
        layout:              { name: 'dagre', rankDir: 'LR', nodeSep: 55, rankSep: 150, padding: 50 },
        userZoomingEnabled:  true,
        userPanningEnabled:  true,
        boxSelectionEnabled: false,
        minZoom: 0.15,
        maxZoom: 4,
    });

    _sym.cy.on('tap', 'node', e => {
        const ndata = e.target.data();
        if (ndata.isCenter) {
            // Click center node → open its file in code panel at its definition line
            if (center.file && window.loadFileInPanel) loadFileInPanel(center.file, center.name);
            return;
        }
        if (ndata.symId) symViewActivate(ndata.symId);
    });

    // Open center symbol's file in code panel
    if (center.file && window.loadFileInPanel) loadFileInPanel(center.file, center.name);

    _symRenderMemberPanel(center);
    _symUpdateBack();
}

function _symCenterLabel(center) {
    // Member list is shown in #sym-member-panel; center node only shows the name.
    return center.name;
}

function _symBuildElements(data) {
    const { center, incoming, outgoing } = data;
    const nodes = [];
    const edges = [];
    const seen  = new Set();

    nodes.push({
        data: {
            id:       'center',
            label:    _symCenterLabel(center),
            kind:     center.kind,
            symId:    center.id,
            isCenter: true,
        },
    });
    seen.add(center.id);

    for (const item of (incoming || [])) {
        const s = item.sym;
        if (!s || seen.has(s.id)) continue;
        seen.add(s.id);
        const edgeLabel = `${item.edge_type}${item.count > 1 ? ' ×' + item.count : ''}`;
        nodes.push({ data: { id: s.id, label: s.name, kind: s.kind, symId: s.id } });
        edges.push({
            data: {
                id:       `in_${s.id}`,
                source:   s.id,
                target:   'center',
                edgeType: item.edge_type,
                count:    item.count,
                label:    edgeLabel,
            },
        });
    }

    for (const item of (outgoing || [])) {
        const s = item.sym;
        if (!s || seen.has(s.id)) continue;
        seen.add(s.id);
        const edgeLabel = `${item.edge_type}${item.count > 1 ? ' ×' + item.count : ''}`;
        nodes.push({ data: { id: s.id, label: s.name, kind: s.kind, symId: s.id } });
        edges.push({
            data: {
                id:       `out_${s.id}`,
                source:   'center',
                target:   s.id,
                edgeType: item.edge_type,
                count:    item.count,
                label:    edgeLabel,
            },
        });
    }

    return { nodes, edges };
}

// ── Member Panel ──────────────────────────────────────────────────────────────

function _symRenderMemberPanel(center) {
    const panel = document.getElementById('sym-member-panel');
    if (!panel) return;

    const children = center.children || [];
    if (!children.length) {
        panel.innerHTML = '';
        panel.classList.remove('visible');
        return;
    }

    panel.classList.add('visible');

    const pub  = children.filter(c => c.is_public);
    const priv = children.filter(c => !c.is_public);

    let html = `<div class="sym-mp-header">
        <span class="sym-kind-badge kind-${center.kind}">${center.kind}</span>
        <span class="sym-mp-name">${_symEscHtml(center.name)}</span>
    </div><div class="sym-mp-list">`;

    pub.forEach(c => {
        html += `<div class="sym-member-row is-public" data-line="${c.line}">
            <span class="sym-mr-vis">+</span>
            <span class="sym-mr-name">${_symEscHtml(c.name)}</span>
        </div>`;
    });

    if (pub.length && priv.length) html += `<div class="sym-mp-divider"></div>`;

    priv.forEach(c => {
        html += `<div class="sym-member-row" data-line="${c.line}">
            <span class="sym-mr-vis">−</span>
            <span class="sym-mr-name">${_symEscHtml(c.name)}</span>
        </div>`;
    });

    html += '</div>';
    panel.innerHTML = html;

    panel.querySelectorAll('.sym-member-row').forEach(row => {
        row.addEventListener('click', () => {
            const line = parseInt(row.dataset.line, 10);
            if (!line) return;
            if (!window.jumpToLine) return;
            const alreadyOpen = window.codeState && codeState.currentFile === center.file;
            if (!alreadyOpen && window.loadFileInPanel) {
                loadFileInPanel(center.file, null);
                setTimeout(() => jumpToLine(line), 150);
            } else {
                jumpToLine(line);
            }
            // Highlight the clicked row
            panel.querySelectorAll('.sym-member-row').forEach(r => r.classList.remove('active'));
            row.classList.add('active');
        });
    });
}

// ── Search ────────────────────────────────────────────────────────────────────

async function _symSearch(query) {
    const container = document.getElementById('sym-search-results');
    if (!container) return;
    if (!query || query.length < 2) { container.innerHTML = ''; return; }

    const jid = _sym.jobId || '';
    try {
        const resp = await fetch(`/symbols?job=${encodeURIComponent(jid)}&query=${encodeURIComponent(query)}`);
        const data = await resp.json();
        _symShowSearchResults(data.results || []);
    } catch (e) {
        console.error('[sym-view] Search error:', e);
    }
}

function _symShowSearchResults(results) {
    const container = document.getElementById('sym-search-results');
    if (!container) return;
    container.innerHTML = '';
    if (!results.length) return;

    results.slice(0, 12).forEach(r => {
        const item     = document.createElement('div');
        item.className = 'sym-search-item';
        item.innerHTML = `<span class="sym-kind-badge kind-${r.kind}">${r.kind}</span><span>${_symEscHtml(r.name)}</span>`;
        item.onclick   = () => {
            container.innerHTML = '';
            const si = document.getElementById('sym-search-input');
            if (si) si.value = '';
            symViewActivate(r.id);
        };
        container.appendChild(item);
    });
}

// ── Navigation ────────────────────────────────────────────────────────────────

function _symBack() {
    if (!_sym.history.length) return;
    const prev  = _sym.history.pop();
    _sym.active = null;
    symViewActivate(prev);
}

function _symUpdateBack() {
    const btn = document.getElementById('sym-back-btn');
    if (btn) btn.disabled = _sym.history.length === 0;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _symDebounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function _symEscHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
