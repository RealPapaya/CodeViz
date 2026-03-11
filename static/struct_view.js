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
    document.getElementById('cy').style.display = 'none';
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
    const btn = document.getElementById('struct-toggle-btn');
    if (btn) btn.classList.remove('active');
    document.getElementById('cy').style.display = '';

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

    // Header bar
    const header = document.createElement('div');
    header.className = 'sv-header';
    header.innerHTML = `
        <span class="sv-header-title" style="display:flex;align-items:center;gap:6px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3" width="8" height="6" rx="1"></rect><path d="M12 9v4"></path><path d="M5 13h14"></path><path d="M5 13v3"></path><rect x="2" y="16" width="6" height="5" rx="1"></rect><path d="M19 13v3"></path><rect x="16" y="16" width="6" height="5" rx="1"></rect></svg>Structure<span style="color:var(--muted)">·</span><code>${_svEsc(fname)}</code></span>
        <span class="sv-header-count">${classes.length} class${classes.length !== 1 ? 'es' : ''}</span>
        <button class="sv-close-btn" onclick="svToggleStructView()" title="Close Structure View">✕</button>`;
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
    scroll.appendChild(svg);
    scroll.appendChild(grid);

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
        grid.appendChild(box);
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

// -- Arrow drawing with click handlers -----------------------------------------

function _svDrawArrows(classes, svg, scroll) {
    const boxMap = {};
    classes.forEach((cls, i) => { boxMap[cls.name] = i; });

    // arrows now carry optional anchorName so we can find the badge element
    const arrows = [];
    classes.forEach((cls, fi) => {
        cls.inherits.forEach(parent => {
            if (boxMap[parent] !== undefined)
                arrows.push({
                    from: fi, to: boxMap[parent], type: 'inherit',
                    targetLine: classes[boxMap[parent]].line,
                    anchorName: null,   // from class header (no specific badge)
                });
        });
        cls.fields.forEach(f => {
            const clean = f.name.replace(/^_+|_+$/g, '');
            classes.forEach((other, ti) => {
                if (ti !== fi && other.name.toLowerCase() === clean.toLowerCase())
                    arrows.push({
                        from: fi, to: ti, type: 'uses',
                        targetLine: f.line,
                        anchorName: f.name,   // ← start from this specific field badge
                    });
            });
        });
    });

    if (arrows.length === 0) return;

    const scrollRect = scroll.getBoundingClientRect();
    svg.style.width = scroll.scrollWidth + 'px';
    svg.style.height = scroll.scrollHeight + 'px';

    arrows.forEach(({ from, to, type, targetLine, anchorName }) => {
        const fe = document.getElementById(`sv-cls-${from}`);
        const te = document.getElementById(`sv-cls-${to}`);
        if (!fe || !te) return;

        // Try to find the specific field badge as the arrow start point
        let startEl = fe;
        if (anchorName) {
            const esc = anchorName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const badge = fe.querySelector(`.sv-field[data-sv-name="${esc}"]`);
            if (badge) startEl = badge;
        }

        const sr = startEl.getBoundingClientRect();
        const tr = te.getBoundingClientRect();

        // Start from right-center of the badge (or box)
        const x1 = sr.right  - scrollRect.left + scroll.scrollLeft;
        const y1 = sr.top + sr.height / 2 - scrollRect.top + scroll.scrollTop;
        // End at left-center of target box header
        const hdr = te.querySelector('.sv-class-hdr') || te;
        const hr = hdr.getBoundingClientRect();
        const x2 = hr.left  - scrollRect.left + scroll.scrollLeft;
        const y2 = hr.top + hr.height / 2 - scrollRect.top + scroll.scrollTop;
        const cx = (x1 + x2) / 2;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`);
        path.classList.add('sv-arrow', `sv-arrow-${type}`);
        path.setAttribute('marker-end', `url(#sv-ah-${type})`);
        path.style.pointerEvents = 'stroke';
        path.style.cursor = 'pointer';

        path.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.sv-arrow-active').forEach(a => a.classList.remove('sv-arrow-active'));
            path.classList.add('sv-arrow-active');
            const fromBox = document.getElementById(`sv-cls-${from}`);
            const toBox   = document.getElementById(`sv-cls-${to}`);
            if (fromBox) fromBox.classList.add('sv-active-box');
            if (toBox)   toBox.classList.add('sv-active-box');
            if (anchorName) {
                const esc = anchorName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                const badge = fromBox?.querySelector(`.sv-field[data-sv-name="${esc}"]`);
                if (badge) badge.classList.add('sv-active-badge');
            }
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

    // querySelector with escaped name attribute
    const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const badge = document.querySelector(`.sv-method[data-sv-name="${escaped}"]`);
    if (!badge) return;

    badge.classList.add('sv-active-badge');
    badge.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    _sv._activeBadge = badge;

    const classIdx = parseInt(badge.dataset.svClass, 10);
    const box = document.getElementById(`sv-cls-${classIdx}`);
    if (box) box.classList.add('sv-active-box');
}

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

    // Show a subtle loading pill in the sv-header while fetching
    const hdr = document.querySelector('#sv-view .sv-header');
    let pill = null;
    if (hdr) {
        pill = document.createElement('span');
        pill.className = 'sv-cf-loading';
        pill.textContent = '↗ loading cross-file…';
        hdr.appendChild(pill);
    }

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

    _svApplyCrossFileData(crossData, classes, svg, scroll, grid);
}

/**
 * Given cross-file data from /structure, inject ghost boxes into the grid and
 * draw sv-arrow-cross-file SVG paths connecting local class boxes to ghost boxes.
 *
 * Ghost boxes are placed in a clearly labelled "External Dependencies" section
 * appended after all local class boxes.
 *
 * @param {Object}     crossData — { funcs, func_edges, imports, imported_by, class_map }
 * @param {Array}      classes   — locally parsed class array (index = box id)
 * @param {SVGElement} svg
 * @param {HTMLElement} scroll
 * @param {HTMLElement} grid
 */
function _svApplyCrossFileData(crossData, classes, svg, scroll, grid) {
    const { class_map = {}, imports = [], imported_by = [] } = crossData;

    // ── 1. Build ghost file map from ALL neighbours ────────────────────────
    // Key insight: we draw arrows for EVERY imported/imported-by file,
    // not just inheritance — because Python/JS uses composition, not just inherit.
    const ghostFileMap = {}; // path → ghostFile record

    // Helper: add or merge a file into ghostFileMap
    const _addGhost = (f, direction) => {
        if (!ghostFileMap[f.path]) {
            ghostFileMap[f.path] = {
                path: f.path, label: f.label,
                edge_type: f.edge_type, direction,
                classes: [],
            };
        }
    };
    imports.forEach(f => _addGhost(f, 'import'));
    imported_by.forEach(f => _addGhost(f, 'imported_by'));

    // Attach class names found via class_map
    Object.entries(class_map).forEach(([cname, info]) => {
        if (ghostFileMap[info.path]) {
            const gf = ghostFileMap[info.path];
            if (!gf.classes.find(c => c.name === cname)) {
                gf.classes.push({ name: cname, edge_type: info.edge_type });
            }
        }
    });

    const ghostFiles = Object.values(ghostFileMap);
    if (ghostFiles.length === 0) return;

    // ── 2. Render separator + ghost boxes ─────────────────────────────────
    const sep = document.createElement('div');
    sep.className = 'sv-ghost-separator';
    sep.innerHTML = `<span class="sv-ghost-sep-line"></span>
        <span class="sv-ghost-sep-label">↗ External Dependencies</span>
        <span class="sv-ghost-sep-line"></span>`;
    grid.appendChild(sep);

    const ghostBoxEls = {}; // fi → DOM element (for arrow drawing)

    ghostFiles.forEach((gf, fi) => {
        const dirIcon  = gf.direction === 'import' ? '→' : '←';
        const dirLabel = gf.direction === 'import' ? 'imports' : 'imported by';

        const box = document.createElement('div');
        box.className = 'sv-ghost-box';
        box.id = `sv-ghost-${fi}`;
        ghostBoxEls[fi] = box;

        let html = `
        <div class="sv-ghost-hdr" title="${_svEsc(gf.path)}">
            <span class="sv-ghost-dir-badge">${dirIcon} ${dirLabel}</span>
            <span class="sv-ghost-fname">${_svEsc(gf.label)}</span>
            ${gf.classes.length > 0 ? `<span class="sv-ghost-count">${gf.classes.length}</span>` : ''}
        </div>`;

        if (gf.classes.length > 0) {
            html += `<div class="sv-ghost-classes">
                ${gf.classes.map(gc =>
                    `<span class="sv-ghost-class-badge" title="${_svEsc(gf.path)}">${_svEsc(gc.name)}</span>`
                ).join('')}
            </div>`;
        } else {
            html += `<div class="sv-ghost-no-classes">no classes detected</div>`;
        }

        // "open file" button — uses loadFileInPanel (code panel only, no nav change)
        html += `<button class="sv-ghost-nav-btn" data-gpath="${_svEsc(gf.path)}"
            title="Open in code panel">↗ open file</button>`;

        box.innerHTML = html;
        grid.appendChild(box);
    });

    // ── 3. Attach open-file handlers ───────────────────────────────────────
    // Use loadFileInPanel to open in code panel without changing navigation level.
    // Falls back to openCodePanel + fetch if loadFileInPanel not available.
    grid.querySelectorAll('.sv-ghost-nav-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const p = btn.dataset.gpath;
            if (!p) return;
            if (typeof loadFileInPanel === 'function') {
                loadFileInPanel(p);
                if (typeof openCodePanel === 'function') openCodePanel();
            } else if (typeof openCodePanel === 'function') {
                openCodePanel();
            }
            // Visual feedback
            btn.textContent = '✓ opened';
            setTimeout(() => { btn.textContent = '↗ open file'; }, 1500);
        });
    });

    // ── 4. Build precise cross-file arrows from field badges ──────────────
    //
    // Strategy (Sourcetrail-style):
    //   a) Check each local class field — if its name (stripped of _) matches
    //      a class name in class_map → draw arrow FROM that field badge
    //   b) Check cls.inherits against class_map → draw from class header badge
    //   c) Fallback: one arrow from last local class box to each import ghost
    //      (only used if (a) and (b) produce nothing)

    const pathToFi = {};
    ghostFiles.forEach((gf, fi) => { pathToFi[gf.path] = fi; });

    const localNames = new Set(classes.map(c => c.name));
    const crossArrows = []; // { fromEl, toEl, label, isField }
    const seenPairs   = new Set(); // "fromElId|toElId" dedup

    const localBoxEls = {};
    classes.forEach((_, i) => {
        const el = document.getElementById(`sv-cls-${i}`);
        if (el) localBoxEls[i] = el;
    });

    // Helper: add arrow deduped
    const _addArrow = (fromEl, toEl, label, isField = false) => {
        const key = `${fromEl.id || fromEl.dataset?.svName}|${toEl.id}`;
        if (seenPairs.has(key)) return;
        seenPairs.add(key);
        crossArrows.push({ fromEl, toEl, label, isField });
    };

    // Build case-insensitive class_map lookup array for fuzzy matching
    const classMapEntries = Object.entries(class_map).map(([cname, info]) => ({
        cname, info, lower: cname.toLowerCase()
    }));

    // Find best ghost class match for a field name:
    // Priority: 1) exact, 2) class contains field, 3) field contains class
    const _findClassMatch = (fieldClean) => {
        const fl = fieldClean.toLowerCase();
        let exact = null, classContains = null, fieldContains = null;
        for (const entry of classMapEntries) {
            if (entry.lower === fl) { exact = entry; break; }
            if (!classContains && entry.lower.includes(fl)) classContains = entry;
            if (!fieldContains && fl.includes(entry.lower) && entry.lower.length > 2) fieldContains = entry;
        }
        return exact || classContains || fieldContains || null;
    };

    classes.forEach((cls, ci) => {
        const boxEl = localBoxEls[ci];
        if (!boxEl) return;

        // (a) Field badges → ghost class (fuzzy: cache → LRUCache, scheduler → TaskScheduler)
        cls.fields.forEach(f => {
            const clean = f.name.replace(/^_+|_+$/g, '');
            if (clean.length < 2) return;
            const match = _findClassMatch(clean);
            if (!match) return;
            const fi = pathToFi[match.info.path];
            if (fi === undefined) return;
            const toEl = ghostBoxEls[fi];
            if (!toEl) return;

            // Find the specific field badge element
            const esc = f.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const fieldBadge = boxEl.querySelector(`.sv-field[data-sv-name="${esc}"]`);
            const fromEl = fieldBadge || boxEl;
            _addArrow(fromEl, toEl, `${f.name} → ${match.cname}`, !!fieldBadge);
        });

        // (b) Inheritance → ghost class
        cls.inherits.forEach(parent => {
            if (localNames.has(parent)) return;
            const match = _findClassMatch(parent);
            if (!match) return;
            const fi = pathToFi[match.info.path];
            if (fi === undefined) return;
            const toEl = ghostBoxEls[fi];
            if (!toEl) return;
            const hdr = boxEl.querySelector('.sv-class-hdr') || boxEl;
            _addArrow(hdr, toEl, `extends ${parent}`, false);
        });
    });

    // (c) Fallback: if no field/inherit matches found, one arrow per import ghost
    if (crossArrows.length === 0) {
        ghostFiles.forEach((gf, fi) => {
            if (gf.direction !== 'import') return;
            const toEl = ghostBoxEls[fi];
            if (!toEl) return;
            const lastIdx = classes.length - 1;
            const fromEl = localBoxEls[lastIdx] || localBoxEls[0];
            if (fromEl) _addArrow(fromEl, toEl, 'uses', false);
        });
    }

    if (crossArrows.length === 0) return;

    // ── 5. Draw arrows after layout ────────────────────────────────────────
    requestAnimationFrame(() => {
        svg.style.width  = scroll.scrollWidth  + 'px';
        svg.style.height = scroll.scrollHeight + 'px';
        const scrollRect = scroll.getBoundingClientRect();

        crossArrows.forEach(({ fromEl, toEl, label, isField }) => {
            const fr = fromEl.getBoundingClientRect();
            const tr = toEl.getBoundingClientRect();

            let x1, y1, x2, y2, d;

            if (isField) {
                // Field badge → ghost box: right-center → left-center (horizontal)
                x1 = fr.right  - scrollRect.left + scroll.scrollLeft;
                y1 = fr.top + fr.height / 2 - scrollRect.top + scroll.scrollTop;
                x2 = tr.left   - scrollRect.left + scroll.scrollLeft;
                y2 = tr.top + tr.height / 2 - scrollRect.top + scroll.scrollTop;
                // If target is below: curve down; if same row: horizontal S-curve
                const dy = y2 - y1;
                const dx = x2 - x1;
                if (Math.abs(dy) < 40) {
                    // Same row — simple horizontal bezier
                    const cx = (x1 + x2) / 2;
                    d = `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`;
                } else {
                    // Different row — elbow down then across
                    const cx1 = x1 + Math.min(dx * 0.4, 80);
                    const cy1 = y1 + dy * 0.5;
                    const cx2 = x2 - 20;
                    const cy2 = y2;
                    d = `M${x1},${y1} C${cx1},${cy1} ${cx2},${cy2} ${x2},${y2}`;
                }
            } else {
                // Box/header → ghost box: bottom-center → top-center (vertical)
                x1 = fr.left + fr.width  / 2 - scrollRect.left + scroll.scrollLeft;
                y1 = fr.bottom              - scrollRect.top  + scroll.scrollTop;
                x2 = tr.left + tr.width  / 2 - scrollRect.left + scroll.scrollLeft;
                y2 = tr.top                   - scrollRect.top  + scroll.scrollTop;
                const dy = Math.abs(y2 - y1);
                d = `M${x1},${y1} C${x1},${y1 + dy * 0.5} ${x2},${y2 - dy * 0.3} ${x2},${y2}`;
            }

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            path.classList.add('sv-arrow', 'sv-arrow-cross-file');
            path.setAttribute('marker-end', 'url(#sv-ah-cross-file)');
            path.style.pointerEvents = 'stroke';
            path.style.cursor = 'pointer';
            path.setAttribute('title', label);

            path.addEventListener('click', e => {
                e.stopPropagation();
                document.querySelectorAll('.sv-arrow-active').forEach(a => a.classList.remove('sv-arrow-active'));
                path.classList.add('sv-arrow-active');
                // Highlight origin badge (field) and target box
                fromEl.classList.add(isField ? 'sv-active-badge' : 'sv-active-box');
                toEl.classList.add('sv-active-box');
            });

            svg.appendChild(path);
        });
    });
}

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