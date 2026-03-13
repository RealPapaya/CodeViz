// ── Symbol View — Sourcetrail-style, embedded in #graph-wrap ─────────────────
// Phase 1+2: Symbol Index + basic symbol graph (Cytoscape dagre LR).
// Phase 3: Compound class card nodes (PUBLIC/PRIVATE sections) + TrailLayouter.
// Phase 6: Section expand/collapse toggle on group header nodes.
// Phase 7: Edge type filter pills in toolbar.
// Phase 8: Back/Forward navigation with future stack + layout animation.
//
// Entry points (called from viz.js):
//   symViewOpen(fileRel)   — open the primary symbol in a file
//   symViewActivate(symId) — navigate to a specific symbol
//   symViewClose()         — hide, restore #cy

'use strict';

const _sym = {
    active:    null,   // current center symbol id
    history:   [],     // back stack  [symId, ...]
    future:    [],     // forward stack [symId, ...]
    cy:        null,   // Cytoscape instance inside #sym-cy
    jobId:     null,
    ready:     false,
    collapsed:       new Set(),  // nodeIds whose class card is collapsed
    hiddenEdgeTypes: new Set(),  // edge type keys that are currently hidden
};

// ── Sizing constants (must match _symEstimateCardHeight) ──────────────────────
const _SYM_MEMBER_W    = 130;
const _SYM_MEMBER_H    = 22;
const _SYM_MEMBER_GAP  = 4;
const _SYM_SEC_HDR_H   = 18;   // height of ⊕ PUBLIC / 🏠 PRIVATE section header
const _SYM_CLASS_HDR_H = 26;   // height of class name header child node
const _SYM_SEC_GAP     = 6;    // gap between public and private sections
const _SYM_CLASS_PAD   = 6;    // compound padding (all sides)

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
    // ── Compound class card (no label — name shown via isClassHdr child) ────
    {
        selector: 'node[?isClassCard]',
        style: {
            'shape':                        'roundrectangle',
            'background-color':             '#0d1a2e',
            'border-color':                 '#334155',
            'border-width':                 1.5,
            'label':                        '',
            'padding':                      `${_SYM_CLASS_PAD}px`,
            'compound-sizing-wrt-labels':   'exclude',
        },
    },
    {
        selector: 'node[isCenter][?isClassCard]',
        style: { 'border-color': '#00d4ff', 'border-width': 2 },
    },
    // ── Class name header child node ─────────────────────────────────────────
    {
        selector: 'node[?isClassHdr]',
        style: {
            'shape':             'rectangle',
            'background-color':  '#0d1a2e',
            'border-width':      0,
            'label':             'data(label)',
            'text-valign':       'center',
            'text-halign':       'center',
            'color':             '#94a3b8',
            'font-size':         11,
            'font-weight':       600,
            'width':             _SYM_MEMBER_W,
            'height':            _SYM_CLASS_HDR_H,
        },
    },
    {
        selector: 'node[isCenter][?isClassHdr]',
        style: { 'color': '#00d4ff' },
    },
    // ── Section header (⊕ PUBLIC / 🏠 PRIVATE) ─────────────────────────────
    {
        selector: 'node[?isSectionHdr]',
        style: {
            'shape':             'rectangle',
            'background-color':  '#0b1628',
            'border-width':      0,
            'label':             'data(label)',
            'text-valign':       'center',
            'text-halign':       'left',
            'text-margin-x':     6,
            'color':             '#64748b',
            'font-size':         9,
            'font-weight':       700,
            'text-transform':    'uppercase',
            'letter-spacing':    0.5,
            'width':             _SYM_MEMBER_W,
            'height':            _SYM_SEC_HDR_H,
        },
    },
    // ── Member badge nodes (inside compound) ─────────────────────────────────
    {
        selector: 'node[?isMember]',
        style: {
            'shape':             'roundrectangle',
            'background-color':  '#2a1f0e',
            'border-color':      '#78500a',
            'border-width':      1,
            'label':             'data(label)',
            'text-valign':       'center',
            'text-halign':       'center',
            'color':             '#fbbf24',
            'font-size':         10,
            'font-family':       'JetBrains Mono, monospace',
            'width':             _SYM_MEMBER_W,
            'height':            _SYM_MEMBER_H,
        },
    },
    {
        selector: 'node[?isMember][?isPublic]',
        style: {
            'background-color': '#2a1f0e',
            'border-color':     '#78500a',
            'color':            '#fbbf24',
        },
    },
    {
        selector: 'node[?isMember][!isPublic]',
        style: {
            'background-color': '#0d1e30',
            'border-color':     '#1e3a52',
            'color':            '#60a5fa',
        },
    },
    {
        selector: 'node.sym-active-member',
        style: { 'border-color': '#00d4ff', 'border-width': 2 },
    },
    // ── Plain symbol nodes ────────────────────────────────────────────────────
    {
        selector: 'node[!isClassCard][!isGroup][!isMember][!isSectionHdr][!isClassHdr]',
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
    { selector: 'node[kind="class"][!isClassCard][!isMember][!isClassHdr]',    style: { 'border-color': '#60a5fa' } },
    { selector: 'node[kind="function"][!isMember][!isClassHdr]', style: { 'shape': 'ellipse', 'border-color': '#34d399' } },
    { selector: 'node[kind="method"][!isMember][!isClassHdr]',   style: { 'shape': 'ellipse', 'border-color': '#a78bfa' } },
    { selector: 'node[kind="struct"][!isClassCard][!isMember][!isClassHdr]',   style: { 'border-color': '#fbbf24' } },
    { selector: 'node[kind="enum"][!isMember][!isClassHdr]',     style: { 'shape': 'diamond', 'border-color': '#fb923c' } },
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
    _sym.future  = [];
    _sym.active  = null;
    symViewActivate(inFile[0].id);
}

function symViewActivate(symId, _fromHistory) {
    if (_sym.active && _sym.active !== symId) {
        _sym.history.push(_sym.active);
        if (!_fromHistory) _sym.future = [];   // new navigation clears forward stack
        _sym.collapsed.clear();  // reset section collapsed state on navigation
    }
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
    _sym.active    = null;
    _sym.history   = [];
    _sym.future    = [];
    _sym.collapsed.clear();
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
                    <button id="sym-back-btn" onclick="_symBack()" title="Back" disabled>&#x21A9;</button>
                    <button id="sym-fwd-btn"  onclick="_symForward()" title="Forward" disabled>&#x21AA;</button>
                    <span id="sym-breadcrumb"></span>
                </div>
                <div id="sym-filter-pills"></div>
                <div id="sym-search-wrapper">
                    <input id="sym-search-input" type="text" placeholder="Search symbols\u2026"
                           autocomplete="off" spellcheck="false">
                    <div id="sym-search-results"></div>
                </div>
                <button id="sym-close-btn" onclick="symViewClose()" title="Close">&#x2715;</button>
            </div>
            <div id="sym-body">
                <div id="sym-cy"></div>
            </div>
            <div id="sym-edge-tooltip" class="sym-edge-tooltip"></div>
        `;
        _symBuildFilterPills();
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
    _symCloseSnippets();

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

    // Phase 8: animated fit-to-view
    _sym.cy.fit(undefined, 60);
    _sym.cy.animate({ fit: { eles: _sym.cy.elements(), padding: 60 } }, { duration: 280, easing: 'ease-out-cubic' });

    // Phase 7: re-apply edge filters after each render
    _symApplyEdgeFilters();

    // Overlay collapse/expand buttons on class card nodes
    // Delay first render until after fit() has settled
    requestAnimationFrame(() => {
        _symUpdateToggleOverlays();
        _sym.cy.on('viewport', _symUpdateToggleOverlays);
    });

    if (center.file && window.loadFileInPanel) loadFileInPanel(center.file, center.name);
    _symUpdateBack();
}

// ── Collapse/expand overlay buttons (HTML, not Cytoscape nodes) ───────────────

function _symUpdateToggleOverlays() {
    if (!_sym.cy) return;
    const container = document.getElementById('sym-cy');
    if (!container) return;

    // Remove old overlays
    container.querySelectorAll('.sym-toggle-btn').forEach(el => el.remove());

    _sym.cy.nodes('[?isClassCard]').forEach(node => {
        const nodeId      = node.id();
        const bb          = node.renderedBoundingBox({ includeLabels: false });
        const isCollapsed = _sym.collapsed.has(nodeId);

        const btn = document.createElement('button');
        btn.className   = 'sym-toggle-btn';
        btn.textContent = isCollapsed ? '\u2304' : '\u2303';  // ⌄ or ⌃
        btn.title       = isCollapsed ? 'Expand' : 'Collapse';
        btn.style.left = `${bb.x2 - 18}px`;
        btn.style.top  = `${bb.y1 + 3}px`;
        // hover handled by CSS .sym-toggle-btn:hover
        btn.addEventListener('click', e => {
            e.stopPropagation();
            if (_sym.collapsed.has(nodeId)) _sym.collapsed.delete(nodeId);
            else _sym.collapsed.add(nodeId);
            _symFetchAndRender(_sym.active);
        });
        container.appendChild(btn);
    });
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
    const isCollapsed = _sym.collapsed.has(nodeId);
    const result = [{ data: {
        id: nodeId, label: '', kind: sym.kind, symId: sym.id,
        isCenter: isCenter || undefined, isClassCard: true,
    }}];

    // Class name header is always present (even when collapsed)
    result.push({ data: {
        id: `${nodeId}__hdr`, parent: nodeId,
        isClassHdr: true, isCenter: isCenter || undefined,
        label: sym.name,
    }});

    if (isCollapsed) return result;  // collapsed: only header, card shrinks

    const pub  = visChildren.filter(c => c.access_level === 'public');
    const priv = visChildren.filter(c => c.access_level !== 'public');

    if (pub.length) {
        result.push({ data: {
            id: `${nodeId}__pub_hdr`, parent: nodeId,
            isSectionHdr: true,
            label: '\u2295 PUBLIC',
        }});
        pub.forEach(m => result.push(_symMakeMemberNode(m, nodeId)));
    }

    if (priv.length) {
        result.push({ data: {
            id: `${nodeId}__priv_hdr`, parent: nodeId,
            isSectionHdr: true,
            label: '\u2302 PRIVATE',
        }});
        priv.forEach(m => result.push(_symMakeMemberNode(m, nodeId)));
    }

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

    // Compute member + section header positions per class card.
    // NOTE: compound parent positions are NOT included — Cytoscape derives them from children.
    const allPos = {};
    const computed = new Set();

    // For non-compound (plain) nodes, keep TrailLayouter positions
    for (const el of elements.nodes) {
        if (el.data.parent) continue;  // skip children (handled below)
        if (el.data.isClassCard) continue;  // skip compound parents
        if (classPos[el.data.id]) allPos[el.data.id] = classPos[el.data.id];
    }

    // For compound class cards: position their children (class hdr, section headers, members)
    for (const el of elements.nodes) {
        if (!el.data.isMember && !el.data.isSectionHdr && !el.data.isClassHdr) continue;
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
    const isCollapsed = _sym.collapsed.has(nodeId);
    // Always has class name header child
    const base = _SYM_CLASS_HDR_H + _SYM_MEMBER_GAP + _SYM_CLASS_PAD * 2;
    if (isCollapsed) return base;

    const memberNodes = elements.nodes.filter(n => n.data.isMember && n.data.parent === nodeId);
    const hdrNodes    = elements.nodes.filter(n => n.data.isSectionHdr && n.data.parent === nodeId);
    if (!memberNodes.length) return base;
    let h = base;
    h += hdrNodes.length * (_SYM_SEC_HDR_H + _SYM_MEMBER_GAP);
    h += memberNodes.length * (_SYM_MEMBER_H + _SYM_MEMBER_GAP);
    // gap between public and private sections
    const hasBoth = memberNodes.some(n => n.data.isPublic) && memberNodes.some(n => !n.data.isPublic);
    if (hasBoth) h += _SYM_SEC_GAP;
    return Math.max(h, 60);
}

function _symMemberPositions(sym, classPos, nodeId, elements) {
    const result   = {};
    const totalH   = _symEstimateCardHeight(sym, nodeId, elements);
    const cx       = classPos.x;
    const children = elements.nodes.filter(n => n.data.parent === nodeId);

    // Starting y: top of content area inside card
    let y = classPos.y - totalH / 2 + _SYM_CLASS_PAD;

    // Class name header (always present)
    const classHdr = children.find(n => n.data.isClassHdr);
    if (classHdr) {
        result[classHdr.data.id] = { x: cx, y: y + _SYM_CLASS_HDR_H / 2 };
        y += _SYM_CLASS_HDR_H + _SYM_MEMBER_GAP;
    }

    if (_sym.collapsed.has(nodeId)) return result;

    // Public section
    const pubHdr = children.find(n => n.data.id === `${nodeId}__pub_hdr`);
    if (pubHdr) {
        result[pubHdr.data.id] = { x: cx, y: y + _SYM_SEC_HDR_H / 2 };
        y += _SYM_SEC_HDR_H + _SYM_MEMBER_GAP;
    }
    const pubMembers = children.filter(n => n.data.isMember && n.data.isPublic)
        .sort((a, b) => (a.data.line || 0) - (b.data.line || 0));
    for (const n of pubMembers) {
        result[n.data.id] = { x: cx, y: y + _SYM_MEMBER_H / 2 };
        y += _SYM_MEMBER_H + _SYM_MEMBER_GAP;
    }

    // Gap between sections
    if (pubMembers.length) y += _SYM_SEC_GAP;

    // Private section
    const privHdr = children.find(n => n.data.id === `${nodeId}__priv_hdr`);
    if (privHdr) {
        result[privHdr.data.id] = { x: cx, y: y + _SYM_SEC_HDR_H / 2 };
        y += _SYM_SEC_HDR_H + _SYM_MEMBER_GAP;
    }
    const privMembers = children.filter(n => n.data.isMember && !n.data.isPublic)
        .sort((a, b) => (a.data.line || 0) - (b.data.line || 0));
    for (const n of privMembers) {
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

    // Section labels and class header are non-interactive (handled by card tap)
    if (d.isSectionHdr || d.isClassHdr) return;

    if (d.isMember) {
        _sym.cy.nodes().removeClass('sym-active-member');
        event.target.addClass('sym-active-member');
        if (d.symId) {
            _symShowSnippets(d.symId, d.line);
        } else {
            // fallback: no symId, open full file at line
            const file = _symCenterFile();
            if (file && window.loadFileInPanel) loadFileInPanel(file, null);
            if (d.line) setTimeout(() => window.jumpToLine && jumpToLine(d.line), 150);
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

// ── Snippet panel (Phase 5) — rendered inside the existing #code-panel ────────

async function _symShowSnippets(symId, _fallbackLine) {
    // Render snippets into the existing right-side code panel (#cp-code-wrap)
    // rather than a separate sidebar, so structure mode reuses the normal panel.
    const wrap       = document.getElementById('cp-code-wrap');
    const filenameEl = document.getElementById('cp-filename');
    const extBadge   = document.getElementById('cp-ext-badge');
    if (!wrap) return;

    // Ensure code panel is visible
    if (window.openCodePanel) openCodePanel();
    if (window.hideFuncBar)   hideFuncBar();

    // Hide loading/empty placeholders and show wrap
    const cpLoading = document.getElementById('cp-loading');
    const cpEmpty   = document.getElementById('cp-empty');
    if (cpLoading) cpLoading.classList.add('hidden');
    if (cpEmpty)   cpEmpty.style.display = 'none';
    wrap.style.display = '';
    wrap.innerHTML = '<div class="sym-snip-loading">Loading\u2026</div>';

    // Sentinel: force next loadFileInPanel call to re-fetch even for same path
    if (window.codeState) codeState.currentFile = '__sym_snippet__';

    const jid = _sym.jobId || '';
    try {
        const resp = await fetch(
            `/symbol-refs?job=${encodeURIComponent(jid)}&sym=${encodeURIComponent(symId)}`
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const sym  = data.symbol || {};

        // Update code panel header to reflect the symbol being inspected
        if (filenameEl) filenameEl.textContent = sym.name || 'References';
        if (extBadge) {
            extBadge.textContent        = (sym.kind || 'SYM').toUpperCase();
            extBadge.style.background   = '#334155';
            extBadge.style.color        = '#e2e8f0';
        }

        _symRenderSnippets(wrap, data);
    } catch (e) {
        console.error('[sym-view] snippet fetch error:', e);
        wrap.innerHTML = '<div class="sym-snip-loading">Error loading references</div>';
    }
}

function _symCloseSnippets() {
    // No separate panel to close — snippets live in #cp-code-wrap.
    // The next loadFileInPanel call (triggered by navigation) overwrites the content.
    if (_sym.cy) _sym.cy.nodes().removeClass('sym-active-member');
}

function _symRenderSnippets(wrap, data) {
    const defs = data.definitions || [];
    const refs  = data.references  || [];

    wrap.innerHTML = '';
    const body = document.createElement('div');
    body.className = 'sym-snip-body';

    if (!defs.length && !refs.length) {
        const empty = document.createElement('div');
        empty.className = 'sym-snip-loading';
        empty.textContent = 'No references found';
        body.appendChild(empty);
    } else {
        if (defs.length) _symAppendSnipSection(body, 'Definition', defs, 'definition');
        if (refs.length) _symAppendSnipSection(body, 'References', refs, 'reference');
    }
    wrap.appendChild(body);
}

function _symAppendSnipSection(container, title, items, type) {
    const hdr = document.createElement('div');
    hdr.className = 'sym-snip-sec-hdr';
    hdr.textContent = `${title} (${items.length})`;
    container.appendChild(hdr);
    for (const item of items) container.appendChild(_symMakeSnipItem(item, type));
}

function _symMakeSnipItem(item, type) {
    const wrap = document.createElement('div');
    wrap.className = `sym-snip-item ${type}`;

    const label = document.createElement('div');
    label.className = 'sym-snip-file-label';
    label.textContent = `${item.file}:${item.line}`;
    label.onclick = () => {
        if (window.loadFileInPanel) loadFileInPanel(item.file, null);
        if (item.line) setTimeout(() => window.jumpToLine && jumpToLine(item.line), 150);
    };
    wrap.appendChild(label);

    const pre = document.createElement('div');
    pre.className = 'sym-snip-pre';
    const snippetLines = (item.snippet || '').split('\n');
    const hlOffset = item.highlight != null ? item.highlight : -1;
    snippetLines.forEach((lineText, i) => {
        const row = document.createElement('div');
        row.className = 'sym-snip-line' + (i === hlOffset ? ' hl' : '');
        const lnum = document.createElement('span');
        lnum.className = 'sym-snip-lnum';
        lnum.textContent = (item.start_line || 1) + i;
        const code = document.createElement('span');
        code.className = 'sym-snip-code';
        code.textContent = lineText;
        row.appendChild(lnum);
        row.appendChild(code);
        pre.appendChild(row);
    });
    wrap.appendChild(pre);
    return wrap;
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

// ── Navigation (Phase 8) ──────────────────────────────────────────────────────

function _symBack() {
    if (!_sym.history.length) return;
    _sym.future.unshift(_sym.active);
    const prev  = _sym.history.pop();
    _sym.active = null;
    symViewActivate(prev, true);
}

function _symForward() {
    if (!_sym.future.length) return;
    _sym.history.push(_sym.active);
    const next  = _sym.future.shift();
    _sym.active = null;
    symViewActivate(next, true);
}

function _symUpdateBack() {
    const back = document.getElementById('sym-back-btn');
    const fwd  = document.getElementById('sym-fwd-btn');
    if (back) back.disabled = _sym.history.length === 0;
    if (fwd)  fwd.disabled  = _sym.future.length  === 0;
}

// ── Edge type filter pills (Phase 7) ─────────────────────────────────────────

// Ordered list of edge types to show in toolbar
const _SYM_FILTER_ORDER = ['call', 'inheritance', 'import', 'type_usage', 'include', 'override', 'member'];

function _symBuildFilterPills() {
    const container = document.getElementById('sym-filter-pills');
    if (!container) return;
    container.innerHTML = '';
    for (const type of _SYM_FILTER_ORDER) {
        const color = _SYM_EDGE_COLORS[type] || '#94a3b8';
        const pill  = document.createElement('button');
        pill.className   = 'sym-filter-pill';
        pill.dataset.type = type;
        pill.title       = `Toggle ${type} edges`;
        pill.innerHTML   = `<span class="sym-fp-dot" style="background:${color}"></span>${type}`;
        pill.addEventListener('click', () => _symToggleEdgeFilter(type, pill));
        container.appendChild(pill);
    }
}

function _symToggleEdgeFilter(type, pill) {
    if (_sym.hiddenEdgeTypes.has(type)) {
        _sym.hiddenEdgeTypes.delete(type);
        pill.classList.remove('sym-fp-off');
    } else {
        _sym.hiddenEdgeTypes.add(type);
        pill.classList.add('sym-fp-off');
    }
    _symApplyEdgeFilters();
}

function _symApplyEdgeFilters() {
    if (!_sym.cy) return;
    _sym.cy.edges().forEach(edge => {
        const type    = edge.data('edgeType');
        const hidden  = _sym.hiddenEdgeTypes.has(type);
        edge.style('display', hidden ? 'none' : 'element');
    });
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
