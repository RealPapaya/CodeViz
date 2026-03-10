/* =============================================================================
   struct_view.js -- Sourcetrail-style Structure View (VIZCODE V4 Plugin)
   Place this file in: static/struct_view.js
   Load in launcher.html AFTER viz.js (no script tag needed -- inlined by build_html)

   HOW IT WORKS
   ------------
   1. Adds a "Structure" tab next to the code view toggle in the code panel.
   2. On activation, parses classes/structs from the current source file
      (Python . C/C++ . JS/TS . Go) entirely in the browser - no backend change.
   3. Renders Sourcetrail-style boxes:  class name | PUBLIC methods | PRIVATE methods | fields
   4. SVG arrows connect classes that inherit from or reference each other.
   5. Clicking any method/field badge jumps back to that line in the Code view.
   6. Falls back to a "Module" box (top-level functions) for non-OOP files.
   ----------------------------------------------------------------------------- */

// -- Internal State -------------------------------------------------------------
const _sv = {
    active: false,   // true when Structure tab is showing
    classes: [],     // last parsed class list
    _src: '',        // cached source
    _ext: '',        // cached extension
    _fname: '',      // cached filename
};

// -- Tab API (called from onclick in HTML) --------------------------------------

window.svShowCodeTab = function () {
    _sv.active = false;
    _setTabActive('cp-tab-code');
    _el('cp-code-wrap').style.display = '';
    _el('cp-struct-wrap').style.display = 'none';
    const fb = _el('cp-func-bar');
    if (fb) fb.style.display = '';
};

window.svShowStructTab = function () {
    _sv.active = true;
    _setTabActive('cp-tab-struct');
    _el('cp-code-wrap').style.display = 'none';
    _el('cp-struct-wrap').style.display = '';
    const fb = _el('cp-func-bar');
    if (fb) fb.style.display = 'none';
    if (_sv._src) _svRender(_sv._src, _sv._ext, _sv._fname);
};

// -- Hook: called by viz.js renderCode() at the end ----------------------------
// Add this one line at the end of renderCode():
//     if (window.svAfterRenderCode) svAfterRenderCode(src, ext, fname);

window.svAfterRenderCode = function (src, ext, fname) {
    _sv._src = src;
    _sv._ext = ext || '';
    _sv._fname = fname || '';

    // Check if structure view is supported for this file
    const extLower = (ext || '').toLowerCase();
    const isSupported = ['.py', '.cpp', '.c', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.hh', '.js', '.jsx', '.ts', '.tsx', '.go'].includes(extLower);

    const tabStruct = document.getElementById('cp-tab-struct');
    if (tabStruct) {
        tabStruct.style.display = isSupported ? '' : 'none';
    }

    if (_sv.active) {
        if (isSupported) {
            _svRender(src, ext, fname);
        } else {
            // Force back to code tab if switching to unsupported file
            svShowCodeTab();
        }
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

        // Class definition
        const cm = line.match(/^class\s+(\w+)(?:\(([^)]*)\))?:/);
        if (cm) {
            if (cur) classes.push(cur);
            cur = _mkClass(cm[1], i,
                cm[2] ? cm[2].split(',').map(s => s.trim()).filter(Boolean) : []);
            continue;
        }

        if (!cur) continue;

        // Method
        const mm = line.match(/^    def\s+(\w+)\s*\(/);
        if (mm) {
            const n = mm[1];
            if (n === '__init__') {
                // Collect self.field = ... assignments inside __init__
                for (let j = i + 1; j < Math.min(i + 60, lines.length); j++) {
                    const fl = lines[j];
                    if (/^    def\s/.test(fl)) break;
                    const fm = fl.match(/\s+self\.(\w+)\s*=/);
                    if (fm && !cur.fields.find(f => f.name === fm[1]))
                        cur.fields.push({ name: fm[1], line: j, access: fm[1].startsWith('_') ? 'private' : 'public' });
                }
            }
            const isSpecial = /^__\w+__$/.test(n) && n !== '__init__';
            if (isSpecial || n.startsWith('_')) cur.private_methods.push({ name: n, line: i });
            else cur.public_methods.push({ name: n, line: i });
            continue;
        }

        // Module-level fields (class body, before any def)
        const fm = line.match(/^    (\w+)\s*(?::\s*[\w\[\], |]+)?\s*=\s*/);
        if (fm && !fm[1].startsWith('def') && !cur.fields.find(f => f.name === fm[1]))
            cur.fields.push({ name: fm[1], line: i, access: fm[1].startsWith('_') ? 'private' : 'public' });
    }
    if (cur) classes.push(cur);

    // Fallback: module-level functions as a virtual "Module" class
    if (classes.length === 0) {
        const mod = _mkClass(_svBasename(_sv._fname) || 'Module', 0, []);
        for (let i = 0; i < lines.length; i++) {
            const fm = lines[i].match(/^def\s+(\w+)\s*\(/);
            if (fm) {
                const n = fm[1];
                if (n.startsWith('_')) mod.private_methods.push({ name: n, line: i });
                else mod.public_methods.push({ name: n, line: i });
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

        // Class or struct
        const cm = raw.match(/^\s*(?:class|struct)\s+(\w+)(?:\s*:\s*(?:public|protected|private)\s+(\w+))?/);
        if (cm && !raw.trim().startsWith('//') && !raw.trim().startsWith('*')) {
            if (cur) classes.push(cur);
            const isStruct = /\bstruct\b/.test(raw);
            access = isStruct ? 'public' : 'private';
            cur = _mkClass(cm[1], i, cm[2] ? [cm[2]] : []);
            classDepth = depth + opens;
            depth += opens - closes;
            classes.push(cur);
            cur = classes[classes.length - 1]; // keep ref
            continue;
        }

        depth += opens - closes;

        if (!cur) continue;

        // End of class brace
        if (classDepth >= 0 && depth < classDepth) {
            cur = null; classDepth = -1; access = 'private';
            continue;
        }

        // Access specifier
        if (/^public\s*:/.test(line)) { access = 'public'; continue; }
        if (/^private\s*:/.test(line)) { access = 'private'; continue; }
        if (/^protected\s*:/.test(line)) { access = 'protected'; continue; }

        // Only parse declarations at the immediate class body depth
        if (depth !== classDepth) continue;

        // Member function declaration  (has parentheses + ends with ; or {)
        const methM = line.match(/(?:virtual\s+|static\s+|inline\s+|explicit\s+|constexpr\s+)?(?:[\w:*&<>[\]]+\s+)+(\w+)\s*\([^)]*\)/);
        if (methM) {
            const n = methM[1];
            if (n === cur.name || n === '~' + cur.name) continue; // ctor/dtor - skip
            if (access === 'public') cur.public_methods.push({ name: n, line: i });
            else cur.private_methods.push({ name: n, line: i });
            continue;
        }

        // Member variable  (no parens, ends with ;)
        const fieldM = line.match(/(?:[\w:*&<>[\]]+\s+)+(\w[\w_]*)\s*(?:=\s*[^;]*)?\s*;/);
        if (fieldM && !line.includes('(')) {
            const n = fieldM[1];
            if (!cur.fields.find(f => f.name === n))
                cur.fields.push({ name: n, line: i, access });
        }
    }

    // Fallback: top-level functions as Module
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

        // Class declaration
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
        if (classDepth >= 0 && depth < classDepth) {
            cur = null; classDepth = -1;
            continue;
        }
        if (depth !== classDepth) continue;

        // Method (async? #?name(...))
        const methM = raw.match(/^\s+(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(\#?\w+)\s*(?:<[^>]*>)?\s*\(/);
        if (methM) {
            const rawN = methM[1];
            const n = rawN.replace('#', '');
            if (n === 'constructor') continue;
            const isPrivate = rawN.startsWith('#') || n.startsWith('_') || /\bprivate\b/.test(raw);
            if (isPrivate) cur.private_methods.push({ name: n, line: i });
            else cur.public_methods.push({ name: n, line: i });
            continue;
        }

        // Class field  (TypeScript: name: Type = val; or JS: #name = val)
        const fieldM = raw.match(/^\s+(?:private\s+|public\s+|protected\s+|readonly\s+|static\s+)*(\#?\w+)\s*(?:!\s*)?(?::\s*[\w<>[\]| ]+)?\s*(?:=|;)/);
        if (fieldM && !raw.includes('(')) {
            const rawN = fieldM[1];
            const n = rawN.replace('#', '');
            const isPrivate = rawN.startsWith('#') || n.startsWith('_') || /\bprivate\b/.test(raw);
            if (!cur.fields.find(f => f.name === n))
                cur.fields.push({ name: n, line: i, access: isPrivate ? 'private' : 'public' });
        }
    }

    // Fallback: module-level const/function
    if (classes.length === 0) {
        const mod = _mkClass(_svBasename(_sv._fname) || 'Module', 0, []);
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/)
                || lines[i].match(/^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/);
            if (m) {
                const n = m[1];
                if (n.startsWith('_')) mod.private_methods.push({ name: n, line: i });
                else mod.public_methods.push({ name: n, line: i });
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

    // Structs
    for (let i = 0; i < lines.length; i++) {
        const sm = lines[i].match(/^type\s+(\w+)\s+struct\s*\{/);
        if (sm) {
            const s = _mkClass(sm[1], i, []);
            for (let j = i + 1; j < lines.length; j++) {
                const fl = lines[j].trim();
                if (fl === '}') break;
                const fm = fl.match(/^(\w+)\s+/);
                if (fm) {
                    const n = fm[1];
                    const isPrivate = n[0] === n[0].toLowerCase() && n[0] !== n[0].toUpperCase();
                    s.fields.push({ name: n, line: j, access: isPrivate ? 'private' : 'public' });
                }
            }
            structs.push(s);
        }
    }

    // Methods  func (recv *TypeName) MethodName(...)
    for (let i = 0; i < lines.length; i++) {
        const mm = lines[i].match(/^func\s+\(\w+\s+\*?(\w+)\)\s+(\w+)\s*\(/);
        if (mm) {
            const s = structs.find(x => x.name === mm[1]);
            if (s) {
                const n = mm[2];
                const isPrivate = n[0] === n[0].toLowerCase();
                if (isPrivate) s.private_methods.push({ name: n, line: i });
                else s.public_methods.push({ name: n, line: i });
            }
        }
    }

    // Fallback: top-level functions
    if (structs.length === 0) {
        const mod = _mkClass(_svBasename(_sv._fname) || 'Module', 0, []);
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^func\s+(\w+)\s*\(/);
            if (m) {
                const n = m[1];
                if (n[0] === n[0].toLowerCase()) mod.private_methods.push({ name: n, line: i });
                else mod.public_methods.push({ name: n, line: i });
            }
        }
        if (mod.public_methods.length + mod.private_methods.length > 0) structs.push(mod);
    }

    return structs;
}

// -- Renderer -------------------------------------------------------------------

// Method color wheel - warm Sourcetrail-style palette
const _SV_COLORS = [
    '#f59e0b', '#3b82f6', '#10b981', '#ec4899', '#8b5cf6',
    '#06b6d4', '#f97316', '#84cc16', '#e11d48', '#14b8a6',
    '#a855f7', '#22d3ee', '#fb923c', '#4ade80', '#f43f5e',
];

function _svRender(src, ext, fname) {
    const wrap = _el('cp-struct-wrap');
    if (!wrap) return;
    wrap.innerHTML = '';

    const classes = _svParseClasses(src, ext);
    _sv.classes = classes;

    if (classes.length === 0) {
        wrap.innerHTML = `
        <div class="sv-empty">
            <div class="sv-empty-icon">🔍</div>
            <p>No classes or structs found</p>
            <small>Supports Python . C/C++ . JavaScript/TypeScript . Go</small>
        </div>`;
        return;
    }

    // -- SVG overlay for arrows -----------------------------------------------
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'sv-arrows';
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<defs>
        <marker id="sv-ah-uses"    markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <polygon points="0 0,8 3,0 6" fill="#f59e0baa"/>
        </marker>
        <marker id="sv-ah-inherit" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <polygon points="0 0,8 3,0 6" fill="#60a5faaa"/>
        </marker>
    </defs>`;

    // -- Class box container --------------------------------------------------
    const grid = document.createElement('div');
    grid.id = 'sv-grid';

    wrap.appendChild(svg);
    wrap.appendChild(grid);

    classes.forEach((cls, ci) => {
        const box = document.createElement('div');
        box.className = 'sv-class-box';
        box.id = `sv-cls-${ci}`;

        const total = cls.public_methods.length + cls.private_methods.length + cls.fields.length;
        const baseColor = _SV_COLORS[ci % _SV_COLORS.length];

        let html = `
        <div class="sv-class-hdr" style="border-top: 3px solid ${baseColor}" onclick="svJumpToLine(${cls.line})">
            <span class="sv-class-name">${_svEsc(cls.name)}</span>
            <span class="sv-class-badge" style="background:${baseColor}22;border-color:${baseColor};color:${baseColor}">${total}</span>
        </div>`;

        if (cls.inherits.length > 0) {
            html += `<div class="sv-inherits">↑ ${cls.inherits.map(_svEsc).join(', ')}</div>`;
        }

        // Fields
        if (cls.fields.length > 0) {
            const show = cls.fields.slice(0, 10);
            const extra = cls.fields.length - show.length;
            html += `<div class="sv-section">
                <div class="sv-section-hdr"><span>#</span> FIELDS</div>
                <div class="sv-items">
                ${show.map(f => `
                    <span class="sv-field sv-field-${f.access || 'private'}"
                          onclick="svJumpToLine(${f.line})"
                          title="${_svEsc(f.name)}">${_svEsc(f.name)}</span>
                `).join('')}
                ${extra > 0 ? `<span class="sv-more">+${extra}</span>` : ''}
                </div></div>`;
        }

        // Public methods
        if (cls.public_methods.length > 0) {
            const show = cls.public_methods.slice(0, 14);
            const extra = cls.public_methods.length - show.length;
            html += `<div class="sv-section">
                <div class="sv-section-hdr"><span>🌐</span> PUBLIC</div>
                <div class="sv-items">
                ${show.map((m, mi) => {
                const col = _SV_COLORS[(ci * 5 + mi) % _SV_COLORS.length];
                return `<span class="sv-method"
                                  style="background:${col}1a;border-color:${col}88;color:${col}"
                                  onclick="svJumpToLine(${m.line})"
                                  title="${_svEsc(m.name)}">${_svEsc(m.name)}</span>`;
            }).join('')}
                ${extra > 0 ? `<span class="sv-more">+${extra}</span>` : ''}
                </div></div>`;
        }

        // Private methods
        if (cls.private_methods.length > 0) {
            const show = cls.private_methods.slice(0, 14);
            const extra = cls.private_methods.length - show.length;
            html += `<div class="sv-section">
                <div class="sv-section-hdr"><span>🏠</span> PRIVATE</div>
                <div class="sv-items">
                ${show.map(m => `
                    <span class="sv-method sv-method-priv"
                          onclick="svJumpToLine(${m.line})"
                          title="${_svEsc(m.name)}">${_svEsc(m.name)}</span>
                `).join('')}
                ${extra > 0 ? `<span class="sv-more">+${extra}</span>` : ''}
                </div></div>`;
        }

        box.innerHTML = html;
        grid.appendChild(box);
    });

    // Draw arrows after layout is painted
    requestAnimationFrame(() => _svDrawArrows(classes, svg, grid));
}

function _svDrawArrows(classes, svg, grid) {
    // Build: class name -> DOM box
    const boxMap = {};
    classes.forEach((cls, i) => { boxMap[cls.name] = i; });

    const arrows = [];

    classes.forEach((cls, fi) => {
        // Inheritance
        cls.inherits.forEach(parent => {
            if (boxMap[parent] !== undefined)
                arrows.push({ from: fi, to: boxMap[parent], type: 'inherit' });
        });

        // Field-type associations: if a field name (stripped of _) matches a class name
        cls.fields.forEach(f => {
            const clean = f.name.replace(/^_+|_+$/g, '');
            classes.forEach((other, ti) => {
                if (ti !== fi && other.name.toLowerCase() === clean.toLowerCase())
                    arrows.push({ from: fi, to: ti, type: 'uses' });
            });
        });
    });

    if (arrows.length === 0) return;

    const gridRect = grid.getBoundingClientRect();
    const wrapRect = _el('cp-struct-wrap').getBoundingClientRect();
    const ox = gridRect.left - wrapRect.left;
    const oy = gridRect.top - wrapRect.top;

    // Resize SVG to full wrap
    svg.style.width = _el('cp-struct-wrap').scrollWidth + 'px';
    svg.style.height = _el('cp-struct-wrap').scrollHeight + 'px';

    arrows.forEach(({ from, to, type }) => {
        const fe = document.getElementById(`sv-cls-${from}`);
        const te = document.getElementById(`sv-cls-${to}`);
        if (!fe || !te) return;

        const fr = fe.getBoundingClientRect();
        const tr = te.getBoundingClientRect();

        const x1 = fr.right - wrapRect.left;
        const y1 = fr.top + fr.height / 2 - wrapRect.top;
        const x2 = tr.left - wrapRect.left;
        const y2 = tr.top + tr.height / 2 - wrapRect.top;

        const cx = (x1 + x2) / 2;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`);
        path.classList.add('sv-arrow', `sv-arrow-${type}`);
        path.setAttribute('marker-end', `url(#sv-ah-${type})`);
        svg.appendChild(path);
    });
}

// -- Jump to line (from badge click) -------------------------------------------

window.svJumpToLine = function (lineIdx) {
    svShowCodeTab();
    setTimeout(() => {
        const target = document.getElementById(`cl-${lineIdx}`);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('sv-jump-highlight');
        setTimeout(() => target.classList.remove('sv-jump-highlight'), 1600);
    }, 120);
};

// -- Helpers --------------------------------------------------------------------

function _mkClass(name, line, inherits) {
    return { name, line, inherits, public_methods: [], private_methods: [], fields: [] };
}

function _svEsc(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _svBasename(p) {
    return (p || '').split(/[\\/]/).pop().replace(/\.\w+$/, '');
}

function _el(id) { return document.getElementById(id); }

function _setTabActive(id) {
    ['cp-tab-code', 'cp-tab-struct'].forEach(tid => {
        const b = _el(tid);
        if (b) b.classList.toggle('active', tid === id);
    });
}

console.log('[VIZCODE] struct_view.js loaded');