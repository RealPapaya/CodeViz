/* =============================================================================
   struct_view.js -- Sourcetrail-style Structure View (VIZCODE V4 Plugin)
   
   ARCHITECTURE (v2):
   - Structure button lives in breadcrumb alongside Back / Call Graph / Code
   - Structure view renders in #sv-view (inside #graph-wrap), same as #func-view
   - cy canvas is hidden when sv-view is active (like func-view)
   - Clicking a method badge → code panel jumps to that line
   - Bidirectional sync: code panel click → highlight badge
   ============================================================================= */

// -- Internal State -------------------------------------------------------------
const _sv = {
    active: false,    // true when sv-view is showing
    classes: [],      // last parsed class list
    _src: '',         // cached source
    _ext: '',         // cached extension
    _fname: '',       // cached filename
    _fileRel: '',     // current file rel path
    _activeBadge: null,
    _renderToken: 0,  // incremented on each render — stale async results are dropped
    showExternal: false, // true to show external dependencies
    _legendSnapshot: null,
};
window._sv = _sv;

function _svLegendMarkup() {
    const legendLabel = (typeof T === 'function' ? T('legendLabel') : 'Legend');
    const edgeLabel = (typeof T === 'function' ? T('edgeTypes') : 'Edge Types');
    return `
<div class="legend-title" onclick="this.parentElement.classList.toggle('legend-collapsed')">
  <span>⬡</span> ${legendLabel} <span class="legend-toggle">▾</span>
</div>
<div class="legend-body">
  <div class="legend-section-label">${edgeLabel}</div>
  <div class="legend-row">
    <span class="sv-legend-line sv-legend-cross"></span>
    <span class="legend-label">cross-class</span>
  </div>
  <div class="legend-row">
    <span class="sv-legend-line sv-legend-inner"></span>
    <span class="legend-label">pub→priv</span>
  </div>
  <div class="legend-row">
    <span class="sv-legend-line sv-legend-inherit"></span>
    <span class="legend-label">inherit</span>
  </div>
  <div class="legend-row">
    <span class="sv-legend-line sv-legend-uses"></span>
    <span class="legend-label">uses</span>
  </div>
</div>`;
}

function _svShowLegend() {
    const wrap = document.getElementById('graph-wrap');
    if (!wrap) return;
    let leg = document.getElementById('graph-legend');

    if (!_sv._legendSnapshot) {
        _sv._legendSnapshot = {
            existed: !!leg,
            html: leg ? leg.innerHTML : '',
            className: leg ? leg.className : '',
            opacity: leg ? leg.style.opacity : '',
            pointerEvents: leg ? leg.style.pointerEvents : '',
        };
    }

    if (!leg) {
        leg = document.createElement('div');
        leg.id = 'graph-legend';
        wrap.appendChild(leg);
    }

    leg.className = _sv._legendSnapshot.className || 'legend-collapsed';
    leg.innerHTML = _svLegendMarkup();
    leg.style.opacity = '';
    leg.style.pointerEvents = '';
}

function _svRestoreLegend() {
    const snap = _sv._legendSnapshot;
    if (!snap) return;
    const leg = document.getElementById('graph-legend');
    if (!snap.existed) {
        if (leg) leg.remove();
        _sv._legendSnapshot = null;
        return;
    }
    if (leg) {
        leg.innerHTML = snap.html;
        leg.className = snap.className;
        leg.style.opacity = snap.opacity;
        leg.style.pointerEvents = snap.pointerEvents;
    }
    _sv._legendSnapshot = null;
}

// -- Button lifecycle (called from viz.js) ----------------------------------------

// Called by viz.js when a file is selected that has parseable structure
window.svUpdateStructureBtn = function (fileRel, ext) {
    const btn = document.getElementById('struct-toggle-btn');
    if (!btn) return;
    const extLower = (ext || '').toLowerCase();
    const supported = ['.py', '.cpp', '.c', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.hh',
        '.js', '.jsx', '.ts', '.tsx', '.go'].includes(extLower);

    // Keep fileRel in sync so the Focus Panel can query DATA.funcs_by_file
    if (fileRel) _sv._fileRel = fileRel;

    if (supported && fileRel) {
        btn.disabled = false;
        btn.title = 'Structure View';
    } else {
        btn.disabled = true;
        btn.title = 'Structure View (Not supported for this file)';
    }
    if (_sv && _sv.active) {
        btn.classList.add('active');
    } else {
        btn.classList.remove('active');
    }
};

// Called by viz.js when user dismisses a file / goes back to L0/L1
window.svHideStructureBtn = function () {
    const btn = document.getElementById('struct-toggle-btn');
    if (btn) {
        btn.disabled = true;
        btn.title = 'Structure View (No file selected)';
        btn.classList.remove('active');
    }
    svHideSvView();
};

// Show the sv-view (hides cy like func-view does)
window.svShowSvView = function () {
    // Allow opening via symbol even without source loaded
    if (!_sv._src && !_sv._fileRel) { svHideSvView(); return; }
    _sv.active = true;

    // Switch to structure mode if not already active to align other UI states
    if (typeof state !== 'undefined' && state.level >= 1) {
        const structBtn = document.getElementById('struct-toggle-btn');
        if (structBtn && !structBtn.classList.contains('active')) {
            if (typeof window.switchMode === 'function') {
                window.switchMode('structure');
            }
        }
    }
    const cyEl = document.getElementById('cy');
    if (cyEl) {
        cyEl.style.opacity = '0';
    }
    if (typeof cy !== 'undefined' && cy) {
        _sv._cySavedViewport = { pan: { ...cy.pan() }, zoom: cy.zoom() };
        cy.viewport({ zoom: 1, pan: { x: 50, y: 50 } });
    }
    const fv = document.getElementById('func-view');
    if (fv) fv.classList.remove('active');

    // Hide irrelevant panels
    ['l1-toolbar', 'l2-toolbar', 'layout-switcher', 'l2-legend'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
        }
    });
    _svShowLegend();
    // Turn off Call Graph button active state
    const cgBtn = document.getElementById('graph-toggle-btn');
    if (cgBtn) cgBtn.classList.remove('active');

    const sv = document.getElementById('sv-view');
    if (sv) sv.classList.add('active');
    const btn = document.getElementById('struct-toggle-btn');
    if (btn) btn.classList.add('active');
    // Always render the full-file grid (all classes, PUBLIC/PRIVATE, cross-class arrows)
    _svRender(_sv._src, _sv._ext, _sv._fname);
};

// Hide the sv-view and restore cy
window.svHideSvView = function () {
    _sv.active = false;

    const sv = document.getElementById('sv-view');
    if (sv) { sv.classList.remove('active'); sv.innerHTML = ''; }

    if (window._svCyListener && typeof cy !== 'undefined' && cy) {
        cy.off('pan zoom', window._svCyListener);
        window._svCyListener = null;
    }

    const btn = document.getElementById('struct-toggle-btn');
    if (btn) btn.classList.remove('active');

    const cyEl = document.getElementById('cy');
    if (cyEl) cyEl.style.opacity = '';

    if (typeof cy !== 'undefined' && cy && _sv._cySavedViewport) {
        cy.viewport(_sv._cySavedViewport);
    }

    // Restore irrelevant panels (viz.js will handle display block/none logic, we just restore opacity)
    ['l1-toolbar', 'l2-toolbar', 'layout-switcher', 'l2-legend'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.style.opacity = '';
            el.style.pointerEvents = '';
        }
    });
    _svRestoreLegend();

    // Restore Call Graph button active state if we are in L2
    if (typeof state !== 'undefined' && state.level >= 2) {
        const cgBtn = document.getElementById('graph-toggle-btn');
        if (cgBtn) cgBtn.classList.add('active');
    }

    // Stop local arrow ResizeObserver
    if (_sv._localResizeObserver) {
        _sv._localResizeObserver.disconnect();
    }
    clearTimeout(_sv._localArrowTimer);

    // Clear structure-only code highlight
    document.querySelectorAll('.sv-jump-highlight').forEach(el => el.classList.remove('sv-jump-highlight'));
};

// Toggle from button click
window.svToggleStructView = function () {
    if (_sv.active) {
        if (typeof state !== 'undefined' && state.level >= 2 && typeof window.restoreL1FromCallGraph === 'function') {
            window.restoreL1FromCallGraph();
        } else {
            svHideSvView();
        }
    } else {
        svShowSvView();
    }
};

// -- Hook: called by viz.js renderCode() at the end ----------------------------
// viz.js already has this line at end of renderCode():
//     if (window.svAfterRenderCode) svAfterRenderCode(src, ext, fname);

window.svAfterRenderCode = function (src, ext, fname) {
    _sv._src = src;
    _sv._ext = ext || '';
    _sv._fname = fname || '';
    _sv.classes = _svParseClasses(src, ext);

    // If structure was active, re-render live
    if (_sv.active) {
        _svRender(src, ext, fname);
    }
};

// -- Parsers --------------------------------------------------------------------

function _svParseClasses(src, ext) {
    if (ext === '.py') return _parsePython(src);
    if (['.cpp', '.c', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.hh'].includes(ext)) return _parseCpp(src);
    if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) return _parseJs(src);
    if (ext === '.go') return _parseGo(src);
    return [];
}

/* -- Python -- */
function _parsePython(src) {
    const classes = [];
    const lines = src.split('\n');
    let cur = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const cm = line.match(/^class\s+(\w+)(?:\(([^)]*)\))?:/);
        if (cm) {
            if (cur) classes.push(cur);
            cur = _mkClass(cm[1], i, cm[2] ? cm[2].split(',').map(s => s.trim()).filter(Boolean) : []);
            continue;
        }
        if (!cur) continue;
        const mm = line.match(/^    def\s+(\w+)\s*\(/);
        if (mm) {
            const n = mm[1];
            if (n === '__init__') {
                for (let j = i + 1; j < Math.min(i + 60, lines.length); j++) {
                    if (/^    def\s/.test(lines[j])) break;
                    const fm = lines[j].match(/\s+self\.(\w+)\s*=/);
                    if (fm && !cur.fields.find(f => f.name === fm[1]))
                        cur.fields.push({ name: fm[1], line: j, access: fm[1].startsWith('_') ? 'private' : 'public' });
                }
            }
            const isSpecial = /^__\w+__$/.test(n) && n !== '__init__';
            if (isSpecial || n.startsWith('_')) cur.private_methods.push({ name: n, line: i });
            else cur.public_methods.push({ name: n, line: i });
            continue;
        }
        const fm = line.match(/^    (\w+)\s*(?::\s*[\w\[\], |]+)?\s*=\s*/);
        if (fm && !fm[1].startsWith('def') && !cur.fields.find(f => f.name === fm[1]))
            cur.fields.push({ name: fm[1], line: i, access: fm[1].startsWith('_') ? 'private' : 'public' });
    }
    if (cur) classes.push(cur);

    if (classes.length === 0) {
        const mod = _mkClass(_svBasename(_sv._fname) || 'Module', 0, []);
        for (let i = 0; i < lines.length; i++) {
            const fm = lines[i].match(/^def\s+(\w+)\s*\(/);
            if (fm) {
                if (fm[1].startsWith('_')) mod.private_methods.push({ name: fm[1], line: i });
                else mod.public_methods.push({ name: fm[1], line: i });
            }
        }
        if (mod.public_methods.length + mod.private_methods.length > 0) classes.push(mod);
    }
    return classes;
}

/* -- C / C++ -- */
function _parseCpp(src) {
    const classes = [];
    const lines = src.split('\n');
    let cur = null;
    let access = 'private';
    let depth = 0;
    let classDepth = -1;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.replace(/\/\/.*$/, '').trim();
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;

        const cm = raw.match(/^\s*(?:class|struct)\s+(\w+)(?:\s*:\s*(?:public|protected|private)\s+(\w+))?/);
        if (cm && !raw.trim().startsWith('//') && !raw.trim().startsWith('*')) {
            if (cur) classes.push(cur);
            const isStruct = /\bstruct\b/.test(raw);
            access = isStruct ? 'public' : 'private';
            cur = _mkClass(cm[1], i, cm[2] ? [cm[2]] : []);
            classDepth = depth + opens;
            depth += opens - closes;
            classes.push(cur);
            cur = classes[classes.length - 1];
            continue;
        }
        depth += opens - closes;
        if (!cur) continue;
        if (classDepth >= 0 && depth < classDepth) { cur = null; classDepth = -1; access = 'private'; continue; }
        if (/^public\s*:/.test(line)) { access = 'public'; continue; }
        if (/^private\s*:/.test(line)) { access = 'private'; continue; }
        if (/^protected\s*:/.test(line)) { access = 'protected'; continue; }
        if (depth !== classDepth) continue;
        const methM = line.match(/(?:virtual\s+|static\s+|inline\s+|explicit\s+|constexpr\s+)?(?:[\w:*&<>\[\]]+\s+)+(\w+)\s*\([^)]*\)/);
        if (methM) {
            const n = methM[1];
            if (n === cur.name || n === '~' + cur.name) continue;
            if (access === 'public') cur.public_methods.push({ name: n, line: i });
            else cur.private_methods.push({ name: n, line: i });
            continue;
        }
        const fieldM = line.match(/(?:[\w:*&<>\[\]]+\s+)+(\w[\w_]*)\s*(?:=\s*[^;]*)?\s*;/);
        if (fieldM && !line.includes('(')) {
            const n = fieldM[1];
            if (!cur.fields.find(f => f.name === n))
                cur.fields.push({ name: n, line: i, access });
        }
    }

    if (classes.length === 0) {
        const mod = _mkClass(_svBasename(_sv._fname) || 'Module', 0, []);
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^(?:static\s+)?(?:[\w*&:<>]+\s+)+(\w+)\s*\([^)]*\)\s*\{/);
            if (m) mod.public_methods.push({ name: m[1], line: i });
        }
        if (mod.public_methods.length > 0) classes.push(mod);
    }
    return classes;
}

/* -- JavaScript / TypeScript -- */
function _parseJs(src) {
    const classes = [];
    const lines = src.split('\n');
    let cur = null;
    let depth = 0;
    let classDepth = -1;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.replace(/\/\/.*$/, '').trim();
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;

        const cm = raw.match(/^\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/);
        if (cm) {
            if (cur) classes.push(cur);
            cur = _mkClass(cm[1], i, cm[2] ? [cm[2]] : []);
            classDepth = depth + opens;
            depth += opens - closes;
            classes.push(cur);
            cur = classes[classes.length - 1];
            continue;
        }
        depth += opens - closes;
        if (!cur) continue;
        if (classDepth >= 0 && depth < classDepth) { cur = null; classDepth = -1; continue; }
        if (depth !== classDepth) continue;

        const methM = raw.match(/^\s+(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(\#?\w+)\s*(?:<[^>]*>)?\s*\(/);
        if (methM) {
            const rawN = methM[1], n = rawN.replace('#', '');
            if (n === 'constructor') continue;
            const isPrivate = rawN.startsWith('#') || n.startsWith('_') || /\bprivate\b/.test(raw);
            if (isPrivate) cur.private_methods.push({ name: n, line: i });
            else cur.public_methods.push({ name: n, line: i });
            continue;
        }
        const fieldM = raw.match(/^\s+(?:private\s+|public\s+|protected\s+|readonly\s+|static\s+)*(\#?\w+)\s*(?:!\s*)?(?::\s*[\w<>\[\]| ]+)?\s*(?:=|;)/);
        if (fieldM && !raw.includes('(')) {
            const rawN = fieldM[1], n = rawN.replace('#', '');
            const isPrivate = rawN.startsWith('#') || n.startsWith('_') || /\bprivate\b/.test(raw);
            if (!cur.fields.find(f => f.name === n))
                cur.fields.push({ name: n, line: i, access: isPrivate ? 'private' : 'public' });
        }
    }

    if (classes.length === 0) {
        const mod = _mkClass(_svBasename(_sv._fname) || 'Module', 0, []);
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/)
                || lines[i].match(/^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/);
            if (m) {
                if (m[1].startsWith('_')) mod.private_methods.push({ name: m[1], line: i });
                else mod.public_methods.push({ name: m[1], line: i });
            }
        }
        if (mod.public_methods.length + mod.private_methods.length > 0) classes.push(mod);
    }
    return classes;
}

/* -- Go -- */
function _parseGo(src) {
    const structs = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const sm = lines[i].match(/^type\s+(\w+)\s+struct\s*\{/);
        if (sm) {
            const s = _mkClass(sm[1], i, []);
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim() === '}') break;
                const fm = lines[j].trim().match(/^(\w+)\s+/);
                if (fm) {
                    const n = fm[1], isPrivate = n[0] === n[0].toLowerCase() && n[0] !== n[0].toUpperCase();
                    s.fields.push({ name: n, line: j, access: isPrivate ? 'private' : 'public' });
                }
            }
            structs.push(s);
        }
    }
    for (let i = 0; i < lines.length; i++) {
        const mm = lines[i].match(/^func\s+\(\w+\s+\*?(\w+)\)\s+(\w+)\s*\(/);
        if (mm) {
            const s = structs.find(x => x.name === mm[1]);
            if (s) {
                const n = mm[2], isPrivate = n[0] === n[0].toLowerCase();
                if (isPrivate) s.private_methods.push({ name: n, line: i });
                else s.public_methods.push({ name: n, line: i });
            }
        }
    }
    if (structs.length === 0) {
        const mod = _mkClass(_svBasename(_sv._fname) || 'Module', 0, []);
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^func\s+(\w+)\s*\(/);
            if (m) {
                if (m[1][0] === m[1][0].toLowerCase()) mod.private_methods.push({ name: m[1], line: i });
                else mod.public_methods.push({ name: m[1], line: i });
            }
        }
        if (mod.public_methods.length + mod.private_methods.length > 0) structs.push(mod);
    }
    return structs;
}

// -- Renderer (renders into #sv-view) -------------------------------------------

const _SV_COLORS = [
    '#f59e0b', '#3b82f6', '#10b981', '#ec4899', '#8b5cf6',
    '#06b6d4', '#f97316', '#84cc16', '#e11d48', '#14b8a6',
    '#a855f7', '#22d3ee', '#fb923c', '#4ade80', '#f43f5e',
];

function _svRender(src, ext, fname) {
    const view = document.getElementById('sv-view');
    if (!view) return;
    view.innerHTML = '';

    // Clean up node-drag event listeners from any previous render
    if (typeof _sv._nodeDragCleanup === 'function') {
        _sv._nodeDragCleanup();
        _sv._nodeDragCleanup = null;
    }

    const classes = _svParseClasses(src, ext);
    _sv.classes = classes;

    if (classes.length === 0) {
        view.innerHTML = `<div class="sv-empty">
            <div class="sv-empty-icon">🔍</div>
            <p>No classes or structs found</p>
            <small>${_svEsc(fname)} · Supports Python · C/C++ · JavaScript/TypeScript · Go</small>
        </div>`;
        return;
    }

    const header = document.createElement('div');
    header.className = 'sv-header';
    header.innerHTML = `
        <span class="sv-header-title" style="display:flex;align-items:center;gap:6px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3" width="8" height="6" rx="1"></rect><path d="M12 9v4"></path><path d="M5 13h14"></path><path d="M5 13v3"></path><rect x="2" y="16" width="6" height="5" rx="1"></rect><path d="M19 13v3"></path><rect x="16" y="16" width="6" height="5" rx="1"></rect></svg>Structure<span style="color:var(--muted)">·</span><code>${_svEsc(fname)}</code></span>
        <span class="sv-header-count">${classes.length} class${classes.length !== 1 ? 'es' : ''}</span>
        <div class="sv-header-actions">
            <button class="sv-ext-btn ${_sv.showExternal ? 'active' : ''}" onclick="window._svToggleExternal && window._svToggleExternal(this)">
                ↗ Ext.Deps ${_sv.showExternal ? 'On' : 'Off'}
            </button>
            <button class="sv-close-btn" onclick="svToggleStructView()" title="Close Structure View">✕</button>
        </div>`;
    view.appendChild(header);

    // Scroll area
    const scroll = document.createElement('div');
    scroll.className = 'sv-scroll';
    view.appendChild(scroll);

    // SVG overlay
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'sv-arrows';
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<defs>
        <marker id="sv-ah-uses"          markerWidth="8"  markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#fbbf24bb"/></marker>
        <marker id="sv-ah-inherit"       markerWidth="8"  markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#60a5faaa"/></marker>
        <marker id="sv-ah-cross-file"    markerWidth="8"  markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#f97316cc"/></marker>
        <marker id="sv-ah-call"          markerWidth="8"  markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#fb923ccc"/></marker>
        <marker id="sv-ah-call-inner"    markerWidth="8"  markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#a78bfacc"/></marker>
        <marker id="sv-ah-call-bundled"  markerWidth="11" markerHeight="8" refX="9" refY="4" orient="auto"><polygon points="0 0,11 4,0 8" fill="#fb923c"/></marker>
        <marker id="sv-ah-inner-bundled" markerWidth="11" markerHeight="8" refX="9" refY="4" orient="auto"><polygon points="0 0,11 4,0 8" fill="#a78bfa"/></marker>
    </defs>`;

    const grid = document.createElement('div');
    grid.id = 'sv-grid';

    const tGroup = document.createElement('div');
    tGroup.className = 'sv-transform-group';
    tGroup.style.transformOrigin = '0 0';
    tGroup.style.position = 'absolute';
    tGroup.appendChild(svg);
    tGroup.appendChild(grid);
    scroll.appendChild(tGroup);

    // ── Independent pan/zoom (no Cytoscape dependency) ───────────────────────
    // Disconnect any stale Cytoscape listener from a previous render
    if (typeof cy !== 'undefined' && cy && window._svCyListener) {
        cy.off('pan zoom', window._svCyListener);
        window._svCyListener = null;
    }
    // Reset transform state on each fresh render
    _sv._panX  = 20;
    _sv._panY  = 20;
    _sv._scale = 1.0;
    tGroup.style.transform = `translate(${_sv._panX}px,${_sv._panY}px) scale(${_sv._scale})`;
    // Give the canvas a large virtual size so absolute-positioned nodes don't clip
    tGroup.style.minWidth  = '6000px';
    tGroup.style.minHeight = '4000px';
    _svInitPanZoom(scroll, tGroup, svg);

    // ── Topological sort: callers on left, callees on right ───────────────────
    const _sortedClasses = _svTopoSort(classes);

    // Local classes go into a flex-wrap sub-area; ghost column added later
    const localArea = document.createElement('div');
    localArea.className = 'sv-local-area';
    grid.appendChild(localArea);

    _sortedClasses.forEach((cls) => {
        const ci = classes.indexOf(cls);
        const box = document.createElement('div');
        box.className = 'sv-class-box';
        box.id = `sv-cls-${ci}`;
        const total = cls.public_methods.length + cls.private_methods.length + cls.fields.length;
        const baseColor = _SV_COLORS[ci % _SV_COLORS.length];

        let html = `
        <div class="sv-class-hdr" style="border-top: 3px solid ${baseColor}"
             data-sv-class="${ci}" data-sv-line="${cls.line}">
            <span class="sv-class-name">${_svEsc(cls.name)}</span>
            <span class="sv-class-badge" style="background:${baseColor}22;border-color:${baseColor};color:${baseColor}">${total}</span>
        </div>`;

        if (cls.inherits.length > 0)
            html += `<div class="sv-inherits">↑ ${cls.inherits.map(_svEsc).join(', ')}</div>`;

        if (cls.fields.length > 0) {
            const show = cls.fields.slice(0, 10), extra = cls.fields.length - show.length;
            html += `<div class="sv-section"><div class="sv-section-hdr"><span>#</span> FIELDS</div><div class="sv-items">
            ${show.map(f => `<span class="sv-field sv-field-${f.access || 'private'}" data-sv-class="${ci}" data-sv-line="${f.line}" data-sv-name="${_svEsc(f.name)}" title="${_svEsc(f.name)}">${_svEsc(f.name)}</span>`).join('')}
            ${extra > 0 ? `<span class="sv-more">+${extra}</span>` : ''}</div></div>`;
        }

        if (cls.public_methods.length > 0) {
            const show = cls.public_methods.slice(0, 14), extra = cls.public_methods.length - show.length;
            html += `<div class="sv-section"><div class="sv-section-hdr"><span>🌐</span> PUBLIC</div><div class="sv-items">
            ${show.map((m, mi) => {
                const col = _SV_COLORS[(ci * 5 + mi) % _SV_COLORS.length];
                return `<span class="sv-method" style="background:${col}1a;border-color:${col}88;color:${col}" data-sv-class="${ci}" data-sv-line="${m.line}" data-sv-name="${_svEsc(m.name)}" data-sv-access="public" title="${_svEsc(m.name)}">${_svEsc(m.name)}</span>`;
            }).join('')}
            ${extra > 0 ? `<span class="sv-more">+${extra}</span>` : ''}</div></div>`;
        }

        if (cls.private_methods.length > 0) {
            const show = cls.private_methods.slice(0, 14), extra = cls.private_methods.length - show.length;
            html += `<div class="sv-section"><div class="sv-section-hdr"><span>🏠</span> PRIVATE</div><div class="sv-items">
            ${show.map(m => `<span class="sv-method sv-method-priv" data-sv-class="${ci}" data-sv-line="${m.line}" data-sv-name="${_svEsc(m.name)}" data-sv-access="private" title="${_svEsc(m.name)}">${_svEsc(m.name)}</span>`).join('')}
            ${extra > 0 ? `<span class="sv-more">+${extra}</span>` : ''}</div></div>`;
        }

        box.innerHTML = html;
        localArea.appendChild(box);
    });

    _svAttachBadgeHandlers(scroll);

    // ── Convert flex grid → absolute positions + enable free-drag per node ───
    // Two nested rAFs: first rAF allows flex layout to paint, second reads coords
    requestAnimationFrame(() => requestAnimationFrame(() => {
        _svConvertToAbsolute(localArea);
        _svInitNodeDrag(localArea, svg, scroll);
    }));

    // ── Wire a ResizeObserver so arrows always stick to their badges ──────────
    // Any flex-wrap reflow (window resize, code panel open/close) re-triggers draw.
    // We store refs on _sv so the observer survives re-renders.
    _sv._localArrowClasses = classes;
    _sv._localArrowSvg = svg;
    _sv._localArrowScroll = scroll;

    const _redrawLocal = () => {
        if (!_sv.active) return;
        clearTimeout(_sv._localArrowTimer);
        _sv._localArrowTimer = setTimeout(() => {
            _svDrawArrows(_sv._localArrowClasses, _sv._localArrowSvg, _sv._localArrowScroll);
        }, 30);
    };

    if (!_sv._localResizeObserver) {
        _sv._localResizeObserver = new ResizeObserver(_redrawLocal);
    }
    _sv._localResizeObserver.disconnect();
    _sv._localResizeObserver.observe(localArea);
    const svView = document.getElementById('sv-view');
    if (svView) _sv._localResizeObserver.observe(svView);

    // Initial draw — double rAF ensures flex layout is fully painted first
    requestAnimationFrame(() => requestAnimationFrame(() =>
        _svDrawArrows(classes, svg, scroll)
    ));

    // ── Async: fetch cross-file data from /structure endpoint ─────────────
    _svFetchAndApplyCrossFile(++_sv._renderToken, classes, svg, scroll, grid);

    // ── Async: fetch backend symbol_defs to enrich C/C++ (and any) badges ─
    _svFetchAndMergeSymbols(_sv._renderToken, classes, localArea, svg, scroll);
}

// -- Badge click/hover → code panel sync ----------------------------------------

function _svAttachBadgeHandlers(container) {
    container.addEventListener('click', (e) => {
        const badge = e.target.closest('[data-sv-line]');
        if (!badge) return;
        e.stopPropagation();
        const lineIdx = parseInt(badge.dataset.svLine, 10);
        const classIdx = parseInt(badge.dataset.svClass, 10);
        const name = badge.dataset.svName || '';

        _svSelectBadge(badge, classIdx);
        _svJumpCodeToLine(lineIdx);

        // Focus panel removed per user request
    });

    container.addEventListener('mouseover', (e) => {
        const badge = e.target.closest('[data-sv-line]');
        if (!badge) return;
        badge.classList.add('sv-hover-badge');
    });

    container.addEventListener('mouseout', (e) => {
        const badge = e.target.closest('[data-sv-line]');
        if (!badge) return;
        badge.classList.remove('sv-hover-badge');
    });
}

function _svSelectBadge(badgeEl, classIdx) {
    // Clear previous
    document.querySelectorAll('.sv-active-badge').forEach(b => b.classList.remove('sv-active-badge'));
    document.querySelectorAll('.sv-active-box').forEach(b => b.classList.remove('sv-active-box'));
    badgeEl.classList.add('sv-active-badge');
    _sv._activeBadge = badgeEl;
    const box = document.getElementById(`sv-cls-${classIdx}`);
    if (box) box.classList.add('sv-active-box');
}

function _svHighlightLine(lineIdx) {
    if (!_sv.active) return;
    if (typeof lineIdx !== 'number' || Number.isNaN(lineIdx)) return;
    const lineEl = document.getElementById(`cl-${lineIdx}`);
    if (!lineEl) return;
    document.querySelectorAll('.sv-jump-highlight').forEach(el => el.classList.remove('sv-jump-highlight'));
    lineEl.classList.add('sv-jump-highlight');
}

// Jump to a line in the code panel (jumps to cp-code-wrap line if panel is open)
function _svJumpCodeToLine(lineIdx) {
    if (!_sv.active) return;
    if (typeof jumpToFunc === 'function') {
        // Prefer built-in jumpToFunc if it handles line-based jumping
    }
    // Scroll the code panel to the line
    const lineEl = document.getElementById(`cl-${lineIdx}`);
    if (!lineEl) return;
    // Make sure code panel is visible
    if (typeof openCodePanel === 'function') openCodePanel();
    lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

    _svHighlightLine(lineIdx);
}

window.svHighlightLine = function (lineIdx) {
    _svHighlightLine(lineIdx);
};


// ── Sourcetrail-style pivot point system ──────────────────────────────────────
// Ported from QtLineItemBase::getPivotPoints + getPath().
//
// KEY FIX: getScreenCTM() does NOT include CSS transforms on parent HTML divs.
// tGroup is an HTML element (not SVG), so we parse its transform string directly.
// We set it as "translate(Xpx, Ypx) scale(Z)" — so extraction is exact.

/**
 * Build a viewport→SVG coordinate converter from the tGroup's CSS transform.
 *
 * SVG is at position:absolute top:0 left:0 inside tGroup (transformOrigin:'0 0').
 * Therefore SVG(0,0) renders at the tGroup's getBoundingClientRect() top-left.
 * And scale comes directly from the transform string we wrote ourselves.
 *
 *   svgX = (viewportX - tGroupRect.left) / scale
 *   svgY = (viewportY - tGroupRect.top)  / scale
 */
function _svMakeCoordMapper(scroll) {
    const tGroup = scroll?.querySelector('.sv-transform-group');
    if (!tGroup) return (vpX, vpY) => ({ x: vpX, y: vpY });
    const tgR = tGroup.getBoundingClientRect();
    const sm = (tGroup.style.transform || '').match(/scale\((-?[\d.]+)\)/);
    const scale = sm ? parseFloat(sm[1]) : 1;
    return (vpX, vpY) => ({
        x: (vpX - tgR.left) / scale,
        y: (vpY - tgR.top) / scale,
    });
}

/**
 * Compute 4 candidate connection points for a DOM element, in SVG coords.
 *   [0] top-center  [1] right-center  [2] bottom-center  [3] left-center
 *
 * @param {Element}  el      DOM element
 * @param {Function} toSVG   (vpX, vpY) → {x, y}  from _svMakeCoordMapper
 */
function _svGetPivots(el, toSVG) {
    const r = el.getBoundingClientRect();
    if (r.width + r.height === 0) return null;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return [
        toSVG(cx, r.top),     // [0] top-center
        toSVG(r.right, cy),        // [1] right-center
        toSVG(cx, r.bottom),  // [2] bottom-center
        toSVG(r.left, cy),        // [3] left-center
    ];
}

// Outward direction unit vectors for each side (used for bezier control arms)
const _SV_SIDE_DIR = [
    { x: 0, y: -1 },  // [0] top    → exit upward
    { x: 1, y: 0 },  // [1] right  → exit rightward
    { x: 0, y: 1 },  // [2] bottom → exit downward
    { x: -1, y: 0 },  // [3] left   → exit leftward
];

/**
 * Find the closest same-axis (source side, target side) pair.
 * Same-axis: horizontal pair (sides 1,3) or vertical pair (sides 0,2).
 * This ensures arrows exit/enter perpendicular to the element surface.
 *
 * @param {Array}  srcPts  4 SVG points for source
 * @param {Array}  dstPts  4 SVG points for target
 * @param {string} route   'H'=prefer horizontal  'V'=prefer vertical  ''=any
 */
function _svBestPair(srcPts, dstPts, route) {
    let best = { si: 1, ti: 3, dist: Infinity };
    for (let si = 0; si < 4; si++) {
        for (let ti = 0; ti < 4; ti++) {
            if ((si % 2) !== (ti % 2)) continue;          // same-axis only
            if (route === 'H' && si % 2 === 0) continue;  // skip vertical pairs
            if (route === 'V' && si % 2 === 1) continue;  // skip horizontal pairs
            const dx = srcPts[si].x - dstPts[ti].x;
            const dy = srcPts[si].y - dstPts[ti].y;
            const d = dx * dx + dy * dy;
            if (d < best.dist) best = { si, ti, dist: d };
        }
    }
    return best;
}

/**
 * Build cubic bezier SVG path string (Sourcetrail pull-out style).
 * Control points extend outward from each endpoint perpendicular to its surface.
 */
function _svBezierPath(p1, si, p2, ti, tension) {
    const d1 = _SV_SIDE_DIR[si], d2 = _SV_SIDE_DIR[ti];
    return `M${p1.x},${p1.y} C${p1.x + d1.x * tension},${p1.y + d1.y * tension} ${p2.x + d2.x * tension},${p2.y + d2.y * tension} ${p2.x},${p2.y}`;
}

// Adaptive bezier arm length (in SVG-space pixels)
function _svTension(p1, p2) {
    const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    return Math.max(30, Math.min(d * 0.38, 110));
}

// -- Arrow drawing with click handlers -----------------------------------------

// ── Topological sort: left = callers (root), right = callees (leaves) ─────────
function _svTopoSort(classes) {
    const fileRel = _sv._fileRel;
    const allFuncs = window.DATA?.funcs_by_file?.[fileRel] || [];
    const allEdges = window.DATA?.func_edges_by_file?.[fileRel] || [];

    const labelToCI = new Map();
    classes.forEach((cls, ci) => {
        cls.public_methods.forEach(m => labelToCI.set(m.name, ci));
        cls.private_methods.forEach(m => labelToCI.set(m.name, ci));
    });

    const classEdges = new Set();
    const inDeg = new Array(classes.length).fill(0);
    const adj = Array.from({ length: classes.length }, () => new Set());

    allEdges.forEach(({ s, t }) => {
        const sf = allFuncs[s], tf = allFuncs[t];
        if (!sf || !tf) return;
        const fromCI = labelToCI.get(sf.label);
        const toCI = labelToCI.get(tf.label);
        if (fromCI === undefined || toCI === undefined || fromCI === toCI) return;
        const key = `${fromCI}→${toCI}`;
        if (classEdges.has(key)) return;
        classEdges.add(key);
        adj[fromCI].add(toCI);
        inDeg[toCI]++;
    });

    // Inheritance: parent left of child
    const boxMap = {};
    classes.forEach((cls, i) => { boxMap[cls.name] = i; });
    classes.forEach((cls, ci) => {
        cls.inherits.forEach(parent => {
            const pi = boxMap[parent];
            if (pi !== undefined && pi !== ci) {
                const key = `${pi}→${ci}`;
                if (!classEdges.has(key)) {
                    classEdges.add(key);
                    adj[pi].add(ci);
                    inDeg[ci]++;
                }
            }
        });
    });

    // BFS Kahn's — assign column depth
    const col = new Array(classes.length).fill(0);
    const queue = [];
    for (let i = 0; i < classes.length; i++) {
        if (inDeg[i] === 0) queue.push(i);
    }
    const visited = new Set();
    while (queue.length) {
        const ci = queue.shift();
        if (visited.has(ci)) continue;
        visited.add(ci);
        adj[ci].forEach(nxt => {
            col[nxt] = Math.max(col[nxt], col[ci] + 1);
            inDeg[nxt]--;
            if (inDeg[nxt] <= 0 && !visited.has(nxt)) queue.push(nxt);
        });
    }

    return [...classes].sort((a, b) => {
        const ia = classes.indexOf(a), ib = classes.indexOf(b);
        return col[ia] - col[ib] || a.name.localeCompare(b.name);
    });
}

function _svDrawArrows(classes, svg, scroll) {
    // Remove inherit/uses path arrows, then call arrow groups
    svg.querySelectorAll('.sv-local-arrow').forEach(p => p.remove());
    svg.querySelectorAll('.sv-call-arrow-group').forEach(g => g.remove());

    const boxMap = {};
    classes.forEach((cls, i) => { boxMap[cls.name] = i; });

    const arrows = [];
    classes.forEach((cls, fi) => {
        cls.inherits.forEach(parent => {
            if (boxMap[parent] !== undefined)
                arrows.push({
                    from: fi, to: boxMap[parent], type: 'inherit',
                    targetLine: classes[boxMap[parent]].line, anchorName: null
                });
        });
        cls.fields.forEach(f => {
            const clean = f.name.replace(/^_+|_+$/g, '');
            classes.forEach((other, ti) => {
                if (ti !== fi && other.name.toLowerCase() === clean.toLowerCase())
                    arrows.push({
                        from: fi, to: ti, type: 'uses',
                        targetLine: f.line, anchorName: f.name
                    });
            });
        });
    });

    // Inheritance + field-usage arrows (viewport mapper is fine for box-level)
    if (arrows.length > 0) {
        const toSVG = _svMakeCoordMapper(scroll);
        arrows.forEach(({ from, to, type, targetLine, anchorName }) => {
            const fe = document.getElementById(`sv-cls-${from}`);
            const te = document.getElementById(`sv-cls-${to}`);
            if (!fe || !te) return;

            let startEl = fe;
            if (anchorName)
                for (const b of fe.querySelectorAll('.sv-field'))
                    if (b.dataset.svName === anchorName) { startEl = b; break; }

            const targetEl = te.querySelector('.sv-class-hdr') || te;
            const srcPts = _svGetPivots(startEl, toSVG);
            const dstPts = _svGetPivots(targetEl, toSVG);
            if (!srcPts || !dstPts) return;

            const { si, ti } = _svBestPair(srcPts, dstPts, 'H');
            const p1 = srcPts[si], p2 = dstPts[ti];
            const d = _svBezierPath(p1, si, p2, ti, _svTension(p1, p2));

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            path.classList.add('sv-arrow', 'sv-local-arrow', `sv-arrow-${type}`);
            path.setAttribute('marker-end', `url(#sv-ah-${type})`);
            path.style.pointerEvents = 'stroke';
            path.style.cursor = 'pointer';
            path.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.sv-arrow-active').forEach(a => a.classList.remove('sv-arrow-active'));
                path.classList.add('sv-arrow-active');
                document.getElementById(`sv-cls-${from}`)?.classList.add('sv-active-box');
                document.getElementById(`sv-cls-${to}`)?.classList.add('sv-active-box');
                if (anchorName)
                    for (const b of (document.getElementById(`sv-cls-${from}`)?.querySelectorAll('.sv-field') || []))
                        if (b.dataset.svName === anchorName) { b.classList.add('sv-active-badge'); break; }
                _svJumpCodeToLine(targetLine);
            });
            svg.appendChild(path);
        });
    }

    // Call arrows: cross-class (orange) and same-class pub→priv (violet)
    _svDrawCallArrows(svg);
}


// ── Call-graph arrows with Bundled Edge support ────────────────────────────────
// Groups all edges by (fromClassIdx, toClassIdx) and draws:
//   count == 1 → thin badge-to-badge arrow (original behaviour)
//   count  > 1 → thick box-header-to-box-header arrow + ×N pill label
//                hover shows tooltip; click highlights all source/target badges
function _svDrawCallArrows(svg) {
    const tGroup = svg.parentElement;
    if (!tGroup) return;

    // Remove only our call arrows (not inherit/uses arrows)
    svg.querySelectorAll('.sv-call-arrow-group').forEach(g => g.remove());

    const fileRel = _sv._fileRel;
    const allFuncs = window.DATA?.funcs_by_file?.[fileRel] || [];
    const allEdges = window.DATA?.func_edges_by_file?.[fileRel] || [];
    if (!allFuncs.length || !allEdges.length) return;

    // ── Element → tGroup-local coordinates (= SVG coordinate space) ──────────
    function _localRect(el) {
        let x = 0, y = 0, cur = el;
        while (cur && cur !== tGroup) {
            x += (cur.offsetLeft || 0);
            y += (cur.offsetTop  || 0);
            cur = cur.offsetParent;
        }
        return { x, y, w: el.offsetWidth, h: el.offsetHeight };
    }
    function _pivots(el) {
        const r = _localRect(el);
        if (!r.w && !r.h) return null;
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        return [
            { x: cx,        y: r.y        },  // 0 top-center
            { x: r.x + r.w, y: cy         },  // 1 right-center
            { x: cx,        y: r.y + r.h  },  // 2 bottom-center
            { x: r.x,       y: cy         },  // 3 left-center
        ];
    }

    // ── badge label → {el, access, ci} ───────────────────────────────────────
    const labelMap = new Map();
    document.querySelectorAll('#sv-grid .sv-method[data-sv-name]').forEach(badge => {
        const name = badge.dataset.svName;
        if (!labelMap.has(name)) {
            labelMap.set(name, {
                el:     badge,
                access: badge.dataset.svAccess || (badge.classList.contains('sv-method-priv') ? 'private' : 'public'),
                ci:     parseInt(badge.dataset.svClass, 10),
            });
        }
    });

    // ── Step 1: group every valid edge into a bundle ──────────────────────────
    // Bundle key: `${fromCI}|${toCI}|${type}`
    // Each bundle holds a Map of unique edgeKeys → edge descriptor
    const bundles = new Map();

    allEdges.forEach(({ s, t }) => {
        const sf = allFuncs[s], tf = allFuncs[t];
        if (!sf || !tf) return;
        const from = labelMap.get(sf.label);
        const to   = labelMap.get(tf.label);
        if (!from || !to || from.el === to.el) return;

        const isCross = from.ci !== to.ci;
        const isInner = !isCross && from.access === 'public' && to.access === 'private';
        if (!isCross && !isInner) return;

        const type = isCross ? 'cross' : 'inner';
        const key  = `${from.ci}|${to.ci}|${type}`;

        if (!bundles.has(key)) {
            bundles.set(key, {
                fromCI: from.ci, toCI: to.ci, isCross, isInner,
                edges: new Map(),   // edgeKey → { fromEl, toEl, fromLabel, toLabel, lineIdx }
            });
        }
        const b = bundles.get(key);
        const edgeKey = `${sf.label}→${tf.label}`;
        if (!b.edges.has(edgeKey)) {
            b.edges.set(edgeKey, {
                fromEl:    from.el,
                toEl:      to.el,
                fromLabel: sf.label,
                toLabel:   tf.label,
                lineIdx:   parseInt(to.el.dataset.svLine, 10) || 0,
            });
        }
    });

    if (!bundles.size) return;

    // ── Step 2: draw one SVG group per bundle ─────────────────────────────────
    bundles.forEach(({ fromCI, toCI, isCross, isInner, edges }) => {
        const edgeList   = [...edges.values()];
        const count      = edgeList.length;
        const isBundled  = count > 1;
        const baseColor  = isCross ? '#fb923c' : '#a78bfa';
        const arrowClass = isCross ? 'sv-arrow-call' : 'sv-arrow-call-inner';
        const markerId   = isCross
            ? (isBundled ? 'sv-ah-call-bundled'  : 'sv-ah-call')
            : (isBundled ? 'sv-ah-inner-bundled' : 'sv-ah-call-inner');

        // Source / target elements:
        //   bundled  → class-box header (centre of the whole node)
        //   singular → individual badge elements
        const fromEl = isBundled
            ? (document.getElementById(`sv-cls-${fromCI}`)?.querySelector('.sv-class-hdr')
               || document.getElementById(`sv-cls-${fromCI}`))
            : edgeList[0].fromEl;
        const toEl = isBundled
            ? (document.getElementById(`sv-cls-${toCI}`)?.querySelector('.sv-class-hdr')
               || document.getElementById(`sv-cls-${toCI}`))
            : edgeList[0].toEl;
        if (!fromEl || !toEl) return;

        const srcPts = _pivots(fromEl);
        const dstPts = _pivots(toEl);
        if (!srcPts || !dstPts) return;

        const { si, ti } = _svBestPair(srcPts, dstPts, isCross ? 'H' : '');
        const p1      = srcPts[si], p2 = dstPts[ti];
        const tension = _svTension(p1, p2);
        const d       = _svBezierPath(p1, si, p2, ti, tension);

        // ── SVG group ─────────────────────────────────────────────────────────
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.classList.add('sv-call-arrow-group');

        // Wide transparent hit-area (thin paths are hard to click precisely)
        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hit.setAttribute('d', d);
        hit.setAttribute('stroke', 'transparent');
        hit.setAttribute('stroke-width', isBundled ? '18' : '12');
        hit.setAttribute('fill', 'none');
        hit.style.cursor = 'pointer';
        g.appendChild(hit);

        // Main visible path
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.classList.add('sv-arrow', arrowClass);
        if (isBundled) path.classList.add('sv-arrow-bundled');
        path.setAttribute('marker-end', `url(#${markerId})`);
        path.style.pointerEvents = 'none';
        g.appendChild(path);

        // ── ×N pill label (bundled only) ──────────────────────────────────────
        if (isBundled) {
            // Cubic bezier midpoint at t=0.5 (De Casteljau)
            const d1 = _SV_SIDE_DIR[si], d2 = _SV_SIDE_DIR[ti];
            const cp1x = p1.x + d1.x * tension, cp1y = p1.y + d1.y * tension;
            const cp2x = p2.x + d2.x * tension, cp2y = p2.y + d2.y * tension;
            const mx = 0.125 * p1.x + 0.375 * cp1x + 0.375 * cp2x + 0.125 * p2.x;
            const my = 0.125 * p1.y + 0.375 * cp1y + 0.375 * cp2y + 0.125 * p2.y;

            const labelStr = `×${count}`;
            const pillW    = labelStr.length * 7 + 14;  // dynamic width for ×10, ×100, etc.

            const pill = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            pill.setAttribute('x',      mx - pillW / 2);
            pill.setAttribute('y',      my - 9);
            pill.setAttribute('width',  pillW);
            pill.setAttribute('height', '17');
            pill.setAttribute('rx',     '8');
            pill.setAttribute('fill',   baseColor);
            pill.setAttribute('opacity', '0.93');
            pill.style.pointerEvents = 'none';
            g.appendChild(pill);

            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x',            mx);
            label.setAttribute('y',            my + 5);
            label.setAttribute('text-anchor',  'middle');
            label.classList.add('sv-bundle-label');
            label.textContent    = labelStr;
            label.style.pointerEvents = 'none';
            g.appendChild(label);
        }

        // Tooltip: list all individual edges on hover
        const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        titleEl.textContent = edgeList.map(e => `${e.fromLabel} → ${e.toLabel}`).join('\n');
        g.appendChild(titleEl);

        // ── Interaction ───────────────────────────────────────────────────────
        const _clearAll = () => {
            document.querySelectorAll('.sv-arrow-active').forEach(a  => a.classList.remove('sv-arrow-active'));
            document.querySelectorAll('.sv-active-badge').forEach(b  => b.classList.remove('sv-active-badge'));
            document.querySelectorAll('.sv-active-box').forEach(b    => b.classList.remove('sv-active-box'));
        };

        const _onClick = e => {
            e.stopPropagation();
            _clearAll();
            path.classList.add('sv-arrow-active');
            document.getElementById(`sv-cls-${fromCI}`)?.classList.add('sv-active-box');
            document.getElementById(`sv-cls-${toCI}`)?.classList.add('sv-active-box');
            edgeList.forEach(edge => {
                edge.fromEl.classList.add('sv-active-badge');
                edge.toEl.classList.add('sv-active-badge');
            });
            const lineIdx = edgeList[0].lineIdx;
            if (lineIdx) _svJumpCodeToLine(lineIdx);
        };

        const _onEnter = () => g.classList.add('sv-call-arrow-hover');
        const _onLeave = () => g.classList.remove('sv-call-arrow-hover');

        [hit, path].forEach(el => {
            el.addEventListener('click',      _onClick);
            el.addEventListener('mouseenter', _onEnter);
            el.addEventListener('mouseleave', _onLeave);
        });

        svg.appendChild(g);
    });
}


// -- Helpers --------------------------------------------------------------------

function _mkClass(name, line, inherits) {
    return { name, line, inherits, public_methods: [], private_methods: [], fields: [] };
}
function _svEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _svBasename(p) { return (p || '').split(/[\\/]/).pop().replace(/\.\w+$/, ''); }

window._svToggleExternal = function (btn) {
    _sv.showExternal = !_sv.showExternal;
    btn.textContent = `External Dependencies: ${_sv.showExternal ? 'On' : 'Off'}`;
    if (_sv.showExternal) btn.classList.add('active');
    else btn.classList.remove('active');
    if (_sv.active && _sv._src) {
        _svRender(_sv._src, _sv._ext, _sv._fname);
    }
};



/**
 * Highlight the badge matching `name` in the structure grid and scroll it into view.
 */
function _svHighlightBadgeByName(name) {
    document.querySelectorAll('.sv-active-badge').forEach(b => b.classList.remove('sv-active-badge'));
    document.querySelectorAll('.sv-active-box').forEach(b => b.classList.remove('sv-active-box'));

    const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let badge = document.querySelector(`[data-sv-name="${escaped}"]`);
    let classBox = null;

    if (!badge) {
        const headers = document.querySelectorAll('.sv-class-hdr .sv-class-name');
        for (const h of headers) {
            if (h.textContent === name) {
                badge = h.closest('.sv-class-hdr');
                classBox = badge.closest('.sv-class-box');
                break;
            }
        }
    } else {
        const classIdx = parseInt(badge.dataset.svClass, 10);
        classBox = document.getElementById(`sv-cls-${classIdx}`);
    }

    if (!badge && !classBox) return;

    if (badge) {
        badge.classList.add('sv-active-badge');
        badge.scrollIntoView({ behavior: 'smooth', block: 'center' });
        _sv._activeBadge = badge;
    }
    if (classBox) {
        classBox.classList.add('sv-active-box');
        if (!badge) {
            classBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
}

window.svHighlightBadgeByName = function (name) {
    if (_sv.classes) {
        const exists = _sv.classes.some(cls =>
            cls.name === name ||
            cls.public_methods.some(m => m.name === name) ||
            cls.private_methods.some(m => m.name === name) ||
            cls.fields.some(f => f.name === name)
        );
        if (!exists) return; // Silent ignore if the word clicked is not in the structure
    }

    if (!_sv.active) {
        if (typeof window.svShowSvView === 'function') {
            window.svShowSvView();
            // Short delay to let the DOM render before trying to scroll and highlight
            setTimeout(() => _svHighlightBadgeByName(name), 50);
            return;
        }
    }
    _svHighlightBadgeByName(name);
};

// ── Cross-file arrows — Gap #1 ─────────────────────────────────────────────────

/**
 * Fetch /structure endpoint and apply ghost boxes + cross-file arrows.
 * @param {number} token      — render token; stale fetches are discarded.
 * @param {Array}  classes    — locally parsed class list from _svParseClasses.
 * @param {SVGElement} svg    — the #sv-arrows SVG element.
 * @param {HTMLElement} scroll — the .sv-scroll container.
 * @param {HTMLElement} grid  — the #sv-grid element.
 */
async function _svFetchAndApplyCrossFile(token, classes, svg, scroll, grid) {
    const jid = window.JOB_ID;
    const fileRel = _sv._fileRel;
    if (!jid || !fileRel) return;

    // No loading pill as per user request

    let crossData = null;
    try {
        const r = await fetch(
            `/structure?job=${encodeURIComponent(jid)}&file=${encodeURIComponent(fileRel)}`
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        crossData = await r.json();
    } catch (e) {
        console.warn('[VIZCODE] /structure fetch failed:', e.message);
    } finally {
        document.getElementById('sv-loading-pill')?.remove();
    }

    // Check token: discard if the user navigated to another file
    if (token !== _sv._renderToken) return;
    if (!crossData || crossData.error) return;

    if (!_sv.showExternal) return;

    _svApplyCrossFileData(crossData, classes, svg, scroll, grid);
}

/**
 * Given cross-file data from /structure, inject ghost boxes into a right-column
 * and draw precise Sourcetrail-style cross-file arrows from field badges.
 *
 * Layout: local classes (left area) ←arrows→ ghost column (right)
 *
 * Bug fixes vs previous version:
 *   ① field badge finding uses dataset.svName comparison, not CSS selector (avoids
 *     any attribute-escaping mismatches in querySelector)
 *   ② Three-tier arrow strategy: class_map → inherits → DOM-based badge scan
 *     (DOM-based fallback bypasses class_map path mismatches entirely — it reads
 *     the ghost class badges that are already rendered on screen)
 *   ③ Arrows always route right→left (badge right-edge → ghost box left-edge)
 *     with a smooth bezier; source gets a circle dot; hover highlights both ends.
 */
function _svApplyCrossFileData(crossData, classes, svg, scroll, grid) {
    const { class_map = {}, imports = [], imported_by = [] } = crossData;

    // ── 1. Build ghost file map ────────────────────────────────────────────
    const ghostFileMap = {};
    const _addGhost = (f, direction) => {
        if (!ghostFileMap[f.path])
            ghostFileMap[f.path] = { path: f.path, label: f.label, edge_type: f.edge_type, direction, classes: [] };
    };
    imports.forEach(f => _addGhost(f, 'import'));
    imported_by.forEach(f => _addGhost(f, 'imported_by'));
    Object.entries(class_map).forEach(([cname, info]) => {
        if (ghostFileMap[info.path]) {
            const gf = ghostFileMap[info.path];
            if (!gf.classes.find(c => c.name === cname))
                gf.classes.push({ name: cname, edge_type: info.edge_type });
        }
    });
    const ghostFiles = Object.values(ghostFileMap);
    if (ghostFiles.length === 0) return;

    // ── 2. Build ghost column (right side) ────────────────────────────────
    const ghostColumn = document.createElement('div');
    ghostColumn.className = 'sv-ghost-column';
    const colHdr = document.createElement('div');
    colHdr.className = 'sv-ghost-col-hdr';
    colHdr.innerHTML = '<span class="sv-ghost-col-hdr-icon">↗</span> External Dependencies';
    ghostColumn.appendChild(colHdr);

    const ghostBoxEls = {};    // fi → ghost box DOM element
    const ghostBadgeEls = {};  // fi → { className → badge DOM element }

    ghostFiles.forEach((gf, fi) => {
        const dirIcon = gf.direction === 'import' ? '→' : '←';
        const dirLabel = gf.direction === 'import' ? 'imports' : 'imported by';
        const box = document.createElement('div');
        box.className = 'sv-ghost-box';
        box.id = `sv-ghost-${fi}`;
        ghostBoxEls[fi] = box;
        ghostBadgeEls[fi] = {};

        let html = `<div class="sv-ghost-hdr" title="${_svEsc(gf.path)}">
            <span class="sv-ghost-dir-badge">${dirIcon} ${dirLabel}</span>
            <span class="sv-ghost-fname">${_svEsc(gf.label)}</span>
            ${gf.classes.length > 0 ? `<span class="sv-ghost-count">${gf.classes.length}</span>` : ''}
        </div>`;
        if (gf.classes.length > 0) {
            html += `<div class="sv-ghost-classes">
                ${gf.classes.map(gc =>
                `<span class="sv-ghost-class-badge" data-gcname="${_svEsc(gc.name)}" title="${_svEsc(gf.path)}">${_svEsc(gc.name)}</span>`
            ).join('')}
            </div>`;
        } else {
            html += `<div class="sv-ghost-no-classes">no classes detected</div>`;
        }
        html += `<button class="sv-ghost-nav-btn" data-gpath="${_svEsc(gf.path)}" title="Open in code panel">↗ open file</button>`;
        box.innerHTML = html;

        // Index class badges for precise arrow targeting
        box.querySelectorAll('.sv-ghost-class-badge').forEach(b => {
            ghostBadgeEls[fi][b.dataset.gcname] = b;
        });

        ghostColumn.appendChild(box);
    });
    grid.appendChild(ghostColumn);

    // ── 3. Open-file button handlers ──────────────────────────────────────
    ghostColumn.querySelectorAll('.sv-ghost-nav-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const p = btn.dataset.gpath;
            if (!p) return;
            if (typeof loadFileInPanel === 'function') {
                loadFileInPanel(p);
                if (typeof openCodePanel === 'function') openCodePanel();
            }
            btn.textContent = '✓ opened';
            setTimeout(() => { btn.textContent = '↗ open file'; }, 1500);
        });
    });

    // ── 4. Find field badges (Fix ①: dataset.svName — no CSS selector escaping) ──
    const _findFieldBadge = (boxEl, fieldName) => {
        for (const b of boxEl.querySelectorAll('.sv-field'))
            if (b.dataset.svName === fieldName) return b;
        return null;
    };

    // Find specific ghost class badge as target (Fix ③: Sourcetrail precision) ──
    // Returns the .sv-ghost-class-badge matching className, or null.
    const _findGhostBadge = (fi, className) => {
        if (!className) return null;
        // Exact match first
        if (ghostBadgeEls[fi][className]) return ghostBadgeEls[fi][className];
        // Case-insensitive
        const cl = className.toLowerCase();
        for (const [k, el] of Object.entries(ghostBadgeEls[fi]))
            if (k.toLowerCase() === cl) return el;
        return null;
    };

    // ── 5. Build arrow descriptors ─────────────────────────────────────────
    // Each descriptor: { fromEl, toEl, ghostBoxEl, label, isField }
    // fromEl = field badge (or class header if inheritance)
    // toEl   = ghost class badge (or ghost box header as fallback)

    const localBoxEls = {};
    classes.forEach((_, i) => { const el = document.getElementById(`sv-cls-${i}`); if (el) localBoxEls[i] = el; });

    const pathToFi = {};
    ghostFiles.forEach((gf, fi) => { pathToFi[gf.path] = fi; });

    const localNames = new Set(classes.map(c => c.name));
    const arrowDescs = [];     // { fromEl, toEl, ghostBoxEl, label, isField }
    const seenPairs = new Set();

    const _addDesc = (fromEl, toEl, ghostBoxEl, label, isField = false) => {
        const key = `${fromEl.id || fromEl.dataset?.svName || 'x'}|${toEl.id || toEl.dataset?.gcname || 'g'}`;
        if (seenPairs.has(key)) return;
        seenPairs.add(key);
        arrowDescs.push({ fromEl, toEl, ghostBoxEl, label, isField });
    };

    const classMapEntries = Object.entries(class_map).map(([cname, info]) => ({
        cname, info, lower: cname.toLowerCase()
    }));
    const _findClassMatch = (fieldClean) => {
        const fl = fieldClean.toLowerCase();
        let exact = null, classContains = null, fieldContains = null;
        for (const e of classMapEntries) {
            if (e.lower === fl) { exact = e; break; }
            if (!classContains && e.lower.includes(fl)) classContains = e;
            if (!fieldContains && fl.includes(e.lower) && e.lower.length > 2) fieldContains = e;
        }
        return exact || classContains || fieldContains || null;
    };

    // Strategy A: class_map based
    classes.forEach((cls, ci) => {
        const boxEl = localBoxEls[ci];
        if (!boxEl) return;
        cls.fields.forEach(f => {
            const clean = f.name.replace(/^_+|_+$/g, '');
            if (clean.length < 2) return;
            const match = _findClassMatch(clean);
            if (!match) return;
            const fi = pathToFi[match.info.path];
            if (fi === undefined) return;
            const badge = _findFieldBadge(boxEl, f.name);
            const ghBadge = _findGhostBadge(fi, match.cname) || ghostBoxEls[fi];
            _addDesc(badge || boxEl, ghBadge, ghostBoxEls[fi], `${f.name} → ${match.cname}`, !!badge);
        });
        cls.inherits.forEach(parent => {
            if (localNames.has(parent)) return;
            const match = _findClassMatch(parent);
            if (!match) return;
            const fi = pathToFi[match.info.path];
            if (fi === undefined) return;
            const hdr = boxEl.querySelector('.sv-class-hdr') || boxEl;
            const ghBadge = _findGhostBadge(fi, match.cname) || ghostBoxEls[fi];
            _addDesc(hdr, ghBadge, ghostBoxEls[fi], `extends ${parent}`, false);
        });
    });

    // Strategy B: DOM badge scan (fix ②: bypasses class_map path mismatches)
    if (arrowDescs.length === 0) {
        classes.forEach((cls, ci) => {
            const boxEl = localBoxEls[ci];
            if (!boxEl) return;
            cls.fields.forEach(f => {
                const clean = f.name.replace(/^_+|_+$/g, '').toLowerCase();
                if (clean.length < 2) return;
                Object.entries(ghostBoxEls).forEach(([fi, ghostBoxEl]) => {
                    let matched = false;
                    ghostBoxEl.querySelectorAll('.sv-ghost-class-badge').forEach(badge => {
                        if (matched) return;
                        const cn = badge.textContent.trim().toLowerCase();
                        if (cn === clean || cn.includes(clean) || (clean.includes(cn) && cn.length > 2)) {
                            matched = true;
                            const fieldBadge = _findFieldBadge(boxEl, f.name);
                            _addDesc(
                                fieldBadge || boxEl, badge, ghostBoxEl,
                                `${f.name} → ${badge.textContent.trim()}`, !!fieldBadge
                            );
                        }
                    });
                });
            });
        });
    }

    // Strategy C: fallback box-level arrows
    if (arrowDescs.length === 0) {
        ghostFiles.forEach((gf, fi) => {
            if (gf.direction !== 'import') return;
            const toEl = ghostBoxEls[fi];
            if (!toEl) return;
            const lastIdx = classes.length - 1;
            const fromEl = localBoxEls[lastIdx] ?? localBoxEls[0];
            if (fromEl) _addDesc(fromEl, toEl, toEl, 'uses', false);
        });
    }
    if (arrowDescs.length === 0) return;

    // ── 6. Persist descriptors in _sv for redraw-on-resize ─────────────────
    // Store everything needed so _svRedrawCrossFileArrows() can be called any time.
    _sv._crossArrowDescs = arrowDescs;
    _sv._crossArrowSvg = svg;
    _sv._crossArrowScroll = scroll;

    // ── 7. Draw now, and wire ResizeObserver to redraw on layout change ─────
    //
    // Fix ④ (stale coordinates): The old approach of removing tGroup's transform,
    // measuring, and restoring breaks whenever any container changes size (code
    // panel open/close, window resize).
    //
    // Instead we use svg.createSVGPoint() + getScreenCTM().inverse() which
    // converts screen (page) coordinates → SVG local coordinates correctly
    // regardless of any CSS transforms on ancestor elements.
    _svDrawCrossFileArrows(arrowDescs, svg, scroll);

    if (!_sv._gridResizeObserver) {
        _sv._gridResizeObserver = new ResizeObserver(() => {
            if (_sv.active && _sv._crossArrowDescs) {
                // Debounce: layout may still be settling
                clearTimeout(_sv._gridResizeTimer);
                _sv._gridResizeTimer = setTimeout(() => {
                    _svDrawCrossFileArrows(
                        _sv._crossArrowDescs,
                        _sv._crossArrowSvg,
                        _sv._crossArrowScroll
                    );
                }, 60);
            }
        });
    }
    _sv._gridResizeObserver.disconnect();
    _sv._gridResizeObserver.observe(grid);
    // Also observe the sv-view itself (catches code-panel-driven reflow)
    const svView = document.getElementById('sv-view');
    if (svView) _sv._gridResizeObserver.observe(svView);
}

/**
 * Draw (or redraw) cross-file arrows using svg.createSVGPoint() coordinate
 * conversion.  This is the ONLY function that touches the SVG paths — all
 * arrow descriptors (fromEl, toEl, ghostBoxEl) are plain DOM references so
 * positions are re-measured fresh on every call.
 *
 * Called on first render and whenever ResizeObserver fires.
 */
function _svDrawCrossFileArrows(arrowDescs, svg, scroll) {
    svg.querySelectorAll('.sv-cf-arrow-group').forEach(g => g.remove());
    if (!arrowDescs.length) return;

    // Build coordinate mapper from tGroup's actual CSS transform
    // (Fixes the getScreenCTM() bug: CSS transforms on HTML parents are ignored)
    const toSVG = _svMakeCoordMapper(scroll);

    arrowDescs.forEach(({ fromEl, toEl, ghostBoxEl, label, isField }) => {
        // Skip invisible/unmounted elements
        const fr = fromEl.getBoundingClientRect();
        const tr = toEl.getBoundingClientRect();
        if (fr.width + fr.height === 0 || tr.width + tr.height === 0) return;

        // ── Sourcetrail pivot-point algorithm ─────────────────────────────
        // 4 candidate exits/entries per element → pick closest same-axis pair
        const srcPts = _svGetPivots(fromEl, toSVG);
        const dstPts = _svGetPivots(toEl, toSVG);
        if (!srcPts || !dstPts) return;

        // Ghost column is always to the right → force horizontal routing
        // so arrows always exit right-edge of badges, enter left-edge of ghost
        const { si, ti } = _svBestPair(srcPts, dstPts, 'H');
        const p1 = srcPts[si];
        const p2 = dstPts[ti];
        const d = _svBezierPath(p1, si, p2, ti, _svTension(p1, p2));

        // ── Build SVG group ────────────────────────────────────────────────
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.classList.add('sv-cf-arrow-group');

        // Transparent wide hit-area (thin beziers are hard to hover precisely)
        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hit.setAttribute('d', d);
        hit.setAttribute('stroke', 'transparent');
        hit.setAttribute('stroke-width', '14');
        hit.setAttribute('fill', 'none');
        hit.style.cursor = 'pointer';
        g.appendChild(hit);

        // Glow copy (wider, behind main line)
        const glow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        glow.setAttribute('d', d);
        glow.classList.add('sv-arrow-cf-glow');
        g.appendChild(glow);

        // Main dashed arrow
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.classList.add('sv-arrow', 'sv-arrow-cross-file');
        path.setAttribute('marker-end', 'url(#sv-ah-cross-file)');
        g.appendChild(path);

        // Source dot — sits precisely at the chosen exit point on the badge/box
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', p1.x); dot.setAttribute('cy', p1.y);
        dot.setAttribute('r', isField ? '4' : '5');
        dot.classList.add('sv-arrow-dot-cf');
        g.appendChild(dot);

        // Target dot — sits on the chosen entry point of the ghost badge
        const dotT = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dotT.setAttribute('cx', p2.x); dotT.setAttribute('cy', p2.y);
        dotT.setAttribute('r', '3');
        dotT.classList.add('sv-arrow-dot-cf', 'sv-arrow-dot-cf-target');
        g.appendChild(dotT);

        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        title.textContent = label;
        g.appendChild(title);

        // ── Interaction: hover glows path + highlights both endpoints ──────
        const _activate = () => {
            g.classList.add('sv-cf-arrow-active');
            fromEl.classList.add(isField ? 'sv-active-badge' : 'sv-active-box');
            toEl.classList.add('sv-ghost-badge-active');
            ghostBoxEl.classList.add('sv-ghost-box-active');
        };
        const _deactivate = () => {
            if (g.dataset.clicked) return;
            g.classList.remove('sv-cf-arrow-active');
            fromEl.classList.remove('sv-active-badge');
            fromEl.classList.remove('sv-active-box');
            toEl.classList.remove('sv-ghost-badge-active');
            ghostBoxEl.classList.remove('sv-ghost-box-active');
        };
        [hit, glow, path].forEach(el => {
            el.addEventListener('mouseenter', _activate);
            el.addEventListener('mouseleave', _deactivate);
            el.addEventListener('click', e => {
                e.stopPropagation();
                document.querySelectorAll('.sv-cf-arrow-group[data-clicked]').forEach(old => {
                    delete old.dataset.clicked;
                    old.classList.remove('sv-cf-arrow-active');
                });
                document.querySelectorAll('.sv-ghost-badge-active').forEach(b => b.classList.remove('sv-ghost-badge-active'));
                document.querySelectorAll('.sv-ghost-box-active').forEach(b => b.classList.remove('sv-ghost-box-active'));
                document.querySelectorAll('.sv-active-badge').forEach(b => b.classList.remove('sv-active-badge'));
                g.dataset.clicked = '1';
                _activate();
            });
        });

        svg.appendChild(g);
    });
}


/**
 * Public: redraw cross-file arrows. Call from viz.js when code panel opens/closes.
 * Debounced internally — safe to call immediately after a layout change.
 */
window.svRedrawArrows = function () {
    if (!_sv.active || !_sv._crossArrowDescs) return;
    clearTimeout(_sv._gridResizeTimer);
    _sv._gridResizeTimer = setTimeout(() => {
        _svDrawCrossFileArrows(
            _sv._crossArrowDescs,
            _sv._crossArrowSvg,
            _sv._crossArrowScroll
        );
    }, 40);
};

// ══════════════════════════════════════════════════════════════════════════════
// CANVAS PAN / ZOOM  (independent of Cytoscape)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Attach wheel-zoom and drag-pan listeners to the .sv-scroll container.
 * All transforms are stored in _sv._panX / _sv._panY / _sv._scale and written
 * to `tGroup.style.transform` so _svMakeCoordMapper() continues to work.
 *
 * After every transform the arrows are redrawn via _svRedrawAll().
 */
function _svInitPanZoom(scroll, tGroup, svg) {
    const _apply = () => {
        tGroup.style.transform =
            `translate(${_sv._panX}px,${_sv._panY}px) scale(${_sv._scale})`;
    };
    const _redraw = () => _svRedrawAll(svg, scroll);

    // ── Wheel → zoom toward the cursor ────────────────────────────────────
    scroll.addEventListener('wheel', e => {
        if (!_sv.active) return;
        e.preventDefault();
        const prev  = _sv._scale;
        const delta = e.deltaY < 0 ? 1.10 : (1 / 1.10);
        _sv._scale  = Math.max(0.12, Math.min(6.0, prev * delta));
        // Zoom toward cursor position
        const rect  = scroll.getBoundingClientRect();
        const mx    = e.clientX - rect.left;
        const my    = e.clientY - rect.top;
        _sv._panX   = mx - (mx - _sv._panX) * (_sv._scale / prev);
        _sv._panY   = my - (my - _sv._panY) * (_sv._scale / prev);
        _apply();
        _redraw();
    }, { passive: false });

    // ── Background drag → pan (skip clicks on cards / badges) ─────────────
    let _pan = null;
    const _SKIP = '.sv-class-box,.sv-ghost-box,.sv-header,.sv-header-actions,[data-sv-line],[data-sv-name]';

    scroll.addEventListener('mousedown', e => {
        if (!_sv.active || e.button !== 0) return;
        if (e.target.closest(_SKIP)) return;
        e.preventDefault();
        _pan = { sx: e.clientX, sy: e.clientY, px: _sv._panX, py: _sv._panY };
        scroll.style.cursor = 'grabbing';
    });

    const _stopPan = () => { _pan = null; scroll.style.cursor = ''; };

    scroll.addEventListener('mousemove', e => {
        if (!_pan || !_sv.active) return;
        _sv._panX = _pan.px + (e.clientX - _pan.sx);
        _sv._panY = _pan.py + (e.clientY - _pan.sy);
        _apply();
        _redraw();
    });
    scroll.addEventListener('mouseup',    _stopPan);
    scroll.addEventListener('mouseleave', _stopPan);
}

// ══════════════════════════════════════════════════════════════════════════════
// PER-NODE DRAG  (convert flex → absolute, then allow free repositioning)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * After the initial flex layout has painted, snapshot every class-box's position
 * then switch the localArea to `position:relative` with explicit dimensions and
 * each box to `position:absolute left:X top:Y`.
 *
 * This allows drag-repositioning while keeping the SVG arrow coordinate system
 * (offsetLeft traversal + getBoundingClientRect) fully intact.
 */
function _svConvertToAbsolute(localArea) {
    if (!localArea || localArea.dataset.absLayout) return;
    const boxes = localArea.querySelectorAll(':scope > .sv-class-box');
    if (!boxes.length) return;

    // Single-pass layout read — avoid forced reflow loops
    const baseR = localArea.getBoundingClientRect();
    const snaps = Array.from(boxes).map(b => {
        const r = b.getBoundingClientRect();
        return {
            left: r.left - baseR.left,
            top:  r.top  - baseR.top,
            w: r.width, h: r.height,
        };
    });

    // Canvas size = bounding box of all snaps + padding
    let maxW = 0, maxH = 0;
    snaps.forEach(s => {
        maxW = Math.max(maxW, s.left + s.w);
        maxH = Math.max(maxH, s.top  + s.h);
    });

    localArea.style.position = 'relative';
    localArea.style.width    = (maxW + 80) + 'px';
    localArea.style.height   = (maxH + 80) + 'px';
    localArea.dataset.absLayout = '1';

    boxes.forEach((box, i) => {
        box.style.position = 'absolute';
        box.style.left     = snaps[i].left + 'px';
        box.style.top      = snaps[i].top  + 'px';
    });
}

/**
 * Wire mousedown/move/up drag listeners to every .sv-class-box inside localArea.
 * Dragging a box updates its absolute left/top and triggers an immediate arrow redraw.
 *
 * The drag delta is divided by the current canvas scale so the box tracks the
 * pointer correctly at any zoom level.
 */
function _svInitNodeDrag(localArea, svg, scroll) {
    if (!localArea) return;
    let _drag = null;

    // Capture mousedown on the localArea (event delegation)
    localArea.addEventListener('mousedown', e => {
        if (e.button !== 0 || !_sv.active) return;
        const box = e.target.closest('.sv-class-box');
        if (!box) return;
        // Let badge / method clicks pass through uninterrupted
        if (e.target.closest('[data-sv-line],[data-sv-name]')) return;
        e.stopPropagation();
        e.preventDefault();
        _drag = {
            box,
            sx: e.clientX, sy: e.clientY,
            l0: parseFloat(box.style.left) || 0,
            t0: parseFloat(box.style.top)  || 0,
            scale: _sv._scale || 1,
        };
        box.classList.add('sv-box-dragging');
    });

    // mousemove / mouseup are on document so the drag survives fast cursor moves
    const _onMove = e => {
        if (!_drag || !_sv.active) return;
        const dx = (e.clientX - _drag.sx) / _drag.scale;
        const dy = (e.clientY - _drag.sy) / _drag.scale;
        _drag.box.style.left = (_drag.l0 + dx) + 'px';
        _drag.box.style.top  = (_drag.t0 + dy) + 'px';
        _svRedrawAll(svg, scroll);
    };
    const _onUp = () => {
        if (!_drag) return;
        _drag.box.classList.remove('sv-box-dragging');
        _drag = null;
    };

    document.addEventListener('mousemove', _onMove);
    document.addEventListener('mouseup',   _onUp);

    // Store references so we can clean up on the next render
    _sv._nodeDragCleanup = () => {
        document.removeEventListener('mousemove', _onMove);
        document.removeEventListener('mouseup',   _onUp);
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// UNIFIED ARROW REDRAW
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Redraw both local (intra-file) arrows and cross-file arrows in one call.
 * Safe to call during drag/pan/zoom — local arrows are synchronous, cross-file
 * arrows are debounced to avoid excessive work during rapid mouse movement.
 */
function _svRedrawAll(svg, scroll) {
    if (!svg || !_sv.active) return;
    const classes = _sv._localArrowClasses || [];
    // Synchronous: local arrows are cheap to redraw
    _svDrawArrows(classes, svg, scroll);
    // Debounced: cross-file arrows involve more DOM queries
    if (_sv._crossArrowDescs && _sv._crossArrowSvg) {
        clearTimeout(_sv._crossRedrawTimer);
        _sv._crossRedrawTimer = setTimeout(() => {
            if (!_sv.active) return;
            _svDrawCrossFileArrows(
                _sv._crossArrowDescs,
                _sv._crossArrowSvg,
                _sv._crossArrowScroll
            );
        }, 12);
    }
}


// ══════════════════════════════════════════════════════════════════════════════
// /symbol-file INTEGRATION — backend badge enrichment
// Fetch symbol_index entries for the current file from the server and inject
// any methods/fields that the frontend regex parser missed into the existing
// class-box cards. Additive only — never removes existing badges.
// ══════════════════════════════════════════════════════════════════════════════

async function _svFetchAndMergeSymbols(token, classes, localArea, svg, scroll) {
    const jid     = window.JOB_ID;
    const fileRel = _sv._fileRel;
    if (!jid || !fileRel) return;

    let data = null;
    try {
        const r = await fetch(
            `/symbol-file?job=${encodeURIComponent(jid)}&file=${encodeURIComponent(fileRel)}`
        );
        if (!r.ok) return;
        data = await r.json();
    } catch (_) { return; }

    // Stale-render guard
    if (token !== _sv._renderToken) return;

    const symbols = data?.symbols || [];
    if (!symbols.length) return;

    // ── Build per-class buckets from backend symbols ───────────────────────────
    // kind: 'method' | 'function' → goes into pub / priv lists
    // kind: 'variable'            → goes into fields list
    // kind: 'class'               → skip (already rendered by frontend regex)
    const byClass = {};
    for (const sym of symbols) {
        if (sym.kind === 'class') continue;
        const parent = sym.parent;
        if (!parent) continue;
        if (!byClass[parent]) byClass[parent] = { pub: [], priv: [], fields: [] };
        const b = byClass[parent];
        if (sym.kind === 'method' || sym.kind === 'function') {
            (sym.is_public ? b.pub : b.priv).push({ name: sym.name, line: sym.line });
        } else if (sym.kind === 'variable') {
            b.fields.push({ name: sym.name, line: sym.line, access: sym.is_public ? 'public' : 'private' });
        }
    }

    if (!Object.keys(byClass).length) return;

    let anyAdded = false;

    classes.forEach((cls, ci) => {
        const extra = byClass[cls.name];
        if (!extra) return;

        const box = document.getElementById(`sv-cls-${ci}`);
        if (!box) return;

        // Snapshot existing badge names to avoid duplicates
        const existingNames = new Set();
        box.querySelectorAll('[data-sv-name]').forEach(b => existingNames.add(b.dataset.svName));

        // ── Helper: append new method badges to the correct .sv-section ────────
        const _injectMethods = (items, isPublic) => {
            const newItems = items.filter(m => !existingNames.has(m.name));
            if (!newItems.length) return;

            // Find (or create) the target section
            let section = null;
            const hdrText = isPublic ? 'PUBLIC' : 'PRIVATE';
            const hdrIcon = isPublic ? '🌐' : '🏠';
            box.querySelectorAll('.sv-section').forEach(sec => {
                const hdr = sec.querySelector('.sv-section-hdr');
                if (hdr && hdr.textContent.includes(hdrText)) section = sec;
            });
            if (!section) {
                section = document.createElement('div');
                section.className = 'sv-section';
                section.innerHTML = `<div class="sv-section-hdr"><span>${hdrIcon}</span> ${hdrText}</div><div class="sv-items"></div>`;
                box.appendChild(section);
            }
            const itemsEl = section.querySelector('.sv-items');
            if (!itemsEl) return;

            newItems.forEach((m, idx) => {
                if (existingNames.has(m.name)) return;
                existingNames.add(m.name);
                anyAdded = true;

                const col  = _SV_COLORS[(ci * 5 + idx) % _SV_COLORS.length];
                const span = document.createElement('span');
                span.className        = isPublic ? 'sv-method sv-backend-badge' : 'sv-method sv-method-priv sv-backend-badge';
                if (isPublic) span.style.cssText = `background:${col}1a;border-color:${col}88;color:${col}`;
                span.dataset.svClass  = ci;
                span.dataset.svLine   = m.line;
                span.dataset.svName   = m.name;
                span.dataset.svAccess = isPublic ? 'public' : 'private';
                span.title            = `${m.name} (backend)`;
                span.textContent      = m.name;
                itemsEl.appendChild(span);

                // Keep cls object in sync for arrow drawing
                (isPublic ? cls.public_methods : cls.private_methods).push({ name: m.name, line: m.line });
            });
        };

        // ── Helper: append new field badges ────────────────────────────────────
        const _injectFields = (fields) => {
            const newFields = fields.filter(f => !existingNames.has(f.name));
            if (!newFields.length) return;

            let section = null;
            box.querySelectorAll('.sv-section').forEach(sec => {
                const hdr = sec.querySelector('.sv-section-hdr');
                if (hdr && hdr.textContent.includes('FIELDS')) section = sec;
            });
            if (!section) {
                section = document.createElement('div');
                section.className = 'sv-section';
                section.innerHTML = `<div class="sv-section-hdr"><span>#</span> FIELDS</div><div class="sv-items"></div>`;
                // Insert before PUBLIC section if one exists
                const pubSec = Array.from(box.querySelectorAll('.sv-section'))
                    .find(s => s.querySelector('.sv-section-hdr')?.textContent.includes('PUBLIC'));
                pubSec ? box.insertBefore(section, pubSec) : box.appendChild(section);
            }
            const itemsEl = section.querySelector('.sv-items');
            if (!itemsEl) return;

            newFields.forEach(f => {
                if (existingNames.has(f.name)) return;
                existingNames.add(f.name);
                anyAdded = true;

                const span = document.createElement('span');
                span.className       = `sv-field sv-field-${f.access || 'private'} sv-backend-badge`;
                span.dataset.svClass = ci;
                span.dataset.svLine  = f.line;
                span.dataset.svName  = f.name;
                span.title           = `${f.name} (backend)`;
                span.textContent     = f.name;
                itemsEl.appendChild(span);

                cls.fields.push({ name: f.name, line: f.line, access: f.access });
            });
        };

        _injectMethods(extra.pub,   true);
        _injectMethods(extra.priv,  false);
        _injectFields(extra.fields);
    });

    if (!anyAdded) return;

    // NOTE: _svAttachBadgeHandlers uses event delegation on `scroll`, so dynamically
    // injected badges are already covered — DO NOT re-call it here (would double-fire).

    // Redraw arrows — new badges may be valid arrow endpoints
    requestAnimationFrame(() => _svRedrawAll(svg, scroll));
}


/**
 * Map edge_type string to a representative colour for ghost box styling.
 */
function _svEdgeTypeColor(edgeType) {
    const map = {
        import: '#10b981',
        include: '#c084fc',
        library: '#a78bfa',
        package: '#00d4ff',
        component: '#60a5fa',
        inherit: '#60a5fa',
    };
    return map[edgeType] || '#64748b';
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCETRAIL-STYLE SYMBOL-CENTRIC VIEW
// Entry point: window.svShowSymbol(symId) — shows a 3-column layout inside
// the existing #sv-view:
//   [ Incoming column ] [ Center class box ] [ Outgoing column ]
// Arrows are drawn via SVG beziers with bundled-edge ×N labels.
// Clicking any neighbour box pivots the view to that symbol.
// ══════════════════════════════════════════════════════════════════════════════

// ─── Symbol graph state (separate from file-based _sv state) ──────────────────
const _svSym = {
    activeId: null,
    history: [],    // [{symId}] for back-stack
    _token: 0,     // render token (stale fetches discarded)
};

// ─── Kind icons / colours ─────────────────────────────────────────────────────
const _SVKIND = {
    class: { icon: '🔷', color: '#4c6ef5', tag: 'class' },
    method: { icon: '🔹', color: '#20c997', tag: 'method' },
    function: { icon: '🟢', color: '#37b24d', tag: 'fn' },
    variable: { icon: '🔶', color: '#9775fa', tag: 'var' },
    file: { icon: '📁', color: '#868e96', tag: 'file' },
};
function _svkind(k) { return _SVKIND[k] || { icon: '⬡', color: '#64748b', tag: k }; }

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Show the Sourcetrail-style Symbol-Centric view for the given symId.
 * Opens the Structure panel (if not already open) and replaces its content.
 */
window.svShowSymbol = async function (symId) {
    if (!symId || !window.DATA?.symbol_index?.[symId]) return;
    if (!window.JOB_ID) return;

    // Push to history (before changing activeId)
    _svSym.history.push(_svSym.activeId);
    _svSym.activeId = symId;
    const token = ++_svSym._token;

    // Make sure sv-view is visible
    if (!_sv.active) {
        // Show sv-view without requiring _sv._src
        const cyEl = document.getElementById('cy');
        if (cyEl) { cyEl.style.opacity = '0'; cyEl.style.pointerEvents = 'none'; }
        const funcView = document.getElementById('func-view');
        if (funcView) funcView.style.display = 'none';
        const svView = document.getElementById('sv-view');
        if (svView) svView.style.display = 'flex';
        _sv.active = true;
        const btn = document.getElementById('struct-toggle-btn');
        if (btn) btn.classList.add('active');
    }

    const view = document.getElementById('sv-view');
    if (!view) return;

    // Show loading state
    view.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:13px;gap:10px">
        <span class="spinner" style="width:16px;height:16px;border-width:2px"></span>
        Loading symbol graph…
    </div>`;

    let data = null;
    try {
        const r = await fetch(`/symbol-graph?job=${encodeURIComponent(window.JOB_ID)}&sym=${encodeURIComponent(symId)}`);
        data = await r.json();
    } catch (e) {
        if (token !== _svSym._token) return;
        view.innerHTML = `<div style="padding:20px;color:#f87171">Failed to load symbol graph: ${e.message}</div>`;
        return;
    }

    if (token !== _svSym._token) return;   // stale
    if (data?.error) {
        view.innerHTML = `<div style="padding:20px;color:#f87171">Error: ${data.error}</div>`;
        return;
    }

    _svSymRender(data, view);

    // Sync code panel to definition
    const sym = data.center;
    if (sym?.file && typeof loadFileInPanel === 'function') {
        loadFileInPanel(sym.file, sym.name);
    }
};

/**
 * Convenience: activate by name (used from code panel click).
 * Picks the best match (exact class > function > any).
 */
window.svShowSymbolByName = function (name) {
    if (!window.DATA?.symbol_index) return false;
    const all = Object.values(window.DATA.symbol_index).filter(s => s.name === name);
    if (!all.length) return false;
    const pick = all.find(s => s.kind === 'class')
        || all.find(s => s.kind === 'function')
        || all[0];
    window.svShowSymbol(pick.id);
    return true;
};

/**
 * Go back one step in the symbol pivot history.
 */
window.svSymBack = function () {
    const prev = _svSym.history.pop();
    if (prev) {
        _svSym.activeId = null;  // will be set by svShowSymbol
        window.svShowSymbol(prev);
    } else {
        // Nothing in history → return to file-based structure view or close
        if (_sv._src) {
            _svRender(_sv._src, _sv._ext, _sv._fname);
        } else {
            window.svHideSvView();
        }
    }
};

// ─── Core renderer ────────────────────────────────────────────────────────────

function _svSymRender(data, view) {
    const { center, incoming, outgoing } = data;
    const ck = _svkind(center.kind);

    // ── Build center members HTML (using symbol_index parent link to find siblings)
    const allSyms = window.DATA?.symbol_index || {};
    const members = Object.values(allSyms).filter(s =>
        s.parent === center.name && s.file === center.file
    );
    const pubMethods = members.filter(s => s.kind === 'method' && s.is_public);
    const privMethods = members.filter(s => s.kind === 'method' && !s.is_public);
    const fields = members.filter(s => s.kind === 'variable');

    function _memberBadge(m, type) {
        const icon = type === 'field' ? '●' : (m.is_public === false ? '○' : '◆');
        const cls = type === 'field' ? 'sv-field' : (m.is_public === false ? 'sv-priv' : 'sv-badge');
        return `<span class="${cls} sv-sym-member" data-sym-id="${m.id}" data-line="${m.line}"
            title="${_svEsc(m.name)} : line ${m.line}">${icon} ${_svEsc(m.name)}</span>`;
    }

    const membersHtml = [
        ...(pubMethods.length ? [`<div class="sv-section-label">PUBLIC</div>`, ...pubMethods.map(m => _memberBadge(m, 'method'))] : []),
        ...(privMethods.length ? [`<div class="sv-section-label sv-private-label">PRIVATE</div>`, ...privMethods.map(m => _memberBadge(m, 'method'))] : []),
        ...(fields.length ? [`<div class="sv-section-label">FIELDS</div>`, ...fields.map(m => _memberBadge(m, 'field'))] : []),
    ].join('');

    // ── Column helper
    function _colItem(item, dir) {
        const sk = _svkind(item.sym.kind);
        const bundleTag = item.count > 1 ? `<span class="sv-sym-bundle">×${item.count}</span>` : '';
        const edgeTag = `<span class="sv-sym-edge-type">${item.edge_type}</span>`;
        const parentTag = item.sym.parent ? `<span class="sv-sym-parent">${_svEsc(item.sym.parent)}.</span>` : '';
        const arrow = dir === 'in' ? '→' : '←';
        return `<div class="sv-sym-nbr-box" data-sym-id="${item.sym.id}" title="${_svEsc(item.sym.file)}:${item.sym.line}">
            <div class="sv-sym-nbr-hdr">
                <span class="sv-sym-nbr-icon" style="color:${sk.color}">${sk.icon}</span>
                <span class="sv-sym-nbr-name">${parentTag}<strong>${_svEsc(item.sym.name)}</strong></span>
                ${bundleTag}
            </div>
            <div class="sv-sym-nbr-meta">${edgeTag} <span>${_svEsc(item.sym.file.split('/').pop())}</span></div>
        </div>`;
    }

    const inHtml = incoming.length ? incoming.map(i => _colItem(i, 'in')).join('') : `<div class="sv-sym-empty">No incoming</div>`;
    const outHtml = outgoing.length ? outgoing.map(i => _colItem(i, 'out')).join('') : `<div class="sv-sym-empty">No outgoing</div>`;

    const backBtn = _svSym.history.filter(Boolean).length > 0
        ? `<button class="sv-sym-back-btn" id="sv-sym-back">← Back</button>`
        : '';

    // ── Full layout
    view.innerHTML = `
    <div class="sv-sym-root">
        <div class="sv-sym-topbar">
            ${backBtn}
            <span class="sv-sym-title-icon" style="color:${ck.color}">${ck.icon}</span>
            <span class="sv-sym-title-name">${_svEsc(center.name)}</span>
            <span class="sv-sym-title-kind">${center.kind}</span>
            <span class="sv-sym-title-file" title="${_svEsc(center.file)}">${_svEsc(center.file.split('/').pop())}:${center.line}</span>
            <span class="sv-sym-count in">◀ ${data.total_in}</span>
            <span class="sv-sym-count out">▶ ${data.total_out}</span>
        </div>
        <div class="sv-sym-layout" id="sv-sym-layout">
            <div class="sv-sym-col sv-sym-in-col" id="sv-sym-in-col">
                <div class="sv-sym-col-hdr" style="color:#20c997">◀ CALLERS / INCOMING</div>
                ${inHtml}
            </div>
            <div class="sv-sym-center-col" id="sv-sym-center">
                <div class="sv-class-box sv-sym-center-box" id="sv-sym-center-box">
                    <div class="sv-class-hdr" style="background:${ck.color}22;border-color:${ck.color}">
                        <span class="sv-class-icon">${ck.icon}</span>
                        <span class="sv-class-name">${_svEsc(center.name)}</span>
                        <span class="sv-class-tag" style="background:${ck.color}">${ck.tag}</span>
                    </div>
                    <div class="sv-class-body">
                        ${membersHtml || '<div class="sv-sym-empty" style="font-size:11px">No members found in local file</div>'}
                    </div>
                </div>
            </div>
            <div class="sv-sym-col sv-sym-out-col" id="sv-sym-out-col">
                <div class="sv-sym-col-hdr" style="color:#cc5de8">CALLEES / OUTGOING ▶</div>
                ${outHtml}
            </div>
        </div>
        <svg class="sv-sym-arrows" id="sv-sym-arrows" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible">
            <defs>
                <marker id="sv-sym-ah-in" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L8,3 z" fill="#20c997" opacity="0.85"/>
                </marker>
                <marker id="sv-sym-ah-out" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L8,3 z" fill="#cc5de8" opacity="0.85"/>
                </marker>
            </defs>
        </svg>
    </div>`;

    // ── Event: back button
    document.getElementById('sv-sym-back')?.addEventListener('click', window.svSymBack);

    // ── Event: click neighbour box → pivot
    view.querySelectorAll('.sv-sym-nbr-box').forEach(box => {
        box.addEventListener('click', e => {
            e.stopPropagation();
            const sid = box.dataset.symId;
            if (sid) window.svShowSymbol(sid);
        });
    });

    // ── Event: click member badge → jump code
    view.querySelectorAll('.sv-sym-member').forEach(badge => {
        badge.addEventListener('click', e => {
            e.stopPropagation();
            const sid = badge.dataset.symId;
            const line = parseInt(badge.dataset.line, 10);
            if (sid) {
                const s = window.DATA?.symbol_index?.[sid];
                if (s?.file && typeof loadFileInPanel === 'function') {
                    loadFileInPanel(s.file, s.name);
                }
            }
        });
    });

    // ── Draw bezier arrows after DOM settles
    requestAnimationFrame(() => requestAnimationFrame(() => _svSymDrawArrows(view, incoming, outgoing)));
}

// ─── Bezier arrow drawing (reuses _svGetPivots / _svBezierPath) ───────────────

function _svSymDrawArrows(view, incoming, outgoing) {
    const svg = document.getElementById('sv-sym-arrows');
    if (!svg) return;
    svg.querySelectorAll('.sv-sym-arrow').forEach(p => p.remove());

    const centerBox = document.getElementById('sv-sym-center-box');
    if (!centerBox) return;

    const svgRect = svg.getBoundingClientRect();
    const toLocal = (vpX, vpY) => ({ x: vpX - svgRect.left, y: vpY - svgRect.top });

    function _pivots(el) {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return null;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        return [
            toLocal(cx, r.top),    // 0 top
            toLocal(r.right, cy),  // 1 right
            toLocal(cx, r.bottom), // 2 bottom
            toLocal(r.left, cy),   // 3 left
        ];
    }

    function _drawArrow(fromEl, toEl, color, markerId) {
        if (!fromEl || !toEl) return;
        const sp = _pivots(fromEl), dp = _pivots(toEl);
        if (!sp || !dp) return;

        // Force horizontal routing: right of source → left of target
        const p1 = sp[1], p2 = dp[3];  // right → left
        const tension = Math.max(30, Math.min(Math.abs(p2.x - p1.x) * 0.4, 120));
        const d = `M${p1.x},${p1.y} C${p1.x + tension},${p1.y} ${p2.x - tension},${p2.y} ${p2.x},${p2.y}`;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        path.setAttribute('stroke', color);
        path.setAttribute('stroke-width', '1.5');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-opacity', '0.7');
        path.setAttribute('marker-end', `url(#${markerId})`);
        path.classList.add('sv-sym-arrow');
        svg.appendChild(path);
    }

    // incoming: neighbour.right → center.left
    incoming.forEach(item => {
        const nbrEl = view.querySelector(`.sv-sym-nbr-box[data-sym-id="${item.sym.id}"]`);
        _drawArrow(nbrEl, centerBox, '#20c997', 'sv-sym-ah-in');
    });

    // outgoing: center.right → neighbour.left
    outgoing.forEach(item => {
        const nbrEl = view.querySelector(`.sv-sym-nbr-box[data-sym-id="${item.sym.id}"]`);
        _drawArrow(centerBox, nbrEl, '#cc5de8', 'sv-sym-ah-out');
    });
}

console.log('[VIZCODE] struct_view.js v3 (Sourcetrail Symbol Mode) loaded');

// ─── Dedicated Cytoscape instance for symbol graph ───────────────────────────
let svCy = null;

// Extend _SVKIND with missing kinds (safe to re-add)
Object.assign(_SVKIND, {
    struct: { icon: '🔷', color: '#06b6d4', tag: 'struct' },
    namespace: { icon: '◈', color: '#a78bfa', tag: 'ns' },
    module: { icon: '📦', color: '#ec4899', tag: 'mod' },
    field: { icon: '🔶', color: '#9775fa', tag: 'field' },
    typedef: { icon: '⬡', color: '#64748b', tag: 'typedef' },
});

// ─── Helper: find the best "entry-point" symbol for a given file ─────────────
//  Priority: class/struct first (lowest line#), then function/method.
function _svFindPrimarySymbol(fileRel) {
    const idx = window.DATA?.symbol_index;
    if (!idx || !fileRel) return null;
    let bestClass = null, bestFunc = null;
    for (const [sid, sym] of Object.entries(idx)) {
        if (sym.file !== fileRel) continue;
        if (sym.parent) continue;          // top-level only, skip members
        const line = sym.line || 0;
        if (sym.kind === 'class' || sym.kind === 'struct') {
            if (!bestClass || line < (idx[bestClass]?.line || 0)) bestClass = sid;
        } else if (sym.kind === 'function' || sym.kind === 'method') {
            if (!bestFunc || line < (idx[bestFunc]?.line || 0)) bestFunc = sid;
        }
    }
    return bestClass || bestFunc;
}
window._svFindPrimarySymbol = _svFindPrimarySymbol;

// ─── Auto-launch Symbol mode DISABLED ────────────────────────────────────────
//  Structure view always uses _svRender (full-file grid).

// ─── Destroy svCy on sv-view hide ────────────────────────────────────────────
(function () {
    const _origHide = window.svHideSvView;
    window.svHideSvView = function () {
        if (svCy) {
            try { svCy.destroy(); } catch (_) { }
            svCy = null;
        }
        if (_origHide) _origHide();
    };
})();

// ─── Initialize dedicated Cytoscape for symbol graph ─────────────────────────
function _svCyInit(mountEl) {
    if (svCy) { try { svCy.destroy(); } catch (_) { } svCy = null; }
    if (typeof cytoscape === 'undefined') return null;

    svCy = cytoscape({
        container: mountEl,
        style: [
            // Ghost nodes: invisible point-anchors used only for edge routing
            {
                selector: 'node.ghost',
                style: { opacity: 0, width: 2, height: 2, events: 'no' },
            },
            // ── Edges ─────────────────────────────────────────────────────────
            {
                selector: 'edge',
                style: {
                    'curve-style': 'bezier',
                    'target-arrow-shape': 'triangle',
                    'target-arrow-color': 'data(color)',
                    'line-color': 'data(color)',
                    'width': 'data(width)',
                    'opacity': 0.75,
                    'source-endpoint': 'outside-to-line',
                    'target-endpoint': 'outside-to-line',
                },
            },
            {
                selector: 'edge.bundled',
                style: {
                    'label': 'data(countLabel)',
                    'font-size': '10px',
                    'color': 'data(color)',
                    'text-background-color': '#0d1117',
                    'text-background-opacity': 0.92,
                    'text-background-shape': 'roundrectangle',
                    'text-background-padding': '3px',
                    'text-border-color': 'data(color)',
                    'text-border-width': 1,
                    'text-border-opacity': 0.5,
                },
            },
            {
                selector: 'edge.inheritance',
                style: {
                    'line-style': 'dashed',
                    'target-arrow-shape': 'triangle-hollow',
                },
            },
        ],
        elements: [],
        userZoomingEnabled: true,
        userPanningEnabled: true,
        boxSelectionEnabled: false,
        autoungrabify: true,
        minZoom: 0.08,
        maxZoom: 4,
        wheelSensitivity: 0.2,
    });

    return svCy;
}

// ─── Edge color helper ────────────────────────────────────────────────────────
function _svEdgeColor(etype) {
    return etype === 'inheritance' ? '#60a5fa' :
        etype === 'call' ? '#f59e0b' :
            etype === 'import' ? '#34d399' : '#94a3b8';
}

// ─── Core renderer (replaces the existing _svSymRender) ──────────────────────
//  Called by window.svShowSymbol() after /symbol-graph fetch.
function _svSymRender(data, view) {
    const { center, incoming, outgoing } = data;
    const ck = _svkind(center.kind);

    // ── Collect center members from symbol_index ──────────────────────────────
    const allSyms = window.DATA?.symbol_index || {};
    const members = Object.values(allSyms).filter(
        s => s.parent === center.name && s.file === center.file
    );
    const pubMethods = members.filter(s => s.kind === 'method' && s.is_public !== false);
    const privMethods = members.filter(s => s.kind === 'method' && s.is_public === false);
    const fields = members.filter(s => s.kind === 'variable' || s.kind === 'field');

    // ── Layout constants ──────────────────────────────────────────────────────
    const CARD_W_SIDE = 300;
    const CARD_W_CTR = 320;
    const CARD_GAP = 24;
    const ROW_H_SIDE = 88;   // approx height of a collapsed side card

    // Center card height (estimated)
    const _rowCount = (arr, perRow) => Math.max(1, Math.ceil(arr.length / perRow));
    const centerH = 72                                                             // header + stats
        + (pubMethods.length > 0 ? 28 + _rowCount(pubMethods, 3) * 26 + 4 : 0)
        + (privMethods.length > 0 ? 28 + _rowCount(privMethods, 3) * 26 + 4 : 0)
        + (fields.length > 0 ? 28 + _rowCount(fields, 4) * 22 + 4 : 0)
        + 16;

    const sideCount = Math.max(incoming.length, outgoing.length, 1);
    const totalH = Math.max(sideCount * (ROW_H_SIDE + CARD_GAP), centerH + 80);
    const centerY = Math.round((totalH - centerH) / 2);

    // Column x positions (card LEFT edge)
    const COL_IN = 0;
    const COL_CTR = CARD_W_SIDE + 80;
    const COL_OUT = COL_CTR + CARD_W_CTR + 80;

    // ── Build view DOM ────────────────────────────────────────────────────────
    view.innerHTML = '';
    view.classList.add('sv-sym-mode');

    // — Toolbar —
    const toolbar = document.createElement('div');
    toolbar.id = 'sv-sym-toolbar';
    toolbar.innerHTML = `
        <button id="sv-sym-back-btn" class="sv-sym-tb-btn" ${_svSym.history.filter(Boolean).length === 0 ? 'disabled' : ''}>
            ← Back
        </button>
        <div id="sv-sym-breadcrumb">
            <span class="sv-sym-bc-icon" style="color:${ck.color}">${ck.icon}</span>
            <span class="sv-sym-bc-file">${_svEsc(center.file.split('/').pop())}</span>
            <span class="sv-sym-bc-sep">›</span>
            <span class="sv-sym-bc-name">${_svEsc(center.name)}</span>
            <span class="sv-sym-bc-kind" style="color:${ck.color}">${center.kind}</span>
            <span class="sv-sym-bc-counts">
                <span title="incoming">◀ ${data.total_in}</span>
                <span title="outgoing">▶ ${data.total_out}</span>
            </span>
        </div>
        <div class="sv-sym-search-wrap">
            <input id="sv-sym-search" class="sv-sym-search" type="text"
                   placeholder="⬡ Jump to symbol…" autocomplete="off" spellcheck="false">
            <div id="sv-sym-sr" class="sv-sym-sr" style="display:none"></div>
        </div>
        <button id="sv-sym-fit-btn" class="sv-sym-tb-btn" title="Fit graph to screen">⊡</button>
        <button id="sv-sym-grid-btn" class="sv-sym-tb-btn" title="Switch to File Structure view">≡ File</button>
    `;
    view.appendChild(toolbar);

    // — Main area: Cytoscape mount + HTML cards layer —
    const main = document.createElement('div');
    main.id = 'sv-sym-main';

    const cyMount = document.createElement('div');
    cyMount.id = 'sv-cy-mount';

    const cardsLayer = document.createElement('div');
    cardsLayer.id = 'sv-cards-layer';

    main.appendChild(cyMount);
    main.appendChild(cardsLayer);
    view.appendChild(main);

    // ── Initialize Cytoscape ──────────────────────────────────────────────────
    _svCyInit(cyMount);
    if (!svCy) {
        // Cytoscape not available — fallback: static HTML layout
        _svSymRenderFallback(data, view, centerH, centerY, COL_IN, COL_CTR, COL_OUT,
            CARD_W_SIDE, CARD_W_CTR, pubMethods, privMethods, fields);
        return;
    }

    // ── Sync cards layer to svCy pan/zoom ─────────────────────────────────────
    const _syncTransform = () => {
        if (!svCy) return;
        const { x, y } = svCy.pan();
        const z = svCy.zoom();
        cardsLayer.style.transform = `translate(${x}px,${y}px) scale(${z})`;
    };
    svCy.on('pan zoom', _syncTransform);

    // ── Compute side card y-positions ─────────────────────────────────────────
    const _sideY = (i, total) => {
        if (total === 1) return centerY + (centerH - ROW_H_SIDE) / 2;
        return Math.round(i * (totalH - ROW_H_SIDE) / (total - 1));
    };

    // ── Add ghost nodes + edges to Cytoscape ──────────────────────────────────
    // Ghost node positions = card edge connection points (in model coordinates)
    const ctrInX = COL_CTR;                      // left edge of center card
    const ctrOutX = COL_CTR + CARD_W_CTR;         // right edge of center card
    const ctrMidY = centerY + centerH / 2;

    svCy.add({ data: { id: '_ci' }, position: { x: ctrInX, y: ctrMidY }, classes: 'ghost' });
    svCy.add({ data: { id: '_co' }, position: { x: ctrOutX, y: ctrMidY }, classes: 'ghost' });

    incoming.forEach((item, i) => {
        const cy = _sideY(i, incoming.length) + ROW_H_SIDE / 2;
        svCy.add({ data: { id: `_ig${i}` }, position: { x: COL_IN + CARD_W_SIDE, y: cy }, classes: 'ghost' });
        const color = _svEdgeColor(item.edge_type);
        const isBundled = item.count > 1;
        svCy.add({
            data: {
                id: `_ie${i}`, source: `_ig${i}`, target: '_ci',
                color, width: isBundled ? 3 : 1.5,
                countLabel: isBundled ? `×${item.count}` : ''
            },
            classes: `${item.edge_type} ${isBundled ? 'bundled' : ''}`,
        });
    });

    outgoing.forEach((item, i) => {
        const cy = _sideY(i, outgoing.length) + ROW_H_SIDE / 2;
        svCy.add({ data: { id: `_og${i}` }, position: { x: COL_OUT, y: cy }, classes: 'ghost' });
        const color = _svEdgeColor(item.edge_type);
        const isBundled = item.count > 1;
        svCy.add({
            data: {
                id: `_oe${i}`, source: '_co', target: `_og${i}`,
                color, width: isBundled ? 3 : 1.5,
                countLabel: isBundled ? `×${item.count}` : ''
            },
            classes: `${item.edge_type} ${isBundled ? 'bundled' : ''}`,
        });
    });

    // ── Render HTML cards (positioned in model space) ─────────────────────────
    // Center card
    const cCard = _svMakeCenterCard(center, pubMethods, privMethods, fields, data, ck);
    cCard.style.cssText += `left:${COL_CTR}px;top:${centerY}px;width:${CARD_W_CTR}px;`;
    cardsLayer.appendChild(cCard);

    // Incoming (left column)
    incoming.forEach((item, i) => {
        const cardY = _sideY(i, incoming.length);
        const card = _svMakeSideCard(item, 'in');
        card.style.cssText += `left:${COL_IN}px;top:${cardY}px;width:${CARD_W_SIDE}px;`;
        cardsLayer.appendChild(card);
    });

    // Outgoing (right column)
    outgoing.forEach((item, i) => {
        const cardY = _sideY(i, outgoing.length);
        const card = _svMakeSideCard(item, 'out');
        card.style.cssText += `left:${COL_OUT}px;top:${cardY}px;width:${CARD_W_SIDE}px;`;
        cardsLayer.appendChild(card);
    });

    // ── Fit + apply initial transform ─────────────────────────────────────────
    requestAnimationFrame(() => {
        if (!svCy) return;
        svCy.fit(undefined, 60);
        _syncTransform();
    });

    // ── Wire toolbar buttons ──────────────────────────────────────────────────
    document.getElementById('sv-sym-back-btn')?.addEventListener('click', window.svSymBack);

    document.getElementById('sv-sym-fit-btn')?.addEventListener('click', () => {
        svCy?.fit(undefined, 60);
    });

    document.getElementById('sv-sym-grid-btn')?.addEventListener('click', () => {
        view.classList.remove('sv-sym-mode');
        if (_sv._src) _svRender(_sv._src, _sv._ext, _sv._fname);
        else window.svHideSvView();
    });

    // ── Symbol search ─────────────────────────────────────────────────────────
    _svSymSearchBind(
        document.getElementById('sv-sym-search'),
        document.getElementById('sv-sym-sr')
    );
}

// ─── Center card factory ──────────────────────────────────────────────────────
function _svMakeCenterCard(center, pubMethods, privMethods, fields, graphData, ck) {
    const card = document.createElement('div');
    card.className = 'sv-sc-card sv-sc-center';
    card.dataset.symId = center.id;

    let html = `
    <div class="sv-sc-hdr" style="border-color:${ck.color};background:${ck.color}14;">
        <span class="sv-sc-icon">${ck.icon}</span>
        <span class="sv-sc-name">${_svEsc(center.name)}</span>
        <span class="sv-sc-tag" style="background:${ck.color}33;color:${ck.color}">${ck.tag}</span>
    </div>
    <div class="sv-sc-meta">
        <span class="sv-sc-file" title="${_svEsc(center.file)}">${_svEsc(center.file.split('/').pop())}:${center.line || '?'}</span>
        <span class="sv-sc-flow">◀ ${graphData.total_in}  ▶ ${graphData.total_out}</span>
    </div>`;

    const _section = (label, color, items, perRow, cls) => {
        if (!items.length) return '';
        const shown = items.slice(0, 15), extra = items.length - shown.length;
        const badges = shown.map(m =>
            `<span class="sv-sc-badge ${cls}" data-sym-id="${m.id}" data-line="${m.line}" data-file="${_svEsc(m.file)}" title="${_svEsc(m.name)}">${_svEsc(m.name)}</span>`
        ).join('');
        return `<div class="sv-sc-section">
            <div class="sv-sc-sec-hdr" style="color:${color}">${label}</div>
            <div class="sv-sc-badges">${badges}${extra > 0 ? `<span class="sv-sc-more">+${extra}</span>` : ''}</div>
        </div>`;
    };

    html += _section('◆ PUBLIC', '#20c997', pubMethods, 3, 'sv-pub');
    html += _section('○ PRIVATE', '#cc5de8', privMethods, 3, 'sv-priv');
    html += _section('● FIELDS', '#9775fa', fields, 4, 'sv-field');

    card.innerHTML = html;

    // Member badges → jump to code
    card.querySelectorAll('.sv-sc-badge').forEach(b => {
        b.addEventListener('click', e => {
            e.stopPropagation();
            const s = window.DATA?.symbol_index?.[b.dataset.symId];
            if (s?.file && typeof loadFileInPanel === 'function') {
                loadFileInPanel(s.file, s.name);
            } else if (b.dataset.line) {
                _svJumpCodeToLine(parseInt(b.dataset.line, 10));
            }
        });
    });

    // Header → open file at definition
    card.querySelector('.sv-sc-hdr')?.addEventListener('click', () => {
        if (center.file && typeof loadFileInPanel === 'function')
            loadFileInPanel(center.file, center.name);
    });

    return card;
}

// ─── Side (caller / callee) card factory ─────────────────────────────────────
function _svMakeSideCard(item, dir) {
    const { sym, edge_type, count } = item;
    const sk = _svkind(sym.kind);
    const eColor = _svEdgeColor(edge_type);
    const dirArrow = dir === 'in' ? '→' : '←';

    const card = document.createElement('div');
    card.className = `sv-sc-card sv-sc-side ${dir === 'in' ? 'sv-sc-caller' : 'sv-sc-callee'}`;
    card.dataset.symId = sym.id;

    card.innerHTML = `
    <div class="sv-sc-side-hdr" style="border-color:${sk.color}">
        <span class="sv-sc-icon" style="color:${sk.color}">${sk.icon}</span>
        <span class="sv-sc-name">${sym.parent ? _svEsc(sym.parent) + '.<wbr>' : ''}${_svEsc(sym.name)}</span>
    </div>
    <div class="sv-sc-side-meta">
        <span class="sv-sc-edge-pill" style="background:${eColor}18;color:${eColor};border-color:${eColor}44">
            ${_svEsc(edge_type)}${count > 1 ? ' ×' + count : ''} ${dirArrow}
        </span>
        <span class="sv-sc-file sv-sc-side-file" title="${_svEsc(sym.file)}">${_svEsc(sym.file.split('/').pop())}</span>
    </div>`;

    // Click → pivot to this symbol
    card.addEventListener('click', () => {
        _svSym.history.push(_svSym.activeId);
        _svSym.activeId = null;
        window.svShowSymbol(sym.id);
    });

    return card;
}

// ─── Fallback renderer (when Cytoscape unavailable) ──────────────────────────
function _svSymRenderFallback(data, view, centerH, centerY, COL_IN, COL_CTR, COL_OUT,
    CARD_W_SIDE, CARD_W_CTR, pubMethods, privMethods, fields) {
    const { center, incoming, outgoing } = data;
    const ck = _svkind(center.kind);
    const fallbackEl = document.createElement('div');
    fallbackEl.id = 'sv-sym-fallback';
    // Simple flex layout fallback
    const cCard = _svMakeCenterCard(center, pubMethods, privMethods, fields, data, ck);
    const inCol = document.createElement('div'); inCol.className = 'sv-sym-fb-col';
    const outCol = document.createElement('div'); outCol.className = 'sv-sym-fb-col';
    incoming.forEach(item => inCol.appendChild(_svMakeSideCard(item, 'in')));
    outCol.appendChild(cCard);
    outgoing.forEach(item => outCol.appendChild(_svMakeSideCard(item, 'out')));
    fallbackEl.appendChild(inCol);
    fallbackEl.appendChild(outCol);
    view.appendChild(fallbackEl);
}

// ─── Symbol search ────────────────────────────────────────────────────────────
function _svSymSearchBind(input, resultsEl) {
    if (!input || !resultsEl) return;

    const _search = () => {
        const q = input.value.trim();
        if (q.length < 2) { resultsEl.style.display = 'none'; return; }
        const idx = window.DATA?.symbol_index;
        if (!idx) return;
        const ql = q.toLowerCase();
        const results = [];
        for (const [sid, sym] of Object.entries(idx)) {
            if (sym.parent) continue;   // top-level symbols only
            if (sym.name.toLowerCase().includes(ql)) {
                results.push(sym);
                if (results.length >= 12) break;
            }
        }
        if (!results.length) { resultsEl.style.display = 'none'; return; }

        resultsEl.innerHTML = results.map(sym => {
            const k = _svkind(sym.kind);
            return `<div class="sv-sr-item" data-sid="${sym.id}">
                <span class="sv-sr-icon" style="color:${k.color}">${k.icon}</span>
                <span class="sv-sr-name">${_svEsc(sym.name)}</span>
                <span class="sv-sr-file">${_svEsc(sym.file.split('/').pop())}</span>
                <span class="sv-sr-kind" style="color:${k.color}">${k.tag}</span>
            </div>`;
        }).join('');
        resultsEl.style.display = 'block';

        resultsEl.querySelectorAll('.sv-sr-item').forEach(item => {
            item.addEventListener('mousedown', e => {
                e.preventDefault();
                const sid = item.dataset.sid;
                resultsEl.style.display = 'none';
                input.value = '';
                _svSym.history.push(_svSym.activeId);
                _svSym.activeId = null;
                window.svShowSymbol(sid);
            });
        });
    };

    input.addEventListener('input', _search);
    input.addEventListener('blur', () => setTimeout(() => { resultsEl.style.display = 'none'; }, 160));
    input.addEventListener('focus', () => { if (input.value.trim().length >= 2) _search(); });
}
window._svSymSearchBind = _svSymSearchBind;

console.log('[VIZCODE] sv_p2_additions.js loaded — Phase 2 Symbol-Centric Graph active');
