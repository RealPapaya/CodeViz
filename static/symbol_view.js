// ── Symbol View — Sourcetrail-style, embedded in #graph-wrap ─────────────────
// Phase 1+2: Symbol Index + basic symbol graph (Cytoscape dagre LR).
// Phase 3: Compound class card nodes (PUBLIC/PRIVATE sections) + TrailLayouter.
//
// Entry points (called from viz.js):
//   symViewOpen(fileRel)   — open the primary symbol in a file
//   symViewActivate(symId) — navigate to a specific symbol
//   symViewClose()         — hide, restore #cy

'use strict';

const _sym = {
    active:  null,   // current center symbol id
    history: [],     // navigation stack [symId, ...]
    cy:      null,   // Cytoscape instance inside #sym-cy
    jobId:   null,
    ready:   false,
};

// ── Sizing constants (must match _symEstimateCardHeight) ──────────────────────
const _SYM_MEMBER_W    = 130;
const _SYM_MEMBER_H    = 22;
const _SYM_MEMBER_GAP  = 4;
const _SYM_GROUP_HDR   = 16;
const _SYM_GROUP_GAP   = 6;
const _SYM_CLASS_HDR   = 28;
const _SYM_CLASS_PAD   = 8;

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
    // ── Compound class card ──────────────────────────────────────────────────
    {
        selector: 'node[?isClassCard]',
        style: {
            'shape':                        'roundrectangle',
            'background-color':             '#0d1a2e',
            'border-color':                 '#334155',
            'border-width':                 1.5,
            'label':                        'data(label)',
            'text-valign':                  'top',
            'text-halign':                  'center',
            'color':                        '#94a3b8',
            'font-size':                    11,
            'font-weight':                  600,
            'padding':                      `${_SYM_CLASS_PAD}px`,
            'compound-sizing-wrt-labels':   'exclude',
        },
    },
    {
        selector: 'node[isCenter][?isClassCard]',
        style: { 'border-color': '#00d4ff', 'border-width': 2, 'color': '#00d4ff' },
    },
    // ── Member badge nodes (inside compound) ─────────────────────────────────
    {
        selector: 'node[?isMember]',
        style: {
            'shape':             'roundrectangle',
            'background-color':  '#181e2e',
            'border-color':      '#2e2a4a',
            'border-width':      1,
            'label':             'data(label)',
            'text-valign':       'center',
            'text-halign':       'center',
            'color':             '#7c6fa8',
            'font-size':         10,
            'font-family':       'JetBrains Mono, monospace',
            'width':             _SYM_MEMBER_W,
            'height':            _SYM_MEMBER_H,
        },
    },
    {
        selector: 'node[?isMember][?isPublic]',
        style: {
            'background-color': '#0d1e30',
            'border-color':     '#1e3a52',
            'color':            '#5b9fc7',
        },
    },
    // ── Divider node between public/private sections ─────────────────────────
    {
        selector: 'node[?isDivider]',
        style: {
            'shape':            'rectangle',
            'background-color': '#1a2535',
            'border-width':     0,
            'label':            '',
            'width':            _SYM_MEMBER_W,
            'height':           1,
        },
    },
    {
        selector: 'node.sym-active-member',
        style: { 'background-color': '#1a3a5c', 'border-color': '#00d4ff', 'color': '#e2e8f0' },
    },
    // ── Plain symbol nodes ────────────────────────────────────────────────────
    {
        selector: 'node[!isClassCard][!isGroup][!isMember]',
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
        selector: 'node[isCenter][!isClassCard]',
        style: { 'border-color': '#00d4ff', 'border-width': 2, 'color': '#00d4ff' },
    },
    { selector: 'node[kind="class"]',    style: { 'border-color': '#60a5fa' } },
    { selector: 'node[kind="function"]', style: { 'shape': 'ellipse', 'border-color': '#34d399' } },
    { selector: 'node[kind="method"]',   style: { 'shape': 'ellipse', 'border-color': '#a78bfa' } },
    { selector: 'node[kind="struct"]',   style: { 'border-color': '#fbbf24' } },
    { selector: 'node[kind="enum"]',     style: { 'shape': 'diamond', 'border-color': '#fb923c' } },
    // Member badges override kind-based shape (must come after kind selectors)
    { selector: 'node[?isMember]', style: { 'shape': 'roundrectangle' } },
    // ── Edges ─────────────────────────────────────────────────────────────────
    {
        selector: 'edge',
        style: {
            'width':                   'data(lineWidth)',
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
        style: { 'line-color': '#34d399', 'target-arrow-color': '#34d399', 'line-style': 'dashed' },
    },
    {
        selector: 'edge[edgeType="override"]',
        style: { 'line-color': '#f472b6', 'target-arrow-color': '#f472b6', 'line-style': 'dotted' },
    },
    {
        selector: 'edge[edgeType="type_usage"]',
        style: { 'line-color': '#fbbf24', 'target-arrow-color': '#fbbf24', 'line-style': 'dashed' },
    },
    // ── Bundled edges (count > 1) ─────────────────────────────────────────────
    {
        selector: 'edge[?isBundled]',
        style: { 'opacity': 0.95, 'text-opacity': 1 },
    },
    { selector: 'node:selected', style: { 'border-color': '#fbbf24', 'border-width': 3 } },
    { selector: 'edge:selected', style: { 'overlay-color': '#fbbf24', 'overlay-opacity': 0.2, 'overlay-padding': 4 } },
];

// ── Entry Points ──────────────────────────────────────────────────────────────

function symViewOpen(fileRel) {
    if (!window.DATA || !DATA.symbol_index) return;
    _sym.jobId = window.JOB_ID || null;

    const allSymbols  = Object.values(DATA.symbol_index);
    const inFile      = allSymbols.filter(s => s.file === fileRel);
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
    if (_sym.active && _sym.active !== symId) _sym.history.push(_sym.active);
    _sym.active = symId;
    _sym.jobId  = window.JOB_ID || _sym.jobId || null;
    _symShow();
    _symFetchAndRender(symId);
}

function symViewClose() {
    const panel = document.getElementById('sym-view');
    if (panel) panel.classList.remove('active');
    const cyEl = document.getElementById('cy');
    if (cyEl) cyEl.style.display = '';
    if (_sym.cy) { _sym.cy.destroy(); _sym.cy = null; }
    _sym.active  = null;
    _sym.history = [];
}

// ── Panel setup ───────────────────────────────────────────────────────────────

function _symShow() {
    const cyEl = document.getElementById('cy');
    if (cyEl) cyEl.style.display = 'none';
    const fv = document.getElementById('func-view');
    if (fv) fv.classList.remove('active');

    const panel = document.getElementById('sym-view');
    if (!panel) return;

    if (!_sym.ready) {
        panel.innerHTML = `
            <div id="sym-toolbar">
                <div id="sym-toolbar-left">
                    <button id="sym-back-btn" onclick="_symBack()" title="Back">&#x21A9; Back</button>
                    <span id="sym-breadcrumb"></span>
                </div>
                <div id="sym-search-wrapper">
                    <input id="sym-search-input" type="text" placeholder="Search symbols\u2026"
                           autocomplete="off" spellcheck="false">
                    <div id="sym-search-results"></div>
                </div>
                <button id="sym-close-btn" onclick="symViewClose()" title="Close">&#x2715;</button>
            </div>
            <div id="sym-body"><div id="sym-cy"></div></div>
            <div id="sym-edge-tooltip" class="sym-edge-tooltip"></div>
        `;
        const si = panel.querySelector('#sym-search-input');
        si.addEventListener('input', _symDebounce(e => _symSearch(e.target.value), 300));
        si.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            document.getElementById('sym-search-results').innerHTML = '';
            si.value = '';
            si.blur();
        });
        _sym.ready = true;
    }
    panel.classList.add('active');
    _symUpdateBack();
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function _symFetchAndRender(symId) {
    const jid = _sym.jobId || '';
    const url = `/symbol-graph?job=${encodeURIComponent(jid)}&sym=${encodeURIComponent(symId)}`;
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
    const { center } = data;
    if (!center) return;
    _symHideEdgeTooltip();

    const bc = document.getElementById('sym-breadcrumb');
    if (bc) bc.textContent = `${center.kind}: ${center.name}`;

    const elements  = _symBuildCompoundElements(data);
    const positions = _symComputeLayout(data, elements);

    if (_sym.cy) { _sym.cy.destroy(); _sym.cy = null; }
    const container = document.getElementById('sym-cy');
    if (!container) return;

    _sym.cy = cytoscape({
        container,
        elements,
        style:               _SYM_CY_STYLE,
        layout:              { name: 'preset', positions: node => positions[node.id()] || { x: 0, y: 0 } },
        userZoomingEnabled:  true,
        userPanningEnabled:  true,
        boxSelectionEnabled: false,
        minZoom: 0.1,
        maxZoom: 4,
    });

    _sym.cy.nodes().ungrabify();   // nodes are not draggable (Sourcetrail behaviour)

    _sym.cy.on('tap', 'node', e => _symOnNodeTap(e, data));
    _sym.cy.on('tap', 'edge', e => _symOnEdgeTap(e));
    _sym.cy.on('tap', e => { if (e.target === _sym.cy) _symHideEdgeTooltip(); });
    _sym.cy.fit(undefined, 60);

    if (center.file && window.loadFileInPanel) loadFileInPanel(center.file, center.name);
    _symUpdateBack();
}

// ── Element building (compound nodes) ────────────────────────────────────────

function _symBuildCompoundElements(data) {
    const { center, incoming = [], outgoing = [] } = data;
    const nodes = [];
    const edges = [];
    const seen  = new Set();

    // Collect neighbor symIds for selective member display in neighbor classes
    const edgeMemberIds = new Set([...incoming, ...outgoing].map(i => i.sym && i.sym.id).filter(Boolean));

    nodes.push(..._symNodesForSym(center, 'center', true, null));
    seen.add(center.id);

    for (const item of [...incoming, ...outgoing]) {
        const s = item.sym;
        if (!s || seen.has(s.id)) continue;
        seen.add(s.id);
        nodes.push(..._symNodesForSym(s, s.id, false, edgeMemberIds));
    }

    for (const item of incoming) {
        if (!item.sym) continue;
        const cnt  = item.count || 1;
        const lw   = cnt > 1 ? Math.min(1.5 + Math.log2(cnt), 6) : 1.5;
        const label = `${item.edge_type}${cnt > 1 ? ' \xd7' + cnt : ''}`;
        edges.push({ data: { id: `in_${item.sym.id}`, source: item.sym.id, target: 'center',
            edgeType: item.edge_type, count: cnt, lineWidth: lw,
            isBundled: cnt > 1 || undefined, label } });
    }
    for (const item of outgoing) {
        if (!item.sym) continue;
        const cnt  = item.count || 1;
        const lw   = cnt > 1 ? Math.min(1.5 + Math.log2(cnt), 6) : 1.5;
        const label = `${item.edge_type}${cnt > 1 ? ' \xd7' + cnt : ''}`;
        edges.push({ data: { id: `out_${item.sym.id}`, source: 'center', target: item.sym.id,
            edgeType: item.edge_type, count: cnt, lineWidth: lw,
            isBundled: cnt > 1 || undefined, label } });
    }
    return { nodes, edges };
}

function _symNodesForSym(sym, nodeId, isCenter, edgeMemberIds) {
    const isCard = ['class', 'struct'].includes(sym.kind);
    if (!isCard) return [_symMakePlainNode(sym, nodeId, isCenter)];
    const children = (sym.children || []).slice().sort((a, b) => (a.line || 0) - (b.line || 0));
    const vis = isCenter ? children : children.filter(c => edgeMemberIds && edgeMemberIds.has(c.id));
    if (!vis.length) return [_symMakePlainNode(sym, nodeId, isCenter)];
    return _symMakeClassCompound(sym, nodeId, isCenter, vis);
}

function _symMakeClassCompound(sym, nodeId, isCenter, visChildren) {
    const result = [{ data: {
        id: nodeId, label: sym.name, kind: sym.kind, symId: sym.id,
        isCenter: isCenter || undefined, isClassCard: true,
    }}];
    const pub  = visChildren.filter(c => c.access_level === 'public');
    const priv = visChildren.filter(c => c.access_level !== 'public');
    pub.forEach(m => result.push(_symMakeMemberNode(m, nodeId)));
    if (pub.length && priv.length) {
        // Thin divider line between sections
        result.push({ data: { id: `${nodeId}__div`, parent: nodeId, isDivider: true } });
    }
    priv.forEach(m => result.push(_symMakeMemberNode(m, nodeId)));
    return result;
}

function _symMakePlainNode(sym, nodeId, isCenter) {
    return { data: { id: nodeId, label: sym.name, kind: sym.kind, symId: sym.id, isCenter: isCenter || undefined } };
}

function _symMakeMemberNode(member, groupId) {
    return { data: {
        id: member.id, parent: groupId, label: member.name, kind: member.kind,
        symId: member.id, line: member.line || 0, isMember: true,
        isPublic: member.access_level === 'public' || undefined,
    }};
}

// ── Layout: TrailLayouter + member positioning ────────────────────────────────

function _symComputeLayout(data, elements) {
    const { center, incoming = [], outgoing = [] } = data;
    const allSyms = [center, ...incoming.map(i => i.sym), ...outgoing.map(o => o.sym)].filter(Boolean);
    const symById = Object.fromEntries(allSyms.map(s => [s.id, s]));

    // Top-level node sizes for TrailLayouter
    const seen = new Set();
    const topNodes = [];
    for (const el of elements.nodes) {
        const id = el.data.id;
        if (el.data.parent || seen.has(id)) continue;
        seen.add(id);
        const sym = symById[el.data.symId] || symById[id];
        const h   = sym ? _symEstimateCardHeight(sym, el.data.id, elements) : 44;
        topNodes.push({ id, width: _SYM_MEMBER_W + _SYM_CLASS_PAD * 2 + 10, height: h });
    }

    // Deduplicated top-level edges
    const rawEdges = elements.edges.map(e => ({
        source: _symGetTopLevelId(e.data.source, elements),
        target: _symGetTopLevelId(e.data.target, elements),
    })).filter(e => e.source !== e.target);

    const classPos = (window.TrailLayouter && topNodes.length)
        ? TrailLayouter.layout(topNodes, _symDedupeEdges(rawEdges), { rankDir: 'LR', rankSep: 220, nodeSep: 80 })
        : {};

    // Fallback: if TrailLayouter unavailable, arrange horizontally
    if (!Object.keys(classPos).length) {
        topNodes.forEach((n, i) => { classPos[n.id] = { x: i * 280, y: 0 }; });
    }

    // Compute member + divider positions per class card
    const allPos = { ...classPos };
    const computed = new Set();
    for (const el of elements.nodes) {
        if (!el.data.isMember && !el.data.isDivider) continue;
        const topId = el.data.parent || el.data.id;
        if (computed.has(topId)) continue;
        const cp = classPos[topId];
        if (!cp) continue;
        const symId = (topId === 'center') ? center.id : topId;
        const sym   = symById[symId];
        if (!sym) continue;
        computed.add(topId);
        const mp = _symMemberPositions(sym, cp, topId, elements);
        Object.assign(allPos, mp);
    }
    return allPos;
}

function _symEstimateCardHeight(sym, nodeId, elements) {
    const memberNodes = elements.nodes.filter(n => n.data.isMember && n.data.parent === nodeId);
    const pubCount  = memberNodes.filter(n => n.data.isPublic).length;
    const privCount = memberNodes.length - pubCount;
    if (!memberNodes.length) return 44;
    const total = memberNodes.length;
    let h = _SYM_CLASS_HDR + _SYM_CLASS_PAD * 2;
    h += total * (_SYM_MEMBER_H + _SYM_MEMBER_GAP) - _SYM_MEMBER_GAP;
    if (pubCount && privCount) h += _SYM_GROUP_GAP + 3; // divider gap
    return Math.max(h, 60);
}

function _symMemberPositions(sym, classPos, nodeId, elements) {
    const result = {};
    const memberNodes = elements.nodes
        .filter(n => n.data.isMember && n.data.parent === nodeId)
        .sort((a, b) => (a.data.line || 0) - (b.data.line || 0));
    const pub  = memberNodes.filter(n => n.data.isPublic);
    const priv = memberNodes.filter(n => !n.data.isPublic);
    const hasDivider = pub.length > 0 && priv.length > 0;
    const totalH = _symEstimateCardHeight(sym, nodeId, elements);
    const cx = classPos.x;
    let y = classPos.y - totalH / 2 + _SYM_CLASS_HDR + _SYM_CLASS_PAD;

    for (const n of pub) {
        result[n.data.id] = { x: cx, y: y + _SYM_MEMBER_H / 2 };
        y += _SYM_MEMBER_H + _SYM_MEMBER_GAP;
    }
    if (hasDivider) {
        // Position the divider node
        const divId = `${nodeId}__div`;
        result[divId] = { x: cx, y: y + 1 };
        y += _SYM_GROUP_GAP + 3;
    }
    for (const n of priv) {
        result[n.data.id] = { x: cx, y: y + _SYM_MEMBER_H / 2 };
        y += _SYM_MEMBER_H + _SYM_MEMBER_GAP;
    }
    return result;
}

function _symGetTopLevelId(nodeId, elements) {
    let id = nodeId;
    for (let i = 0; i < 6; i++) {
        const el = elements.nodes.find(n => n.data.id === id);
        if (!el || !el.data.parent) return id;
        id = el.data.parent;
    }
    return id;
}

function _symDedupeEdges(edges) {
    const seen = new Set();
    return edges.filter(e => {
        const key = `${e.source}\u2192${e.target}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ── Tap handler ───────────────────────────────────────────────────────────────

function _symOnNodeTap(event, data) {
    const d = event.target.data();
    if (d.isGroup) return;
    _symHideEdgeTooltip();

    if (d.isMember) {
        _sym.cy.nodes().removeClass('sym-active-member');
        event.target.addClass('sym-active-member');
        const file = _symCenterFile();
        if (!file) return;
        const alreadyOpen = window.codeState && codeState.currentFile === file;
        if (!alreadyOpen && window.loadFileInPanel) {
            loadFileInPanel(file, null);
            if (d.line) setTimeout(() => window.jumpToLine && jumpToLine(d.line), 150);
        } else if (d.line && window.jumpToLine) {
            jumpToLine(d.line);
        }
        return;
    }

    if (d.isCenter) {
        const sym = data.center;
        if (sym.file && window.loadFileInPanel) loadFileInPanel(sym.file, sym.name);
        return;
    }

    if (d.symId) symViewActivate(d.symId);
}

// ── Edge tooltip (bundled edges) ──────────────────────────────────────────────

function _symOnEdgeTap(e) {
    const d  = e.target.data();
    const oe = e.originalEvent;
    if (!oe) return;
    const tooltip = document.getElementById('sym-edge-tooltip');
    if (!tooltip) return;

    const typeColor = _SYM_EDGE_COLORS[d.edgeType] || '#94a3b8';
    tooltip.innerHTML =
        `<span class="sym-et-type" style="color:${_symEscHtml(typeColor)}">${_symEscHtml(d.edgeType || 'edge')}</span>` +
        (d.count > 1 ? `<span class="sym-et-count">\xd7${d.count}</span>` : '');
    tooltip.style.left = (oe.clientX + 14) + 'px';
    tooltip.style.top  = (oe.clientY - 12) + 'px';
    tooltip.classList.add('visible');
}

function _symHideEdgeTooltip() {
    const tooltip = document.getElementById('sym-edge-tooltip');
    if (tooltip) tooltip.classList.remove('visible');
}

// ── Search ────────────────────────────────────────────────────────────────────

async function _symSearch(query) {
    const container = document.getElementById('sym-search-results');
    if (!container) return;
    if (!query || query.length < 2) { container.innerHTML = ''; return; }
    const jid = _sym.jobId || '';
    try {
        const resp = await fetch(`/symbols?job=${encodeURIComponent(jid)}&query=${encodeURIComponent(query)}`);
        const result = await resp.json();
        _symShowSearchResults(result.results || []);
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
        item.innerHTML = `<span class="sym-kind-badge kind-${r.kind}">${_symEscHtml(r.kind)}</span>` +
                         `<span>${_symEscHtml(r.name)}</span>`;
        item.onclick = () => {
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

function _symCenterFile() {
    if (!_sym.active || !window.DATA || !DATA.symbol_index) return null;
    const sym = DATA.symbol_index[_sym.active];
    return sym ? sym.file : null;
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
