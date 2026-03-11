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
};
window._sv = _sv;

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
    if (!_sv._src) { svHideSvView(); return; }
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
    ['l1-toolbar', 'l2-toolbar', 'layout-switcher', 'graph-legend', 'l2-legend'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.style.opacity = '0';
            el.style.pointerEvents = 'none';
        }
    });
    // Turn off Call Graph button active state
    const cgBtn = document.getElementById('graph-toggle-btn');
    if (cgBtn) cgBtn.classList.remove('active');

    const sv = document.getElementById('sv-view');
    if (sv) sv.classList.add('active');
    const btn = document.getElementById('struct-toggle-btn');
    if (btn) btn.classList.add('active');
    _svRender(_sv._src, _sv._ext, _sv._fname);
};

// Hide the sv-view and restore cy
window.svHideSvView = function () {
    _sv.active = false;
    _svHideFocusPanel();      // close any open focus panel first
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
    ['l1-toolbar', 'l2-toolbar', 'layout-switcher', 'graph-legend', 'l2-legend'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.style.opacity = '';
            el.style.pointerEvents = '';
        }
    });

    // Restore Call Graph button active state if we are in L2
    if (typeof state !== 'undefined' && state.level >= 2) {
        const cgBtn = document.getElementById('graph-toggle-btn');
        if (cgBtn) cgBtn.classList.add('active');
    }
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
            <button class="sv-nav-btn" onclick="typeof goL2Prev === 'function' && goL2Prev()" title="Previous">&#x21A9;</button>
            <button class="sv-nav-btn" onclick="typeof goL2Next === 'function' && goL2Next()" title="Next">&#x21AA;</button>
            <button class="sv-ext-btn ${_sv.showExternal ? 'active' : ''}" onclick="window._svToggleExternal && window._svToggleExternal(this)">
                External Dependencies: ${_sv.showExternal ? 'On' : 'Off'}
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
        <marker id="sv-ah-uses"       markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#f59e0baa"/></marker>
        <marker id="sv-ah-inherit"    markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#60a5faaa"/></marker>
        <marker id="sv-ah-cross-file" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#f97316cc"/></marker>
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

    // Sync Cytoscape pan/zoom to the transform group
    if (typeof cy !== 'undefined' && cy) {
        if (window._svCyListener) cy.off('pan zoom', window._svCyListener);
        const applyTransform = () => {
            if (!_sv.active) return;
            const p = cy.pan();
            const z = cy.zoom();
            tGroup.style.transform = `translate(${p.x}px, ${p.y}px) scale(${z})`;
        };
        window._svCyListener = () => applyTransform();
        cy.on('pan zoom', window._svCyListener);
        applyTransform();
    }

    // Local classes go into a flex-wrap sub-area; ghost column added later alongside
    const localArea = document.createElement('div');
    localArea.className = 'sv-local-area';
    grid.appendChild(localArea);

    classes.forEach((cls, ci) => {
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
                return `<span class="sv-method" style="background:${col}1a;border-color:${col}88;color:${col}" data-sv-class="${ci}" data-sv-line="${m.line}" data-sv-name="${_svEsc(m.name)}" title="${_svEsc(m.name)}">${_svEsc(m.name)}</span>`;
            }).join('')}
            ${extra > 0 ? `<span class="sv-more">+${extra}</span>` : ''}</div></div>`;
        }

        if (cls.private_methods.length > 0) {
            const show = cls.private_methods.slice(0, 14), extra = cls.private_methods.length - show.length;
            html += `<div class="sv-section"><div class="sv-section-hdr"><span>🏠</span> PRIVATE</div><div class="sv-items">
            ${show.map(m => `<span class="sv-method sv-method-priv" data-sv-class="${ci}" data-sv-line="${m.line}" data-sv-name="${_svEsc(m.name)}" title="${_svEsc(m.name)}">${_svEsc(m.name)}</span>`).join('')}
            ${extra > 0 ? `<span class="sv-more">+${extra}</span>` : ''}</div></div>`;
        }

        box.innerHTML = html;
        localArea.appendChild(box);
    });

    _svAttachBadgeHandlers(scroll);
    requestAnimationFrame(() => _svDrawArrows(classes, svg, scroll));

    // ── Async: fetch cross-file data from /structure endpoint ─────────────
    _svFetchAndApplyCrossFile(++_sv._renderToken, classes, svg, scroll, grid);
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

        // Method badges (public or private) → show the callers/callees Focus Panel
        if (badge.classList.contains('sv-method')) {
            _svShowFocusPanel(name, lineIdx, classIdx);
        } else {
            // Field or class-header click — just jump, no panel
            _svHideFocusPanel();
        }
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

// Jump to a line in the code panel (jumps to cp-code-wrap line if panel is open)
function _svJumpCodeToLine(lineIdx) {
    if (typeof jumpToFunc === 'function') {
        // Prefer built-in jumpToFunc if it handles line-based jumping
    }
    // Scroll the code panel to the line
    const lineEl = document.getElementById(`cl-${lineIdx}`);
    if (!lineEl) return;
    // Make sure code panel is visible
    if (typeof openCodePanel === 'function') openCodePanel();
    lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Flash highlight
    lineEl.classList.add('sv-jump-highlight');
    setTimeout(() => lineEl.classList.remove('sv-jump-highlight'), 1500);
}


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
    const tgR   = tGroup.getBoundingClientRect();
    const sm    = (tGroup.style.transform || '').match(/scale\((-?[\d.]+)\)/);
    const scale = sm ? parseFloat(sm[1]) : 1;
    return (vpX, vpY) => ({
        x: (vpX - tgR.left) / scale,
        y: (vpY - tgR.top)  / scale,
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
    const cx = r.left + r.width  / 2;
    const cy = r.top  + r.height / 2;
    return [
        toSVG(cx,      r.top),     // [0] top-center
        toSVG(r.right, cy),        // [1] right-center
        toSVG(cx,      r.bottom),  // [2] bottom-center
        toSVG(r.left,  cy),        // [3] left-center
    ];
}

// Outward direction unit vectors for each side (used for bezier control arms)
const _SV_SIDE_DIR = [
    { x:  0, y: -1 },  // [0] top    → exit upward
    { x:  1, y:  0 },  // [1] right  → exit rightward
    { x:  0, y:  1 },  // [2] bottom → exit downward
    { x: -1, y:  0 },  // [3] left   → exit leftward
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
            const d  = dx * dx + dy * dy;
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

function _svDrawArrows(classes, svg, scroll) {
    svg.querySelectorAll('.sv-local-arrow').forEach(p => p.remove());

    const boxMap = {};
    classes.forEach((cls, i) => { boxMap[cls.name] = i; });

    const arrows = [];
    classes.forEach((cls, fi) => {
        cls.inherits.forEach(parent => {
            if (boxMap[parent] !== undefined)
                arrows.push({ from: fi, to: boxMap[parent], type: 'inherit',
                              targetLine: classes[boxMap[parent]].line, anchorName: null });
        });
        cls.fields.forEach(f => {
            const clean = f.name.replace(/^_+|_+$/g, '');
            classes.forEach((other, ti) => {
                if (ti !== fi && other.name.toLowerCase() === clean.toLowerCase())
                    arrows.push({ from: fi, to: ti, type: 'uses',
                                  targetLine: f.line, anchorName: f.name });
            });
        });
    });

    if (arrows.length === 0) return;

    // Build coordinate mapper ONCE (parses tGroup transform, measures its rect)
    const toSVG = _svMakeCoordMapper(scroll);

    arrows.forEach(({ from, to, type, targetLine, anchorName }) => {
        const fe = document.getElementById(`sv-cls-${from}`);
        const te = document.getElementById(`sv-cls-${to}`);
        if (!fe || !te) return;

        // Source: specific field badge if available, else class box
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


// -- Helpers --------------------------------------------------------------------

function _mkClass(name, line, inherits) {
    return { name, line, inherits, public_methods: [], private_methods: [], fields: [] };
}
function _svEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _svBasename(p) { return (p || '').split(/[\\/]/).pop().replace(/\.\w+$/, ''); }

window._svToggleExternal = function(btn) {
    _sv.showExternal = !_sv.showExternal;
    btn.textContent = `External Dependencies: ${_sv.showExternal ? 'On' : 'Off'}`;
    if (_sv.showExternal) btn.classList.add('active');
    else btn.classList.remove('active');
    if (_sv.active && _sv._src) {
        _svRender(_sv._src, _sv._ext, _sv._fname);
    }
};

// ── Focus Panel — Callers / Callees inline view ────────────────────────────────

/**
 * Show (or refresh) the Focus Panel at the bottom of sv-view.
 * Looks up window.DATA.funcs_by_file / func_edges_by_file so it works without
 * any new server endpoint.  Gracefully degrades if DATA isn't present.
 *
 * @param {string} methodName  — function label (as stored in DATA.funcs_by_file)
 * @param {number} lineIdx     — 0-based code line (fallback for code jump)
 * @param {number} classIdx    — sv-class-box index (for box highlight)
 */
function _svShowFocusPanel(methodName, lineIdx, classIdx) {
    _svHideFocusPanel(/* immediate */ true);

    const view = document.getElementById('sv-view');
    if (!view) return;

    const fileRel = _sv._fileRel;
    const allFuncs = (window.DATA?.funcs_by_file?.[fileRel]) || [];
    const allEdges = (window.DATA?.func_edges_by_file?.[fileRel]) || [];

    // Match by exact label; fallback: strip leading underscores
    let funcIdx = allFuncs.findIndex(f => f.label === methodName);
    if (funcIdx === -1) funcIdx = allFuncs.findIndex(f => f.label === methodName.replace(/^_+/, ''));

    const panel = document.createElement('div');
    panel.id = 'sv-focus-panel';
    panel.className = 'sv-focus-panel';

    if (funcIdx === -1 || allFuncs.length === 0) {
        // No call-graph data available — show a minimal info strip
        panel.innerHTML = `
            <div class="sv-fp-header">
                <span class="sv-fp-title">⬡ <code>${_svEsc(methodName)}</code></span>
                <span class="sv-fp-hint">No call-graph data for this method</span>
                <button class="sv-fp-close" title="Close">✕</button>
            </div>`;
    } else {
        const center = allFuncs[funcIdx];

        // Collect callers (edges where e.t === funcIdx → callers are e.s)
        // and callees (edges where e.s === funcIdx → callees are e.t)
        const _dedupe = (arr) => {
            const seen = new Set();
            return arr.filter(f => f && !seen.has(f.label) && seen.add(f.label));
        };
        const callers = _dedupe(
            allEdges.filter(e => e.t === funcIdx).map(e => allFuncs[e.s])
        ).slice(0, 7);
        const callees = _dedupe(
            allEdges.filter(e => e.s === funcIdx).map(e => allFuncs[e.t])
        ).slice(0, 7);

        const accessBadgeHtml = center.is_public
            ? `<span class="sv-fp-access sv-fp-public">PUBLIC</span>`
            : `<span class="sv-fp-access sv-fp-private">PRIVATE</span>`;

        const _card = (f, dir) => {
            const fi = allFuncs.indexOf(f);
            const icon = dir === 'caller' ? '◀' : '▶';
            return `<div class="sv-fp-card sv-fp-${dir}" data-fp-func-idx="${fi}" title="${_svEsc(f.label)}">
                ${dir === 'caller' ? `<span class="sv-fp-card-icon">${icon}</span>` : ''}
                <span class="sv-fp-card-name">${_svEsc(f.label)}</span>
                ${dir === 'callee' ? `<span class="sv-fp-card-icon">${icon}</span>` : ''}
            </div>`;
        };

        const callerHtml = callers.length
            ? `<div class="sv-fp-cards">${callers.map(f => _card(f, 'caller')).join('')}</div>`
            : `<div class="sv-fp-empty">No callers found</div>`;

        const calleeHtml = callees.length
            ? `<div class="sv-fp-cards">${callees.map(f => _card(f, 'callee')).join('')}</div>`
            : `<div class="sv-fp-empty">No callees found</div>`;

        panel.innerHTML = `
            <div class="sv-fp-header">
                <span class="sv-fp-title">⬡ <code>${_svEsc(methodName)}</code></span>
                ${accessBadgeHtml}
                <button class="sv-fp-close" title="Close">✕</button>
            </div>
            <div class="sv-fp-body">
                <div class="sv-fp-col">
                    <div class="sv-fp-col-label">◀ CALLERS <span class="sv-fp-count">${callers.length}</span></div>
                    ${callerHtml}
                </div>
                <div class="sv-fp-divider"></div>
                <div class="sv-fp-col">
                    <div class="sv-fp-col-label">CALLEES <span class="sv-fp-count">${callees.length}</span> ▶</div>
                    ${calleeHtml}
                </div>
            </div>`;
    }

    view.appendChild(panel);

    // Slide in
    requestAnimationFrame(() => {
        requestAnimationFrame(() => panel.classList.add('sv-fp-visible'));
    });

    // ── Event bindings ────────────────────────────────────────────────────────

    panel.querySelector('.sv-fp-close')?.addEventListener('click', () => _svHideFocusPanel());

    panel.querySelectorAll('.sv-fp-card').forEach(card => {
        card.addEventListener('click', () => {
            const fi = parseInt(card.dataset.fpFuncIdx, 10);
            const f = allFuncs[fi];
            if (!f) return;

            // Jump the code panel to this function
            if (typeof jumpToFunc === 'function') {
                jumpToFunc(f.label);
            } else {
                // Fallback: scan funcLineMap or use lineIdx heuristic
                const li = (typeof codeState !== 'undefined' && codeState.funcLineMap?.[f.label]);
                if (li !== undefined) _svJumpCodeToLine(li);
            }

            // Highlight the matching badge in the structure grid (if visible)
            _svHighlightBadgeByName(f.label);

            // Recurse: show callers/callees for the clicked card's function
            const li2 = (typeof codeState !== 'undefined' && codeState.funcLineMap?.[f.label]) ?? 0;
            _svShowFocusPanel(f.label, li2, -1);
        });
    });
}

/**
 * Remove the focus panel.
 * @param {boolean} immediate  — skip the slide-out animation (used on sv-view close)
 */
function _svHideFocusPanel(immediate) {
    const existing = document.getElementById('sv-focus-panel');
    if (!existing) return;
    if (immediate) {
        existing.remove();
    } else {
        existing.classList.remove('sv-fp-visible');
        setTimeout(() => existing.remove(), 220);
    }
}

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

window.svHighlightBadgeByName = function(name) {
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
        pill && pill.remove();
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
        const dirIcon  = gf.direction === 'import' ? '→' : '←';
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
    const seenPairs  = new Set();

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
            const badge    = _findFieldBadge(boxEl, f.name);
            const ghBadge  = _findGhostBadge(fi, match.cname) || ghostBoxEls[fi];
            _addDesc(badge || boxEl, ghBadge, ghostBoxEls[fi], `${f.name} → ${match.cname}`, !!badge);
        });
        cls.inherits.forEach(parent => {
            if (localNames.has(parent)) return;
            const match = _findClassMatch(parent);
            if (!match) return;
            const fi = pathToFi[match.info.path];
            if (fi === undefined) return;
            const hdr     = boxEl.querySelector('.sv-class-hdr') || boxEl;
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
    _sv._crossArrowSvg   = svg;
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
        const dstPts = _svGetPivots(toEl,   toSVG);
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
window.svRedrawArrows = function() {
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

/**
 * Map edge_type string to a representative colour for ghost box styling.
 */
function _svEdgeTypeColor(edgeType) {
    const map = {
        import:    '#10b981',
        include:   '#c084fc',
        library:   '#a78bfa',
        package:   '#00d4ff',
        component: '#60a5fa',
        inherit:   '#60a5fa',
    };
    return map[edgeType] || '#64748b';
}

console.log('[VIZCODE] struct_view.js v2 loaded');