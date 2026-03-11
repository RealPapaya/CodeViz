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

const l2State = {
    activeFile: null,
    activeFuncIdx: 0,
    expandedModules: new Set(),
    externalModules: [],
    fileHistory: [],
    fileHistoryIdx: -1,
    showExternalEdges: false,
    showExternalFuncs: false,
    expandOriginPos: null,
    preserveViewport: null,
    _prevNodeIds: null,
    _animGen: 0,
    _l1Snapshot: null,          // { pan, zoom, selectedNodeId } saved when entering L2
    fileHistorySnapshots: [],   // per-history-slot viewport+expand snapshots
};

// ─── Dependency Map (L1) external-files state ─────────────────────────────────
const depMapState = {
    showExternalFiles: false,
    expandedExtModules: new Set(),
    currentExtModules: [],
    currentModId: null,
    pendingFocusFile: null,
    // Navigation history (Prev/Next)
    navHistory: [],       // [{ modId, subDir }]
    navHistoryIdx: -1,
    _navigating: false,   // true while stepping through history (don't push)
    // Expand animation
    expandOriginPos: null,   // { x, y } graph coords of the group node before re-render
    preserveViewport: null,  // { pan, zoom } to restore after layout
    _prevNodeIds: null,
    _animGen: 0,             // increment every render; stale setTimeout callbacks bail out
};

// File-ID → module/file lookup, built once after DATA is parsed
let _fileIdToModule = {};
let _fileIdToFile = {};

function buildFileIdLookup() {
    Object.entries(DATA.files_by_module).forEach(([modId, files]) => {
        files.forEach(f => { _fileIdToModule[f.id] = modId; _fileIdToFile[f.id] = f; });
    });
    Object.entries(DATA.other_files_by_module || {}).forEach(([modId, files]) => {
        files.forEach(f => { _fileIdToModule[f.id] = modId; _fileIdToFile[f.id] = f; });
    });
}

// Code panel state
const codeState = {
    jobId: window.JOB_ID || null,
    currentFile: null,
    currentFunc: null,
    funcLineMap: {},   // funcName -> lineIndex (0-based)
    funcList: [],      // list of {name, line} for current file
    funcIdx: 0,        // current func index in funcList
    isOpen: false,
    userClosed: false, // true when user explicitly closed panel — prevents auto-reopen
    rawLines: [],      // cache raw contents for exact callsite matching
};

// ─── Layout extension availability ───────────────────────────────────────────
// All CDN UMD bundles (fcose, elk, cola) self-register by calling
// cytoscape.use() internally when their <script> tag executes.
// No manual cytoscape.use() or window.cytoscapeXxx lookup needed.
// We probe after cy is initialised: cy.layout({ name }) throws synchronously
// if the layout name is unknown, which tells us the CDN didn't load.

const _registeredLayouts = new Set([
    'dagre', 'cose', 'concentric', 'breadthfirst', 'circle', 'grid', 'random', 'preset', 'null',
]);

function _probeAvailableLayouts() {
    ['fcose', 'elk', 'cola'].forEach(name => {
        try {
            const dummy = cy.layout({ name, stop: () => { } });
            dummy.destroy();
            _registeredLayouts.add(name);
            console.log('[layout] available:', name);
        } catch (_) {
            console.warn('[layout] not available (CDN may not have loaded):', name);
        }
    });
    refreshLayoutSwitcher();
}

function _isLayoutAvailable(name) {
    return _registeredLayouts.has(name);
}

let cy = null;
let tooltipPinned = false;
let tooltipHideTimer = null;
const DEFAULT_CODE_FONT = "'JetBrains Mono', monospace";
const EXT_DOUBLE_CLICK_MS = 260;
let extClickLastId = null;
let extClickLastTime = 0;

// ─── Render cancel token ──────────────────────────────────────────────────────
// Incremented every time a render starts; async callbacks check staleness.
let _renderToken = 0;

// ─── Preferences ──────────────────────────────────────────────────────────────
const _PREFS = {
    KEYS: {
        font: 'biosviz_code_font', lang: 'biosviz_lang',
        extFiles: 'biosviz_ext_files', extFuncs: 'biosviz_ext_funcs',
        theme: 'biosviz_theme',
        layoutL0: 'biosviz_layout_l0',    // default layout for L0 module overview
        layoutL1: 'biosviz_layout_l1',    // default layout for L1 dep-map
        layoutL2: 'biosviz_layout_l2',    // default layout for L2 call-flow
    },
    DEFAULTS: {
        font: "'JetBrains Mono', monospace", lang: 'en',
        extFiles: false, extFuncs: false, theme: 'dark',
        layoutL0: 'cose',      // Force-directed — best for module overview
        layoutL1: 'dagre-lr',  // Hierarchy LR — best for dep-map 
        layoutL2: 'dagre-lr',  // Hierarchy LR — best for call-flow
    },
    get(k) {
        try {
            const v = localStorage.getItem(this.KEYS[k]);
            if (v === null) return this.DEFAULTS[k];
            if (v === 'true') return true; if (v === 'false') return false;
            return v;
        } catch (_) { return this.DEFAULTS[k]; }
    },
    set(k, v) { try { localStorage.setItem(this.KEYS[k], String(v)); } catch (_) { } },
    load() {
        depMapState.showExternalFiles = this.get('extFiles');
        l2State.showExternalFuncs = this.get('extFuncs');
        l2State.showExternalEdges = l2State.showExternalFuncs;
    },
};

function T(key, vars) {
    return window._i18n ? window._i18n.t(key, vars) : key;
}

function getSavedFont() { return _PREFS.get('font'); }

function _currentRootName() {
    const root = (window.DATA?.stats?.root || '').replace(/\\/g, '/').replace(/\/$/, '');
    return root.split('/').filter(Boolean).pop() || 'VIZCODE';
}

function _formatL2Stats(stats) {
    if (!stats) return '';
    const parts = [];
    parts.push(T('countFuncsShort', { count: stats.funcs || 0 }));
    parts.push(T('countEdges', { count: stats.internalEdges || 0 }));
    if (stats.extModules) parts.push(T('countModules', { count: stats.extModules }));
    if (stats.extFuncs) parts.push(T('countExternalFunctions', { count: stats.extFuncs }));
    if (stats.legacy) parts.push(T('legacyEdges'));
    return parts.join(' | ');
}

function _refreshTopbarStatsLabels() {
    const stats = document.querySelectorAll('#topbar .stats-bar .stat');
    const files = document.getElementById('st-files')?.textContent || '0';
    const mods = document.getElementById('st-mods')?.textContent || '0';
    const funcs = document.getElementById('st-funcs')?.textContent || '0';
    if (stats[0]) stats[0].innerHTML = `${T('topbarFiles')} <strong id="st-files">${files}</strong>`;
    if (stats[1]) stats[1].innerHTML = `${T('topbarModules')} <strong id="st-mods">${mods}</strong>`;
    if (stats[2]) stats[2].innerHTML = `${T('topbarFunctions')} <strong id="st-funcs">${funcs}</strong>`;
}

function _refreshSearchChrome() {
    const filesBtn = document.getElementById('srm-files');
    const codeBtn = document.getElementById('srm-code');
    const caseBtn = document.getElementById('srt-case');
    const wordBtn = document.getElementById('srt-word');
    const regexBtn = document.getElementById('srt-regex');
    const search = document.getElementById('search');
    const filterLabels = document.querySelectorAll('#sr-filters .sr-filter-label');
    const include = document.getElementById('sr-include');
    const exclude = document.getElementById('sr-exclude');
    if (filesBtn) { filesBtn.setAttribute('data-tip', T('searchModeFilesTip')); filesBtn.setAttribute('aria-label', T('searchModeFiles')); }
    if (codeBtn) { codeBtn.setAttribute('data-tip', T('searchModeCodeTip')); codeBtn.setAttribute('aria-label', T('searchModeCode')); }
    if (caseBtn) caseBtn.setAttribute('data-tip', T('searchMatchCase'));
    if (wordBtn) wordBtn.setAttribute('data-tip', T('searchMatchWord'));
    if (regexBtn) regexBtn.setAttribute('data-tip', T('searchRegex'));
    if (search) search.placeholder = (typeof _srState !== 'undefined' && _srState.mode === 'code') ? T('searchPlaceholderCode') : T('searchPlaceholderFiles');
    if (filterLabels[0]) filterLabels[0].textContent = T('searchIncludeLabel');
    if (filterLabels[1]) filterLabels[1].textContent = T('searchExcludeLabel');
    if (include) include.placeholder = T('searchIncludePlaceholder');
    if (exclude) exclude.placeholder = T('searchExcludePlaceholder');
}

function _refreshPreferenceCopy() {
    const hint = document.querySelector('.pref-hint');
    const extDesc = document.querySelectorAll('.pref-check-desc');
    if (hint) hint.innerHTML = T('langHint');
    if (extDesc[0]) extDesc[0].textContent = T('extFilesAlwaysDesc');
    if (extDesc[1]) extDesc[1].innerHTML = T('extFuncsAlwaysDesc');
}

function _refreshCodePanelChrome() {
    const loading = document.querySelector('#cp-loading span');
    const empty = document.getElementById('cp-empty');
    const filename = document.getElementById('cp-filename');
    const prev = document.getElementById('cp-prev-func');
    const next = document.getElementById('cp-next-func');
    if (loading) loading.textContent = T('loadingSource');
    if (filename && !codeState.currentFile) filename.textContent = T('noFileSelected');
    if (prev) prev.setAttribute('data-tip', T('prevFunc'));
    if (next) next.setAttribute('data-tip', T('nextFunc'));
    if (empty && !codeState.currentFile) {
        empty.innerHTML = `<div class="cp-empty-icon">??</div><p>${T('clickFileToView')}</p><small>${T('clickFileHint')}</small>`;
    }
}

function _refreshContextMenuChrome() {
    const items = {
        'ctx-copy': 'copyPath',
        'ctx-open-code': 'viewSource',
        'ctx-vscode': 'openInVSCode',
        'ctx-module-only': 'onlyThisModule',
        'ctx-pin': 'pinNode',
    };
    Object.entries(items).forEach(([id, key]) => {
        const el = document.getElementById(id);
        if (el) el.textContent = T(key);
    });
}

function _refreshVisualChrome() {
    if (!window._i18n) return;
    document.documentElement.lang = _PREFS.get('lang');
    document.title = T('visualizerPageTitle', { root: _currentRootName() });
    _refreshTopbarStatsLabels();
    _refreshSearchChrome();
    _refreshPreferenceCopy();
    _refreshCodePanelChrome();
    _refreshContextMenuChrome();

    // Global pass for any data-i18n tags
    window._i18n.apply(document);

    const dashboardBtn = document.getElementById('dashboard-btn');
    if (dashboardBtn) {
        dashboardBtn.innerHTML = `<svg style="width:16px;height:16px;margin-right:4px;vertical-align:middle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/></svg> ${T('dashboard')}`;
        dashboardBtn.setAttribute('data-tip', T('analyticsDashboard'));
    }
    const prefBtn = document.getElementById('pref-btn');
    if (prefBtn) prefBtn.setAttribute('data-tip', T('settingsButton'));
    const cancelBtn = document.getElementById('loading-cancel-btn');
    if (cancelBtn) cancelBtn.innerHTML = `✕ ${T('cancelRender')}`;
    const backBtn = document.getElementById('back-btn');
    if (backBtn) backBtn.innerHTML = `&#8592; ${T('back')}`;
    const codeBtn = document.getElementById('code-toggle-btn');
    if (codeBtn) {
        codeBtn.innerHTML = `<span class="code-icon">&#60;&#92;&#62;</span> ${T('codePanelToggle')}`;
        codeBtn.setAttribute('data-tip', T('codePanelToggleTip'));
    }

    const sbTitle = document.querySelector('#sidebar-title span[data-i18n="fileSystem"]');
    if (sbTitle) sbTitle.textContent = T('sidebarFileSystem');

    const l1Title = document.querySelector('#l1-toolbar .l2-title');
    const l2Title = document.querySelector('#l2-toolbar .l2-title');
    if (l1Title) l1Title.textContent = T('l1Title');
    if (l2Title) l2Title.textContent = T('l2Title');
    const l1Expand = document.getElementById('l1-expand-all-ext');
    const l1Collapse = document.getElementById('l1-collapse-all-ext');
    const l2Expand = document.getElementById('l2-expand-all');
    const l2Collapse = document.getElementById('l2-collapse-all');
    if (l1Expand) l1Expand.textContent = T('searchExpandAll');
    if (l1Collapse) l1Collapse.textContent = T('searchCollapseAll');
    if (l2Expand) l2Expand.textContent = T('searchExpandAll');
    if (l2Collapse) l2Collapse.textContent = T('searchCollapseAll');
    const extLines = document.getElementById('l2-toggle-ext-lines');
    if (extLines) extLines.textContent = l2State.showExternalEdges ? T('extLinesOn') : T('extLinesOff');

    // Update graph-toggle-btn text (Call Graph / Dependency Map)
    const graphBtn = document.getElementById('graph-toggle-btn');
    if (graphBtn) {
        const isL2 = state.level === 2;
        const icon = isL2 ? '&#9671;' : '&#11041;';
        const txt = isL2 ? T('graphBtnDependencyMap') : T('graphBtnCallGraph');
        const tip = isL2 ? T('graphBtnDependencyMapTip') : T('graphBtnCallGraphTip');
        graphBtn.innerHTML = `${icon} <span>${txt}</span>`;
        graphBtn.setAttribute('data-tip', tip);
    }
}

function _layoutKeyMap(id) {
    return ({
        'dagre-lr': ['layoutDagreLR', 'layoutDagreLR_Tip'],
        'dagre-tb': ['layoutDagreTB', 'layoutDagreTB_Tip'],
        'cose': ['layoutCose', 'layoutCose_Tip'],
        'fcose': ['layoutFcose', 'layoutFcose_Tip'],
        'cola': ['layoutCola', 'layoutCola_Tip'],
        'elk-layered': ['layoutElkLayered', 'layoutElkLayered_Tip'],
        'elk-stress': ['layoutElkStress', 'layoutElkStress_Tip'],
    })[id] || [];
}

function _layoutLabel(preset) {
    const [labelKey] = _layoutKeyMap(preset.id);
    return labelKey ? T(labelKey) : preset.label;
}

function _layoutTip(preset) {
    const [, tipKey] = _layoutKeyMap(preset.id);
    return tipKey ? T(tipKey) : preset.tip;
}

function _refreshDashboardLocale() {
    const overlay = document.getElementById('dashboard-overlay');
    if (!overlay) return;
    const open = overlay.style.display !== 'none';
    overlay.remove();
    _dashBuilt = false;
    _buildDashboardDOM();
    if (open) {
        document.getElementById('dashboard-overlay').style.display = 'block';
        _renderDashboard();
        _dashBuilt = true;
    }
}

function withFont(styleList, font) {
    return styleList.map(s => {
        if (!s || !s.selector || !s.style) return s;
        const sel = s.selector;
        if (sel === 'node' || sel.startsWith('node') || sel === 'edge' || sel.startsWith('edge')) {
            return { ...s, style: { ...s.style, 'font-family': font } };
        }
        return s;
    });
}

function applyCyFont(font) {
    if (!cy || typeof cy.style !== 'function') return;
    try {
        const cyFont = (font || '').replace(/["']/g, '');
        cy.style(withFont(CY_STYLE, cyFont));
        // Ensure existing elements are updated immediately
        cy.nodes().style('font-family', cyFont);
        cy.edges().style('font-family', cyFont);
        // Force a repaint for canvas labels
        cy.resize();
    } catch (e) {
        console.warn('Failed to update cytoscape font', e);
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

// ─── Global themed tooltip ────────────────────────────────────────────────────
const _gtip = { el: null, timer: null, DELAY: 380 };

function _initGlobalTooltip() {
    const el = document.createElement('div');
    el.id = 'g-tooltip';
    document.body.appendChild(el);
    _gtip.el = el;
    // Migrate static title= → data-tip= to suppress browser tooltip
    document.querySelectorAll('[title]').forEach(n => {
        const t = n.getAttribute('title');
        if (!t) return;
        n.setAttribute('data-tip', t);
        n.removeAttribute('title');
    });
    document.addEventListener('mouseover', _gtipOver, true);
    document.addEventListener('mouseout', _gtipOut, true);
    document.addEventListener('mousemove', _gtipMove, true);
    document.addEventListener('scroll', () => _gtipHide(), true);
    document.addEventListener('keydown', () => _gtipHide(), true);
}
function _gtipOver(e) {
    const t = e.target.closest('[data-tip]'); if (!t) return;
    clearTimeout(_gtip.timer);
    _gtip.timer = setTimeout(() => _gtipShow(t, e), _gtip.DELAY);
}
function _gtipOut(e) {
    if (!e.target.closest('[data-tip]')) return;
    clearTimeout(_gtip.timer); _gtipHide();
}
function _gtipMove(e) {
    if (_gtip.el && _gtip.el.style.display !== 'none') _gtipPos(e.clientX, e.clientY);
}
function _gtipShow(target, e) {
    const raw = target.dataset.tip || ''; if (!raw) return;
    const lines = raw.split('\n');
    _gtip.el.innerHTML = lines.map((l, i) => {
        if (i === 0) return `<strong class="gt-head">${escapeHtml(l)}</strong>`;
        if (l.startsWith('⚠')) return `<span class="gt-warn">${escapeHtml(l)}</span>`;
        return `<span class="gt-line">${escapeHtml(l)}</span>`;
    }).join('');
    _gtip.el.style.display = 'block';
    requestAnimationFrame(() => { _gtipPos(e.clientX, e.clientY); _gtip.el.classList.add('g-tip-visible'); });
}
function _gtipHide() {
    clearTimeout(_gtip.timer);
    if (!_gtip.el) return;
    _gtip.el.classList.remove('g-tip-visible');
    _gtip.el.style.display = 'none';
}
function _gtipPos(mx, my) {
    const el = _gtip.el; if (!el) return;
    const W = window.innerWidth, H = window.innerHeight, TW = el.offsetWidth || 220, TH = el.offsetHeight || 40, G = 14;
    let x = mx + G, y = my + G;
    if (x + TW > W - 8) x = mx - TW - G;
    if (y + TH > H - 8) y = my - TH - G;
    el.style.left = `${Math.max(4, x)}px`; el.style.top = `${Math.max(4, y)}px`;
}

window.addEventListener('DOMContentLoaded', () => {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            try {
                const el = document.getElementById('viz-data');
                if (!el) { showMsg(T('errorNoDataElement')); return; }

                document.getElementById('loading-msg').textContent = '🔍 Parsing graph data...';
                const t0 = performance.now();
                window.DATA = JSON.parse(el.textContent);
                console.log(`JSON.parse: ${(performance.now() - t0).toFixed(0)}ms`);

                if (!window.DATA?.stats) { showMsg(T('errorInvalidDataFormat')); return; }

                const s = DATA.stats;
                const rootOther = (DATA.other_files_by_module || {})['_root'] || [];
                const rootFiles = (DATA.files_by_module || {})['_root'] || [];
                if ((rootOther.length || rootFiles.length) && Array.isArray(DATA.modules)
                    && !DATA.modules.some(m => m.id === '_root')) {
                    const rootPath = (DATA.stats?.root || '').replace(/\\/g, '/').replace(/\/$/, '');
                    const rootName = rootPath.split('/').filter(Boolean).pop() || '_root';
                    const rootFuncCount = rootFiles.reduce((sum, f) => sum + (f.func_count || 0), 0);
                    DATA.modules.push({
                        id: '_root',
                        label: rootName,
                        color: '#94a3b8',
                        file_count: rootFiles.length,
                        func_count: rootFuncCount,
                        other_count: rootOther.length,
                    });
                }
                const totalFiles = s.files + (s.other_files || 0);
                document.getElementById('st-files').textContent = totalFiles.toLocaleString();
                document.getElementById('st-mods').textContent = (DATA.modules || []).length || s.modules;
                document.getElementById('st-funcs').textContent = s.functions.toLocaleString();

                buildSidebar();
                buildFileIdLookup();
                _PREFS.load();
                initCy();
                loadLevel0();

                document.getElementById('search').addEventListener('input', onSearch);
                document.addEventListener('keydown', onKey);
                document.addEventListener('click', () => hideCtxMenu());

                // Code panel init
                initCodePanel();

                // Preferences init
                initPreferences();

                // Search system init (must be after DATA loads)
                initSearch();

                // L1 toolbar init
                initL1Toolbar();

                // L2 toolbar init
                initL2Toolbar();

                // Tooltip actions init
                initTooltipActions();

                // Layout Switcher init
                initLayoutSwitcher();
                _initGlobalTooltip();
                // Probe which advanced layouts actually loaded (needs cy + switcher to exist)
                _probeAvailableLayouts();

                // Ensure Canvas redraws after Google Fonts are fully loaded
                document.fonts.ready.then(() => {
                    if (cy) applyCyFont(getSavedFont());
                });
            } catch (e) {
                showMsg('Error: ' + e.message + '\n' + (e.stack || ''));
            }
        });
    });
});



function showMsg(msg) {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.add('show');
    const spinner = document.querySelector('#loading .spinner');
    if (spinner) spinner.style.display = 'none';
    document.getElementById('loading-msg').textContent = msg;
}

function isAlreadyAtLocation(node) {
    if (!node) return false;
    const d = node.data();
    // Normalize paths
    const normalize = p => (p || '').replace(/\\/g, '/').toLowerCase();

    const srcPath = normalize(state.level === 2 ? (l2State.activeFile || '') : (state.activeModule || ''));
    const tgtPath = normalize((typeof d._f === 'object' ? d._f?.path : d._f) || d.mod || d.id || '');

    if (!srcPath || !tgtPath) return false;

    // Level 1: Dependency Map (Module level)
    if (state.level === 1) {
        // If target is the current module itself
        if (tgtPath === srcPath) return true;
        // If target is a file or submodule INSIDE the current module
        if (tgtPath.startsWith(srcPath + '/')) return true;
    }

    // Level 2: Call Flow (File level)
    if (state.level === 2) {
        // If target is the current file or a function within it
        if (tgtPath === srcPath) return true;
    }

    return false;
}


function showToast(msg, type = 'info') {

    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${msg}</span>`;
    container.appendChild(el);

    setTimeout(() => {
        el.classList.add('toast-hide');
        setTimeout(() => el.remove(), 300);
    }, 3000);
}


// ─── Code Panel ──────────────────────────────────────────────────────────────
function initCodePanel() {
    document.getElementById('cp-close').onclick = closeCodePanel;

    document.getElementById('code-toggle-btn').onclick = () => {
        if (codeState.isOpen) {
            closeCodePanel();
        } else {
            codeState.userClosed = false; // user wants panel open
            // If we have a current file loaded, sync it
            if (codeState.currentFile) {
                _syncCodePanel(codeState.currentFile, codeState.currentFunc);
            } else {
                openCodePanel();
            }
        }
    };

    document.getElementById('graph-toggle-btn').onclick = () => {
        // Mutually exclusive: If Structure view is active, switch to Call Graph view
        if (window._sv && window._sv.active) {
            if (window.svHideSvView) window.svHideSvView();

            // If we were at L1, drill down to Call Graph L2 explicitly
            if (state.level < 2 && typeof drillCurrentFileToL2 === 'function') {
                drillCurrentFileToL2();
            }
            // If already in L2 Call graph under the Structure view, svHideSvView restores it naturally.
            return;
        }

        // Toggle from Call Graph back to L1
        if (state.level === 2) {
            restoreL1FromCallGraph();
        } else {
            drillCurrentFileToL2();
        }
    };

    // Structure button: toggle structure view in center panel
    const structBtn = document.getElementById('struct-toggle-btn');
    if (structBtn) {
        structBtn.onclick = () => {
            if (window.svToggleStructView) svToggleStructView();
        };
    }

    document.getElementById('cp-prev-func').onclick = () => navigateFunc(-1);
    document.getElementById('cp-next-func').onclick = () => navigateFunc(1);

    // Resizer drag
    initResizer();
    initSidebarResizer();
}

// ─── Preferences ─────────────────────────────────────────────────────────────
function applyFont(font) {
    document.documentElement.style.setProperty('--code-font', font);
    document.documentElement.style.setProperty('--ui-font', font);
    document.body.style.fontFamily = font + ', Inter, sans-serif';

    applyCyFont(font);
}

// ─── Theme ────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme || 'dark');
}

function _applyLang(lang) {
    if (!window._i18n) return;
    const active = window._i18n.init(lang || _PREFS.get('lang'));
    document.documentElement.lang = active;
    if (window._i18n.apply) window._i18n.apply(document);
    _refreshVisualChrome();
    updateDepMapExtToggle();
    updateExternalFuncsToggle();
    const l1Stats = document.getElementById('l1-stats');
    if (l1Stats && l1Stats.dataset.count) l1Stats.textContent = T('countFiles', { count: l1Stats.dataset.count });
    const l2Stats = document.getElementById('l2-stats');
    if (l2Stats && l2Stats.dataset.stats) l2Stats.textContent = _formatL2Stats(JSON.parse(l2Stats.dataset.stats));
    updateBreadcrumb();
    if (typeof _srRenderActionBar === 'function') _srRenderActionBar();
    if (typeof _srRenderResults === 'function') _srRenderResults();
    refreshLayoutSwitcher();
    _refreshDashboardLocale();
}

function initPreferences() {
    const prefBtn = document.getElementById('pref-btn');
    const prefModal = document.getElementById('pref-modal');
    if (!prefBtn || !prefModal) return;

    // Apply saved values on load
    const savedFont = getSavedFont();
    const savedTheme = _PREFS.get('theme');
    const savedLang = _PREFS.get('lang');

    applyFont(savedFont);
    applyTheme(savedTheme);
    _applyLang(savedLang);

    const fontSel = document.getElementById('font-select');
    const themeSel = document.getElementById('pref-theme-select');
    const langSel = document.getElementById('pref-lang-select');

    if (fontSel) { fontSel.value = savedFont; fontSel.style.fontFamily = savedFont; }
    if (themeSel) { themeSel.value = savedTheme; }
    if (langSel) { langSel.value = savedLang; }

    _syncCheck('pref-ext-files', _PREFS.get('extFiles'));
    _syncCheck('pref-ext-funcs', _PREFS.get('extFuncs'));

    // Layout defaults
    const layoutL0Sel = document.getElementById('pref-layout-l0');
    const layoutL1Sel = document.getElementById('pref-layout-l1');
    const layoutL2Sel = document.getElementById('pref-layout-l2');
    if (layoutL0Sel) layoutL0Sel.value = _PREFS.get('layoutL0');
    if (layoutL1Sel) layoutL1Sel.value = _PREFS.get('layoutL1');
    if (layoutL2Sel) layoutL2Sel.value = _PREFS.get('layoutL2');

    // Open/close
    prefBtn.addEventListener('click', () => { prefModal.style.display = 'flex'; });
    const close = () => { prefModal.style.display = 'none'; };
    document.getElementById('pref-close-x')?.addEventListener('click', close);
    document.getElementById('pref-close-btn')?.addEventListener('click', close);
    prefModal.addEventListener('click', e => { if (e.target === prefModal) close(); });

    // Font
    if (fontSel) fontSel.addEventListener('change', e => {
        const f = e.target.value; applyFont(f); _PREFS.set('font', f);
        fontSel.style.fontFamily = f;
    });

    // Theme — live switch
    if (themeSel) themeSel.addEventListener('change', e => {
        const t = e.target.value; applyTheme(t); _PREFS.set('theme', t);
    });

    // Language — live switch (no reload needed)
    if (langSel) langSel.addEventListener('change', e => {
        const l = e.target.value; _PREFS.set('lang', l); _applyLang(l);
    });

    // Behaviour checkboxes
    _bindCheck('pref-ext-files', 'extFiles', v => {
        depMapState.showExternalFiles = v; updateDepMapExtToggle();
    });
    _bindCheck('pref-ext-funcs', 'extFuncs', v => {
        l2State.showExternalFuncs = v;
        l2State.showExternalEdges = v;          // lines always follow funcs
        updateExternalFuncsToggle?.();
        applyExternalEdgeVisibility?.();
    });

    // Default layout selects — save pref; takes effect on next level load
    if (layoutL0Sel) layoutL0Sel.addEventListener('change', e => {
        _PREFS.set('layoutL0', e.target.value);
    });
    if (layoutL1Sel) layoutL1Sel.addEventListener('change', e => {
        _PREFS.set('layoutL1', e.target.value);
    });
    if (layoutL2Sel) layoutL2Sel.addEventListener('change', e => {
        _PREFS.set('layoutL2', e.target.value);
    });
}

function _syncCheck(id, val) { const el = document.getElementById(id); if (el) el.checked = !!val; }
function _bindCheck(id, key, fn) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => { _PREFS.set(key, el.checked); fn(el.checked); });
}

// ─── L1 Toolbar (Dependency Map) ─────────────────────────────────────────────
function initL1Toolbar() {
    const prevBtn = document.getElementById('l1-prev');
    const nextBtn = document.getElementById('l1-next');
    const toggleBtn = document.getElementById('l1-toggle-ext');
    const expandBtn = document.getElementById('l1-expand-all-ext');
    const collapseBtn = document.getElementById('l1-collapse-all-ext');

    if (prevBtn) prevBtn.addEventListener('click', goL1Prev);
    if (nextBtn) nextBtn.addEventListener('click', goL1Next);

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            depMapState.showExternalFiles = !depMapState.showExternalFiles;
            updateDepMapExtToggle();
            rerenderCurrentL1();
        });
    }
    if (expandBtn) {
        expandBtn.addEventListener('click', () => {
            depMapState.expandedExtModules = new Set(depMapState.currentExtModules);
            rerenderCurrentL1();
        });
    }
    if (collapseBtn) {
        collapseBtn.addEventListener('click', () => {
            depMapState.expandedExtModules = new Set();
            rerenderCurrentL1();
        });
    }

    updateDepMapExtToggle();
    updateL1NavButtons();
    window.addEventListener('mouseup', onL1MouseNav);
}

function setL1ToolbarVisible(v) {
    const bar = document.getElementById('l1-toolbar');
    if (!bar) return;
    bar.classList.toggle('hidden', !v);
}

function updateDepMapExtToggle() {
    const btn = document.getElementById('l1-toggle-ext');
    if (!btn) return;
    btn.textContent = depMapState.showExternalFiles ? T('extFilesOn') : T('extFilesOff');
    btn.classList.toggle('active', depMapState.showExternalFiles);
}

function updateL1Toolbar(modId, fileCount) {
    const labelEl = document.getElementById('l1-mod-label');
    if (labelEl) { labelEl.textContent = modId || T('noModule'); labelEl.title = modId || ''; }
    const statsEl = document.getElementById('l1-stats');
    if (statsEl) { statsEl.dataset.count = String(fileCount || 0); statsEl.textContent = T('countFiles', { count: fileCount || 0 }); }
}

function pushL1History(modId, subDir) {
    if (depMapState._navigating) return;
    const entry = { modId, subDir: subDir || null };
    // Truncate forward history when navigating fresh
    depMapState.navHistory = depMapState.navHistory.slice(0, depMapState.navHistoryIdx + 1);
    // Avoid duplicate consecutive entries
    const last = depMapState.navHistory[depMapState.navHistoryIdx];
    if (last && last.modId === entry.modId && last.subDir === entry.subDir) return;
    depMapState.navHistory.push(entry);
    depMapState.navHistoryIdx = depMapState.navHistory.length - 1;
    updateL1NavButtons();
}

function updateL1NavButtons() {
    const prevBtn = document.getElementById('l1-prev');
    const nextBtn = document.getElementById('l1-next');
    if (prevBtn) prevBtn.disabled = depMapState.navHistoryIdx <= 0;
    if (nextBtn) nextBtn.disabled = depMapState.navHistoryIdx >= depMapState.navHistory.length - 1;
}

function goL1Prev() {
    if (depMapState.navHistoryIdx <= 0) return;
    depMapState.navHistoryIdx--;
    _jumpL1History();
}

function goL1Next() {
    if (depMapState.navHistoryIdx >= depMapState.navHistory.length - 1) return;
    depMapState.navHistoryIdx++;
    _jumpL1History();
}

function _jumpL1History() {
    const entry = depMapState.navHistory[depMapState.navHistoryIdx];
    if (!entry) return;
    depMapState._navigating = true;
    if (entry.subDir) {
        // Navigate to module first (no push), then filter to subdir
        if (state.activeModule !== entry.modId) {
            drillToModule(entry.modId);
        }
        filterGraphToSubPath(entry.modId, entry.subDir);
    } else {
        drillToModule(entry.modId);
    }
    depMapState._navigating = false;
    updateL1NavButtons();
}

function onL1MouseNav(e) {
    if (state.level !== 1) return;
    if (e.button === 3) {
        e.preventDefault();
        goL1Prev();
    } else if (e.button === 4) {
        e.preventDefault();
        goL1Next();
    }
}

function toggleDepMapExtGroup(extModId) {
    // Save the clicked group node's graph position + current viewport for expand animation
    const modSlug = _safeId(extModId) + '-' + _hashId(extModId);
    const groupNode = cy.$id(`depext-${modSlug}`);
    if (groupNode && groupNode.length) {
        depMapState.expandOriginPos = { ...groupNode.position() };
    } else {
        depMapState.expandOriginPos = null;
    }
    depMapState.preserveViewport = { pan: { ...cy.pan() }, zoom: cy.zoom() };

    if (depMapState.expandedExtModules.has(extModId)) {
        depMapState.expandedExtModules.delete(extModId);
        depMapState.expandOriginPos = null; // collapsing — no spawn animation
    } else {
        depMapState.expandedExtModules.add(extModId);
    }
    rerenderCurrentL1();
}

function rerenderCurrentL1() {
    if (state.level !== 1 || !state.activeModule) return;
    const allFiles = DATA.files_by_module[state.activeModule] || [];
    const filtered = state.activeSubDir
        ? allFiles.filter(f => f.path.startsWith(state.activeModule + '/' + state.activeSubDir + '/'))
        : allFiles;
    renderFilesFlat(state.activeModule, filtered, state.activeSubDir || undefined);
}

function initL2Toolbar() {
    const prevBtn = document.getElementById('l2-prev');
    const nextBtn = document.getElementById('l2-next');
    const toggleExtLinesBtn = document.getElementById('l2-toggle-ext-lines');
    const toggleExtFuncsBtn = document.getElementById('l2-toggle-ext-funcs');
    const expandBtn = document.getElementById('l2-expand-all');
    const collapseBtn = document.getElementById('l2-collapse-all');

    if (prevBtn) prevBtn.addEventListener('click', goL2Prev);
    if (nextBtn) nextBtn.addEventListener('click', goL2Next);
    if (toggleExtLinesBtn) {
        toggleExtLinesBtn.addEventListener('click', () => {
            l2State.showExternalEdges = !l2State.showExternalEdges;
            updateExternalToggle();
            applyExternalEdgeVisibility();
        });
    }
    if (toggleExtFuncsBtn) {
        toggleExtFuncsBtn.addEventListener('click', () => {
            l2State.showExternalFuncs = !l2State.showExternalFuncs;
            if (l2State.showExternalFuncs) {
                l2State.showExternalEdges = true;
            }
            updateExternalFuncsToggle();
            renderL2Flowchart(l2State.activeFile);
        });
    }

    if (expandBtn) {
        expandBtn.addEventListener('click', () => {
            if (!l2State.activeFile) return;
            l2State.preserveViewport = cy ? { pan: { ...cy.pan() }, zoom: cy.zoom() } : null;
            l2State.expandOriginPos = null;
            l2State.expandedModules = new Set(l2State.externalModules || []);
            if (!l2State.expandedSysCategories) l2State.expandedSysCategories = new Set();
            (l2State.sysCategories || []).forEach(c => l2State.expandedSysCategories.add(c));
            if (l2State.hasUnresolved) l2State.expandedSysCategories.add('__unk__');
            renderL2Flowchart(l2State.activeFile);
        });
    }

    if (collapseBtn) {
        collapseBtn.addEventListener('click', () => {
            if (!l2State.activeFile) return;
            l2State.preserveViewport = cy ? { pan: { ...cy.pan() }, zoom: cy.zoom() } : null;
            l2State.expandOriginPos = null;
            l2State.expandedModules = new Set();
            if (l2State.expandedSysCategories) l2State.expandedSysCategories.clear();
            renderL2Flowchart(l2State.activeFile);
        });
    }

    updateExternalToggle();
    updateL2NavButtons();
    window.addEventListener('mouseup', onL2MouseNav);
}

function initTooltipActions() {
    const tip = document.getElementById('tooltip');
    if (!tip) return;

    tip.addEventListener('mouseenter', () => {
        tooltipPinned = true;
        if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
    });
    tip.addEventListener('mouseleave', () => {
        tooltipPinned = false;
        hideTooltip();
        clearHighlight();
    });
    tip.addEventListener('click', (e) => {
        if (window.getSelection()?.toString()) return; // avoid toggling when selecting text
        const btn = e.target.closest('[data-action]');
        if (!btn) {
            showNodeModal(window._currentHoverNode);
            return;
        }
        const action = btn.dataset.action;
        const file = decodeURIComponent(btn.dataset.file || '');
        const func = decodeURIComponent(btn.dataset.func || '');
        if (action === 'open') {
            const nodeType = btn.dataset.nodeType || '';
            const node = window._currentHoverNode;

            if (isAlreadyAtLocation(node)) {
                showToast('您已在此位置 (Already at this location)');
                return;
            }

            if (nodeType === 'dep_ext_file' || nodeType === 'dep_ext_group') {
                const extMod = decodeURIComponent(btn.dataset.mod || '');
                const extFile = decodeURIComponent(btn.dataset.file || '');
                hideTooltip();
                if (extMod) drillToModule(extMod, { focusFile: extFile || null, closeExt: true });
            } else {
                openL2File(file, { pushHistory: true, focusFunc: func || null });
                hideNodeModal();
            }
        } else if (action === 'view') {
            _syncCodePanel(file, func || null);
            hideNodeModal();
        }
    });
}

function showNodeModal(node) {
    if (!node) return;

    let backdrop = document.getElementById('node-modal-backdrop');
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'node-modal-backdrop';
        backdrop.innerHTML = `
            <div id="node-modal">
                <button id="node-modal-close">&times;</button>
                <div id="node-modal-content"></div>
            </div>
        `;
        document.body.appendChild(backdrop);

        document.getElementById('node-modal-close').addEventListener('click', hideNodeModal);
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) hideNodeModal();
        });

        // Delegate tip-btn clicks inside modal
        document.getElementById('node-modal-content').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            let file = decodeURIComponent(btn.dataset.file || '');
            const func = decodeURIComponent(btn.dataset.func || '');

            if (action === 'open-ambiguous' || action === 'view-ambiguous') {
                const selected = document.querySelector('input[name="ambiguous-file-select"]:checked');
                if (!selected) {
                    showToast('請先選擇一個檔案 (Please select a file first)', 'error');
                    return;
                }
                file = selected.value;
                if (action === 'open-ambiguous') {
                    openL2File(file, { pushHistory: true, focusFunc: func || null });
                    hideNodeModal();
                } else {
                    _syncCodePanel(file, func || null);
                    hideNodeModal();
                }
                return;
            }

            if (action === 'open') {
                const nodeType = btn.dataset.nodeType || '';
                // Check guardrail
                if (isAlreadyAtLocation(window._currentHoverNode)) {
                    showToast('您已在此位置 (Already at this location)');
                    return;
                }

                // dep_ext_file / dep_ext_group → navigate to that module's Dependency Map (L1)
                if (nodeType === 'dep_ext_file' || nodeType === 'dep_ext_group') {
                    const extMod = decodeURIComponent(btn.dataset.mod || '');
                    const extFile = decodeURIComponent(btn.dataset.file || '');
                    hideNodeModal();
                    if (extMod) drillToModule(extMod, { focusFile: extFile || null, closeExt: true });
                } else {
                    openL2File(file, { pushHistory: true, focusFunc: func || null });
                    hideNodeModal();
                }
            } else if (action === 'view') {
                _syncCodePanel(file, func || null);
                hideNodeModal();
            }
        });
    }

    const d = node.data();
    let html = '';

    // Subtitle inline formatting
    const lines = (d.tt || '').split('\n');
    let title = '';
    let subtitle = '';

    if (d._t === 'ext_func') {
        title = d.fn || '';
        subtitle = escapeHtml(d._f || T('tooltipUnknownTarget'));
    } else if (d._t === 'potential_func') {
        title = d.fn ? `Ambiguous: ${d.fn}` : lines[0] || '';
    } else {
        title = lines[0] || '';
        subtitle = lines.slice(1).map(escapeHtml).join('<br>').trim();
    }

    // Header
    html += `<div class="modal-header">`;
    html += `<div class="tip-title" style="font-size: 18px; line-height: 1.4; font-family: monospace; white-space: normal; word-break: break-all;" title="${escapeHtml(title)}">${escapeHtml(title)}</div>`;

    if (d._t === 'potential_func') {
        html += `<div class="tip-body" style="font-size: 12px; margin-top: 12px; font-family: monospace;">`;
        html += `<div style="margin-bottom: 8px; font-weight: bold; color: #a78bfa;">${escapeHtml(T('tooltipPossibleFiles'))}</div>`;
        html += `<div class="ambiguous-file-list" style="max-height: 150px; overflow-y: auto; background: rgba(0,0,0,0.2); border-radius: 4px; padding: 4px;">`;
        if (d._files && d._files.length) {
            d._files.forEach((f) => {
                html += `<label style="display: block; padding: 6px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.05); user-select: none;">
                    <input type="radio" name="ambiguous-file-select" value="${escapeHtml(f)}" style="margin-right: 8px;">
                    <span style="word-break: break-all;">${escapeHtml(f)}</span>
                </label>`;
            });
        }
        html += `</div></div>`;
    } else if (d._t === 'dep_ext_file' || d._t === 'dep_ext_group' || d._t === 'ext_func' || d._t === 'ext_group' || d._t === 'drilled_func' || d._t === 'drill_group') {
        const srcPath = state.level === 2 ? (l2State.activeFile || '') : (state.activeModule || '');
        const tgtPath = (typeof d._f === 'object' ? d._f?.path : d._f) || d.mod || '';
        const dist = _pathDist(srcPath, tgtPath);
        const distColor = _distColor(dist);
        const distLabel = dist === 0 ? (state.level === 2 ? T('distSame') : T('distSame')) : T('distAway', { count: dist });

        let displaySubtitle = subtitle;
        const typeStr = (d._t === 'ext_group' || d._t === 'dep_ext_group') ? T('externalModule') : T('externalFile');

        // Clean up redundant (EXTERNAL FILE) strings from subtitle across L1/L2
        displaySubtitle = displaySubtitle
            .replace(/\(External file\)/gi, '')
            .replace(/\(EXTERNAL FILE\)/gi, '')
            .replace(/\(EXTERNAL MODULE\)/gi, '')
            .replace(/<br><br>$/, '')
            .trim();

        html += `<div class="tip-body" style="font-size: 11px; margin-top: 8px; font-family: monospace; line-height: 1.6; color: rgba(255,255,255,0.85);">`;
        if (displaySubtitle) html += displaySubtitle + '<br>';
        html += `<span style="
            display: inline-block;
            margin-top: 6px;
            font-size: 11px;
            color: ${distColor};
            background: ${distColor}22;
            border: 1px solid ${distColor}66;
            border-radius: 4px;
            padding: 2px 8px;
            font-weight: 700;
            letter-spacing: 0.05em;
        ">⬡ ${typeStr} · ${distLabel}</span>`;
        html += `</div>`;
    } else if (subtitle) {
        html += `<div class="tip-body" style="font-size: 11px; margin-top: 8px; font-family: monospace; line-height: 1.4; color: rgba(255,255,255,0.85);">${subtitle}</div>`;
    }

    // Actions
    html += `<div class="tip-actions" style="margin-top: 16px;">`;
    if (d._t === 'potential_func') {
        html += `<button class="tip-btn" data-action="open-ambiguous" data-func="${encodeURIComponent(d.fn || '')}">${escapeHtml(T('tooltipOpenLocation'))}</button>` +
            `<button class="tip-btn" data-action="view-ambiguous" data-func="${encodeURIComponent(d.fn || '')}">${escapeHtml(T('tooltipViewFile'))}</button>`;
    } else {
        html += `<button class="tip-btn" data-action="open" data-file="${encodeURIComponent(d._f?.path || d._f || '')}" data-func="${encodeURIComponent(d.fn || '')}" data-node-type="${d._t || ''}" data-mod="${encodeURIComponent(d.mod || '')}">${escapeHtml(T('tooltipOpenLocation'))}</button>` +
            `<button class="tip-btn" data-action="view" data-file="${encodeURIComponent(d._f?.path || d._f || '')}" data-func="${encodeURIComponent(d.fn || '')}">${escapeHtml(T('tooltipViewFile'))}</button>`;
    }
    html += `</div>`;
    html += `</div>`;

    // Dependencies
    const outEdges = node.outgoers('edge');
    const inEdges = node.incomers('edge');

    if (outEdges.length > 0 || inEdges.length > 0) {
        html += `<div class="modal-deps">`;
        html += `<div style="font-weight:bold; margin: 20px 0 12px; padding-top:16px; border-top: 1px solid var(--border); font-size: 14px;">${T('dependencies')}:</div>`;

        const OUT_MAP = {
            'Inc': T('relInclude'), 'owns': T('relOwns'), 'Src': T('relSources'), 'Pkg': T('relPackage'), 'Lib': T('relLibrary'),
            'ELINK': T('relElink'), 'Comp': T('relComponent'), 'GUID': T('relGuidRef'),
            'Strings': T('relStrings'), 'ASL': T('relAslInclude'), 'Callback': T('relCallback'),
            'HII-Pkg': T('relHiiPkg'), 'Depex': T('relDepex'),
            'Import': T('relImports'),
            'ext': T('relExternalCalls'), 'group': T('relGroup'),
            '': state.level === 2 ? T('relCalls') : T('relIncludes')
        };
        const IN_MAP = {
            'Inc': T('relIncludedBy'), 'owns': T('relOwnedBy'), 'Src': T('relSourceOf'), 'Pkg': T('relPackagedIn'), 'Lib': T('relUsedAsLibBy'),
            'ELINK': T('relElinkParentOf'), 'Comp': T('relUsedAsCompBy'), 'GUID': T('relReferencedGuidBy'),
            'Strings': T('relReferencedAsStringBy'), 'ASL': T('relIncludedByAsl'), 'Callback': T('relTriggeredBy'),
            'HII-Pkg': T('relPackagedInHii'), 'Depex': T('relDependedBy'),
            'Import': T('relImportedBy'),
            'ext': T('relExternalCallers'), 'group': T('relGroup'),
            '': state.level === 2 ? T('relCalledBy') : T('relIncludedBy')
        };

        const outGroups = {};
        outEdges.forEach(edge => {
            const lbl = edge.data('el') || '';
            const col = edge.data('ec') || '#f59e0b';
            const outTxt = T(OUT_MAP[lbl]) || lbl || T('outgoing');
            const key = outTxt + '|' + col;
            if (!outGroups[key]) outGroups[key] = [];
            outGroups[key].push(edge.target());
        });

        const inGroups = {};
        inEdges.forEach(edge => {
            const lbl = edge.data('el') || '';
            const col = edge.data('ec') || '#10b981';
            const inTxt = T(IN_MAP[lbl]) || lbl || T('incoming');
            const key = inTxt + '|' + col;
            if (!inGroups[key]) inGroups[key] = [];
            inGroups[key].push(edge.source());
        });

        const renderList = (groups) => {
            for (const [key, nodes] of Object.entries(groups)) {
                const [lbl, col] = key.split('|');
                html += `<div style="margin-bottom: 12px;">`;
                html += `<div style="color:${col}; font-weight: 600; font-size: 13px; margin-bottom: 6px; font-family: monospace;">• ${lbl}: ${nodes.length}</div>`;
                html += `<div style="padding-left: 14px; display: flex; flex-direction: column; gap: 4px;">`;
                nodes.forEach(n => {
                    const nd = n.data();
                    let nTitle = nd.fn || nd.label || nd.id;
                    let nSub = nd._f?.path || nd._f || '';
                    if (nTitle.includes('\n')) nTitle = nTitle.split('\n')[0];
                    if (nd._t === 'file') {
                        nSub = nd._f?.ext ? nd._f.ext.toUpperCase() : T('file');
                    }

                    // ── Distance badge for external dep-map nodes ─────────────
                    let distBadge = '';
                    const isExtNode = nd._t === 'dep_ext_file' || nd._t === 'dep_ext_group';
                    if (isExtNode) {
                        const tgtPath = (typeof nd._f === 'object' ? nd._f?.path : nd._f) || nd.mod || '';
                        const dist = _pathDist(state.activeModule || '', tgtPath);
                        const distColor = _distColor(dist);
                        const distLabel = dist === 0 ? T('distSame') : `d=${dist}`;
                        distBadge = `<span style="
                            margin-left: auto;
                            font-size: 10px;
                            font-family: monospace;
                            color: ${distColor};
                            background: ${distColor}22;
                            border: 1px solid ${distColor}66;
                            border-radius: 4px;
                            padding: 1px 6px;
                            white-space: nowrap;
                            flex-shrink: 0;
                        ">${distLabel}</span>`;
                    }

                    html += `<div class="modal-dep-item" style="font-size: 12px; background: rgba(255,255,255,0.03); padding: 6px 10px; border-radius: 6px; cursor: pointer; display: flex; align-items: baseline; gap: 8px; transition: background 0.15s;" data-nav-node="${n.id()}">`;
                    html += `<span style="color: #e2e8f0; font-weight: 500; font-family: monospace;">${escapeHtml(nTitle)}</span>`;
                    if (nSub && nSub !== nTitle) {
                        html += `<span style="color: var(--muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace;">${escapeHtml(nSub)}</span>`;
                    }
                    if (distBadge) html += distBadge;
                    html += `</div>`;
                });
                html += `</div></div>`;
            }
        };

        renderList(outGroups);
        renderList(inGroups);
        html += `</div>`;
    }

    const modalTitle = document.getElementById('node-modal-title') || document.querySelector('.modal-header-title');
    if (modalTitle) modalTitle.textContent = T('details');

    const content = document.getElementById('node-modal-content');
    content.innerHTML = html;
    hideTooltip();

    // Bind click events to graph nav rows
    content.querySelectorAll('.modal-dep-item').forEach(el => {
        el.addEventListener('mouseover', () => el.style.background = 'rgba(255,255,255,0.08)');
        el.addEventListener('mouseout', () => el.style.background = 'rgba(255,255,255,0.03)');
        el.addEventListener('click', () => {
            const targetId = el.dataset.navNode;
            const targetNode = cy.getElementById(targetId);
            if (targetNode && targetNode.length) {
                hideNodeModal();
                const d = targetNode.data();
                if (d._t === 'module') drillToModule(d._m.id);
                else {
                    highlightNode(targetNode);
                    setTimeout(() => {
                        cy.animate({
                            center: { eles: targetNode },
                            zoom: Math.max(cy.zoom(), 1.0)
                        }, {
                            duration: 500,
                            easing: 'ease-in-out-cubic'
                        });
                    }, 0);
                }
            }
        });
    });

    requestAnimationFrame(() => {
        backdrop.classList.add('show');
    });
}

function hideNodeModal() {
    const backdrop = document.getElementById('node-modal-backdrop');
    if (backdrop) backdrop.classList.remove('show');
}

function onL2MouseNav(e) {
    if (state.level !== 2) return;
    if (e.button === 3) {
        e.preventDefault();
        goL2Prev();
    } else if (e.button === 4) {
        e.preventDefault();
        goL2Next();
    }
}

function updateExternalToggle() {
    // External lines always follow external funcs — no separate toggle
    l2State.showExternalEdges = l2State.showExternalFuncs;
    applyExternalEdgeVisibility();
}

function updateExternalFuncsToggle() {
    const btn = document.getElementById('l2-toggle-ext-funcs');
    if (!btn) return;
    btn.textContent = l2State.showExternalFuncs ? T('extFuncsOn') : T('extFuncsOff');
    btn.classList.toggle('active', l2State.showExternalFuncs);
    setL2ToolbarVisible(state.level === 2);
}

function applyExternalEdgeVisibility() {
    if (!cy) return;
    const edges = cy.edges('[el="ext"]');
    edges.style('display', l2State.showExternalEdges ? 'element' : 'none');
}

function updateL2NavButtons() {
    const prevBtn = document.getElementById('l2-prev');
    const nextBtn = document.getElementById('l2-next');
    const canPrev = l2State.fileHistoryIdx > 0;
    const canNext = l2State.fileHistoryIdx >= 0 && l2State.fileHistoryIdx < l2State.fileHistory.length - 1;
    if (prevBtn) prevBtn.disabled = !canPrev;
    if (nextBtn) nextBtn.disabled = !canNext;
}

function _saveL2Snapshot() {
    if (!cy) return;
    const idx = l2State.fileHistoryIdx;
    if (idx < 0) return;
    if (!l2State.fileHistorySnapshots) l2State.fileHistorySnapshots = [];
    l2State.fileHistorySnapshots[idx] = {
        pan: { ...cy.pan() },
        zoom: cy.zoom(),
        expandedModules: new Set(l2State.expandedModules),
        expandedSysCategories: new Set(l2State.expandedSysCategories || []),
        activeFuncIdx: l2State.activeFuncIdx || 0,
    };
}

function _applyL2Snapshot(idx) {
    const snap = l2State.fileHistorySnapshots && l2State.fileHistorySnapshots[idx];
    if (!snap) return;
    l2State.expandedModules = new Set(snap.expandedModules);
    l2State.expandedSysCategories = new Set(snap.expandedSysCategories);
    l2State.activeFuncIdx = snap.activeFuncIdx;
    // Schedule viewport restore after layout (preserveViewport, no originPos → exact restore)
    l2State.preserveViewport = { pan: snap.pan, zoom: snap.zoom };
    l2State.expandOriginPos = null;
}

function goL2Prev() {
    if (l2State.fileHistoryIdx <= 0) return;
    _saveL2Snapshot();
    l2State.fileHistoryIdx -= 1;
    const fileRel = l2State.fileHistory[l2State.fileHistoryIdx];
    if (!fileRel) return;
    _applyL2Snapshot(l2State.fileHistoryIdx);
    openL2File(fileRel, { pushHistory: false });
}

function goL2Next() {
    if (l2State.fileHistoryIdx < 0 || l2State.fileHistoryIdx >= l2State.fileHistory.length - 1) return;
    _saveL2Snapshot();
    l2State.fileHistoryIdx += 1;
    const fileRel = l2State.fileHistory[l2State.fileHistoryIdx];
    if (!fileRel) return;
    _applyL2Snapshot(l2State.fileHistoryIdx);
    openL2File(fileRel, { pushHistory: false });
}

function setL2ToolbarVisible(v) {
    const bar = document.getElementById('l2-toolbar');
    if (bar) bar.classList.toggle('hidden', !v);

    const extLinesBtn = document.getElementById('l2-toggle-ext-lines');
    if (extLinesBtn) extLinesBtn.style.display = (v && l2State.showExternalFuncs) ? 'block' : 'none';
}

function updateL2Toolbar(fileRel, stats) {
    const label = document.getElementById('l2-file-label');
    const statsEl = document.getElementById('l2-stats');
    if (label) {
        label.textContent = fileRel || T('noFile');
        label.title = fileRel || '';
    }
    if (statsEl && stats) {
        statsEl.dataset.stats = JSON.stringify(stats);
        statsEl.textContent = _formatL2Stats(stats);
    }
}

function clearFuncOverlay() {
    const fv = document.getElementById('func-view');
    if (!fv) return;
    fv.classList.remove('active');
    fv.innerHTML = '';
    document.getElementById('cy').style.display = '';
}

function openFileInVsCode(fileRel) {
    if (!fileRel) return;
    const root = DATA.stats.root;
    const abs = root.replace(/\//g, '\\') + '\\' + fileRel.replace(/\//g, '\\');
    window.open(`vscode://file/${abs}`);
}

function resetL2State(fileRel) {
    l2State.activeFile = fileRel;
    l2State.activeFuncIdx = 0;
    l2State.expandedModules = new Set();
    l2State.expandedSysCategories = new Set();
    l2State.externalModules = [];
    l2State._sysMap = null;
    l2State._unkMap = null;
    l2State._funcs = null;
}

function resetL2History() {
    l2State.fileHistory = [];
    l2State.fileHistoryIdx = -1;
}

function resolveModuleForFile(fileRel) {
    if (!fileRel || !DATA) return null;
    if (!fileRel.includes('/')) return '_root';
    const map = DATA.file_to_module || {};
    let mod = map[fileRel] || null;
    if (!mod) {
        const first = fileRel.split('/')[0];
        if (first && Array.isArray(DATA.modules) && DATA.modules.some(m => m.id === first)) {
            mod = first;
        }
    }
    return mod;
}

function syncBreadcrumbForFile(fileRel) {
    if (!fileRel) return;
    state.level = 2;
    state.activeFile = fileRel;
    const mod = resolveModuleForFile(fileRel);
    state.activeModule = mod || null;
    state.activeSubDir = null;
    const last = state.history[state.history.length - 1];
    if (mod && last && last.level === 1) {
        last.activeModule = mod;
    }
    updateBreadcrumb();
}

function focusL2Func(fileRel, idx, opts = {}) {
    const { center = false, openCodePanel = true } = opts;
    const funcs = DATA.funcs_by_file[fileRel] || [];
    if (!funcs[idx]) return;
    l2State.activeFuncIdx = idx;
    const node = cy.$id(`fn-${idx}`);
    if (node && node.length) {
        cy.elements().unselect();
        node.select();
        if (center) {
            cy.animate({ center: { eles: node }, duration: 200 });
        }
    }
    if (openCodePanel) {
        _syncCodePanel(fileRel, funcs[idx].label);
    }
    updateL2NavButtons();
}

function focusL2External(entry, opts = {}) {
    const { center = false } = opts;
    if (!entry) return;
    let node = entry.nodeId ? cy.$id(entry.nodeId) : null;
    if (!node || !node.length) {
        node = cy.nodes().filter(n => n.data('_t') === 'ext_func'
            && n.data('fn') === entry.func
            && n.data('mod') === entry.mod);
    }
    if (node && node.length) {
        cy.elements().unselect();
        node.select();
        highlightNode(node);
        if (center) cy.animate({ center: { eles: node }, duration: 200 });
    }
    if (entry.file) _syncCodePanel(entry.file, entry.func);
    updateL2NavButtons();
}

function syncActiveL2FuncCode(targetCallText = null) {
    const fileRel = l2State.activeFile;
    if (!fileRel) return;
    const funcs = DATA.funcs_by_file[fileRel] || [];
    let idx = l2State.activeFuncIdx || 0;
    if (idx < 0 || idx >= funcs.length) idx = 0;
    const funcName = funcs[idx]?.label || null;
    _syncCodePanel(fileRel, funcName || null, targetCallText);
}

function pickCallerIdxForExternal(node) {
    if (!node || !cy) return null;
    const callers = node.incomers('edge').sources().filter(n => n.data('_t') === 'func');
    if (!callers.length) return null;
    const activeIdx = l2State.activeFuncIdx;
    if (activeIdx != null) {
        const activeNode = cy.$id(`fn-${activeIdx}`);
        if (activeNode && activeNode.length) {
            const isCaller = callers.some(n => n.id() === activeNode.id());
            if (isCaller) return activeIdx;
        }
    }
    return callers[0]?.data('idx') ?? null;
}

function pushL2FileHistory(fileRel) {
    const current = l2State.fileHistory[l2State.fileHistoryIdx];
    if (current === fileRel) return;
    if (l2State.fileHistoryIdx < l2State.fileHistory.length - 1) {
        l2State.fileHistory = l2State.fileHistory.slice(0, l2State.fileHistoryIdx + 1);
    }
    l2State.fileHistory.push(fileRel);
    l2State.fileHistoryIdx = l2State.fileHistory.length - 1;
}

function toggleExternalGroup(modName) {
    if (!modName) return;
    const modSlug = _safeId(modName) + '-' + _hashId(modName);
    const groupNode = cy.$id(`extmod-${modSlug}`);

    if (l2State.expandedModules.has(modName)) {
        l2State.expandedModules.delete(modName);
        l2State.expandOriginPos = null; // collapse 不做展開動畫
    } else {
        l2State.expandedModules.add(modName);
        if (groupNode && groupNode.length) {
            l2State.expandOriginPos = { ...groupNode.position() };
        } else {
            l2State.expandOriginPos = null;
        }
    }
    l2State.preserveViewport = { pan: { ...cy.pan() }, zoom: cy.zoom() };

    renderL2Flowchart(l2State.activeFile);
}

// ─── Toggle sys_group (known system APIs + unresolved) ────────────────────────
// Mirrors toggleExternalGroup: saves origin + viewport, re-runs renderL2Flowchart
// so dagre handles layout (no overlaps) and spawn animation fires normally.
function toggleSysGroup(catName) {
    if (!l2State.expandedSysCategories) l2State.expandedSysCategories = new Set();

    const isUnk = catName === '__unk__';
    const catSlug = isUnk ? null : _safeId(catName) + '-' + _hashId(catName);
    const groupId = isUnk ? 'extmod-unknown' : `syscat-${catSlug}`;

    if (l2State.expandedSysCategories.has(catName)) {
        l2State.expandedSysCategories.delete(catName);
        l2State.expandOriginPos = null;
    } else {
        l2State.expandedSysCategories.add(catName);
        const groupNode = cy.$id(groupId);
        l2State.expandOriginPos = (groupNode && groupNode.length)
            ? { ...groupNode.position() }
            : null;
    }

    l2State.preserveViewport = { pan: { ...cy.pan() }, zoom: cy.zoom() };
    renderL2Flowchart(l2State.activeFile);
}

// ─── (dead code below — kept so git diff is readable, never called) ──────────
function _toggleSysGroup_old(catName) {
    if (!l2State.expandedSysCategories) l2State.expandedSysCategories = new Set();
    const isUnk = catName === '__unk__';
    const catSlug = isUnk ? null : _safeId(catName) + '-' + _hashId(catName);
    const groupId = isUnk ? 'extmod-unknown' : `syscat-${catSlug}`;
    const isExpanded = l2State.expandedSysCategories.has(catName);

    const SYS_CAT_STYLE = {
        'UEFI Boot Services': { color: '#60a5fa', bg: '#0b1e38' },
        'UEFI Runtime Services': { color: '#818cf8', bg: '#110e2e' },
        'EDK2 MemoryLib': { color: '#34d399', bg: '#0a2218' },
        'EDK2 BaseLib': { color: '#00d4ff', bg: '#021a22' },
        'EDK2 DebugLib': { color: '#fbbf24', bg: '#1f1500' },
        'EDK2 PrintLib': { color: '#fbbf24', bg: '#1f1500' },
        'EDK2 MemAlloc': { color: '#34d399', bg: '#0a2218' },
        'PEI Services': { color: '#a78bfa', bg: '#180d2e' },
        'EDK2 HobLib': { color: '#a78bfa', bg: '#180d2e' },
        'EDK2 UefiLib': { color: '#60a5fa', bg: '#0b1e38' },
        'EDK2 DevicePath': { color: '#60a5fa', bg: '#0b1e38' },
        'C Runtime': { color: '#fb923c', bg: '#1e0e00' },
        'AMI SDK': { color: '#e879f9', bg: '#1e0820' },
        'CPU/IO Lib': { color: '#f87171', bg: '#200808' },
        'Status Code': { color: '#94a3b8', bg: '#0f1520' },
    };
    const SYS_DEFAULT = { color: '#64748b', bg: '#101820' };
    const style = isUnk ? { color: '#475569', bg: '#1a1218' } : (SYS_CAT_STYLE[catName] || SYS_DEFAULT);

    const sysMap = l2State._sysMap || new Map();
    const unkMap = l2State._unkMap || new Map();
    const funcs = l2State._funcs || [];

    if (isExpanded) {
        // ── Collapse: remove individual func nodes, restore group node ─────────
        l2State.expandedSysCategories.delete(catName);

        // Find position centroid of expanded nodes to place group at
        const fnPrefix = isUnk ? 'unkfn-' : `sysfn-${catSlug}-`;
        const expandedNodes = cy.nodes().filter(n => n.id().startsWith(fnPrefix));
        let cx = 0, cy2 = 0;
        expandedNodes.forEach(n => { cx += n.position('x'); cy2 += n.position('y'); });
        if (expandedNodes.length) { cx /= expandedNodes.length; cy2 /= expandedNodes.length; }

        // Remove expanded nodes and their edges
        expandedNodes.connectedEdges().remove();
        expandedNodes.remove();

        // Count for collapsed label
        const fnMap = isUnk ? unkMap : sysMap.get(catName);
        const funcCount = fnMap ? fnMap.size : 0;

        // Add group node back at centroid
        cy.add({
            data: {
                id: groupId,
                label: isUnk ? `Unresolved\n${funcCount} funcs` : `${catName}\n${funcCount} funcs`,
                bg: style.bg, bc: style.color,
                w: isUnk ? 160 : 170, h: 52, sh: 'roundrectangle', lvl: 2,
                _t: 'sys_group', syscat: catName,
                tt: isUnk
                    ? `Unresolved symbols (${funcCount})\nClick to expand ↕`
                    : `${catName}\n${funcCount} funcs\n\nClick to expand ↕`,
            },
            position: { x: cx || 0, y: cy2 || 0 }
        });

        // Re-add edges from caller func nodes to this group
        const callerSet = new Map();
        if (isUnk) {
            unkMap.forEach(callers => callers.forEach(idx => callerSet.set(idx, (callerSet.get(idx) || 0) + 1)));
        } else {
            (sysMap.get(catName) || new Map()).forEach(callerSetI => callerSetI.forEach(idx => callerSet.set(idx, (callerSet.get(idx) || 0) + 1)));
        }
        callerSet.forEach((count, callerIdx) => {
            const edgeId = isUnk ? `unke-${callerIdx}` : `syse-${catSlug}-${callerIdx}`;
            if (!cy.$id(edgeId).length && cy.$id(`fn-${callerIdx}`).length) {
                cy.add({
                    data: {
                        id: edgeId,
                        source: `fn-${callerIdx}`, target: groupId,
                        w: Math.min(3, 1 + count / 3), ec: style.color,
                        es: isUnk ? 'dotted' : 'solid', el: '',
                        tt: isUnk ? `→ unresolved (${count})` : `→ ${catName} (${count} call${count !== 1 ? 's' : ''})`,
                    }
                });
            }
        });

    } else {
        // ── Expand: remove group node, scatter individual func nodes around it ──
        l2State.expandedSysCategories.add(catName);

        const groupNode = cy.$id(groupId);
        const origin = groupNode.length ? { ...groupNode.position() } : { x: 0, y: 0 };

        // Remove collapsed group node + its edges
        groupNode.connectedEdges().remove();
        groupNode.remove();

        const fnMap = isUnk ? unkMap : (sysMap.get(catName) || new Map());
        const NODE_W = 160, NODE_H = 42, GAP = 10;
        const COLS = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(fnMap.size))));
        let fnIdx = 0;

        fnMap.forEach((callerSet, funcName) => {
            const fnId = isUnk ? `unkfn-${_hashId(funcName)}` : `sysfn-${catSlug}-${_hashId(funcName)}`;
            const col = fnIdx % COLS;
            const row = Math.floor(fnIdx / COLS);
            const nx = origin.x + (col - (COLS - 1) / 2) * (NODE_W + GAP);
            const ny = origin.y + (row + 1) * (NODE_H + GAP + 10);

            cy.add({
                data: {
                    id: fnId,
                    label: `${funcName}\n(${catName})`,
                    bg: style.bg, bc: style.color,
                    w: NODE_W, h: NODE_H, sh: 'roundrectangle', lvl: 2,
                    _t: 'sys_func', fn: funcName, syscat: catName,
                    tt: isUnk
                        ? `${funcName}\nUnresolved — not found in scanned files.`
                        : `${funcName}\n${catName}\n\nKnown system API.`,
                },
                position: { x: nx, y: ny }
            });

            const callers = isUnk ? callerSet : callerSet; // both are Sets
            callers.forEach(callerIdx => {
                const edgeId = isUnk
                    ? `unkfne-${_hashId(funcName)}-${callerIdx}`
                    : `sysfne-${catSlug}-${callerIdx}-${_hashId(funcName)}`;
                if (!cy.$id(edgeId).length && cy.$id(`fn-${callerIdx}`).length) {
                    cy.add({
                        data: {
                            id: edgeId,
                            source: `fn-${callerIdx}`, target: fnId,
                            w: isUnk ? 1.2 : 1.5, ec: style.color,
                            es: isUnk ? 'dotted' : 'solid', el: '',
                            tt: `${(funcs[callerIdx] || {}).label || callerIdx} → ${funcName}`,
                        }
                    });
                }
            });
            fnIdx++;
        });
    }
}

function openL2File(fileRel, opts = {}) {
    const { pushHistory = true, newSession = false, focusFunc = null } = opts;
    if (!fileRel) return;
    document.getElementById('cy')?.classList.add('l2-view');
    if (newSession) resetL2History();
    pushHistory && pushL2FileHistory(fileRel);
    syncBreadcrumbForFile(fileRel);
    renderL2Flowchart(fileRel, focusFunc);
    updateL2NavButtons();
}

function _safeId(s) {
    return String(s || '').replace(/[^a-zA-Z0-9_]+/g, '_').slice(0, 32) || 'x';
}

function _hashId(s) {
    let h = 0;
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h).toString(36);
}

function renderL2Flowchart(fileRel, focusFuncName = null) {
    if (!fileRel) return;
    showLoading(true, T('renderingCallFlow'));
    clearFuncOverlay();
    setL2ToolbarVisible(true);

    if (l2State.activeFile !== fileRel) {
        resetL2State(fileRel);
        l2State._expandInitialized = false;
    }

    const funcs = DATA.funcs_by_file[fileRel] || [];
    if (focusFuncName) {
        const idx = funcs.findIndex(f => f.label === focusFuncName);
        if (idx >= 0) l2State.activeFuncIdx = idx;
    }
    if (l2State.activeFuncIdx >= funcs.length) l2State.activeFuncIdx = 0;
    updateL2Toolbar(fileRel, { funcs: funcs.length, internalEdges: 0, extModules: 0, extFuncs: 0 });

    if (!funcs.length) {
        showFuncViewEmpty(fileRel);
        showLoading(false);
        return;
    }

    const callList = (DATA.func_calls_by_file && DATA.func_calls_by_file[fileRel]) || null;
    const hasCallList = Array.isArray(callList) && callList.length > 0;
    const legacyEdges = DATA.func_edges_by_file[fileRel] || [];
    const nameToFile = DATA.func_name_to_file || {};
    const nameToFiles = DATA.func_name_to_files || {};  // ambiguous: name → [file, ...]
    const fileToModule = DATA.file_to_module || {};
    const moduleColorMap = {};
    (DATA.modules || []).forEach(m => { moduleColorMap[m.id] = m.color; });

    const currentModule = fileToModule[fileRel] || resolveModuleForFile(fileRel) || '';

    const fidMap = new Map();
    funcs.forEach((f, i) => fidMap.set(f.label, i));

    const els = [];
    funcs.forEach((f, i) => {
        const isPublic = !!f.is_public;
        const isEfi = !!f.is_efiapi;
        const bg = isEfi ? '#3d2e00' : isPublic ? '#0b2745' : '#1e2433';
        const bc = isEfi ? '#fbbf24' : isPublic ? '#60a5fa' : '#94a3b8';
        const access = isPublic ? T('public') : T('static');
        els.push({
            data: {
                id: `fn-${i}`, label: f.label, bg, bc, w: 150, h: 38,
                sh: 'roundrectangle', lvl: 2, _t: 'func', fn: f.label, _f: fileRel,
                idx: i, access, tt: `${T('function')}: ${f.label}\n${access}${isEfi ? ' EFIAPI' : ''}`,
            }
        });
    });

    // extMap:  modName → Map<funcName, { files[], callers:Set }>
    // potMap:  key     → { callee, files[], callers:Set }   (ambiguous)
    // sysMap:  category → Map<funcName, callers:Set>        (known system/UEFI/C-runtime)
    // unkMap:  callee  → callers:Set                         (truly unresolvable)
    const extMap = new Map();
    const potMap = new Map();
    const sysMap = new Map();
    const unkMap = new Map();
    let internalEdgeCount = 0;

    const knownCats = DATA.func_known_categories || {};

    function addExt(modName, callee, targetFiles, callerIdx) {
        if (!extMap.has(modName)) extMap.set(modName, new Map());
        const fm = extMap.get(modName);
        if (!fm.has(callee)) fm.set(callee, { files: targetFiles, callers: new Set() });
        fm.get(callee).callers.add(callerIdx);
    }

    function addSys(category, callee, callerIdx) {
        if (!sysMap.has(category)) sysMap.set(category, new Map());
        const cm = sysMap.get(category);
        if (!cm.has(callee)) cm.set(callee, new Set());
        cm.get(callee).add(callerIdx);
    }

    if (hasCallList) {
        for (let i = 0; i < funcs.length; i++) {
            const calls = Array.isArray(callList[i]) ? callList[i] : [];
            const uniq = new Set(calls);
            for (const callee of uniq) {
                const calleeIdx = fidMap.get(callee);
                if (calleeIdx != null) {
                    if (calleeIdx === i) continue;
                    els.push({
                        data: {
                            id: `ie-${i}-${calleeIdx}`,
                            source: `fn-${i}`, target: `fn-${calleeIdx}`,
                            w: 1.6, ec: '#38bdf8', es: 'solid', el: '',
                            tt: `${funcs[i].label} → ${callee}`,
                        }
                    });
                    internalEdgeCount++;
                    continue;
                }
                if (!l2State.showExternalFuncs) continue;
                if (Object.prototype.hasOwnProperty.call(nameToFiles, callee)) {
                    const k = `pot:${callee}`;
                    if (!potMap.has(k)) potMap.set(k, { callee, files: nameToFiles[callee], callers: new Set() });
                    potMap.get(k).callers.add(i);
                    continue;
                }
                const targetFile = Object.prototype.hasOwnProperty.call(nameToFile, callee) ? nameToFile[callee] : null;
                if (!targetFile) {
                    const knownCat = knownCats[callee];
                    if (knownCat) {
                        addSys(knownCat, callee, i);
                    } else {
                        if (!unkMap.has(callee)) unkMap.set(callee, new Set());
                        unkMap.get(callee).add(i);
                    }
                    continue;
                }
                addExt(fileToModule[targetFile] || '_root', callee, [targetFile], i);
            }
        }
    } else {
        legacyEdges.forEach((e, idx) => {
            els.push({
                data: {
                    id: `le-${idx}`, source: `fn-${e.s}`, target: `fn-${e.t}`,
                    w: 1.4, ec: '#38bdf8', es: 'solid', el: '', tt: 'Call'
                }
            });
        });
        internalEdgeCount = legacyEdges.length;
    }

    l2State.externalModules = Array.from(extMap.keys()).sort();

    // First time entering this file → default expand all external modules
    if (!l2State._expandInitialized) {
        l2State.expandedModules = new Set(extMap.keys());
        l2State._expandInitialized = true;
    }

    // ─── External module groups ───────────────────────────────────────────────
    for (const [modName, fnMap] of extMap.entries()) {
        const modSlug = _safeId(modName) + '-' + _hashId(modName);
        const modId = `extmod-${modSlug}`;
        const funcCount = fnMap.size;
        const isExpanded = l2State.expandedModules.has(modName);
        const modColor = moduleColorMap[modName] || '#64748b';
        // Use a representative file path from this module for accurate distance
        const repFile = fnMap.values().next().value?.files?.[0] || modName;
        const distVal = _pathDist(fileRel, repFile);
        const ec = _distColor(distVal);
        const dLabel = _distLabel(distVal);

        if (!isExpanded) {
            // Unexpanded: show the big group node and aggregate edges
            els.push({
                data: {
                    id: modId, label: `${modName}\n${funcCount} funcs`,
                    bg: '#111827', bc: modColor, w: 170, h: 52, sh: 'roundrectangle', lvl: 2,
                    _t: 'ext_group', mod: modName,
                    tt: `${T('externalModule')}: ${modName}\n${T('topbarFunctions')}: ${funcCount}\n\n${T('clickToExpand')}`,
                }
            });

            const callerCounts = new Map();
            fnMap.forEach(info => info.callers.forEach(idx => callerCounts.set(idx, (callerCounts.get(idx) || 0) + 1)));
            for (const [callerIdx, count] of callerCounts.entries()) {
                els.push({
                    data: {
                        id: `exte-${modId}-${callerIdx}`,
                        source: `fn-${callerIdx}`, target: modId,
                        w: Math.min(4, 1 + count / 2), ec, es: 'dashed', el: 'ext',
                        tt: `${funcs[callerIdx].label} → ${modName} (${count})`,
                    }
                });
            }
        } else {
            // Expanded: do NOT show the group bounding box. Show individual external funcs.
            let extIdx = 0;
            fnMap.forEach((info, funcName) => {
                const fnId = `extfn-${modSlug}-${_hashId(funcName)}`;
                const tf = info.files[0] || null;
                const fnDist = _pathDist(fileRel, tf || modName);
                const fnEc = _distColor(fnDist); // use actual file path for accurate distance
                const fnDLabel = _distLabel(fnDist);
                els.push({
                    data: {
                        id: fnId,
                        label: `${funcName}\n(${modName})`,
                        bg: '#0f172a', bc: modColor,
                        w: 160, h: 42, sh: 'roundrectangle', lvl: 2,
                        _t: 'ext_func', fn: funcName, _f: tf, mod: modName, _drilled: false,
                        tt: `${funcName}\n${tf || T('fileUnknown')}\n${T('modalModule')}: ${modName}\n\n${T('doubleClickDrill')}\n${T('clickToCollapse')}`,
                    }
                });
                info.callers.forEach(callerIdx => {
                    els.push({
                        data: {
                            id: `extc-${modId}-${callerIdx}-${_hashId(funcName)}`,
                            source: `fn-${callerIdx}`, target: fnId,
                            w: 1.5, ec: fnEc, es: 'solid', el: 'ext',
                            tt: `${funcs[callerIdx].label} → ${funcName}`,
                        }
                    });
                });
                extIdx++;
            });
        }
    }

    // ─── Potential / ambiguous nodes ──────────────────────────────────────────
    for (const [, info] of potMap.entries()) {
        const { callee, files, callers } = info;
        const slug = _safeId(callee) + '-' + _hashId(callee);
        const potId = `pot-${slug}`;
        const firstMod = fileToModule[files[0]] || '';
        const dVal = files[0] ? _pathDist(fileRel, files[0]) : 99;
        const ec = files[0] ? _distColor(dVal) : '#a78bfa';
        els.push({
            data: {
                id: potId, label: `${callee}\n(${files.length} paths)`,
                bg: '#1a1040', bc: '#a78bfa', w: 160, h: 44, sh: 'roundrectangle', lvl: 2,
                _t: 'potential_func', fn: callee, _files: files,
                tt: `Ambiguous: ${callee}\n${T('tooltipPossibleFiles')}\n${files.join('\n')}`,
            }
        });
        callers.forEach(callerIdx => {
            els.push({
                data: {
                    id: `pote-${slug}-${callerIdx}`,
                    source: `fn-${callerIdx}`, target: potId,
                    w: 1.4, ec, es: 'dashed', el: 'ext',
                    tt: `${funcs[callerIdx].label} → ${callee} (ambiguous)`,
                }
            });
        });
    }

    // ─── Store sysMap on l2State so toggleSysGroup and expand/collapse all can access ─
    l2State._sysMap = sysMap;
    l2State._unkMap = unkMap;
    l2State._funcs = funcs;
    l2State.sysCategories = Array.from(sysMap.keys());
    l2State.hasUnresolved = unkMap.size > 0;

    // ─── Known System / UEFI / C-runtime category groups ─────────────────────
    const SYS_CAT_STYLE = {
        'UEFI Boot Services': { color: '#60a5fa', bg: '#0b1e38' },
        'UEFI Runtime Services': { color: '#818cf8', bg: '#110e2e' },
        'EDK2 MemoryLib': { color: '#34d399', bg: '#0a2218' },
        'EDK2 BaseLib': { color: '#00d4ff', bg: '#021a22' },
        'EDK2 DebugLib': { color: '#fbbf24', bg: '#1f1500' },
        'EDK2 PrintLib': { color: '#fbbf24', bg: '#1f1500' },
        'EDK2 MemAlloc': { color: '#34d399', bg: '#0a2218' },
        'PEI Services': { color: '#a78bfa', bg: '#180d2e' },
        'EDK2 HobLib': { color: '#a78bfa', bg: '#180d2e' },
        'EDK2 UefiLib': { color: '#60a5fa', bg: '#0b1e38' },
        'EDK2 DevicePath': { color: '#60a5fa', bg: '#0b1e38' },
        'C Runtime': { color: '#fb923c', bg: '#1e0e00' },
        'AMI SDK': { color: '#e879f9', bg: '#1e0820' },
        'CPU/IO Lib': { color: '#f87171', bg: '#200808' },
        'Status Code': { color: '#94a3b8', bg: '#0f1520' },
    };
    const SYS_DEFAULT = { color: '#64748b', bg: '#101820' };

    if (!l2State.expandedSysCategories) l2State.expandedSysCategories = new Set();

    for (const [catName, fnMap] of sysMap.entries()) {
        const catSlug = _safeId(catName) + '-' + _hashId(catName);
        const groupId = `syscat-${catSlug}`;
        const style = SYS_CAT_STYLE[catName] || SYS_DEFAULT;
        const funcCount = fnMap.size;
        const isExpanded = l2State.expandedSysCategories.has(catName);

        const allCallers = new Map();
        fnMap.forEach(callerSet => callerSet.forEach(idx => allCallers.set(idx, (allCallers.get(idx) || 0) + 1)));

        if (!isExpanded) {
            els.push({
                data: {
                    id: groupId,
                    label: `${catName}\n${funcCount} funcs`,
                    bg: style.bg, bc: style.color,
                    w: 170, h: 52, sh: 'roundrectangle', lvl: 2,
                    _t: 'sys_group', syscat: catName,
                    tt: `${catName}\n${funcCount} funcs\n\nClick to expand ↕`,
                }
            });
            allCallers.forEach((count, callerIdx) => {
                els.push({
                    data: {
                        id: `syse-${catSlug}-${callerIdx}`,
                        source: `fn-${callerIdx}`, target: groupId,
                        w: Math.min(3, 1 + count / 3), ec: style.color,
                        es: 'solid', el: '',
                        tt: `→ ${catName} (${count} call${count !== 1 ? 's' : ''})`,
                    }
                });
            });
        } else {
            fnMap.forEach((callerSet, funcName) => {
                const fnId = `sysfn-${catSlug}-${_hashId(funcName)}`;
                els.push({
                    data: {
                        id: fnId,
                        label: `${funcName}\n(${catName})`,
                        bg: style.bg, bc: style.color,
                        w: 160, h: 42, sh: 'roundrectangle', lvl: 2,
                        _t: 'sys_func', fn: funcName, syscat: catName,
                        tt: `${funcName}\nCategory: ${catName}\n\nKnown system API — no source in this codebase.`,
                    }
                });
                callerSet.forEach(callerIdx => {
                    els.push({
                        data: {
                            id: `sysfne-${catSlug}-${callerIdx}-${_hashId(funcName)}`,
                            source: `fn-${callerIdx}`, target: fnId,
                            w: 1.5, ec: style.color, es: 'solid', el: '',
                            tt: `${funcs[callerIdx].label} → ${funcName}`,
                        }
                    });
                });
            });
        }
    }

    // ─── Unresolved symbols group ─────────────────────────────────────────────
    if (unkMap.size > 0) {
        const unkId = 'extmod-unknown';
        const isExpanded = l2State.expandedSysCategories.has('__unk__');

        if (!isExpanded) {
            els.push({
                data: {
                    id: unkId,
                    label: `Unresolved\n${unkMap.size} funcs`,
                    bg: '#1a1218', bc: '#475569',
                    w: 160, h: 52, sh: 'roundrectangle', lvl: 2,
                    _t: 'sys_group', syscat: '__unk__',
                    tt: `Unresolved symbols (${unkMap.size})\nNot found in any scanned file.\n\nClick to expand ↕`,
                }
            });
            const callerSet = new Map();
            unkMap.forEach(callers => callers.forEach(idx => callerSet.set(idx, (callerSet.get(idx) || 0) + 1)));
            callerSet.forEach((count, callerIdx) => {
                els.push({
                    data: {
                        id: `unke-${callerIdx}`, source: `fn-${callerIdx}`, target: unkId,
                        w: Math.min(3, 1 + count / 3), ec: '#475569', es: 'dotted', el: '',
                        tt: `→ unresolved (${count})`,
                    }
                });
            });
        } else {
            unkMap.forEach((callers, funcName) => {
                const fnId = `unkfn-${_hashId(funcName)}`;
                els.push({
                    data: {
                        id: fnId,
                        label: `${funcName}\n(unresolved)`,
                        bg: '#1a1218', bc: '#475569',
                        w: 160, h: 42, sh: 'roundrectangle', lvl: 2,
                        _t: 'sys_func', fn: funcName, syscat: '__unk__',
                        tt: `${funcName}\nUnresolved — not found in scanned files.\nMay be a macro or compiler intrinsic.`,
                    }
                });
                callers.forEach(callerIdx => {
                    els.push({
                        data: {
                            id: `unkfne-${_hashId(funcName)}-${callerIdx}`,
                            source: `fn-${callerIdx}`, target: fnId,
                            w: 1.2, ec: '#475569', es: 'dotted', el: '',
                            tt: `${funcs[callerIdx].label} → ${funcName} (unresolved)`,
                        }
                    });
                });
            });
        }
    }

    l2State._animGen++;

    // ── Yield to browser so the loading spinner can paint before heavy work ──
    const _l2Token = ++_renderToken;
    setTimeout(() => {
        if (_renderToken !== _l2Token) return; // cancelled

        cy.elements().stop(true, false);
        l2State._prevNodeIds = new Set(cy.nodes().map(n => n.id()));

        cy.elements().remove();
        cy.add(els);
        applyCyFont(getSavedFont());
        applyExternalEdgeVisibility();

        const l2LayoutId = _PREFS.get('layoutL2');
        const l2Preset = LAYOUT_PRESETS.find(p => p.id === l2LayoutId);
        const canUseL2 = l2Preset && (!l2Preset.requires || _isLayoutAvailable(l2Preset.requires));
        const l2Config = canUseL2
            ? { ...l2Preset.config(), animate: false }
            : { name: 'dagre', rankDir: 'LR', animate: false, nodeSep: 26, rankSep: 80, padding: 50 };
        const lay = cy.layout(l2Config);
        _syncLayoutIndicator(canUseL2 ? l2LayoutId : 'dagre-lr');
        refreshLayoutSwitcher();  // update visible layout buttons for level 2
        lay.one('layoutstop', () => {
            if (_renderToken !== _l2Token) return;

            updateBreadcrumb();
            showLoading(false);
            updateL2Toolbar(fileRel, {
                funcs: funcs.length,
                internalEdges: internalEdgeCount,
                extModules: extMap.size,
                extFuncs: Array.from(extMap.values()).reduce((a, m) => a + m.size, 0),
                legacy: !hasCallList,
            });
            updateExternalToggle();
            updateExternalFuncsToggle();
            focusL2Func(fileRel, l2State.activeFuncIdx || 0, { center: false, openCodePanel: false });

            const savedVP = l2State.preserveViewport;
            const originPos = l2State.expandOriginPos;
            const prevIds = l2State._prevNodeIds || new Set();

            if (savedVP && originPos) {
                cy.viewport({ zoom: savedVP.zoom, pan: savedVP.pan });

                const newNodes = cy.nodes('[_t="ext_func"],[_t="sys_func"]').filter(n => !prevIds.has(n.id()));

                if (newNodes.length > 0) {
                    const finalPos = new Map();
                    newNodes.forEach(n => finalPos.set(n.id(), { ...n.position() }));
                    newNodes.forEach(n => n.position({ x: originPos.x, y: originPos.y }));

                    const myGen = l2State._animGen;
                    let idx = 0;
                    newNodes.forEach(n => {
                        const fp = finalPos.get(n.id());
                        const nid = n.id();
                        const delay = idx * 18;
                        setTimeout(() => {
                            if (l2State._animGen !== myGen) return;
                            if (!cy.hasElementWithId(nid)) return;
                            cy.$id(nid).animate({ position: fp }, { duration: 360, easing: 'ease-out-cubic' });
                        }, delay);
                        idx++;
                    });
                } else {
                    cy.animate({ fit: { eles: cy.elements(), padding: 50 }, duration: 400 });
                }
            } else if (savedVP && !focusFuncName) {
                // Exact restore — preserve camera for collapse / prev / next navigation
                cy.viewport({ zoom: savedVP.zoom, pan: savedVP.pan });
            } else if (focusFuncName) {
                const targetNode = cy.$id(`fn-${l2State.activeFuncIdx}`);
                if (targetNode && targetNode.length) {
                    setTimeout(() => {
                        highlightNode(targetNode);
                        cy.animate({
                            center: { eles: targetNode },
                            zoom: Math.max(cy.zoom(), 1.8),
                        }, {
                            duration: 700,
                            easing: 'ease-in-out-cubic',
                            complete: () => {
                                let count = 0;
                                const originalBc = targetNode.data('bc');
                                const flashInterval = setInterval(() => {
                                    count++;
                                    if (!cy.hasElementWithId(targetNode.id())) { clearInterval(flashInterval); return; }
                                    targetNode.style('border-color', count % 2 === 1 ? '#ffffff' : originalBc);
                                    targetNode.style('border-width', count % 2 === 1 ? 4 : 2);
                                    if (count >= 6) {
                                        clearInterval(flashInterval);
                                        targetNode.style('border-color', originalBc);
                                        targetNode.style('border-width', 2);
                                    }
                                }, 200);
                            }
                        });
                    }, 80);
                } else {
                    cy.animate({ fit: { eles: cy.elements(), padding: 50 }, duration: 400 });
                }
            } else {
                cy.animate({ fit: { eles: cy.elements(), padding: 50 }, duration: 400 });
            }

            l2State.preserveViewport = null;
            l2State.expandOriginPos = null;
            l2State._prevNodeIds = null;

            renderL2Legend();
        });
        lay.run();
    }, 0);
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

// ─── Lazy drill-down on ext_func / potential_func double-click ────────────────
// Expand → wraps callees in a compound box labeled with the source filename.
// Collapse → removes the box + all children (double-click again or click the box).
function drillDownExtFunc(node) {
    const d = node.data();
    const targetFile = d._f || null;
    const funcName = d.fn || null;
    if (!targetFile || !funcName) return;

    const nodeId = node.id();
    const groupId = `dgroup-${_hashId(nodeId)}`;

    // ── Collapse if already drilled ──────────────────────────────────────────
    if (d._drilled) {
        _collapseDrillGroup(node, groupId, funcName);
        return;
    }

    // ── Expand ───────────────────────────────────────────────────────────────
    const funcs = DATA.funcs_by_file[targetFile] || [];
    const callList = DATA.func_calls_by_file?.[targetFile] || null;
    const nameToFile = DATA.func_name_to_file || {};
    const nameToFiles = DATA.func_name_to_files || {};
    const fileToModule = DATA.file_to_module || {};

    const fidIdx = funcs.findIndex(f => f.label === funcName);
    if (fidIdx < 0 || !Array.isArray(callList)) {
        node.data('label', funcName + '\n(leaf)');
        return;
    }

    const callees = new Set(Array.isArray(callList[fidIdx]) ? callList[fidIdx] : []);
    if (callees.size === 0) {
        node.data('label', funcName + '\n(leaf)');
        return;
    }

    // Determine group border color from the source ext_func node
    const groupColor = node.data('bc') || '#64748b';
    const fileLabel = targetFile.split('/').pop();   // filename only

    // Create the compound parent group node FIRST (must exist before children)
    const groupNode = {
        data: {
            id: groupId,
            label: fileLabel,
            _t: 'drill_group',
            _srcNodeId: nodeId,
            bc: groupColor,
            bg: '#0b1929',
        }
    };

    const newEls = [groupNode];

    for (const callee of callees) {
        const childId = `drill-${_hashId(nodeId)}-${_hashId(callee)}`;
        if (cy.$id(childId).length) continue;   // guard against dupes

        let tf = null, modName = '', ec = '#64748b', bc = '#64748b';
        if (Object.prototype.hasOwnProperty.call(nameToFiles, callee)) {
            tf = nameToFiles[callee][0];
            modName = fileToModule[tf] || '';
            ec = bc = '#a78bfa';
        } else if (Object.prototype.hasOwnProperty.call(nameToFile, callee)) {
            tf = nameToFile[callee];
            modName = fileToModule[tf] || '';
            const dVal = _pathDist(targetFile, tf);
            ec = bc = _distColor(dVal);
        }

        newEls.push({
            data: {
                id: childId, label: callee,
                parent: groupId,              // ← inside compound box
                bg: '#0d1f33', bc: bc || '#64748b',
                w: 160, h: 30, sh: 'roundrectangle', lvl: 2,
                _t: 'drilled_func', fn: callee, _f: tf, mod: modName, _drilled: false,
                tt: tf ? `${callee}\n${tf}\n\nDouble-click to drill further` : `${callee}\n(no file found)`,
            }
        });
        // Edge: from the ext_func node to each child
        newEls.push({
            data: {
                id: `drille-${_hashId(nodeId)}-${_hashId(callee)}`,
                source: nodeId, target: childId,
                w: 1.4, ec: ec || '#64748b', es: 'solid', el: '',
                tt: `${funcName} → ${callee}`,
            }
        });
    }

    // Mark source node as drilled
    node.data('_drilled', true);
    node.data('label', funcName + ' ↳');
    node.style('border-style', 'double');

    cy.add(newEls);

    // Re-layout keeping viewport
    const vp = { pan: { ...cy.pan() }, zoom: cy.zoom() };
    cy.layout({
        name: 'dagre', rankDir: 'LR', animate: true, animationDuration: 300,
        nodeSep: 26, rankSep: 80, padding: 50,
    }).one('layoutstop', () => {
        cy.viewport(vp);   // stay where user was looking
    }).run();
}

/** Remove the drill group compound node + all its children, reset the source node. */
function _collapseDrillGroup(srcNode, groupId, funcName) {
    const group = cy.$id(groupId);
    if (group && group.length) {
        // Remove children (and their edges) then the group itself
        group.children().remove();
        group.remove();
    }
    // Reset source ext_func node
    srcNode.data('_drilled', false);
    srcNode.data('label', funcName || srcNode.data('fn'));
    srcNode.style('border-style', 'solid');

    const vp = { pan: { ...cy.pan() }, zoom: cy.zoom() };
    cy.layout({
        name: 'dagre', rankDir: 'LR', animate: true, animationDuration: 250,
        nodeSep: 26, rankSep: 80, padding: 50,
    }).one('layoutstop', () => {
        cy.viewport(vp);
    }).run();
}

// ─── Call Flow Legend ─────────────────────────────────────────────────────────
const L2_LEGEND_ITEMS = [
    { color: '#38bdf8', label: 'Internal / Same file', style: 'solid' },
    { color: '#10b981', label: '1 - 2 layers away', style: 'solid' },
    { color: '#f59e0b', label: '3 - 4 layers away', style: 'solid' },
    { color: '#f87171', label: '5+ layers away', style: 'solid' },
    { color: '#a78bfa', label: 'Ambiguous (multi)', style: 'dashed' },
    { color: '#64748b', label: 'System / unknown', style: 'dotted' },
];

function renderL2Legend() {
    const wrap = document.getElementById('graph-wrap');
    if (!wrap) return;
    clearL2Legend();

    function edgeLine(col, style) {
        const dash = style === 'dashed' ? '6,4' : style === 'dotted' ? '2,3' : 'none';
        const sd = dash !== 'none' ? `stroke-dasharray="${dash}"` : '';
        return `<svg width="32" height="10" style="vertical-align:middle;overflow:visible">
            <line x1="0" y1="5" x2="32" y2="5" stroke="${col}" stroke-width="2" ${sd}/>
            <polygon points="28,2 34,5 28,8" fill="${col}"/>
        </svg>`;
    }

    const leg = document.createElement('div');
    leg.id = 'l2-legend';
    leg.className = 'legend-collapsed';
    leg.innerHTML = `
<div class="legend-title" onclick="this.parentElement.classList.toggle('legend-collapsed')">
  <span>⬡</span> Call Flow Legend <span class="legend-toggle">▾</span>
</div>
<div class="legend-body">
  <div class="legend-section-label">Edge Distance</div>
  ${L2_LEGEND_ITEMS.map(e => `
  <div class="legend-row">
    ${edgeLine(e.color, e.style)}
    <span class="legend-label" style="color:${e.color}">${e.label}</span>
  </div>`).join('')}
  <div class="legend-section-label" style="margin-top:8px">Node Types</div>
  <div class="legend-row"><span class="legend-shape" style="color:#60a5fa">▣</span><span class="legend-label" style="color:#60a5fa">Current file func</span></div>
  <div class="legend-row"><span class="legend-shape" style="color:#64748b">▣</span><span class="legend-label" style="color:#64748b">External func</span></div>
  <div class="legend-row"><span class="legend-shape" style="color:#a78bfa">▣</span><span class="legend-label" style="color:#a78bfa">Ambiguous func</span></div>
  <div class="legend-row"><span class="legend-shape" style="color:#34d399">▣</span><span class="legend-label" style="color:#34d399">System API group</span></div>
  <div class="legend-row"><span class="legend-shape" style="color:#475569">▣</span><span class="legend-label" style="color:#475569">Unresolved symbols</span></div>
  <div class="legend-row"><span style="font-size:10px;margin-right:4px">↳</span><span class="legend-label" style="color:#94a3b8">Click to expand/collapse</span></div>
</div>`;
    wrap.appendChild(leg);

    // Also hide the dependency map legend while in L2
    const depLeg = document.getElementById('graph-legend');
    if (depLeg) depLeg.style.display = 'none';
}

function clearL2Legend() {
    const existing = document.getElementById('l2-legend');
    if (existing) existing.remove();
    // Restore dependency map legend
    const depLeg = document.getElementById('graph-legend');
    if (depLeg) depLeg.style.display = '';
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
        document.getElementById('graph-wrap').style.pointerEvents = 'none';
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', stopDrag);
        e.preventDefault();
    });
    function onDrag(e) {
        const delta = startX - e.clientX;
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
        if (cy) cy.resize();
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
        if (cy) cy.resize();
    }
}

// Continuously call cy.resize() during the code-panel CSS transition so the
// cytoscape canvas tracks the panel width frame-by-frame (no black artifacts).
let _panelRafId = null;
function _startPanelResizeLoop(durationMs) {
    if (!cy) return;
    if (_panelRafId) cancelAnimationFrame(_panelRafId);
    const end = performance.now() + durationMs + 32; // +32ms safety margin
    function tick() {
        cy.resize();
        if (performance.now() < end) _panelRafId = requestAnimationFrame(tick);
        else _panelRafId = null;
    }
    _panelRafId = requestAnimationFrame(tick);
}
const _PANEL_TRANSITION_MS = 200; // must match CSS transition: width .2s

function openCodePanel() {
    const panel = document.getElementById('code-panel');
    panel.classList.add('open');
    document.getElementById('code-toggle-btn').classList.add('active');
    codeState.isOpen = true;
    codeState.userClosed = false;
    const resizer = document.getElementById('resizer');
    if (resizer) resizer.style.display = 'flex';
    _startPanelResizeLoop(_PANEL_TRANSITION_MS);
}

function closeCodePanel() {
    const panel = document.getElementById('code-panel');
    panel.classList.remove('open');
    document.getElementById('code-toggle-btn').classList.remove('active');
    codeState.isOpen = false;
    codeState.userClosed = true;
    const resizer = document.getElementById('resizer');
    if (resizer) resizer.style.display = 'none';
    _startPanelResizeLoop(_PANEL_TRANSITION_MS);
}

// Load a file into the code panel; optionally jump to a function
async function loadFileInPanel(filePath, funcName) {
    if (!filePath) return;
    if (codeState.userClosed && !codeState.isOpen) return; // respect user close
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

    if (!codeState.jobId) {
        showCpError('No job ID — code preview only available via the local server (launch.bat).');
        return;
    }

    if (filePath === codeState.currentFile) {
        showCpLoading(false);
        if (funcName) jumpToFunc(funcName);
        // Ensure Structure button reflects the current file even on no-op reloads
        if (window.svUpdateStructureBtn) svUpdateStructureBtn(filePath, ext);
        return;
    }

    try {
        const url = `/file?job=${encodeURIComponent(codeState.jobId)}&path=${encodeURIComponent(filePath)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) { showCpError(T('fileLoadError', { error: data.error })); return; }
        codeState.currentFile = filePath;
        renderFileContent(data, ext, fname);
        showCpLoading(false);
        if (funcName) setTimeout(() => jumpToFunc(funcName), 80);
        // Show Structure button if file type is supported
        if (window.svUpdateStructureBtn) svUpdateStructureBtn(filePath, ext);
    } catch (e) {
        showCpError(T('fetchError', { error: e.message }));
    }
}

function extColor(ext) {
    const map = {
        // ── C / C++ / Systems ────────────────────────────────────────────────
        '.c': '#3b82f6', '.cpp': '#06b6d4', '.cc': '#06b6d4', '.cxx': '#06b6d4',
        '.h': '#8b5cf6', '.hpp': '#7c3aed', '.hxx': '#7c3aed', '.hh': '#7c3aed',
        '.rs': '#f97316',       // Rust — orange
        '.zig': '#f6a21e',      // Zig — amber
        // ── Assembly ─────────────────────────────────────────────────────────
        '.asm': '#f59e0b', '.s': '#f59e0b', '.S': '#f59e0b', '.nasm': '#f59e0b',
        // ── UEFI / EDK2 / AMI ────────────────────────────────────────────────
        '.inf': '#ffd700', '.dec': '#00d4ff', '.dsc': '#e2e8f0', '.fdf': '#c084fc',
        '.sdl': '#34d399', '.sd': '#10b981', '.cif': '#60a5fa', '.mak': '#94a3b8',
        '.vfr': '#f472b6', '.hfr': '#e940a0', '.uni': '#fb923c', '.asl': '#a78bfa',
        // ── Python ───────────────────────────────────────────────────────────
        '.py': '#4584c3', '.pyw': '#4584c3', '.pyx': '#3a74b3',
        '.ipynb': '#f59e0b',   // Jupyter — amber
        // ── JavaScript / TypeScript ──────────────────────────────────────────
        '.js': '#f0c040', '.mjs': '#f0c040', '.cjs': '#e8b830',
        '.jsx': '#61dafb',
        '.ts': '#3b8fd4', '.tsx': '#61dafb',
        // ── Web ──────────────────────────────────────────────────────────────
        '.html': '#e44d26', '.htm': '#e44d26', '.xhtml': '#e44d26',
        '.css': '#1572b6', '.scss': '#cd669a', '.sass': '#cd669a', '.less': '#1d365d',
        '.styl': '#ff6347',
        '.svg': '#ffb13b',
        '.graphql': '#e10098', '.gql': '#e10098',
        // ── Go ───────────────────────────────────────────────────────────────
        '.go': '#00c6db',
        // ── JVM / Mobile ─────────────────────────────────────────────────────
        '.java': '#ed8b00',    // Java — dark amber
        '.kt': '#7f52ff',      // Kotlin — purple
        '.kts': '#7f52ff',
        '.scala': '#dc322f',   // Scala — red
        '.groovy': '#629fcc',
        '.gradle': '#629fcc',
        '.dart': '#0175c2',    // Dart — blue
        '.swift': '#f05138',   // Swift — orange-red
        '.m': '#438eff',       // Objective-C — blue
        '.mm': '#438eff',
        // ── C# / .NET ────────────────────────────────────────────────────────
        '.cs': '#9b4993',      // C# — purple
        '.vb': '#004289',
        '.fs': '#378bba',      // F# — teal
        '.fsx': '#378bba',
        // ── Scripting ────────────────────────────────────────────────────────
        '.rb': '#cc342d',      // Ruby — red
        '.gemspec': '#cc342d', '.rake': '#cc342d',
        '.php': '#8892bf',     // PHP — indigo
        '.pl': '#39457e',      // Perl — dark blue
        '.pm': '#39457e',
        '.lua': '#000080',     // Lua — navy
        '.sh': '#4eaa25',      // Bash — green
        '.bash': '#4eaa25', '.zsh': '#4eaa25', '.fish': '#4eaa25',
        '.ps1': '#012456',     // PowerShell — dark blue
        '.psm1': '#012456',
        '.bat': '#c1c1c1', '.cmd': '#c1c1c1',
        '.r': '#276dc3',       // R — blue
        '.R': '#276dc3',
        '.jl': '#9558b2',      // Julia — purple
        '.ex': '#6e4a7e',      // Elixir — plum
        '.exs': '#6e4a7e',
        '.erl': '#a90533',     // Erlang — dark red
        '.hrl': '#a90533',
        '.clj': '#5881d8',     // Clojure — blue
        '.cljs': '#5881d8',
        '.hs': '#5e5086',      // Haskell — deep purple
        '.ml': '#ee6a1a',      // OCaml — orange
        '.mli': '#ee6a1a',
        '.elm': '#60b5cc',     // Elm — teal
        '.nim': '#ffe953',     // Nim — yellow
        '.cr': '#000000',      // Crystal — black
        '.d': '#ba595e',       // D — rose
        '.coffee': '#244776',
        '.awk': '#c0c0c0',
        '.tcl': '#e4cc98',
        '.pony': '#864029',
        '.v': '#5d87bf',       // Verilog
        '.vhd': '#048a81',     // VHDL
        // ── Data / Config ────────────────────────────────────────────────────
        '.json': '#cbcb41',    // yellow
        '.jsonc': '#cbcb41',
        '.yaml': '#cc3e44',    // red
        '.yml': '#cc3e44',
        '.toml': '#9c4221',    // burnt
        '.ini': '#94a3b8', '.cfg': '#94a3b8', '.conf': '#94a3b8',
        '.xml': '#f16529',     // orange (like HTML)
        '.plist': '#f16529',
        '.csv': '#6abd45',
        '.env': '#ecd53f',
        '.properties': '#b58900',
        // ── Infrastructure ───────────────────────────────────────────────────
        '.tf': '#7b42bc',      // Terraform — purple
        '.hcl': '#7b42bc',
        '.proto': '#4285f4',   // Protobuf — blue
        '.thrift': '#d74108',
        // ── Build ────────────────────────────────────────────────────────────
        '.cmake': '#064f8c',
        '.mk': '#94a3b8',
        '.bazel': '#76d275', '.bzl': '#76d275',
        // ── Docs ─────────────────────────────────────────────────────────────
        '.md': '#519aba',      // Markdown — steel blue
        '.mdx': '#519aba',
        '.rst': '#87ceeb',
        '.tex': '#3d6117',     // LaTeX — dark green
        '.txt': '#9aaab4',
        // ── Database ─────────────────────────────────────────────────────────
        '.sql': '#dad8d8',
        '.psql': '#336791', '.pgsql': '#336791',
        // ── Shader / GPU ─────────────────────────────────────────────────────
        '.glsl': '#5686a5', '.vert': '#5686a5', '.frag': '#5686a5',
        '.hlsl': '#aaaaff',
        '.wgsl': '#005580',
        // ── Misc ─────────────────────────────────────────────────────────────
        '.diff': '#41535b', '.patch': '#41535b',
        '.vim': '#019733',
        '.nix': '#7ebae4',
        '.sol': '#363636',
        '.lock': '#bbbbbb', '.log': '#999999',
    };
    return map[ext] || '#64748b';
}

// ─── File type → cytoscape node shape ────────────────────────────────────────
const FILE_TYPE_SHAPE = {
    // BIOS / C
    'c_source': { sh: 'ellipse', w: 160, h: 48 },
    'header': { sh: 'round-rectangle', w: 155, h: 44 },
    'assembly': { sh: 'triangle', w: 120, h: 56 },
    'module_inf': { sh: 'diamond', w: 190, h: 60 },
    'package_dec': { sh: 'hexagon', w: 190, h: 58 },
    'platform_dsc': { sh: 'star', w: 160, h: 60 },
    'flash_desc': { sh: 'vee', w: 160, h: 56 },
    'ami_sdl': { sh: 'octagon', w: 170, h: 56 },
    'ami_sd': { sh: 'concave-hexagon', w: 170, h: 54 },
    'ami_cif': { sh: 'barrel', w: 160, h: 56 },
    'makefile': { sh: 'tag', w: 150, h: 46 },
    'hii_vfr': { sh: 'round-tag', w: 165, h: 50 },
    'hii_hfr': { sh: 'round-tag', w: 165, h: 50 },
    'hii_form': { sh: 'round-tag', w: 165, h: 50 },
    'hii_string': { sh: 'round-rectangle', w: 155, h: 44 },
    'acpi_asl': { sh: 'pentagon', w: 160, h: 56 },
    // ── Python ───────────────────────────────────────────────────────────────
    // Rhomboid (parallelogram) — distinctly Python-y, like an ouroboros coil
    'py_source': { sh: 'rhomboid', w: 170, h: 52 },
    // ── JavaScript ───────────────────────────────────────────────────────────
    // Cut-rectangle — like a bracket { } in the corner
    'js_source': { sh: 'cut-rectangle', w: 165, h: 48 },
    // JSX — same family as JS, slightly wider for component name
    'jsx_source': { sh: 'cut-rectangle', w: 175, h: 50 },
    // ── TypeScript ────────────────────────────────────────────────────────────
    // Bottom-round-rectangle — "typed" = smoother than JS
    'ts_source': { sh: 'bottom-round-rectangle', w: 165, h: 50 },
    'tsx_source': { sh: 'bottom-round-rectangle', w: 175, h: 52 },
    // ── Go ────────────────────────────────────────────────────────────────────
    // Hexagon — clean, structured, like Go's package layout
    'go_source': { sh: 'hexagon', w: 175, h: 58 },
    // Fallbacks
    'other': { sh: 'round-rectangle', w: 155, h: 46 },
    'binary': { sh: 'round-rectangle', w: 150, h: 42 },
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
    // ── Universal import (Python / JS / TS / Go) ──────────────────────────
    'import': { color: '#10b981', style: 'dashed', label: 'Import' },
};

function fileNodeData(f, modColor) {
    const ft = f.file_type || 'other';
    const shape = FILE_TYPE_SHAPE[ft] || FILE_TYPE_SHAPE['other'];
    const baseColor = extColor(f.ext);

    // Build tooltip with BIOS metadata
    const bm = f.bios_meta || {};
    let ttLines = [`${f.path}`];
    ttLines.push(`${T('fileType')}: ${f.ext.toUpperCase() || 'FILE'}`);
    ttLines.push(`${T('fileSize')}: ${fmtSize(f.size)}`);
    if (f.func_count > 0) ttLines.push(`${T('funcsCount')}: ${f.func_count}`);
    if (bm.MODULE_TYPE || bm.module_type) ttLines.push(`${T('modType')}: ${bm.MODULE_TYPE || bm.module_type}`);
    if (bm.BASE_NAME || bm.base_name) ttLines.push(`${T('module')}: ${bm.BASE_NAME || bm.base_name}`);
    if (bm.ENTRY_POINT || bm.entry_point) ttLines.push(`${T('entryPoint')}: ${bm.ENTRY_POINT || bm.entry_point}`);
    if (bm.FILE_GUID || bm.file_guid) ttLines.push(`${T('fileGuid')}: ${bm.FILE_GUID || bm.file_guid}`);

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

// ─── Other/Binary file node (not deeply analysed) ────────────────────────────
function otherFileNodeData(f) {
    const ft = f.file_type || 'other';
    const shape = FILE_TYPE_SHAPE[ft] || FILE_TYPE_SHAPE['other'];
    const isBin = ft === 'binary';
    // Muted gray palette — distinct from analysed files
    const bg = isBin ? '#0c0c0e' : '#0d0f12';
    const bc = isBin ? '#374151' : '#4b5563';
    const extLbl = f.ext ? f.ext.toUpperCase() : 'FILE';
    const ttLines = [
        f.path,
        `Type: ${extLbl}${isBin ? ' (binary/obj — not analysed)' : ' (unrecognised — not analysed)'}`,
        `Size: ${fmtSize(f.size)}`,
    ];
    return {
        id: `f${f.id}`, label: f.label,
        bg, bc,
        lvl: 1, w: shape.w, h: shape.h, sh: shape.sh,
        ft,
        isExtra: true,   // used by CY_STYLE selector for dimmed rendering
        tt: ttLines.join('\n'),
        _t: 'file', _f: f,
    };
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

// ─── File Content Renderers ───────────────────────────────────────────────────
// Top-level dispatcher: routes to the right renderer by content_type
function renderFileContent(data, ext, fname) {
    const ct = data.content_type || 'text';
    if (ct === 'image') {
        renderImage(data);
    } else if (ct === 'binary') {
        renderHexDump(data);
    } else if (ct === 'pdf') {
        renderPDF(data);
    } else {
        // text — use lang_hint from server if available, else derive from ext
        renderCode(data.content || '', ext, fname, data.lang_hint);
    }
}

// Render image files (jpg, png, bmp, gif, ico …)
function renderImage(data) {
    const wrap = document.getElementById('cp-code-wrap');
    const src = `data:${data.mime};base64,${data.data}`;
    const kb = data.size ? (data.size / 1024).toFixed(1) + ' KB' : '';
    wrap.innerHTML = `
<div style="display:flex;flex-direction:column;align-items:center;padding:20px;gap:12px;min-height:200px">
  <img src="${src}" alt="${escapeHtml(data.path || '')}"
       style="max-width:100%;max-height:calc(100vh - 180px);border-radius:4px;
              border:1px solid var(--border);background:#111;object-fit:contain"
       onerror="this.parentElement.innerHTML='<div style=\\'color:var(--muted)\\'>Failed to render image</div>'"
  />
  <div style="font-size:11px;color:var(--muted);font-family:var(--code-font)">${escapeHtml(data.path || '')} &nbsp;·&nbsp; ${escapeHtml(kb)}</div>
</div>`;
    wrap.style.display = '';
    // Reset func-related state — no functions in images
    codeState.funcLineMap = {};
    codeState.funcList = [];
}

// Render PDF via embedded <object>
function renderPDF(data) {
    const wrap = document.getElementById('cp-code-wrap');
    const url = `data:application/pdf;base64,${data.data}`;
    const kb = data.size ? (data.size / 1024).toFixed(1) + ' KB' : '';
    wrap.innerHTML = `
<div style="display:flex;flex-direction:column;height:100%;padding:8px;gap:8px;box-sizing:border-box">
  <div style="font-size:11px;color:var(--muted);font-family:var(--code-font);flex-shrink:0">
    ${escapeHtml(data.path || '')} &nbsp;·&nbsp; ${escapeHtml(kb)}
    &nbsp;·&nbsp; <a href="${url}" download="${escapeHtml((data.path || '').split('/').pop())}"
       style="color:var(--accent);text-decoration:none">⬇ Download</a>
  </div>
  <object data="${url}" type="application/pdf"
          style="flex:1;width:100%;min-height:400px;border-radius:4px;border:1px solid var(--border);">
    <div style="padding:20px;color:var(--muted);text-align:center">
      <div style="font-size:32px;margin-bottom:12px">📄</div>
      <div>${T('browserCannotDisplayPdf')}</div>
      <div style="margin-top:8px"><a href="${url}" download style="color:var(--accent)">${T('downloadPdf')}</a></div>
    </div>
  </object>
</div>`;
    wrap.style.display = '';
    codeState.funcLineMap = {};
    codeState.funcList = [];
}

// Render binary files as a hex dump
function renderHexDump(data) {
    const wrap = document.getElementById('cp-code-wrap');
    const lines = (data.content || '').split('\n');
    const kb = data.size ? (data.size / 1024).toFixed(1) + ' KB' : '';
    const trunc = data.truncated
        ? `<div style="color:#f59e0b;font-size:11px;padding:8px 0">⚠ Showing first 8 KB of ${escapeHtml(kb)} file</div>`
        : '';
    const rows = lines.map(ln => {
        // offset  |  hex bytes  |  ascii
        const [addr, ...rest] = ln.split('  ');
        const body = rest.join('  ');
        const asciiIdx = body.lastIndexOf('|');
        const hexPart = asciiIdx > 0 ? body.slice(0, asciiIdx) : body;
        const asciiPart = asciiIdx > 0 ? body.slice(asciiIdx) : '';
        return `<div class="hex-row"><span class="hex-addr">${escapeHtml(addr || '')}</span>` +
            `<span class="hex-bytes">${escapeHtml(hexPart)}</span>` +
            `<span class="hex-ascii">${escapeHtml(asciiPart)}</span></div>`;
    }).join('');

    wrap.innerHTML = `
<div style="padding:12px">
  ${trunc}
  <pre class="hex-dump"><code>${rows}</code></pre>
</div>`;
    wrap.style.display = '';
    codeState.funcLineMap = {};
    codeState.funcList = [];
}

function renderCode(src, ext, fname, langHint) {
    const lines = src.split('\n');
    codeState.rawLines = lines;
    const hlExt = {
        // ── C / C++ / Systems ───────────────────────────────────────────────
        '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
        '.h': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp', '.hh': 'cpp',
        '.cs': 'csharp',
        '.vb': 'vbnet',
        '.rs': 'rust',
        '.zig': 'plaintext',
        '.d': 'd',
        // ── Assembly ─────────────────────────────────────────────────────────
        '.asm': 'x86asm', '.s': 'x86asm', '.S': 'x86asm', '.nasm': 'x86asm',
        '.mips': 'mipsasm',
        // ── UEFI / Firmware ──────────────────────────────────────────────────
        '.inf': 'ini', '.dec': 'ini', '.dsc': 'ini', '.fdf': 'ini',
        '.sdl': 'ini', '.sd': 'ini', '.cif': 'ini', '.mak': 'makefile',
        '.vfr': 'c', '.hfr': 'c', '.uni': 'plaintext', '.asl': 'c',
        // ── Python ───────────────────────────────────────────────────────────
        '.py': 'python', '.pyw': 'python', '.pyx': 'python',
        '.ipynb': 'json',
        // ── JavaScript / TypeScript ──────────────────────────────────────────
        '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
        '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
        '.graphql': 'graphql', '.gql': 'graphql',
        // ── Web ──────────────────────────────────────────────────────────────
        '.html': 'html', '.htm': 'html', '.xhtml': 'html',
        '.css': 'css', '.scss': 'scss', '.sass': 'scss',
        '.less': 'less', '.styl': 'stylus',
        '.svg': 'xml',
        // ── Go ───────────────────────────────────────────────────────────────
        '.go': 'go',
        // ── JVM / Mobile ─────────────────────────────────────────────────────
        '.java': 'java',
        '.kt': 'kotlin', '.kts': 'kotlin',
        '.scala': 'scala', '.sc': 'scala',
        '.groovy': 'groovy', '.gradle': 'groovy',
        '.dart': 'dart',
        '.swift': 'swift',
        '.m': 'objectivec', '.mm': 'objectivec',
        // ── Scripting ────────────────────────────────────────────────────────
        '.rb': 'ruby', '.gemspec': 'ruby', '.rake': 'ruby',
        '.php': 'php',
        '.pl': 'perl', '.pm': 'perl',
        '.lua': 'lua',
        '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.fish': 'bash',
        '.ksh': 'bash', '.tcsh': 'bash',
        '.ps1': 'powershell', '.psm1': 'powershell', '.psd1': 'powershell',
        '.bat': 'dos', '.cmd': 'dos',
        '.awk': 'awk',
        '.tcl': 'tcl',
        '.r': 'r', '.R': 'r',
        '.jl': 'julia',
        '.ex': 'elixir', '.exs': 'elixir',
        '.erl': 'erlang', '.hrl': 'erlang',
        '.clj': 'clojure', '.cljs': 'clojure', '.cljc': 'clojure',
        '.hs': 'haskell', '.lhs': 'haskell',
        '.ml': 'ocaml', '.mli': 'ocaml',
        '.fs': 'fsharp', '.fsi': 'fsharp', '.fsx': 'fsharp',
        '.elm': 'elm',
        '.nim': 'nim',
        '.cr': 'crystal',
        '.coffee': 'coffeescript',
        '.lisp': 'lisp', '.lsp': 'lisp', '.el': 'lisp',
        '.scm': 'scheme',
        '.pas': 'delphi', '.dpr': 'delphi',
        '.for': 'fortran', '.f90': 'fortran', '.f95': 'fortran', '.f': 'fortran',
        '.vala': 'vala',
        '.hx': 'haxe',
        '.awk': 'awk',
        // ── Hardware description ──────────────────────────────────────────────
        '.v': 'verilog', '.sv': 'verilog', '.svh': 'verilog',
        '.vhd': 'vhdl', '.vhdl': 'vhdl',
        // ── Data / Config ────────────────────────────────────────────────────
        '.json': 'json', '.jsonc': 'json', '.json5': 'json',
        '.yaml': 'yaml', '.yml': 'yaml',
        '.toml': 'ini',
        '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini',
        '.properties': 'properties', '.env': 'properties',
        '.xml': 'xml', '.xsl': 'xml', '.xsd': 'xml', '.plist': 'xml',
        '.csv': 'plaintext', '.tsv': 'plaintext',
        // ── Infrastructure / Cloud ───────────────────────────────────────────
        '.tf': 'hcl', '.hcl': 'hcl',
        '.proto': 'protobuf',
        '.thrift': 'thrift',
        // ── Build systems ────────────────────────────────────────────────────
        '.cmake': 'cmake',
        '.mk': 'makefile', '.mak': 'makefile',
        '.bazel': 'python', '.bzl': 'python',
        // ── Docs ─────────────────────────────────────────────────────────────
        '.md': 'markdown', '.mdx': 'markdown',
        '.rst': 'plaintext',
        '.txt': 'plaintext',
        '.tex': 'latex', '.ltx': 'latex',
        // ── Database ─────────────────────────────────────────────────────────
        '.sql': 'sql', '.psql': 'pgsql', '.pgsql': 'pgsql',
        '.ddl': 'sql', '.dml': 'sql',
        // ── Shader / GPU ─────────────────────────────────────────────────────
        '.glsl': 'glsl', '.vert': 'glsl', '.frag': 'glsl',
        '.hlsl': 'plaintext', '.wgsl': 'plaintext',
        // ── Misc ─────────────────────────────────────────────────────────────
        '.diff': 'diff', '.patch': 'diff',
        '.vim': 'vim',
        '.nix': 'nix',
        '.sol': 'javascript',
        '.feature': 'gherkin',
        '.http': 'http',
        '.log': 'plaintext', '.lock': 'plaintext',
        '.editorconfig': 'ini',
        '.gitignore': 'plaintext', '.gitattributes': 'plaintext',
        '.dockerignore': 'plaintext', '.npmignore': 'plaintext',
    };

    // Special filename → hljs lang (files with no extension or fixed names)
    const hlFilename = {
        'dockerfile': 'dockerfile', 'Dockerfile': 'dockerfile',
        'makefile': 'makefile', 'Makefile': 'makefile', 'GNUmakefile': 'makefile',
        'jenkinsfile': 'groovy', 'Jenkinsfile': 'groovy',
        'vagrantfile': 'ruby', 'Vagrantfile': 'ruby',
        'gemfile': 'ruby', 'Gemfile': 'ruby',
        'rakefile': 'ruby', 'Rakefile': 'ruby',
        'brewfile': 'ruby', 'Brewfile': 'ruby',
        'pipfile': 'ini', 'Pipfile': 'ini',
        '.bashrc': 'bash', '.zshrc': 'bash', '.bash_profile': 'bash',
        '.bash_aliases': 'bash', '.profile': 'bash',
        'nginx.conf': 'nginx', 'httpd.conf': 'apache',
        'CMakeLists.txt': 'cmake', 'cmakelists.txt': 'cmake',
    };
    // langHint from server takes priority (e.g. 'xml', 'python')
    const lang = (langHint && langHint !== 'plaintext') ? langHint
        : hlExt[ext] || hlFilename[fname] || 'plaintext';

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
    
    wrap.onclick = (e) => {
        let range;
        if (document.caretRangeFromPoint) {
            range = document.caretRangeFromPoint(e.clientX, e.clientY);
        } else if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
            if (pos) {
                range = document.createRange();
                range.setStart(pos.offsetNode, pos.offset);
            }
        }
        if (!range) return;
        const node = range.startContainer;
        if (node.nodeType !== 3) return; // Node.TEXT_NODE
        
        const offset = range.startOffset;
        const text = node.textContent;
        let start = offset, end = offset;
        
        // Adjust if clicking precisely around word boundaries
        if (start > 0 && start === text.length && /[A-Za-z0-9_$#]/.test(text[start - 1])) {
            start--; end--;
        } else if (start > 0 && !/[A-Za-z0-9_$#]/.test(text[start]) && /[A-Za-z0-9_$#]/.test(text[start - 1])) {
            start--; end--;
        }

        while (start > 0 && /[A-Za-z0-9_$#]/.test(text[start - 1])) start--;
        while (end < text.length && /[A-Za-z0-9_$#]/.test(text[end])) end++;
        
        if (start < end) {
            const word = text.slice(start, end);
            if (window.svHighlightBadgeByName) {
                svHighlightBadgeByName(word);
            }
        }
    };

    // ── Structure View hook ──────────────────────────────────────────────────
    if (window.svAfterRenderCode) svAfterRenderCode(src, ext, fname);
}

function jumpToFunc(funcName, targetCallText = null) {
    let lineIdx = codeState.funcLineMap[funcName];
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

    let highlightIdx = lineIdx;
    if (targetCallText && codeState.rawLines && codeState.rawLines.length) {
        let nextStart = codeState.rawLines.length;
        const sortedStarts = Object.values(codeState.funcLineMap).sort((a, b) => a - b);
        const myStartIdx = sortedStarts.indexOf(lineIdx);
        if (myStartIdx >= 0 && myStartIdx < sortedStarts.length - 1) {
            nextStart = sortedStarts[myStartIdx + 1];
        }

        const targetPattern = new RegExp('\\b' + escapeRe(targetCallText) + '\\b');
        for (let i = lineIdx; i < nextStart; i++) {
            if (targetPattern.test(codeState.rawLines[i])) {
                highlightIdx = i;
                break;
            }
        }
    }

    const lineEl = document.getElementById(`cl-${highlightIdx}`);
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
        badge.textContent = T('functionBadgeEFIAPI');
    } else if (fDef.is_public) {
        badge.className = 'cp-func-badge cp-func-public';
        badge.textContent = T('functionBadgePublic');
    } else {
        badge.className = 'cp-func-badge cp-func-private';
        badge.textContent = T('functionBadgeStatic');
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
    const savedFont = getSavedFont();

    // Create a dynamic style config that includes the real font string
    const dynamicStyle = withFont(CY_STYLE, savedFont);

    cy = cytoscape({
        container: document.getElementById('cy'),
        style: dynamicStyle,
        elements: [],
        minZoom: 0.04, maxZoom: 5,
        wheelSensitivity: 0.3,
        boxSelectionEnabled: false,
    });
    cy.on('tap', 'node', e => onNodeTap(e.target));
    cy.on('cxttap', 'node', e => onNodeRightClick(e, e.target));
    cy.on('mouseover', 'node', e => { showTooltip(e); highlightNode(e.target); });
    cy.on('mouseout', 'node', () => { scheduleHideTooltip(); });
    cy.on('tap', e => { if (e.target === cy) clearSelection(); });
    // Double-tap ext/drilled/potential func nodes → lazy drill-down (or collapse if drilled)
    cy.on('dbltap', 'node', e => {
        const d = e.target.data();
        if (d._t === 'drill_group') {
            // double-tap on group = collapse
            const srcNode = d._srcNodeId ? cy.$id(d._srcNodeId) : null;
            _collapseDrillGroup(srcNode || e.target, e.target.id(), srcNode?.data('fn') || '');
            return;
        }
        if (d._t === 'ext_func' || d._t === 'drilled_func' || d._t === 'potential_func') {
            drillDownExtFunc(e.target);
        }
    });
    document.getElementById('cy').addEventListener('contextmenu', e => e.preventDefault());
}

function clearSelection() {
    clearHighlight();
    document.querySelectorAll('.code-line.fn-highlight').forEach(el => el.classList.remove('fn-highlight'));
}

function highlightNode(node) {
    if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
    // Always clear previous hover highlight so rapid mouseover doesn't stack.
    clearHighlight();
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
            'font-weight': 'bold',
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
    // Other / binary file nodes — visibly distinct: dimmed + dashed border
    {
        selector: 'node[?isExtra]', style: {
            'opacity': 0.50,
            'border-style': 'dashed',
            'border-width': 1.5,
        }
    },
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
    // Drill-down group compound container
    {
        selector: 'node[_t="drill_group"]', style: {
            'background-color': '#0b1929',
            'background-opacity': 0.82,
            'border-width': 1.5,
            'border-color': 'data(bc)',
            'border-style': 'dashed',
            'label': 'data(label)',
            'text-valign': 'top',
            'text-halign': 'center',
            'text-margin-y': 4,
            'color': 'data(bc)',
            'font-size': 10,
            'font-weight': 'bold',
            'padding': '18px',
            'shape': 'roundrectangle',
            'compound-sizing-wrt-labels': 'include',
            'min-width': 60,
            'min-height': 40,
            'cursor': 'pointer',
        }
    },
];

// ─── File Type Filter ────────────────────────────────────────────────────────
const FT_GROUPS = [
    // ── BIOS / C ──────────────────────────────────────────────────────────────
    { key: 'c_source', label: '.c/.cpp', exts: ['.c', '.cpp', '.cc'], group: 'bios' },
    { key: 'header', label: '.h/.hpp', exts: ['.h', '.hpp'], group: 'bios' },
    { key: 'assembly', label: '.asm/.s', exts: ['.asm', '.s', '.S', '.nasm'], group: 'bios' },
    { key: 'module_inf', label: '.inf', exts: ['.inf'], group: 'bios' },
    { key: 'package_dec', label: '.dec', exts: ['.dec'], group: 'bios' },
    { key: 'platform_dsc', label: '.dsc', exts: ['.dsc'], group: 'bios' },
    { key: 'flash_desc', label: '.fdf', exts: ['.fdf'], group: 'bios' },
    { key: 'ami_sdl', label: '.sdl', exts: ['.sdl'], group: 'bios' },
    { key: 'ami_sd', label: '.sd', exts: ['.sd'], group: 'bios' },
    { key: 'ami_cif', label: '.cif', exts: ['.cif'], group: 'bios' },
    { key: 'makefile', label: '.mak', exts: ['.mak'], group: 'bios' },
    { key: 'hii_vfr', label: '.vfr', exts: ['.vfr'], group: 'bios' },
    { key: 'hii_hfr', label: '.hfr', exts: ['.hfr'], group: 'bios' },
    { key: 'hii_string', label: '.uni', exts: ['.uni'], group: 'bios' },
    { key: 'acpi_asl', label: '.asl', exts: ['.asl'], group: 'bios' },
    // ── Python ────────────────────────────────────────────────────────────────
    { key: 'py_source', label: '.py', exts: ['.py'], group: 'python' },
    // ── JavaScript / TypeScript ───────────────────────────────────────────────
    { key: 'js_source', label: '.js/.mjs', exts: ['.js', '.mjs', '.cjs'], group: 'js' },
    { key: 'jsx_source', label: '.jsx', exts: ['.jsx'], group: 'js' },
    { key: 'ts_source', label: '.ts', exts: ['.ts'], group: 'ts' },
    { key: 'tsx_source', label: '.tsx', exts: ['.tsx'], group: 'ts' },
    // ── Go ────────────────────────────────────────────────────────────────────
    { key: 'go_source', label: '.go', exts: ['.go'], group: 'go' },
    // ── Unanalysed ────────────────────────────────────────────────────────────
    { key: 'other', label: 'Other', exts: [], isExtra: true },
    { key: 'binary', label: 'Binary', exts: [], isExtra: true },
];
// Default: all analysed types on
const ftActiveFilter = new Set([
    'c_source', 'header', 'assembly', 'module_inf', 'package_dec',
    'platform_dsc', 'flash_desc', 'ami_sdl', 'ami_sd', 'ami_cif', 'makefile',
    'hii_vfr', 'hii_hfr', 'hii_string', 'acpi_asl',
    'py_source',
    'js_source', 'jsx_source', 'ts_source', 'tsx_source',
    'go_source',
]);

let ftFilterCollapsed = false;

function buildFtFilter(modId = null, subDir = null) {
    const wrap = document.getElementById('ft-filter');
    if (!wrap) return;
    if (state.level !== 1) {
        wrap.style.display = 'none';
        wrap.innerHTML = '';
        return;
    }
    if (!modId) {
        wrap.style.display = 'none';
        wrap.innerHTML = '';
        return;
    }

    // Detect which types actually exist in data
    const presentTypes = new Set();
    let otherTotal = 0;
    let binaryTotal = 0;

    function addFiles(files) {
        files.forEach(f => presentTypes.add(f.file_type || 'other'));
    }

    if (modId) {
        let files = DATA.files_by_module[modId] || [];
        let others = (DATA.other_files_by_module || {})[modId] || [];
        if (subDir) {
            const prefix = modId + '/' + subDir + '/';
            const exc = modId + '/' + subDir;
            files = files.filter(f => f.path.startsWith(prefix) || f.path === exc);
            others = others.filter(f => f.path.startsWith(prefix) || f.path === exc);
        }
        addFiles(files);
        addFiles(others);

        others.forEach(f => {
            if (f.file_type === 'other') otherTotal++;
            if (f.file_type === 'binary') binaryTotal++;
        });
    } else {
        Object.values(DATA.files_by_module).forEach(addFiles);
        const otherByMod = DATA.other_files_by_module || {};
        Object.values(otherByMod).forEach(addFiles);
        otherTotal = (DATA.stats?.other_files || 0) - (DATA.stats?.binary_files || 0);
        binaryTotal = DATA.stats?.binary_files || 0;
    }

    const groups = FT_GROUPS.filter(g => {
        if (g.isExtra) {
            if (g.key === 'other') return otherTotal > 0;
            if (g.key === 'binary') return binaryTotal > 0;
        }
        return presentTypes.has(g.key);
    });
    if (!groups.length) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = 'block';

    const analysed = groups.filter(g => !g.isExtra);
    const extra = groups.filter(g => g.isExtra);

    function chipHtml(g) {
        const col = g.isExtra ? '#4b5563' : extColor(g.exts[0] || '');
        const checked = ftActiveFilter.has(g.key) ? 'checked' : '';
        const count = g.key === 'other' ? otherTotal :
            g.key === 'binary' ? binaryTotal : '';
        const countBadge = count !== '' ? `<span class="ft-count">${count}</span>` : '';
        return `<label class="ft-chip${g.isExtra ? ' ft-chip-extra' : ''}" style="--ft-col:${col}">
  <input type="checkbox" data-ft="${g.key}" ${checked}>
  <span class="ft-dot" style="background:${col}"></span>
  <span>${g.label}</span>${countBadge}
</label>`;
    }

    const togglerStyle = ftFilterCollapsed ? 'transform: rotate(-90deg);' : '';
    const bodyDisplay = ftFilterCollapsed ? 'none' : 'flex';

    wrap.innerHTML =
        `<div class="ft-filter-title" id="ft-filter-title" style="cursor:pointer; display:flex; align-items:center; gap:6px;">
             <span class="legend-toggle" style="font-size:15px; transition:transform 0.2s; ${togglerStyle}">▾</span><span class="sidebar-title-text">${T('fileTypes')}</span>
             <span class="ft-actions">
               <button class="ft-action" data-ft-action="all" data-tip="${T('selectAll')}">${T('selectAll')}</button>
               <button class="ft-action" data-ft-action="none" data-tip="${T('selectNone')}">${T('selectNone')}</button>
             </span>
         </div>` +
        `<div id="ft-filter-body" style="display:${bodyDisplay}; flex-direction:column;">` +
        analysed.map(chipHtml).join('') +
        (extra.length
            ? '<div class="ft-separator" data-tip="Visible in graph but not deeply analysed for dependencies">— unanalysed —</div>' +
            extra.map(chipHtml).join('')
            : '') +
        `</div>`;

    const titleEl = wrap.querySelector('#ft-filter-title');
    const rerender = () => {
        if (state.level === 1 && state.activeModule) {
            const allFiles = DATA.files_by_module[state.activeModule] || [];
            const filtered = state.activeSubDir
                ? allFiles.filter(f => f.path.startsWith(state.activeModule + '/' + state.activeSubDir + '/'))
                : allFiles;
            renderFilesFlat(state.activeModule, filtered, state.activeSubDir);
        }
    };
    titleEl.addEventListener('click', () => {
        ftFilterCollapsed = !ftFilterCollapsed;
        const body = document.getElementById('ft-filter-body');
        const toggle = titleEl.querySelector('.legend-toggle');
        if (!ftFilterCollapsed) {
            body.style.display = 'flex';
            toggle.style.transform = '';
        } else {
            body.style.display = 'none';
            toggle.style.transform = 'rotate(-90deg)';
        }
    });

    wrap.querySelectorAll('.ft-action').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const action = btn.dataset.ftAction;
            if (action === 'all') {
                ftActiveFilter.clear();
                groups.forEach(g => ftActiveFilter.add(g.key));
                wrap.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = true; });
            } else if (action === 'none') {
                ftActiveFilter.clear();
                wrap.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
            }
            rerender();
        });
    });

    wrap.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', () => {
            if (cb.checked) ftActiveFilter.add(cb.dataset.ft);
            else ftActiveFilter.delete(cb.dataset.ft);
            // Re-render current view
            rerender();
        });
    });
}

// ─── Sidebar tree ─────────────────────────────────────────────────────────────
// Builds a tree in the sidebar: Module → sub-folders (expandable)
// Graph always shows file nodes only.

let fsCollapsed = false;

function collectAllFilesForTree() {
    const out = [];
    Object.values(DATA.files_by_module || {}).forEach(files => {
        files.forEach(f => out.push(f));
    });
    Object.values(DATA.other_files_by_module || {}).forEach(files => {
        files.forEach(f => out.push(f));
    });
    return out;
}

function buildFullFileTree(allFiles) {
    const root = { name: '', path: '', children: [], files: [] };
    const nodeMap = { '': root };
    function getNode(folderPath) {
        if (nodeMap[folderPath]) return nodeMap[folderPath];
        const parts = folderPath.split('/');
        const name = parts[parts.length - 1];
        const parent = parts.slice(0, -1).join('/');
        const parentNode = getNode(parent);
        const node = { name, path: folderPath, children: [], files: [] };
        parentNode.children.push(node);
        nodeMap[folderPath] = node;
        return node;
    }
    for (const f of allFiles) {
        if (!f || !f.path) continue;
        const lastSlash = f.path.lastIndexOf('/');
        const folder = lastSlash >= 0 ? f.path.slice(0, lastSlash) : '';
        getNode(folder).files.push(f);
    }
    function sortNode(n) {
        n.children.sort((a, b) => a.name.localeCompare(b.name));
        n.files.sort((a, b) => (a.label || a.path).localeCompare(b.label || b.path));
        n.children.forEach(sortNode);
    }
    sortNode(root);
    return root;
}

function buildFullTreeRows(container, node, depth) {
    node.children.forEach(child => {
        const modId = child.path.split('/')[0] || child.name;
        const isTop = depth === 0;
        const subPath = child.path.startsWith(modId + '/') ? child.path.slice(modId.length + 1) : '';
        const hasKids = child.children.length > 0 || child.files.length > 0;
        const row = document.createElement('div');
        row.className = `tree-row ${isTop ? 'mod-row' : 'subdir-row'}`;
        row.dataset.modId = modId;
        if (isTop) {
            row.id = `mi-${modId}`;
        } else {
            row.dataset.subPath = subPath;
        }

        const count = countFiles(child);
        if (isTop) {
            const mc = _srModuleColor(modId);
            row.innerHTML =
                `<span class="tree-arrow ${hasKids ? '' : 'leaf'}">▶</span>` +
                `<span class="mod-dot" style="background:${mc}"></span>` +
                `<span class="mod-name" data-tip="${child.path}">${child.name}</span>` +
                `<span class="mod-count" data-tip="${count} files">${count}</span>`;
        } else {
            const indent = 20 + depth * 14;
            row.innerHTML =
                `<span style="flex-shrink:0;width:${indent}px"></span>` +
                `<span class="tree-arrow ${hasKids ? '' : 'leaf'}">▶</span>` +
                `<span class="subdir-icon">📁</span>` +
                `<span class="subdir-name" data-tip="${child.path}">${child.name}</span>` +
                `<span class="subdir-count">${count}</span>`;
        }

        const children = document.createElement('div');
        children.className = 'tree-children';
        if (hasKids) {
            buildFullTreeRows(children, child, depth + 1);
        }

        row.addEventListener('click', e => {
            e.stopPropagation();
            const arrow = row.querySelector('.tree-arrow');
            const isOpen = children.classList.contains('open');
            if (hasKids) {
                children.classList.toggle('open', !isOpen);
                arrow?.classList.toggle('open', !isOpen);
            }
            if (isTop) {
                drillToModule(modId);
            } else {
                filterGraphToSubPath(modId, subPath);
                setSubdirActive(modId, subPath);
            }
        });

        container.appendChild(row);
        container.appendChild(children);
    });

    const fileIndent = 24 + depth * 14;
    node.files.forEach(f => {
        const row = document.createElement('div');
        row.className = 'tree-row file-row';
        row.dataset.path = f.path;
        const label = f.label || f.path;
        const ic = _extIcon(f.ext || '');
        row.innerHTML =
            `<span style="flex-shrink:0;width:${fileIndent}px"></span>` +
            `<span class="file-icon">${ic}</span>` +
            `<span class="file-name" data-tip="${f.path}">${label}</span>`;

        row.addEventListener('click', e => {
            e.stopPropagation();
            const ft = f.file_type || 'other';
            if (ft === 'other' && !ftActiveFilter.has('other')) ftActiveFilter.add('other');
            if (ft === 'binary' && !ftActiveFilter.has('binary')) ftActiveFilter.add('binary');
            const modId = resolveModuleForFile(f.path);
            if (modId) drillToModule(modId, { focusFile: f.path });
        });

        container.appendChild(row);
    });
}

function buildSidebar() {
    const list = document.getElementById('module-list');
    list.innerHTML = '';

    // Handle collapsible sidebar title
    const sidebarTitle = document.getElementById('sidebar-title');
    if (sidebarTitle) {
        const togglerStyle = fsCollapsed ? 'transform: rotate(-90deg);' : '';
        const titleKey = (state.level === 0) ? 'sidebarModules' : 'sidebarFileSystem';
        sidebarTitle.innerHTML = `<span class="legend-toggle" style="font-size:15px; transition:transform 0.2s; ${togglerStyle}">▾</span><span class="sidebar-title-text">${T(titleKey)}</span>`;
        sidebarTitle.style.cursor = 'pointer';
        sidebarTitle.style.display = 'flex';
        sidebarTitle.style.justifyContent = 'flex-start';
        sidebarTitle.style.alignItems = 'center';
        sidebarTitle.style.gap = '6px';

        // Remove old listener if exists, normally not needed if innerHTML clears, but here it's on the title itself
        const newTitle = sidebarTitle.cloneNode(true);
        sidebarTitle.parentNode.replaceChild(newTitle, sidebarTitle);

        newTitle.addEventListener('click', () => {
            fsCollapsed = !fsCollapsed;
            const toggle = newTitle.querySelector('.legend-toggle');
            if (!fsCollapsed) {
                list.style.display = '';
                toggle.style.transform = '';
            } else {
                list.style.display = 'none';
                toggle.style.transform = 'rotate(-90deg)';
            }
        });

        // Apply initial state
        if (fsCollapsed) {
            list.style.display = 'none';
        } else {
            list.style.display = '';
        }
    }

    const rootPath = (DATA.stats?.root || '').replace(/\\/g, '/').replace(/\/$/, '');
    const rootName = rootPath.split('/').filter(Boolean).pop() || 'VIZCODE';
    const allFiles = collectAllFilesForTree();
    const tree = buildFullFileTree(allFiles);
    const totalCount = countFiles(tree);
    const hasKids = tree.children.length > 0 || tree.files.length > 0;

    const rootRow = document.createElement('div');
    rootRow.className = 'tree-row root-row';
    rootRow.innerHTML =
        `<span class="tree-arrow ${hasKids ? 'open' : 'leaf'}">▶</span>` +
        `<span class="root-icon">🗂</span>` +
        `<span class="root-name" data-tip="${rootPath}">${rootName}</span>` +
        `<span class="root-count">${totalCount}</span>`;

    const rootChildren = document.createElement('div');
    rootChildren.className = 'tree-children open';
    if (hasKids) buildFullTreeRows(rootChildren, tree, 0);

    rootRow.addEventListener('click', () => {
        const arrow = rootRow.querySelector('.tree-arrow');
        const isOpen = rootChildren.classList.contains('open');
        if (hasKids) {
            rootChildren.classList.toggle('open', !isOpen);
            arrow?.classList.toggle('open', !isOpen);
        }
    });

    list.appendChild(rootRow);
    list.appendChild(rootChildren);
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
            `<span class="subdir-name" data-tip="${modId}/${child.path}">${child.name}</span>` +
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
    pushL1History(modId, subPath);
    setL1ToolbarVisible(true);
    updateL1Toolbar(`${modId} / ${subPath}`, filtered.length);
    renderFilesFlat(modId, filtered, subPath);
    updateBreadcrumb();
    buildFtFilter(modId, subPath);
}

// ─── L0: Module View ──────────────────────────────────────────────────────────
function loadLevel0() {
    showLoading(true, T('renderingModules'));
    hideFuncView();
    state.level = 0; state.activeModule = null; state.activeFile = null; state.activeSubDir = null;
    buildFtFilter(null, null);
    updateBreadcrumb(); setSidebarActive(null);
    setL1ToolbarVisible(false);
    // Reset L1 nav history when returning to module overview
    depMapState.navHistory = [];
    depMapState.navHistoryIdx = -1;
    updateL1NavButtons();

    const els = [];
    const hasRootModule = (DATA.modules || []).some(m => m.id === '_root');
    const rootOther = (DATA.other_files_by_module || {})['_root'] || [];
    const rootFiles = (DATA.files_by_module || {})['_root'] || [];
    if (!hasRootModule && (rootOther.length || rootFiles.length)) {
        const rootPath = (DATA.stats?.root || '').replace(/\\/g, '/').replace(/\/$/, '');
        const rootName = rootPath.split('/').filter(Boolean).pop() || '_root';
        const rootFuncCount = rootFiles.reduce((s, f) => s + (f.func_count || 0), 0);
        const rootColor = '#94a3b8';
        const totalCount = rootFiles.length + rootOther.length;
        const ttExtra = rootOther.length ? `\n${T('otherBinary', { count: rootOther.length })}` : '';
        const rootMod = {
            id: '_root',
            label: rootName,
            color: rootColor,
            file_count: rootFiles.length,
            func_count: rootFuncCount,
            other_count: rootOther.length,
        };
        els.push({
            data: {
                id: rootMod.id,
                label: `${rootName}\n${totalCount} files`,
                bg: rootColor + '18', bc: rootColor, lvl: 0,
                w: 190, h: 68, sh: 'roundrectangle',
                tt: `${rootName}\nAnalysed: ${rootFiles.length} | Funcs: ${rootFuncCount}${ttExtra}`,
                _t: 'module', _m: rootMod,
            }
        });
    }
    DATA.modules.forEach(m => {
        const otherCount = m.other_count || 0;
        const totalLabel = `${m.id}\n${m.file_count} files`;
        const ttExtra = otherCount ? `\n${T('otherBinary', { count: otherCount })}` : '';
        els.push({
            data: {
                id: m.id, label: totalLabel,
                bg: m.color + '18', bc: m.color, lvl: 0,
                w: 190, h: 68, sh: 'roundrectangle',
                tt: `${m.id}\nAnalysed: ${m.file_count} | Funcs: ${m.func_count}${ttExtra}`,
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
    applyCyFont(getSavedFont());

    const l0LayoutId = _PREFS.get('layoutL0');
    const l0Preset = LAYOUT_PRESETS.find(p => p.id === l0LayoutId);
    _syncLayoutIndicator(l0LayoutId);
    refreshLayoutSwitcher();
    // If the saved preset needs an unloaded CDN extension, fall back to cose
    const l0Config = (l0Preset && (!l0Preset.requires || _isLayoutAvailable(l0Preset.requires)))
        ? { ...l0Preset.config(), animate: false }
        : { name: 'cose', animate: false, randomize: true, nodeRepulsion: 10000, idealEdgeLength: 200, nodeOverlap: 20, padding: 60 };
    if (!l0Preset || (l0Preset.requires && !_isLayoutAvailable(l0Preset.requires))) {
        _syncLayoutIndicator('cose'); // fallback indicator
    }
    const lay = cy.layout(l0Config);
    lay.one('layoutstop', () => showLoading(false));
    lay.run();
}

// ─── L1: Module → show ALL files flat (no folder nodes ever) ─────────────────
function drillToModule(modId, opts) {
    // opts: { focusFile?: string, closeExt?: bool }
    if (window._sv && window._sv.active && window.svHideSvView) window.svHideSvView();
    if (window.svHideStructureBtn) svHideStructureBtn();

    if (state.level === 0) state.history.push({ level: 0 });
    state.level = 1; state.activeModule = modId; state.activeSubDir = null;
    showLoading(true, T('loadingModule', { module: modId }));
    hideFuncView(); setSidebarActive(modId);
    // Clear sub-dir active highlight
    document.querySelectorAll('.subdir-row').forEach(el => el.classList.remove('active'));

    // Reset external-files state for new module
    if (depMapState.currentModId !== modId) {
        depMapState.expandedExtModules = new Set();
        depMapState.currentModId = modId;
    }
    if (opts?.closeExt) {
        depMapState.showExternalFiles = false;
    }
    if (opts?.focusFile) {
        depMapState.pendingFocusFile = opts.focusFile;
    }
    setL1ToolbarVisible(true);
    updateDepMapExtToggle();
    const allFiles = DATA.files_by_module[modId] || [];
    const allOther = (DATA.other_files_by_module || {})[modId] || [];
    if (modId === '_root' && allOther.length && allFiles.length === 0) {
        ftActiveFilter.add('other');
        if (allOther.some(f => f.file_type === 'binary')) ftActiveFilter.add('binary');
    }

    // If a focusFile is given, zoom into its parent subfolder instead of showing all files
    if (opts?.focusFile) {
        const focusPath = opts.focusFile;                // e.g. "AmiCompatibilityPkg/Include/Setup.h"
        const modPrefix = modId + '/';
        const relPath = focusPath.startsWith(modPrefix) ? focusPath.slice(modPrefix.length) : focusPath;
        const parts = relPath.split('/');
        if (parts.length >= 2) {
            // File is in a subfolder — show that subfolder
            const subPath = parts.slice(0, -1).join('/');  // e.g. "Include"
            const prefix = modId + '/' + subPath + '/';
            const filtered = allFiles.filter(f =>
                f.path.startsWith(prefix) || f.path === modId + '/' + subPath
            );

            pushL1History(modId, subPath);
            updateL1Toolbar(`${modId} / ${subPath}`, filtered.length);

            state.activeSubDir = subPath;
            setSubdirActive(modId, subPath);

            // Expand the sidebar tree so the active subdir row is visible
            const modRow = document.getElementById(`mi-${modId}`);
            if (modRow) {
                const children = modRow.nextElementSibling;
                if (children && !children.classList.contains('open')) {
                    children.classList.add('open');
                    modRow.querySelector('.tree-arrow')?.classList.add('open');
                }
            }

            renderFilesFlat(modId, filtered, subPath);
            updateBreadcrumb();
            buildFtFilter(modId, subPath);
            return;
        }
    }

    pushL1History(modId, null);
    updateL1Toolbar(modId, allFiles.length);
    renderFilesFlat(modId, allFiles);
    buildFtFilter(modId, null);
}

// Render flat file nodes in graph — the only graph view for L1
function renderFilesFlat(modId, files, subPath) {
    // Apply File Type Filter (for fully-analysed files)
    const visible = files.filter(f => ftActiveFilter.has(f.file_type || 'other'));

    // Optionally add other/binary files
    const showOther = ftActiveFilter.has('other');
    const showBinary = ftActiveFilter.has('binary');
    let otherFiles = [];
    if (showOther || showBinary) {
        const allOther = (DATA.other_files_by_module || {})[modId] || [];
        // Filter by subpath if we're in a sub-directory view
        const pathFiltered = subPath
            ? allOther.filter(f => f.path.startsWith(modId + '/' + subPath + '/') || f.path === modId + '/' + subPath)
            : allOther;
        otherFiles = pathFiltered.filter(f =>
            (f.file_type === 'other' && showOther) ||
            (f.file_type === 'binary' && showBinary)
        );
    }

    const capped = visible.slice(0, 250);
    const cappedOther = otherFiles.slice(0, Math.max(0, 400 - capped.length));

    const visIds = new Set(capped.map(f => `f${f.id}`));
    const allEdges = DATA.file_edges_by_module[modId] || [];
    const edges = allEdges
        .filter(e => visIds.has(`f${e.s}`) && visIds.has(`f${e.t}`)).slice(0, 600);

    const els = [];
    capped.forEach(f => {
        els.push({ data: fileNodeData(f) });
    });
    cappedOther.forEach(f => {
        els.push({ data: otherFileNodeData(f) });
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

    // ─── External modules (if toggle is ON) ──────────────────────────────────
    const moduleColorMap = {};
    (DATA.modules || []).forEach(m => { moduleColorMap[m.id] = m.color; });

    if (depMapState.showExternalFiles) {
        const extEdges = allEdges.filter(e => visIds.has(`f${e.s}`) && !visIds.has(`f${e.t}`));

        // Group target files by their module
        // extModMap: extModId → Map<fileId, { file, edgeType, sources:Set<srcFileId> }>
        const extModMap = new Map();
        extEdges.forEach(e => {
            const targetMod = _fileIdToModule[e.t] || '_external';
            if (!extModMap.has(targetMod)) extModMap.set(targetMod, new Map());
            const modFiles = extModMap.get(targetMod);
            if (!modFiles.has(e.t)) {
                modFiles.set(e.t, {
                    file: _fileIdToFile[e.t] || null,
                    edgeType: e.type || 'include',
                    sources: new Set(),
                });
            }
            modFiles.get(e.t).sources.add(e.s);
        });

        depMapState.currentExtModules = Array.from(extModMap.keys());

        let extEdgeSeq = 0;
        for (const [extModId, fileMap] of extModMap.entries()) {
            const modSlug = _safeId(extModId) + '-' + _hashId(extModId);
            const groupId = `depext-${modSlug}`;
            const fileCount = fileMap.size;
            const isExpanded = depMapState.expandedExtModules.has(extModId);
            const modColor = moduleColorMap[extModId] || '#64748b';

            if (!isExpanded) {
                // ── Collapsed: one group node per external module ─────────────
                els.push({
                    data: {
                        id: groupId,
                        label: `${extModId}\n${fileCount} file${fileCount !== 1 ? 's' : ''}`,
                        bg: '#111827', bc: modColor, w: 170, h: 52,
                        sh: 'roundrectangle', lvl: 1,
                        _t: 'dep_ext_group', mod: extModId,
                        tt: `External Module: ${extModId}\nReferenced files: ${fileCount}\nClick to expand`,
                    }
                });
                // Aggregate edges from each internal source to the group node
                const sourceCounts = new Map();
                fileMap.forEach(info => {
                    info.sources.forEach(srcId => {
                        sourceCounts.set(srcId, (sourceCounts.get(srcId) || 0) + 1);
                    });
                });
                for (const [srcId, count] of sourceCounts.entries()) {
                    els.push({
                        data: {
                            id: `depexte-${modSlug}-${srcId}`,
                            source: `f${srcId}`, target: groupId,
                            w: Math.min(3.5, 1 + count * 0.4),
                            ec: modColor, es: 'dashed', el: 'Ext',
                            tt: `→ ${extModId} (${count} ref${count !== 1 ? 's' : ''})`,
                        }
                    });
                    extEdgeSeq++;
                }
            } else {
                // ── Expanded: individual file nodes for this external module ──
                fileMap.forEach((info, fileId) => {
                    const f = info.file;
                    if (!f) return;
                    const fnId = `depextf-${modSlug}-${fileId}`;
                    const ft = f.file_type || 'other';
                    const shape = FILE_TYPE_SHAPE[ft] || FILE_TYPE_SHAPE['other'];
                    const fileColor = extColor(f.ext || '');   // 依副檔名決定顏色，與內部節點一致

                    // Extract parent folder for display below filename
                    const pathParts = f.path.split('/');
                    const folderName = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : '';
                    const nodeLabel = folderName ? `${f.label}\n(${folderName})` : f.label;
                    // Adjust node height slightly to accommodate the second line
                    const nodeH = folderName ? Math.max(shape.h, 54) : shape.h;

                    els.push({
                        data: {
                            id: fnId, label: nodeLabel,
                            bg: '#0a1520', bc: fileColor,
                            w: shape.w, h: nodeH, sh: shape.sh, lvl: 1,
                            _t: 'dep_ext_file', _f: f, mod: extModId,
                            tt: `${f.path}\nModule: ${extModId}\nType: ${ft}\n(External file)`,
                        }
                    });
                    const es = edgeTypeStyle(info.edgeType);
                    info.sources.forEach(srcId => {
                        els.push({
                            data: {
                                id: `depextfe-${modSlug}-${srcId}-${fileId}`,
                                source: `f${srcId}`, target: fnId,
                                w: 1.4, ec: es.color, es: es.style, el: es.label,
                                tt: `→ ${f.label} (${info.edgeType})`,
                            }
                        });
                        extEdgeSeq++;
                    });
                });
            }
        }

        // Show/hide Expand All / Collapse All buttons based on whether ext nodes exist
        const hasExt = extModMap.size > 0;
        const expandBtn = document.getElementById('l1-expand-all-ext');
        const collapseBtn = document.getElementById('l1-collapse-all-ext');
        if (expandBtn) expandBtn.style.display = hasExt ? '' : 'none';
        if (collapseBtn) collapseBtn.style.display = hasExt ? '' : 'none';

        // Update stats to reflect external count
        const statsEl = document.getElementById('l1-stats');
        if (statsEl) {
            const parts = [`${capped.length} files`];
            if (hasExt) parts.push(`${extModMap.size} ext module${extModMap.size !== 1 ? 's' : ''}`);
            statsEl.textContent = parts.join(' | ');
        }
    } else {
        // External off — hide expand/collapse buttons
        const expandBtn = document.getElementById('l1-expand-all-ext');
        const collapseBtn = document.getElementById('l1-collapse-all-ext');
        if (expandBtn) expandBtn.style.display = 'none';
        if (collapseBtn) collapseBtn.style.display = 'none';
        depMapState.currentExtModules = [];

        // Update stats (files only)
        const statsEl = document.getElementById('l1-stats');
        if (statsEl) statsEl.textContent = `${capped.length} files`;
    }

    // Invalidate any in-flight expand animations from previous render
    depMapState._animGen++;

    // ── Yield to browser so the loading spinner can paint before heavy work ──
    const _l1Token = ++_renderToken;
    setTimeout(() => {
        if (_renderToken !== _l1Token) return; // cancelled

        // Stop any running animations to avoid corrupting cytoscape state
        cy.elements().stop(true, false);   // jumpToEnd=false so we don't flash final positions

        // Snapshot existing node IDs so expand animation knows which are truly new
        const prevNodeIds = new Set(cy.nodes().map(n => n.id()));
        depMapState._prevNodeIds = prevNodeIds;

        cy.elements().remove();
        cy.add(els);
        applyCyFont(getSavedFont());

        // ── Two-pass layout ──────────────────────────────────────────────────────
        // Pass 1: dagre on ONLY the analysed nodes (no extra nodes yet positioned)
        // Pass 2: grid-wrap the extra nodes below the analysed bounding box

        const mainEls = cy.elements().filter(el => !el.data('isExtra'));
        const extraEls = cy.nodes().filter(n => n.data('isExtra'));

        if (extraEls.length === 0) {
            // Simple path: no extras, just run the user's preferred layout
            const l1LayoutId = _PREFS.get('layoutL1');
            const l1Preset = LAYOUT_PRESETS.find(p => p.id === l1LayoutId);
            const canUse = l1Preset && (!l1Preset.requires || _isLayoutAvailable(l1Preset.requires));
            const effectiveId = canUse ? l1LayoutId : 'dagre-lr';
            const l1Config = canUse
                ? { ...l1Preset.config(), animate: false }
                : { name: 'dagre', rankDir: 'LR', animate: false, nodeSep: 30, rankSep: 90, padding: 40 };
            _syncLayoutIndicator(effectiveId);
            refreshLayoutSwitcher();
            const lay = cy.layout(l1Config);
            lay.one('layoutstop', () => {
                if (_renderToken !== _l1Token) return;
                updateBreadcrumb();
                showLoading(false);
                _postLayoutL1();
            });
            lay.run();
            return;
        }

        // Hide extra nodes while main layout runs so they don't affect positions
        extraEls.style('display', 'none');

        // Use user's preferred layout for the main nodes (extras get grid-placed below)
        const l1LayoutId2 = _PREFS.get('layoutL1');
        const l1Preset2 = LAYOUT_PRESETS.find(p => p.id === l1LayoutId2);
        const canUse2 = l1Preset2 && (!l1Preset2.requires || _isLayoutAvailable(l1Preset2.requires));
        const l1Config2 = canUse2
            ? { ...l1Preset2.config(), animate: false }
            : { name: 'dagre', rankDir: 'LR', animate: false, nodeSep: 30, rankSep: 90, padding: 40 };
        _syncLayoutIndicator(canUse2 ? l1LayoutId2 : 'dagre-lr');

        const layMain = cy.layout(l1Config2);

        layMain.one('layoutstop', () => {
            if (_renderToken !== _l1Token) return;

            // Restore extra nodes
            extraEls.style('display', 'element');

            // Compute bounding box of main graph
            const bb = mainEls.length ? mainEls.boundingBox() : { x1: 40, y1: 40, x2: 400, y2: 200 };
            const graphWidth = Math.max(bb.x2 - bb.x1, 600);

            // Grid parameters
            const NODE_W = 155;   // matches FILE_TYPE_SHAPE 'other'/'binary' width
            const NODE_H = 42;
            const H_GAP = 14;
            const V_GAP = 10;
            const COLS = Math.max(1, Math.floor(graphWidth / (NODE_W + H_GAP)));

            const startX = bb.x1;
            const startY = bb.y2 + 60;   // 60px below main graph

            extraEls.forEach((n, idx) => {
                const col = idx % COLS;
                const row = Math.floor(idx / COLS);
                n.position({
                    x: startX + col * (NODE_W + H_GAP) + NODE_W / 2,
                    y: startY + row * (NODE_H + V_GAP) + NODE_H / 2,
                });
            });

            updateBreadcrumb();
            showLoading(false);
            _postLayoutL1();
        });

        layMain.run();
    }, 0);
}

// ── Post-layout handler: handles expand animation OR focus fly-in ──────────────
function _postLayoutL1() {
    // Refresh legend with only the edge types / node shapes visible in this view
    refreshLegend();

    const savedVP = depMapState.preserveViewport;
    const originPos = depMapState.expandOriginPos;
    const focusPath = depMapState.pendingFocusFile;
    const prevIds = depMapState._prevNodeIds || new Set();

    // Clear all state immediately to prevent re-entrancy issues
    depMapState.preserveViewport = null;
    depMapState.expandOriginPos = null;
    depMapState.pendingFocusFile = null;
    depMapState._prevNodeIds = null;

    // ── Case 1: Expand animation (group node was just expanded) ──────────────
    if (savedVP && originPos) {
        // Restore viewport so camera stays put
        cy.viewport({ zoom: savedVP.zoom, pan: savedVP.pan });

        // Only animate nodes that are genuinely new (weren't in graph before)
        const newNodes = cy.nodes('[_t="dep_ext_file"]').filter(n => !prevIds.has(n.id()));

        if (newNodes.length > 0) {
            // Record final dagre positions, then teleport to origin
            const finalPos = new Map();
            newNodes.forEach(n => finalPos.set(n.id(), { ...n.position() }));
            newNodes.forEach(n => n.position({ x: originPos.x, y: originPos.y }));

            const myGen = depMapState._animGen;   // capture generation at animation start

            // Stagger the fly-out
            let idx = 0;
            newNodes.forEach(n => {
                const fp = finalPos.get(n.id());
                const nid = n.id();
                const delay = idx * 18;
                setTimeout(() => {
                    // Bail if a newer render has happened
                    if (depMapState._animGen !== myGen) return;
                    if (!cy.hasElementWithId(nid)) return;
                    cy.$id(nid).animate({ position: fp }, { duration: 360, easing: 'ease-out-cubic' });
                }, delay);
                idx++;
            });
        } else {
            cy.fit(cy.elements(), 40);
        }
        return;
    }

    // ── Case 1.5: Exact viewport restore (e.g. returning from L2 call graph) ──
    if (savedVP && !originPos && !focusPath) {
        cy.viewport({ zoom: savedVP.zoom, pan: savedVP.pan });
        return;
    }

    // ── Case 2: Focus fly-in (Open Location was used) ─────────────────────────
    if (focusPath) {
        const target = cy.nodes().filter(n => {
            const f = n.data('_f');
            return f && (f.path === focusPath);
        }).first();

        if (!target || !target.length) { cy.fit(cy.elements(), 40); return; }

        const myGen = depMapState._animGen;
        cy.fit(cy.elements(), 40);
        setTimeout(() => {
            if (depMapState._animGen !== myGen) return;
            if (!cy.hasElementWithId(target.id())) return;
            highlightNode(target);
            cy.animate({
                center: { eles: target },
                zoom: Math.max(cy.zoom(), 1.8),
            }, {
                duration: 700,
                easing: 'ease-in-out-cubic',
                complete: () => {
                    if (depMapState._animGen !== myGen) return;
                    if (!cy.hasElementWithId(target.id())) return;
                    let count = 0;
                    const originalBc = target.data('bc');
                    const flashInterval = setInterval(() => {
                        count++;
                        if (!cy.hasElementWithId(target.id())) { clearInterval(flashInterval); return; }
                        target.style('border-color', count % 2 === 1 ? '#ffffff' : originalBc);
                        target.style('border-width', count % 2 === 1 ? 4 : 2);
                        if (count >= 6) {
                            clearInterval(flashInterval);
                            target.style('border-color', originalBc);
                            target.style('border-width', 2);
                        }
                    }, 200);
                }
            });
        }, 80);
        return;
    }

    // ── Case 3: Normal navigation — fit to all elements ──────────────────────
    cy.fit(cy.elements(), 40);
}

// ─── Call Graph Button helpers ────────────────────────────────────────────────
/**
 * Show or hide the Call Graph button.
 * filePath = null  → hide (no file selected, or leaving L2)
 * filePath = path  → show only if the file has at least one function
 * Called from: onNodeTap (file single-click), drillToFile, hideFuncView
 */
function updateCallGraphBtn(filePath) {
    const btn = document.getElementById('graph-toggle-btn');
    if (!btn) return;
    const isL2 = state.level >= 2;
    const hasFuncs = filePath && ((DATA.funcs_by_file?.[filePath]?.length || 0) > 0);
    const available = isL2 || hasFuncs;

    if (available) {
        btn.disabled = false;
        btn.title = T('graphBtnCallGraphTip');
    } else {
        btn.disabled = true;
        btn.title = T('graphBtnCallGraphTip') + ' (Not available for this file)';
    }

    // Always label as "Call Graph"
    btn.innerHTML = `⬡ ${T('graphBtnCallGraph')}`;

    // Don't mark Call Graph as active if Structure view is currently showing
    const structActive = window._sv && window._sv.active;
    btn.classList.toggle('active', isL2 && !structActive);
}

/**
 * Return to L1 from the Call Graph view, restoring the exact viewport and
 * selected node that were active before drillToFile() was called.
 * Does NOT call drillToModule (no full re-render of L1 if cy still has L1 nodes).
 */
function restoreL1FromCallGraph() {
    const snap = l2State._l1Snapshot;
    const prevHistory = [...state.history];   // preserve nav history

    // hideFuncView clears L2 DOM and cy classes, but does NOT reload L1 nodes.
    // We then need to re-render L1 (cy was replaced during L2).
    hideFuncView();
    if (window._sv && window._sv.active && window.svHideSvView) window.svHideSvView();
    state.level = 1;
    state.activeFile = null;

    // Restore history so breadcrumb/back-btn stay correct
    state.history = prevHistory.filter(h => h.level < 2);

    setL1ToolbarVisible(true);
    const ftWrap = document.getElementById('ft-filter');
    if (ftWrap) ftWrap.style.display = '';

    // Re-render L1 with viewport preserved
    if (snap) {
        depMapState.preserveViewport = { pan: snap.pan, zoom: snap.zoom };
        depMapState.expandOriginPos = null;
    }

    // drillToModule re-renders the L1 graph; _postLayoutL1 will restore viewport
    if (state.activeModule) {
        const savedH = [...state.history];
        drillToModule(state.activeModule);
        state.history = savedH;
    } else {
        loadLevel0();
    }

    // Re-select the node that was selected before entering L2
    if (snap?.selectedNodeId) {
        // After layout, the node IDs are preserved — re-select in the next tick
        setTimeout(() => {
            cy?.elements().unselect();
            cy?.$id(snap.selectedNodeId).select();
        }, 50);
    }

    setTimeout(() => {
        updateCallGraphBtn(codeState.currentFile);
        if (codeState.currentFile && window.svUpdateStructureBtn) {
            const fName = codeState.currentFile.split('/').pop();
            const ex = fName.includes('.') ? '.' + fName.split('.').pop().toLowerCase() : '';
            svUpdateStructureBtn(codeState.currentFile, ex);
        }
    }, 50);

    l2State._l1Snapshot = null;
    updateBreadcrumb();
}

// ─── L2: Function View ────────────────────────────────────────────────────────
function drillToFile(fileRel) {
    // Save L1 viewport + selected node so we can restore exactly when toggling back
    if (state.level < 2 && cy) {
        const sel = cy.nodes(':selected').first();
        l2State._l1Snapshot = {
            pan: { ...cy.pan() },
            zoom: cy.zoom(),
            selectedNodeId: sel && sel.length ? sel.id() : null,
        };
    }

    state.history.push({ level: 1, activeModule: state.activeModule });
    state.level = 2; state.activeFile = fileRel;
    updateBreadcrumb();
    setL1ToolbarVisible(false);
    const ftWrap = document.getElementById('ft-filter');
    if (ftWrap) ftWrap.style.display = 'none';

    // showFuncView handles code panel sync — do NOT call loadFileInPanel separately
    openL2File(fileRel, { newSession: true, pushHistory: true });
    updateCallGraphBtn(fileRel);
}

// Dedicated code-panel sync — called only from showFuncView to avoid race conditions
async function _syncCodePanel(fileRel, funcName, targetCallText = null) {
    if (!fileRel) return;
    // Respect the user's explicit close — don't force panel open
    if (codeState.userClosed && !codeState.isOpen) {
        // Update internal state silently so panel shows correct content when user reopens
        codeState.currentFile = fileRel;
        codeState.currentFunc = funcName;
        return;
    }
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
            requestAnimationFrame(() => jumpToFunc(funcName, targetCallText));
        }
        // Keep Structure button state in sync when reselecting the same file
        if (window.svUpdateStructureBtn) svUpdateStructureBtn(fileRel, ext);
        return;
    }

    // New file — fetch and render
    showCpLoading(true);
    try {
        const url = `/file?job=${encodeURIComponent(codeState.jobId)}&path=${encodeURIComponent(fileRel)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) { showCpError(T('fileLoadError', { error: data.error })); return; }
        codeState.currentFile = fileRel;
        renderFileContent(data, ext, fname);
        showCpLoading(false);
        if (funcName) requestAnimationFrame(() => jumpToFunc(funcName, targetCallText));
        // Show Structure button if file type is supported
        if (window.svUpdateStructureBtn) svUpdateStructureBtn(fileRel, ext);
    } catch (e) {
        showCpError(T('fetchError', { error: e.message }));
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
    clearFuncOverlay();
    setL2ToolbarVisible(false);
    clearL2Legend();
    document.getElementById('cy')?.classList.remove('l2-view');
    l2State.activeFile = null;
    l2State.activeFuncIdx = 0;
    l2State.expandedModules = new Set();
    l2State.externalModules = [];
    l2State._expandInitialized = false;
    // Hide call-graph button when leaving L2 (updateCallGraphBtn will re-show if needed)
    updateCallGraphBtn(null);
    updateL2NavButtons();
    updateExternalToggle();
}

// ─── Node Tap ─────────────────────────────────────────────────────────────────
function onNodeTap(node) {
    clearHighlight();
    const d = node.data();

    if (state.level === 2) {
        if (d._t === 'func') {
            highlightNode(node);
            focusL2Func(d._f, d.idx, { center: true });
            return;
        }
        if (d._t === 'ext_group') {
            toggleExternalGroup(d.mod);
            return;
        }
        // Single-tap: expand/collapse known system API or unresolved groups
        if (d._t === 'sys_group') {
            toggleSysGroup(d.syscat);
            return;
        }
        // sys_func node — highlight and scroll code panel to the callsite
        if (d._t === 'sys_func') {
            highlightNode(node);
            const callerIdx = pickCallerIdxForExternal(node);
            if (callerIdx != null) l2State.activeFuncIdx = callerIdx;
            syncActiveL2FuncCode(d.fn);
            return;
        }
        // sys_func / unk_func node — highlight and scroll code panel to the callsite
        if (d._t === 'sys_func') {
            highlightNode(node);
            const callerIdx = pickCallerIdxForExternal(node);
            if (callerIdx != null) l2State.activeFuncIdx = callerIdx;
            syncActiveL2FuncCode(d.fn);
            return;
        }
        // Click on a drill_group compound box → collapse it
        if (d._t === 'drill_group') {
            const srcNodeId = d._srcNodeId;
            const srcNode = srcNodeId ? cy.$id(srcNodeId) : null;
            const fn = srcNode?.data('fn') || '';
            _collapseDrillGroup(srcNode || node, node.id(), fn);
            return;
        }

        if (d._t === 'ext_func') {
            // NOTE: drill expand/collapse is handled exclusively by the cy.on('dbltap') handler.
            // Do NOT call drillDownExtFunc here — it races with dbltap: the second tap fires
            // drillDownExtFunc (collapse), then dbltap fires it again (re-expand). ✗
            highlightNode(node);
            if (d._f) {
                _syncCodePanel(d._f, d.fn);
            } else {
                const callerIdx = pickCallerIdxForExternal(node);
                if (callerIdx != null) l2State.activeFuncIdx = callerIdx;
                syncActiveL2FuncCode(d.fn);
            }
            return;
        }
        if (d._t === 'potential_func') {
            // Same — drill handled exclusively by dbltap handler.
            highlightNode(node);
            if (d._f) {
                _syncCodePanel(d._f, d.fn);
            } else {
                const callerIdx = pickCallerIdxForExternal(node);
                if (callerIdx != null) l2State.activeFuncIdx = callerIdx;
                syncActiveL2FuncCode(d.fn);
            }
            return;
        }
    }

    if (state.level === 0 && d._t === 'module') {
        drillToModule(d._m.id);
        return;
    }

    // ─── L1 external module group: toggle expand/collapse ────────────────────
    if (state.level === 1 && d._t === 'dep_ext_group') {
        toggleDepMapExtGroup(d.mod);
        return;
    }

    // ─── L1 external file node: preview in code panel ────────────────────────
    if (state.level === 1 && d._t === 'dep_ext_file') {
        highlightNode(node);
        if (d._f?.path) loadFileInPanel(d._f.path);
        return;
    }

    if (d._t === 'file') {
        const now = performance.now();
        const sameNode = extClickLastId === node.id();
        const isDouble = sameNode && (now - extClickLastTime) < EXT_DOUBLE_CLICK_MS;

        extClickLastId = node.id();
        extClickLastTime = now;

        highlightNode(node);

        if (isDouble) {
            if (d._f?.path) drillToFile(d._f.path);
        } else {
            // Single click → code panel preview + show call-graph button if file has funcs
            if (d._f?.path) {
                loadFileInPanel(d._f.path);
                updateCallGraphBtn(d._f.path);
            }
        }
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

    function addSeg(label, clickFn, isCurrent, title) {
        if (container.children.length > 0) {
            const sep = document.createElement('span');
            sep.className = 'bc-sep';
            sep.textContent = '›';
            container.appendChild(sep);
        }
        const seg = document.createElement('span');
        seg.className = 'bc-item' + (isCurrent ? ' bc-current' : '');
        seg.textContent = label;
        seg.title = title || label || '';
        if (clickFn) seg.onclick = clickFn;
        container.appendChild(seg);
    }

    // Level 0: always show Modules
    addSeg(T('sidebarModules'), () => { state.history = []; loadLevel0(); }, state.level === 0, 'Modules');

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
            isModActive,
            state.activeModule);
    }

    // Level 1: Sub-directory
    if (state.level === 1 && state.activeSubDir) {
        const parts = state.activeSubDir.split('/');
        parts.forEach((part, i) => {
            const isLast = i === parts.length - 1;
            const subPath = parts.slice(0, i + 1).join('/');
            const fullPath = (state.activeModule ? state.activeModule + '/' : '') + subPath;
            addSeg(part,
                isLast ? null : () => {
                    filterGraphToSubPath(state.activeModule, subPath);
                    setSubdirActive(state.activeModule, subPath);
                },
                isLast,
                fullPath);
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
            const fullPath = (modId ? modId + '/' : '') + subPath;
            addSeg(part,
                isLast ? null : () => {
                    state.level = 1;
                    hideFuncView();
                    filterGraphToSubPath(state.activeModule, subPath);
                    setSubdirActive(state.activeModule, subPath);
                },
                isLast,
                fullPath);
        });
    }

    // Update Back button visibility (now managed via disabled attribute)
    const backBtn = document.getElementById('back-btn');
    if (backBtn) {
        if (state.history.length > 0) {
            backBtn.disabled = false;
        } else {
            backBtn.disabled = true;
        }
    }

    // Call-graph button: update text + active state; visibility controlled by updateCallGraphBtn()
    const graphBtn = document.getElementById('graph-toggle-btn');
    if (graphBtn) {
        const isL2 = state.level >= 2;
        graphBtn.innerHTML = `⬡ ${T('graphBtnCallGraph')}`;
        graphBtn.title = T('graphBtnCallGraphTip');
        graphBtn.classList.toggle('active', isL2);
    }
}

function setSidebarActive(modId) {
    document.querySelectorAll('.mod-row').forEach(el => el.classList.remove('active'));
    if (modId) {
        const el = document.getElementById(`mi-${modId}`);
        if (el) el.classList.add('active');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH SYSTEM V3 — VS Code–style: toggles, include/exclude, grouped tree
// ═══════════════════════════════════════════════════════════════════════════════

const _srState = {
    mode: 'files',   // 'files' | 'code'
    query: '',
    // Toggle flags
    matchCase: false,
    wholeWord: false,
    isRegex: false,
    // Filter strings (VS Code-style globs, applied server-side for code, client-side for files)
    include: '',
    exclude: '',
    // Flat results (files mode only)
    results: [],
    activeIdx: -1,
    // Content search state (code mode)
    _contentGroups: [],   // [{path,label,module,ext,count,matches,color}]
    _contentTotal: 0,
    _contentFiles: 0,
    _contentLoading: false,
    _contentDone: false,
    _contentError: '',
    _contentIndexed: false,  // true = server used in-memory index (⚡ fast)
    // View mode (code search)
    viewMode: 'list',       // 'list' | 'tree'
    // View mode (file search)
    fileViewMode: 'list',      // 'list' | 'tree'
    // Tree expand state
    _openGroups: new Set(),   // open file groups (code mode)
    _openFolders: new Set(),   // open folder nodes (tree mode)
    _openFileFolders: new Set(), // open folder nodes (file tree mode)
    // Advanced filter
    _filterFuncOnly: false,    // show only lines that look like func definitions
    // Virtual scroll
    _vsEnd: 0,                 // items rendered so far (both modes)
    // Streaming render state (code mode)
    _streamRendered: false,
    _streamRenderMode: '',
    // Local index
    _indexBuilt: false,
    _fileIndex: [],   // [{label,path,module,ext,file_type,func_count,size}]
};

// ── SSE stream handle ─────────────────────────────────────────────────────────
let _srStream = null;
let _srStreamBatchTimer = null;
let _srStreamPending = [];

// ── Build search indices once ─────────────────────────────────────────────────
function _srBuildIndex() {
    if (_srState._indexBuilt || !window.DATA) return;
    _srState._indexBuilt = true;
    for (const [, files] of Object.entries(DATA.files_by_module || {})) {
        for (const f of files) {
            _srState._fileIndex.push({
                label: f.label, path: f.path,
                module: f.path.split('/')[0] || '_root',
                ext: f.ext || '', file_type: f.file_type || 'other',
                func_count: f.func_count || 0, size: f.size || 0,
            });
        }
    }
}

// ── Client-side search (files / funcs) ───────────────────────────────────────
function _srScore(text, q) {
    const t = text.toLowerCase(), ql = q.toLowerCase();
    if (!t.includes(ql)) return -1;
    if (t === ql) return 1000;
    if (t.indexOf(ql) === 0) return 500;
    return 100 - t.indexOf(ql);
}

function _srApplyToggles(text) {
    // Filter text client-side against matchCase / wholeWord for file search
    const q = _srState.query;
    if (!q) return false;
    let t = text, ql = q;
    if (!_srState.matchCase) { t = t.toLowerCase(); ql = ql.toLowerCase(); }
    if (_srState.wholeWord) {
        const re = new RegExp('\\b' + ql.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b',
            _srState.matchCase ? '' : 'i');
        return re.test(text);
    }
    return t.includes(ql);
}

function _srHighlight(text, q) {
    if (!q) return escapeHtml(text);
    const flags = _srState.matchCase ? 'g' : 'gi';
    let pattern;
    try {
        const core = _srState.isRegex
            ? q
            : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wrapped = _srState.wholeWord ? '\\b' + core + '\\b' : core;
        pattern = new RegExp(wrapped, flags);
    } catch (_) {
        return escapeHtml(text);
    }
    return escapeHtml(text).replace(pattern, m => `<mark>${m}</mark>`);
}

// Highlight individual fuzzy-matched character positions in text
function _srFuzzyHighlight(text, positions) {
    if (!positions || positions.length === 0) return escapeHtml(text);
    const posSet = new Set(positions);
    let html = '';
    for (let i = 0; i < text.length; i++) {
        const ch = escapeHtml(text[i]);
        if (posSet.has(i)) {
            html += `<mark class="sr-fuzzy-mark">${ch}</mark>`;
        } else {
            html += ch;
        }
    }
    return html;
}

// Compute fuzzy match character positions in text for query q
// Returns array of matched indices, or null if no fuzzy match
function _srFuzzyPositions(text, q) {
    const t = _srState.matchCase ? text : text.toLowerCase();
    const ql = _srState.matchCase ? q : q.toLowerCase();
    const positions = [];
    let qi = 0;
    for (let i = 0; i < t.length && qi < ql.length; i++) {
        if (t[i] === ql[qi]) { positions.push(i); qi++; }
    }
    return qi === ql.length ? positions : null;
}

function _srSearchFiles(q) {
    if (!q) return [];
    const ql = q.toLowerCase();

    // Glob matching helper (client-side)
    function globMatch(path, pattern) {
        // Convert glob to regex: * → [^/]*, ** → .*, ? → [^/]
        const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '\x00').replace(/\*/g, '[^/]*').replace(/\x00/g, '.*').replace(/\?/g, '[^/]');
        try { return new RegExp('^' + re + '$', 'i').test(path) || new RegExp(re, 'i').test(path.split('/').pop()); }
        catch (_) { return false; }
    }
    const incGlobs = (_srState.include || '').split(',').map(s => s.trim()).filter(Boolean);
    const excGlobs = (_srState.exclude || '').split(',').map(s => s.trim()).filter(Boolean);

    // Fuzzy match: every char of q appears in order in the string
    function fuzzyMatch(text) {
        const t = text.toLowerCase();
        let qi = 0;
        for (let i = 0; i < t.length && qi < ql.length; i++) {
            if (t[i] === ql[qi]) qi++;
        }
        return qi === ql.length;
    }

    function score(f) {
        const label = f.label.toLowerCase();
        const path = f.path.toLowerCase();
        if (label === ql) return 10000;
        if (label.startsWith(ql)) return 5000 + (100 - Math.min(label.length, 100));
        const li = label.indexOf(ql);
        if (li >= 0) return 3000 + (100 - Math.min(li, 100));
        const pi = path.indexOf(ql);
        if (pi >= 0) return 1000 + (100 - Math.min(pi, 100));
        if (fuzzyMatch(f.label)) return 500;
        if (fuzzyMatch(f.path)) return 100;
        return -1;
    }

    const mc = _srState.matchCase;
    const ww = _srState.wholeWord;
    const rx = _srState.isRegex;

    let pattern = null;
    if (rx) {
        try { pattern = new RegExp(q, mc ? '' : 'i'); } catch (_) { pattern = null; }
    }

    const scored = [];
    for (const f of _srState._fileIndex) {
        // Apply include/exclude globs
        if (incGlobs.length > 0 && !incGlobs.some(g => globMatch(f.path, g))) continue;
        if (excGlobs.length > 0 && excGlobs.some(g => globMatch(f.path, g))) continue;

        let s = -1;
        if (pattern) {
            if (pattern.test(f.label) || pattern.test(f.path)) s = 1000;
        } else if (ww) {
            const re = new RegExp('\\b' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', mc ? '' : 'i');
            if (re.test(f.label) || re.test(f.path)) s = score(f);
        } else {
            s = score(f);
        }
        if (s >= 0) {
            // Track fuzzy-matched positions for per-character highlighting
            let _fuzzyLabelPos = null, _fuzzyPathPos = null;
            if (s < 1000 && !pattern && !ww) {
                // Fuzzy match — compute positions for highlight
                _fuzzyLabelPos = _srFuzzyPositions(f.label, q);
                if (!_fuzzyLabelPos) _fuzzyPathPos = _srFuzzyPositions(f.path, q);
            }
            scored.push({ ...f, _score: s, _type: 'file', _fuzzyLabelPos, _fuzzyPathPos });
        }
    }
    scored.sort((a, b) => b._score - a._score || a.label.localeCompare(b.label));
    return scored;
}

// ── SSE streaming content search ──────────────────────────────────────────────
function _srStartStream(q) {
    // Cancel any in-flight stream
    if (_srStream) { _srStream.close(); _srStream = null; }
    clearTimeout(_srStreamBatchTimer);
    _srStreamPending = [];
    _srState._streamRendered = false;
    _srState._streamRenderMode = _srState.viewMode;

    if (!codeState.jobId || !q) {
        _srState._contentGroups = [];
        _srState._contentTotal = 0;
        _srState._contentFiles = 0;
        _srState._contentLoading = false;
        _srState._contentDone = true;
        _srRenderResults(); _srRenderActionBar();
        return;
    }

    _srState._contentGroups = [];
    _srState._contentTotal = 0;
    _srState._contentFiles = 0;
    _srState._contentError = '';
    _srState._contentLoading = true;
    _srState._contentDone = false;
    _srRenderResults(); _srRenderActionBar();

    const params = new URLSearchParams({
        job: codeState.jobId,
        q,
        match_case: _srState.matchCase ? '1' : '0',
        whole_word: _srState.wholeWord ? '1' : '0',
        is_regex: _srState.isRegex ? '1' : '0',
        include: _srState.include,
        exclude: _srState.exclude,
    });

    const capturedQ = q;
    const es = new EventSource(`/search-stream?${params}`);
    _srStream = es;

    function _flush() {
        if (_srStreamPending.length === 0) return;
        _srState._contentGroups.push(..._srStreamPending);
        _srStreamPending = [];
        _srStreamBatchTimer = null;
        if (_srState.query === capturedQ) {
            _srRenderStreamingBatch();
            _srRenderActionBar();
            // Update count badge
            const countEl = document.getElementById('sr-count');
            if (countEl) {
                const n = _srState._contentTotal;
                countEl.textContent = n > 0 ? n.toLocaleString() : '';
                countEl.style.color = 'var(--accent)';
            }
        }
    }

    es.onmessage = e => {
        if (_srState.query !== capturedQ) { es.close(); _srStream = null; return; }
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }

        if (msg.error) {
            _srState._contentError = msg.error;
            _srState._contentLoading = false;
            _srState._contentDone = true;
            es.close(); _srStream = null;
            _srRenderResults(); _srRenderActionBar(); return;
        }

        if (msg.group) {
            _srStreamPending.push(msg.group);
            _srState._contentTotal += msg.group.count;
            _srState._contentFiles++;
            // Batch: render every 80ms to avoid flooding the DOM
            if (!_srStreamBatchTimer) {
                _srStreamBatchTimer = setTimeout(_flush, 80);
            }
        }

        if (msg.done) {
            clearTimeout(_srStreamBatchTimer);
            _flush();
            _srState._contentLoading = false;
            _srState._contentDone = true;
            _srState._contentIndexed = msg.indexed || false;
            es.close(); _srStream = null;
            const needsFullRender = _srState.viewMode === 'tree'
                || _srState._filterFuncOnly
                || _srState._contentGroups.length === 0;
            if (needsFullRender) {
                _srRenderResults();
            } else {
                const resultsEl = document.getElementById('sr-results');
                const bar = resultsEl?.querySelector('.sr-streaming-bar');
                if (bar) bar.remove();
            }
            _srRenderActionBar();
        }
    };

    es.onerror = () => {
        if (_srState.query !== capturedQ) return;
        _srState._contentLoading = false;
        _srState._contentDone = true;
        clearTimeout(_srStreamBatchTimer);
        _flush();
        es.close(); _srStream = null;
        const needsFullRender = _srState.viewMode === 'tree'
            || _srState._filterFuncOnly
            || _srState._contentGroups.length === 0;
        if (needsFullRender) {
            _srRenderResults();
        } else {
            const resultsEl = document.getElementById('sr-results');
            const bar = resultsEl?.querySelector('.sr-streaming-bar');
            if (bar) bar.remove();
        }
        _srRenderActionBar();
    };
}

// ── Debounce helper ───────────────────────────────────────────────────────────
let _srDebounceTimer = null;
function _srDebounce(q) {
    clearTimeout(_srDebounceTimer);
    _srState._contentLoading = true;
    _srDebounceTimer = setTimeout(() => _srStartStream(q), 300);
}

// ── Func-definition heuristic ─────────────────────────────────────────────────
function _srLineIsFunc(line, ext) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('#')) return false;
    if (['.c', '.cpp', '.cc', '.h', '.hpp'].includes(ext))
        return /\w[\w\s*]+\s+\w+\s*\(/.test(t) && !/^\s*(if|for|while|switch|return|#)\b/.test(t);
    if (ext === '.py') return /^\s*(async\s+)?def\s+\w/.test(t);
    if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(ext))
        return /^\s*(export\s+)?(default\s+)?(async\s+)?function\b/.test(t)
            || /^\s*(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/.test(t)
            || /^\s*(const|let|var)\s+\w+\s*=\s*function\b/.test(t);
    if (ext === '.go') return /^\s*func\s+/.test(t);
    if (['.inf', '.dec', '.dsc'].includes(ext)) return /^\[/.test(t);
    return false;
}

// ── Apply client-side filters to groups ───────────────────────────────────────
function _srFilteredGroups() {
    let groups = _srState._contentGroups;
    // Functions-only filter
    if (_srState._filterFuncOnly) {
        groups = groups.map(g => {
            const funcMatches = g.matches.filter(m => _srLineIsFunc(m.text, g.ext));
            return funcMatches.length > 0 ? { ...g, matches: funcMatches, count: funcMatches.length } : null;
        }).filter(Boolean);
    }
    return groups;
}

// ── Build available ext chips from all results ────────────────────────────────
function _srAvailableExts() {
    const counts = {};
    for (const g of _srState._contentGroups) {
        counts[g.ext] = (counts[g.ext] || 0) + g.count;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _srModuleColor(modId) {
    if (!window.DATA) return '#64748b';
    const mod = (DATA.modules || []).find(m => m.id === modId);
    return mod?.color || '#64748b';
}

function _extIcon(ext) {
    const m = {
        '.c': '🔵', '.cpp': '🔵', '.h': '🟣', '.hpp': '🟣', '.asm': '🟡',
        '.py': '🐍', '.js': '⚡', '.ts': '🔷', '.jsx': '⚛', '.tsx': '⚛',
        '.go': '🟢', '.inf': '📋', '.dec': '📦', '.sdl': '🔧', '.cif': '🗂',
        '.vfr': '🖥', '.asl': '⚙', '.uni': '🔤', '.md': '📝',
        '.json': '{}', '.yaml': '📄', '.xml': '📄'
    };
    return m[ext] || '📄';
}

// ── Collapse / Expand All ─────────────────────────────────────────────────────
function _srCollapseAll() {
    _srState._openGroups.clear();
    _srState._openFolders.clear();
    // Toggle DOM directly — avoid full re-render
    document.querySelectorAll('#sr-results .sr-match-lines').forEach(el => el.style.display = 'none');
    document.querySelectorAll('#sr-results .sr-chevron').forEach(el => {
        el.classList.remove('open'); el.textContent = '▸';
    });
    document.querySelectorAll('#sr-results .sr-tree-folder-body').forEach(el => el.style.display = 'none');
    _srRenderActionBar();
}

function _srExpandAll() {
    _srState._contentGroups.forEach(g => _srState._openGroups.add(g.path));
    if (_srState.viewMode === 'tree') {
        _srState._contentGroups.forEach(g => {
            const parts = g.path.split('/');
            for (let i = 1; i < parts.length; i++) {
                _srState._openFolders.add(parts.slice(0, i).join('/'));
            }
        });
    }
    // For small result sets do direct DOM toggle; for large do full render
    const groups = _srFilteredGroups();
    if (groups.length <= 200) {
        groups.forEach(g => {
            const hdr = document.querySelector(`#sr-results .sr-file-header[data-gpath="${CSS.escape(g.path)}"]`);
            if (!hdr) return;
            const grp = hdr.closest('.sr-file-group');
            if (!grp) return;
            let lines = grp.querySelector('.sr-match-lines');
            if (!lines) {
                // Need to build and insert match lines HTML
                lines = document.createElement('div');
                lines.className = 'sr-match-lines';
                lines.innerHTML = _srMatchLinesHtml(g);
                grp.appendChild(lines);
                _srWireLineRows(lines);
            }
            lines.style.display = '';
            const chev = hdr.querySelector('.sr-chevron');
            if (chev) { chev.classList.add('open'); chev.textContent = '▾'; }
        });
        _srRenderActionBar();
    } else {
        _srRenderResults();
    }
}

// ── Build match-lines HTML for one group (shared between expand & render) ─────
function _srMatchLinesHtml(g) {
    const q = _srState.query;
    let html = '';
    g.matches.forEach(m => {
        const snip = m.text || '';
        const snipHl = escapeHtml(snip.slice(0, m.ms))
            + '<mark>' + escapeHtml(snip.slice(m.ms, m.me)) + '</mark>'
            + escapeHtml(snip.slice(m.me));
        const isFn = _srLineIsFunc(snip, g.ext);
        html += `<div class="sr-line-row${isFn ? ' sr-line-func' : ''}" data-gpath="${escapeHtml(g.path)}" data-line="${m.line}">
    <span class="sr-line-num">${m.line}</span>
    ${isFn ? '<span class="sr-fn-tag" data-tip="Function definition">ƒ</span>' : ''}
    <span class="sr-line-text">${snipHl}</span>
  </div>`;
    });
    return html;
}

// ── Wire click/hover on line rows in a container ─────────────────────────────
function _srWireLineRows(container) {
    container.querySelectorAll('.sr-line-row').forEach(row => {
        const path = row.dataset.gpath;
        const line = parseInt(row.dataset.line, 10);
        row.addEventListener('click', () => _srSelectContentLine(path, line));
        row.addEventListener('mouseenter', () => _srHoverResult({ path }));
    });
}

// ── Build a folder tree from flat group list ──────────────────────────────────
function _srBuildTree(groups) {
    // Returns a nested structure: { name, path, children: [], files: [] }
    const root = { name: '', path: '', children: [], files: [] };
    const nodeMap = { '': root };

    function getNode(folderPath) {
        if (nodeMap[folderPath]) return nodeMap[folderPath];
        const parts = folderPath.split('/');
        const name = parts[parts.length - 1];
        const parent = parts.slice(0, -1).join('/');
        const parentNode = getNode(parent);
        const node = { name, path: folderPath, children: [], files: [] };
        parentNode.children.push(node);
        nodeMap[folderPath] = node;
        return node;
    }

    for (const g of groups) {
        const lastSlash = g.path.lastIndexOf('/');
        const folder = lastSlash >= 0 ? g.path.slice(0, lastSlash) : '';
        getNode(folder).files.push(g);
    }

    // Sort children alphabetically
    function sortNode(n) {
        n.children.sort((a, b) => a.name.localeCompare(b.name));
        n.files.sort((a, b) => a.label.localeCompare(b.label));
        n.children.forEach(sortNode);
    }
    sortNode(root);
    return root;
}

// ── Render a tree node recursively ────────────────────────────────────────────
function _srRenderTreeNode(node, q, depth) {
    let html = '';
    const indent = depth * 14;  // px

    // Render child folders first
    for (const child of node.children) {
        const isOpen = _srState._openFolders.has(child.path);
        const chev = isOpen ? '▾' : '▸';
        const matchCount = _countTreeMatches(child);
        html += `<div class="sr-tree-folder">
  <div class="sr-tree-folder-hdr" data-fpath="${escapeHtml(child.path)}" style="padding-left:${indent + 6}px">
    <span class="sr-chevron${isOpen ? ' open' : ''}">${chev}</span>
    <span class="sr-tree-folder-icon">📁</span>
    <span class="sr-tree-folder-name">${escapeHtml(child.name)}</span>
    <span class="sr-match-badge" style="margin-left:auto">${matchCount}</span>
  </div>`;
        if (isOpen) {
            html += `<div class="sr-tree-folder-body">`;
            html += _srRenderTreeNode(child, q, depth + 1);
            html += `</div>`;
        }
        html += `</div>`;
    }

    // Render files in this folder
    for (const g of node.files) {
        const isOpen = _srState._openGroups.has(g.path);
        const chev = isOpen ? '▾' : '▸';
        const ic = _extIcon(g.ext);
        const mc = g.color || _srModuleColor(g.module);
        const fnHl = _srHighlight(g.label, q);

        html += `<div class="sr-file-group">
  <div class="sr-file-header sr-tree-file-hdr" data-gpath="${escapeHtml(g.path)}" style="padding-left:${indent + 22}px">
    <span class="sr-chevron${isOpen ? ' open' : ''}">${chev}</span>
    <span class="sr-file-icon">${ic}</span>
    <div class="sr-file-name-wrap">
      <span class="sr-file-name">${fnHl}</span>
    </div>
    <span class="sr-match-badge">${g.count}</span>
    <span class="sr-meta-mod" style="background:${mc}22;color:${mc};border:1px solid ${mc}44;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px;flex-shrink:0">${escapeHtml(g.module)}</span>
  </div>`;
        if (isOpen) {
            html += `<div class="sr-match-lines">`;
            g.matches.forEach(m => {
                const snip = m.text || '';
                const snipHl = escapeHtml(snip.slice(0, m.ms))
                    + '<mark>' + escapeHtml(snip.slice(m.ms, m.me)) + '</mark>'
                    + escapeHtml(snip.slice(m.me));
                html += `<div class="sr-line-row" data-gpath="${escapeHtml(g.path)}" data-line="${m.line}" style="padding-left:${indent + 44}px">
      <span class="sr-line-num">${m.line}</span>
      <span class="sr-line-text">${snipHl}</span>
    </div>`;
            });
            html += `</div>`;
        }
        html += `</div>`;
    }

    return html;
}

function _countTreeMatches(node) {
    let n = node.files.reduce((s, f) => s + f.count, 0);
    for (const c of node.children) n += _countTreeMatches(c);
    return n;
}

// ── Render the action toolbar (clean: no chips) ─────────────────────────────
function _srRenderActionBar() {
    const bar = document.getElementById('sr-action-bar');
    if (!bar) return;

    const hasResults = _srState.mode === 'code'
        ? (_srState._contentGroups.length > 0 || _srState._contentLoading)
        : _srState.results.length > 0;

    if (!hasResults) { bar.style.display = 'none'; return; }

    bar.style.display = 'flex';
    bar.style.flexDirection = 'column';
    bar.style.gap = '0';
    bar.style.padding = '0';

    const isTree = _srState.viewMode === 'tree';
    const loading = _srState._contentLoading;
    const indexed = _srState._contentIndexed;

    if (_srState.mode === 'code') {
        const totalShown = _srFilteredGroups().length;
        const totalAll = _srState._contentFiles;
        const filtered = totalShown < totalAll;

        bar.innerHTML = `
<div class="sr-ab-top">
  <span class="sr-ab-info">
    <span class="sr-ab-count">${_srState._contentTotal.toLocaleString()}</span>
    <span class="sr-ab-label">${T('searchResults')}</span>
    <span class="sr-ab-label">${T('searchIn')}</span>
    <span class="sr-ab-count">${totalShown.toLocaleString()}${filtered ? `<span class="sr-ab-filtered">/${totalAll}</span>` : ''}</span>
    <span class="sr-ab-label">${T('searchFilesWord')}</span>
    ${loading ? '<span class="sr-ab-scanning">scanning…</span>' : ''}
  </span>
  <span class="sr-ab-spacer"></span>
  <button class="sr-ab-btn${_srState._filterFuncOnly ? ' active' : ''}" id="sr-ab-func" data-tip="Show only function-definition matches">ƒ</button>
  <div class="sr-ab-sep"></div>
  <button class="sr-ab-btn" id="sr-collapse-all" data-tip="Collapse All">⊟</button>
  <button class="sr-ab-btn" id="sr-expand-all"   data-tip="Expand All">⊞</button>
  <div class="sr-ab-sep"></div>
  <button class="sr-ab-btn${!isTree ? ' active' : ''}" id="sr-view-list" data-tip="View as List">≡</button>
  <button class="sr-ab-btn${isTree ? ' active' : ''}" id="sr-view-tree" data-tip="View as Tree">⬡</button>
</div>
<div class="sr-ab-filters">
  <div class="sr-ab-filter-input-wrap" data-tip="${T('searchIncludeTip')}">
    <span class="sr-ab-filter-icon">⊕</span>
    <input class="sr-ab-filter-input" id="sr-ab-inc" type="text" value="${escapeHtml(_srState.include)}" placeholder="${T('searchIncludeLong')}" spellcheck="false" autocomplete="off">
    ${_srState.include ? `<button class="sr-ab-filter-clear" data-target="inc">✕</button>` : ''}
  </div>
  <div class="sr-ab-filter-input-wrap" data-tip="${T('searchExcludeTip')}">
    <span class="sr-ab-filter-icon sr-ab-filter-exc">⊖</span>
    <input class="sr-ab-filter-input" id="sr-ab-exc" type="text" value="${escapeHtml(_srState.exclude)}" placeholder="${T('searchExcludeLong')}" spellcheck="false" autocomplete="off">
    ${_srState.exclude ? `<button class="sr-ab-filter-clear" data-target="exc">✕</button>` : ''}
  </div>
</div>`;

        document.getElementById('sr-ab-func').addEventListener('click', () => {
            _srState._filterFuncOnly = !_srState._filterFuncOnly;
            _srRenderResults(); _srRenderActionBar();
        });
        document.getElementById('sr-collapse-all').addEventListener('click', _srCollapseAll);
        document.getElementById('sr-expand-all').addEventListener('click', _srExpandAll);
        document.getElementById('sr-view-list').addEventListener('click', () => {
            if (_srState.viewMode === 'list') return;
            _srState.viewMode = 'list'; _srRenderResults(); _srRenderActionBar();
        });
        document.getElementById('sr-view-tree').addEventListener('click', () => {
            if (_srState.viewMode === 'tree') return;
            _srState.viewMode = 'tree'; _srRenderResults(); _srRenderActionBar();
        });

        const incInput = document.getElementById('sr-ab-inc');
        const excInput = document.getElementById('sr-ab-exc');
        let _abTimer = null;
        function _abChanged() {
            clearTimeout(_abTimer);
            _abTimer = setTimeout(() => {
                _srState.include = incInput?.value.trim() || '';
                _srState.exclude = excInput?.value.trim() || '';
                if (_srState.query) _srDebounce(_srState.query);
                else _srRenderActionBar();
            }, 400);
        }
        if (incInput) incInput.addEventListener('input', _abChanged);
        if (excInput) excInput.addEventListener('input', _abChanged);
        bar.querySelectorAll('.sr-ab-filter-clear').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.target === 'inc') { _srState.include = ''; if (incInput) incInput.value = ''; }
                else { _srState.exclude = ''; if (excInput) excInput.value = ''; }
                if (_srState.query) _srDebounce(_srState.query);
                else _srRenderActionBar();
            });
        });
        [incInput, excInput].forEach(inp => {
            if (!inp) return;
            inp.addEventListener('keydown', e => {
                if (e.key === 'Escape') { inp.value = ''; inp.dispatchEvent(new Event('input')); e.stopPropagation(); }
                if (e.key === 'Enter') e.stopPropagation();
            });
        });

    } else {
        // FILES mode bar: count + view toggles + inline include/exclude
        const n = _srState.results.length;
        const isFileTree = _srState.fileViewMode === 'tree';
        bar.innerHTML = `
<div class="sr-ab-top">
  <span class="sr-ab-info"><span class="sr-ab-count">${n.toLocaleString()}</span>&thinsp;${T('searchFilesWord')}</span>
  <span class="sr-ab-spacer"></span>
  ${isFileTree ? `<button class="sr-ab-btn" id="sr-fi-collapse-all" data-tip="Collapse All">⊟</button>
  <button class="sr-ab-btn" id="sr-fi-expand-all" data-tip="Expand All">⊞</button>
  <div class="sr-ab-sep"></div>` : ''}
  <button class="sr-ab-btn${!isFileTree ? ' active' : ''}" id="sr-fi-view-list" data-tip="View as List">≡</button>
  <button class="sr-ab-btn${isFileTree ? ' active' : ''}" id="sr-fi-view-tree" data-tip="View as Tree">⬡</button>
  <div class="sr-ab-sep"></div>
  <div class="sr-ab-filter-input-wrap sr-ab-filter-inline" data-tip="${T('searchIncludeLabel')}">
    <span class="sr-ab-filter-icon">⊕</span>
    <input class="sr-ab-filter-input" id="sr-ab-fi-inc" type="text" value="${escapeHtml(_srState.include)}" placeholder="${T('searchIncludeShort')}" spellcheck="false" autocomplete="off">
    ${_srState.include ? `<button class="sr-ab-filter-clear" data-target="inc">✕</button>` : ''}
  </div>
  <div class="sr-ab-filter-input-wrap sr-ab-filter-inline" data-tip="${T('searchExcludeLabel')}">
    <span class="sr-ab-filter-icon sr-ab-filter-exc">⊖</span>
    <input class="sr-ab-filter-input" id="sr-ab-fi-exc" type="text" value="${escapeHtml(_srState.exclude)}" placeholder="${T('searchExcludeShort')}" spellcheck="false" autocomplete="off">
    ${_srState.exclude ? `<button class="sr-ab-filter-clear" data-target="exc">✕</button>` : ''}
  </div>
</div>`;

        const iInc = document.getElementById('sr-ab-fi-inc');
        const iExc = document.getElementById('sr-ab-fi-exc');

        // View toggle buttons
        const fiViewList = document.getElementById('sr-fi-view-list');
        const fiViewTree = document.getElementById('sr-fi-view-tree');
        if (fiViewList) fiViewList.addEventListener('click', () => {
            if (_srState.fileViewMode === 'list') return;
            _srState.fileViewMode = 'list'; _srRenderResults(); _srRenderActionBar();
        });
        if (fiViewTree) fiViewTree.addEventListener('click', () => {
            if (_srState.fileViewMode === 'tree') return;
            _srState.fileViewMode = 'tree'; _srRenderResults(); _srRenderActionBar();
        });

        // Collapse / Expand All (tree mode only)
        const fiCollapseAll = document.getElementById('sr-fi-collapse-all');
        const fiExpandAll = document.getElementById('sr-fi-expand-all');
        if (fiCollapseAll) fiCollapseAll.addEventListener('click', () => {
            _srState._openFileFolders.clear();
            document.querySelectorAll('#sr-results .sr-fi-tree-body').forEach(el => el.style.display = 'none');
            document.querySelectorAll('#sr-results .sr-fi-tree-chevron').forEach(el => {
                el.classList.remove('open'); el.textContent = '▸';
            });
        });
        if (fiExpandAll) fiExpandAll.addEventListener('click', () => {
            document.querySelectorAll('#sr-results .sr-fi-tree-folder-hdr').forEach(hdr => {
                const fpath = hdr.dataset.fpath;
                if (fpath) _srState._openFileFolders.add(fpath);
                const body = hdr.nextElementSibling;
                if (body) body.style.display = '';
                const chev = hdr.querySelector('.sr-fi-tree-chevron');
                if (chev) { chev.classList.add('open'); chev.textContent = '▾'; }
            });
        });

        let _fTimer = null;
        function _fiChanged() {
            clearTimeout(_fTimer);
            _fTimer = setTimeout(() => {
                _srState.include = iInc?.value.trim() || '';
                _srState.exclude = iExc?.value.trim() || '';
                _srBuildIndex();
                _srState.results = _srSearchFiles(_srState.query);
                _srRenderResults(); _srRenderActionBar();
            }, 200);
        }
        if (iInc) iInc.addEventListener('input', _fiChanged);
        if (iExc) iExc.addEventListener('input', _fiChanged);
        bar.querySelectorAll('.sr-ab-filter-clear').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.target === 'inc') { _srState.include = ''; if (iInc) iInc.value = ''; }
                else { _srState.exclude = ''; if (iExc) iExc.value = ''; }
                _srState.results = _srSearchFiles(_srState.query);
                _srRenderResults(); _srRenderActionBar();
            });
        });
        [iInc, iExc].forEach(inp => {
            if (!inp) return;
            inp.addEventListener('keydown', e => {
                if (e.key === 'Escape') { inp.value = ''; inp.dispatchEvent(new Event('input')); e.stopPropagation(); }
                if (e.key === 'Enter') e.stopPropagation();
            });
        });
    }
}

// ── Virtual-scroll helpers ────────────────────────────────────────────────────
const _SR_VS_CHUNK = 80;
let _srVsObserver = null;

function _srVsObserve(sentinel, onVisible) {
    if (_srVsObserver) { _srVsObserver.disconnect(); _srVsObserver = null; }
    if (!sentinel) return;
    _srVsObserver = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting) onVisible();
    }, { root: document.getElementById('sr-panel'), rootMargin: '200px' });
    _srVsObserver.observe(sentinel);
}

function _srVsStop() {
    if (_srVsObserver) { _srVsObserver.disconnect(); _srVsObserver = null; }
}

// ── Render only the #sr-results area (virtual scroll) ────────────────────────
function _srRenderResults() {
    const resultsEl = document.getElementById('sr-results');
    if (!resultsEl) return;
    _srVsStop();
    _srState._vsEnd = 0;

    const q = _srState.query;

    if (_srState.mode === 'files') {
        const results = _srState.results;
        if (!results.length) {
            resultsEl.innerHTML = q
                ? `<div class="sr-empty">${T('searchNoFilesMatching', { query: escapeHtml(q) })}</div>`
                : '';
            return;
        }

        // Tree view
        if (_srState.fileViewMode === 'tree') {
            _srRenderFileTree(resultsEl, results, q);
            return;
        }

        // List view (virtual scroll)
        const end = Math.min(_SR_VS_CHUNK, results.length);
        resultsEl.innerHTML = _srBuildFileRowsHtml(results, 0, end, q)
            + (results.length > end ? '<div class="sr-vs-sentinel"></div>' : '');
        _srState._vsEnd = end;
        _srWireFileRows(resultsEl, results);
        _srUpdateActive();

        if (results.length > end) {
            _srVsObserve(resultsEl.querySelector('.sr-vs-sentinel'), function _vsNext() {
                const s = _srState._vsEnd;
                const e2 = Math.min(s + _SR_VS_CHUNK, results.length);
                const sentinel = resultsEl.querySelector('.sr-vs-sentinel');
                if (!sentinel) return;
                sentinel.insertAdjacentHTML('beforebegin', _srBuildFileRowsHtml(results, s, e2, q));
                _srState._vsEnd = e2;
                _srWireFileRows(resultsEl, results);
                if (e2 >= results.length) _srVsStop();
            });
        }

    } else {
        const groups = _srFilteredGroups();

        if (_srState._contentLoading && groups.length === 0) {
            resultsEl.innerHTML = `<div class="sr-loading">
              <span class="sr-dot"></span><span class="sr-dot"></span><span class="sr-dot"></span>
              <span>Searching…</span></div>`;
            return;
        }
        if (_srState._contentDone && groups.length === 0) {
            resultsEl.innerHTML = q
                ? `<div class="sr-empty">No results for <strong style="color:var(--text)">"${escapeHtml(q)}"</strong></div>`
                : '';
            return;
        }

        if (_srState.viewMode === 'tree') {
            _srRenderTree(resultsEl, groups, q);
        } else {
            _srRenderCodeList(resultsEl, groups, q);
        }
    }
}

// ── Files mode: build a slice of rows as HTML ────────────────────────────────
function _srBuildFileRowsHtml(results, start, end, q) {
    let html = '';
    for (let i = start; i < end; i++) {
        const r = results[i];
        if (!r) continue;
        const mc = _srModuleColor(r.module);
        const ic = _extIcon(r.ext);
        const nm = r._fuzzyLabelPos
            ? _srFuzzyHighlight(r.label, r._fuzzyLabelPos)
            : _srHighlight(r.label, q);
        const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/') + 1) : '';
        const dirHl = dir ? `<span class="sr-fi-dir">${r._fuzzyPathPos
            ? _srFuzzyHighlight(dir, r._fuzzyPathPos.filter(i => i < dir.length))
            : _srHighlight(dir, q)}</span>` : '';
        const ac = i === _srState.activeIdx ? ' sr-active' : '';
        const fcBadge = r.func_count > 0
            ? `<span class="sr-fi-fc" data-tip="${r.func_count} functions">ƒ ${r.func_count}</span>` : '';
        const szBadge = r.size > 0
            ? `<span class="sr-fi-sz">${_fmtBytes(r.size)}</span>` : '';
        html += `<div class="sr-fi-row${ac}" data-idx="${i}">
  <div class="sr-fi-left" style="border-left-color:${mc}"><span class="sr-fi-icon">${ic}</span></div>
  <div class="sr-fi-body">
    <div class="sr-fi-name">${nm}</div>
    <div class="sr-fi-path">${dirHl}<span class="sr-fi-mod" style="background:${mc}22;color:${mc};border:1px solid ${mc}44">${escapeHtml(r.module)}</span>${fcBadge}${szBadge}</div>
  </div>
</div>`;
    }
    return html;
}

function _fmtBytes(b) {
    if (b < 1024) return b + 'B';
    if (b < 1048576) return (b / 1024).toFixed(0) + 'KB';
    return (b / 1048576).toFixed(1) + 'MB';
}

function _srWireFileRows(container, results) {
    container.querySelectorAll('.sr-fi-row:not([data-wired])').forEach(row => {
        row.dataset.wired = '1';
        const idx = parseInt(row.dataset.idx, 10);
        const r = results[idx];
        if (!r) return;
        row.addEventListener('click', () => _srSelectResult(r));
        row.addEventListener('mouseenter', () => { _srState.activeIdx = idx; _srHoverResult(r); _srUpdateActive(); });
    });
}

// ── File tree mode: group results by folder ───────────────────────────────────
function _srBuildFileTree(results) {
    // Build a nested folder structure from flat result list
    const root = { name: '', path: '', children: [], files: [] };
    const nodeMap = { '': root };
    function getNode(folderPath) {
        if (nodeMap[folderPath]) return nodeMap[folderPath];
        const parts = folderPath.split('/');
        const name = parts[parts.length - 1];
        const parent = parts.slice(0, -1).join('/');
        const parentNode = getNode(parent);
        const node = { name, path: folderPath, children: [], files: [] };
        parentNode.children.push(node);
        nodeMap[folderPath] = node;
        return node;
    }
    for (const r of results) {
        const lastSlash = r.path.lastIndexOf('/');
        const folder = lastSlash >= 0 ? r.path.slice(0, lastSlash) : '';
        getNode(folder).files.push(r);
    }
    function sortNode(n) {
        n.children.sort((a, b) => a.name.localeCompare(b.name));
        n.children.forEach(sortNode);
    }
    sortNode(root);
    return root;
}

function _srRenderFileTreeNode(node, q, depth) {
    let html = '';
    const indent = depth * 14;
    for (const child of node.children) {
        const isOpen = _srState._openFileFolders.has(child.path);
        html += `<div class="sr-fi-tree-folder">
  <div class="sr-fi-tree-folder-hdr" data-fpath="${escapeHtml(child.path)}" style="padding-left:${indent + 6}px">
    <span class="sr-fi-tree-chevron sr-chevron${isOpen ? ' open' : ''}">${isOpen ? '▾' : '▸'}</span>
    <span class="sr-tree-folder-icon">📁</span>
    <span class="sr-tree-folder-name">${escapeHtml(child.name)}</span>
    <span class="sr-match-badge" style="margin-left:auto">${_srCountFileTreeMatches(child)}</span>
  </div>
  <div class="sr-fi-tree-body" style="${isOpen ? '' : 'display:none'}">
    ${_srRenderFileTreeNode(child, q, depth + 1)}
  </div>
</div>`;
    }
    for (const r of node.files) {
        const mc = _srModuleColor(r.module);
        const ic = _extIcon(r.ext);
        const nm = r._fuzzyLabelPos ? _srFuzzyHighlight(r.label, r._fuzzyLabelPos) : _srHighlight(r.label, q);
        const fcBadge = r.func_count > 0 ? `<span class="sr-fi-fc" data-tip="${r.func_count} functions">ƒ ${r.func_count}</span>` : '';
        html += `<div class="sr-fi-row sr-fi-tree-file" data-path="${escapeHtml(r.path)}" style="padding-left:${indent + 24}px">
  <div class="sr-fi-left" style="border-left-color:${mc}"><span class="sr-fi-icon">${ic}</span></div>
  <div class="sr-fi-body">
    <div class="sr-fi-name">${nm}</div>
    <div class="sr-fi-path"><span class="sr-meta-mod" style="background:${mc}22;color:${mc};border:1px solid ${mc}44">${escapeHtml(r.module)}</span>${fcBadge}</div>
  </div>
</div>`;
    }
    return html;
}

function _srCountFileTreeMatches(node) {
    let n = node.files.length;
    for (const c of node.children) n += _srCountFileTreeMatches(c);
    return n;
}

function _srRenderFileTree(resultsEl, results, q) {
    const tree = _srBuildFileTree(results);
    // Default: open top-level folders
    if (_srState._openFileFolders.size === 0) {
        tree.children.forEach(c => _srState._openFileFolders.add(c.path));
    }
    const html = _srRenderFileTreeNode(tree, q, 0);
    resultsEl.innerHTML = html || `<div class="sr-empty">No results</div>`;

    // Wire clicks on folder headers
    resultsEl.querySelectorAll('.sr-fi-tree-folder-hdr').forEach(hdr => {
        hdr.addEventListener('click', () => {
            const fpath = hdr.dataset.fpath;
            const body = hdr.nextElementSibling;
            const chev = hdr.querySelector('.sr-fi-tree-chevron');
            if (_srState._openFileFolders.has(fpath)) {
                _srState._openFileFolders.delete(fpath);
                if (body) body.style.display = 'none';
                if (chev) { chev.classList.remove('open'); chev.textContent = '▸'; }
            } else {
                _srState._openFileFolders.add(fpath);
                if (body) body.style.display = '';
                if (chev) { chev.classList.add('open'); chev.textContent = '▾'; }
            }
        });
    });

    // Wire clicks on file rows
    resultsEl.querySelectorAll('.sr-fi-tree-file').forEach(row => {
        const path = row.dataset.path;
        const r = results.find(x => x.path === path);
        if (!r) return;
        row.addEventListener('click', () => _srSelectResult(r));
        row.addEventListener('mouseenter', () => _srHoverResult(r));
    });
}

// ── Code mode: virtual-scroll flat list ──────────────────────────────────────
function _srRenderCodeList(resultsEl, groups, q) {
    const end = Math.min(_SR_VS_CHUNK, groups.length);
    let html = _srBuildCodeGroupsHtml(groups, 0, end, q);
    if (groups.length > end) html += '<div class="sr-vs-sentinel"></div>';
    if (_srState._contentLoading) html += _srStreamingBarHtml();
    resultsEl.innerHTML = html;
    _srState._vsEnd = end;
    _srWireCodeGroups(resultsEl, groups);

    if (groups.length > end) {
        _srVsObserve(resultsEl.querySelector('.sr-vs-sentinel'), function _cvsNext() {
            const liveGroups = _srFilteredGroups();
            const s = _srState._vsEnd;
            const e2 = Math.min(s + _SR_VS_CHUNK, liveGroups.length);
            const sentinel = resultsEl.querySelector('.sr-vs-sentinel');
            if (!sentinel) return;
            sentinel.insertAdjacentHTML('beforebegin', _srBuildCodeGroupsHtml(liveGroups, s, e2, q));
            _srState._vsEnd = e2;
            _srWireCodeGroups(resultsEl, liveGroups);
            if (e2 >= liveGroups.length) _srVsStop();
        });
    }
}

// ── Code mode: append streaming batches (no full re-render) ──────────────────
function _srAppendCodeGroups(resultsEl, groups, q) {
    if (!resultsEl) return;
    const loading = resultsEl.querySelector('.sr-loading');
    if (loading) loading.remove();
    const rendered = _srState._vsEnd || 0;
    const maxFirst = Math.min(groups.length, _SR_VS_CHUNK);

    if (rendered < maxFirst) {
        const html = _srBuildCodeGroupsHtml(groups, rendered, maxFirst, q);
        const streamBar = resultsEl.querySelector('.sr-streaming-bar');
        const sentinel = resultsEl.querySelector('.sr-vs-sentinel');
        const insertBefore = sentinel || streamBar;
        if (insertBefore) insertBefore.insertAdjacentHTML('beforebegin', html);
        else resultsEl.insertAdjacentHTML('beforeend', html);
        _srState._vsEnd = maxFirst;
        _srWireCodeGroups(resultsEl, groups);
    }

    if (groups.length > _SR_VS_CHUNK) {
        let sentinel = resultsEl.querySelector('.sr-vs-sentinel');
        if (!sentinel) {
            const streamBar = resultsEl.querySelector('.sr-streaming-bar');
            if (streamBar) {
                streamBar.insertAdjacentHTML('beforebegin', '<div class="sr-vs-sentinel"></div>');
            } else {
                resultsEl.insertAdjacentHTML('beforeend', '<div class="sr-vs-sentinel"></div>');
            }
            sentinel = resultsEl.querySelector('.sr-vs-sentinel');
        }
        _srVsObserve(sentinel, function _cvsNext() {
            const liveGroups = _srFilteredGroups();
            const s = _srState._vsEnd;
            const e2 = Math.min(s + _SR_VS_CHUNK, liveGroups.length);
            const sentinelEl = resultsEl.querySelector('.sr-vs-sentinel');
            if (!sentinelEl) return;
            sentinelEl.insertAdjacentHTML('beforebegin', _srBuildCodeGroupsHtml(liveGroups, s, e2, q));
            _srState._vsEnd = e2;
            _srWireCodeGroups(resultsEl, liveGroups);
            if (e2 >= liveGroups.length) _srVsStop();
        });
    }
}

function _srRenderStreamingBatch() {
    const resultsEl = document.getElementById('sr-results');
    if (!resultsEl) return;
    const groups = _srFilteredGroups();
    const q = _srState.query;

    if (groups.length === 0) {
        const hasLoading = resultsEl.querySelector('.sr-loading');
        const hasEmpty = resultsEl.querySelector('.sr-empty');
        if (_srState._contentLoading && !hasLoading) _srRenderResults();
        if (_srState._contentDone && !hasEmpty) _srRenderResults();
        return;
    }

    if (_srState.viewMode === 'list' && !_srState._filterFuncOnly) {
        if (!_srState._streamRendered || _srState._streamRenderMode !== 'list') {
            _srRenderCodeList(resultsEl, groups, q);
            _srState._streamRendered = true;
            _srState._streamRenderMode = 'list';
            return;
        }
        _srAppendCodeGroups(resultsEl, groups, q);
    } else {
        if (!_srState._streamRendered || _srState._streamRenderMode !== 'tree') {
            _srRenderTree(resultsEl, groups, q);
            _srState._streamRendered = true;
            _srState._streamRenderMode = 'tree';
        }
    }
}

function _srBuildCodeGroupsHtml(groups, start, end, q) {
    let html = '';
    for (let i = start; i < end; i++) {
        const g = groups[i];
        if (!g) continue;
        const isOpen = _srState._openGroups.has(g.path);
        const ic = _extIcon(g.ext);
        const mc = g.color || _srModuleColor(g.module);
        const dir = g.path.includes('/') ? g.path.slice(0, g.path.lastIndexOf('/')) : '';
        const fnHl = _srHighlight(g.label, q);
        html += `<div class="sr-file-group">
  <div class="sr-file-header" data-gpath="${escapeHtml(g.path)}">
    <span class="sr-chevron${isOpen ? ' open' : ''}">${isOpen ? '▾' : '▸'}</span>
    <span class="sr-file-icon">${ic}</span>
    <div class="sr-file-name-wrap">
      <span class="sr-file-name">${fnHl}</span>
      ${dir ? `<span class="sr-file-dir">${escapeHtml(dir)}</span>` : ''}
    </div>
    <span class="sr-match-badge">${g.count}</span>
    <span class="sr-meta-mod" style="background:${mc}22;color:${mc};border:1px solid ${mc}44;font-size:9px;padding:1px 5px;border-radius:3px;margin-left:4px;flex-shrink:0">${escapeHtml(g.module)}</span>
  </div>
  ${isOpen ? `<div class="sr-match-lines">${_srMatchLinesHtml(g)}</div>` : ''}
</div>`;
    }
    return html;
}

function _srStreamingBarHtml() {
    return `<div class="sr-streaming-bar">
  <span class="sr-dot"></span><span class="sr-dot"></span><span class="sr-dot"></span>
  <span class="sr-streaming-label">searching…</span></div>`;
}

// ── Wire code group headers (DOM-toggle, no full re-render) ───────────────────
function _srWireCodeGroups(container, groups) {
    container.querySelectorAll('.sr-file-header:not([data-wired])').forEach(hdr => {
        hdr.dataset.wired = '1';
        hdr.addEventListener('click', () => {
            const p = hdr.dataset.gpath;
            const grp = hdr.closest('.sr-file-group');
            if (!grp) return;
            const wasOpen = _srState._openGroups.has(p);
            if (wasOpen) {
                _srState._openGroups.delete(p);
                const lines = grp.querySelector('.sr-match-lines');
                if (lines) lines.style.display = 'none';
            } else {
                _srState._openGroups.add(p);
                let lines = grp.querySelector('.sr-match-lines');
                if (!lines) {
                    const g = groups.find(g => g.path === p) || _srState._contentGroups.find(g => g.path === p);
                    if (g) {
                        lines = document.createElement('div');
                        lines.className = 'sr-match-lines';
                        lines.innerHTML = _srMatchLinesHtml(g);
                        grp.appendChild(lines);
                        _srWireLineRows(lines);
                    }
                } else {
                    lines.style.display = '';
                }
            }
            const chev = hdr.querySelector('.sr-chevron');
            if (chev) {
                const nowOpen = _srState._openGroups.has(p);
                chev.classList.toggle('open', nowOpen);
                chev.textContent = nowOpen ? '▾' : '▸';
            }
        });
    });
    _srWireLineRows(container);
}

// ── Code mode: tree render ────────────────────────────────────────────────────
function _srRenderTree(resultsEl, groups, q) {
    const tree = _srBuildTree(groups);
    let html = _srRenderTreeNode(tree, q, 0);
    if (_srState._contentLoading) html += _srStreamingBarHtml();
    resultsEl.innerHTML = html;
    resultsEl.querySelectorAll('.sr-tree-folder-hdr').forEach(hdr => {
        hdr.addEventListener('click', () => {
            const p = hdr.dataset.fpath;
            if (_srState._openFolders.has(p)) _srState._openFolders.delete(p);
            else _srState._openFolders.add(p);
            const body = hdr.nextElementSibling;
            if (body?.classList.contains('sr-tree-folder-body')) {
                const isNowOpen = _srState._openFolders.has(p);
                body.style.display = isNowOpen ? '' : 'none';
                const chev = hdr.querySelector('.sr-chevron');
                if (chev) { chev.classList.toggle('open', isNowOpen); chev.textContent = isNowOpen ? '▾' : '▸'; }
            }
        });
    });
    _srWireCodeGroups(resultsEl, groups);
}

// ── Render ────────────────────────────────────────────────────────────────────
function _srRenderPanel() {
    const panel = document.getElementById('sr-panel');
    const countEl = document.getElementById('sr-count');
    if (!panel) return;

    const q = _srState.query;

    if (countEl) {
        if (_srState._contentLoading && _srState._contentTotal === 0) {
            countEl.textContent = '…';
        } else {
            const n = _srState.mode === 'code' ? _srState._contentTotal : _srState.results.length;
            countEl.textContent = n > 0 ? n.toLocaleString() : (q ? '0' : '');
            countEl.style.color = n > 0 ? 'var(--accent)' : 'var(--muted)';
        }
    }

    if (!q) { panel.classList.remove('visible'); _srRenderActionBar(); return; }
    panel.classList.add('visible');

    let actionBar = document.getElementById('sr-action-bar');
    let resultsEl = document.getElementById('sr-results');

    if (!actionBar || !resultsEl) {
        panel.innerHTML = `
<div id="sr-action-bar" class="sr-action-bar" style="display:none"></div>
<div id="sr-results"></div>
<div class="sr-footer">
  <span class="sr-footer-hint"><kbd>↑↓</kbd> ${T('searchHintNavigate')}</span>
  <span class="sr-footer-hint"><kbd>↵</kbd> ${T('searchHintOpen')}</span>
  <span class="sr-footer-hint"><kbd>Tab</kbd> ${T('searchHintSwitchMode')}</span>
  <span class="sr-footer-hint"><kbd>Esc</kbd> ${T('searchHintClose')}</span>
</div>`;
    }

    _srRenderActionBar();
    _srRenderResults();
}



// ── Navigate to a graph node + open code panel ────────────────────────────────
function _srHoverResult(r) {
    if (!cy) return;
    const filePath = r.filePath || r.path;
    if (!filePath) return;
    cy.nodes().forEach(n => { const f = n.data('_f'); if (f && f.path === filePath) highlightNode(n); });
}

function _srSelectResult(r) {
    // Keep panel open so user can keep browsing results
    const filePath = r.filePath || r.path;
    const module = r.module || (filePath ? filePath.split('/')[0] : null);
    const funcName = r._type === 'func' ? r.name : null;
    if (filePath && module) {
        if (state.level !== 1 || state.activeModule !== module) {
            drillToModule(module, { focusFile: filePath });
        } else {
            const target = cy.nodes().filter(n => { const f = n.data('_f'); return f && f.path === filePath; }).first();
            if (target && target.length) {
                highlightNode(target);
                cy.animate({ center: { eles: target }, zoom: Math.max(cy.zoom(), 1.8) },
                    { duration: 500, easing: 'ease-in-out-cubic' });
            }
        }
    }
    if (filePath) setTimeout(() => loadFileInPanel(filePath, funcName), 150);
}

function _srSelectContentLine(filePath, line) {
    // Keep panel open for continued browsing
    const module = filePath ? filePath.split('/')[0] : null;
    if (filePath && module) {
        if (state.level !== 1 || state.activeModule !== module) {
            drillToModule(module, { focusFile: filePath });
        } else {
            const target = cy.nodes().filter(n => { const f = n.data('_f'); return f && f.path === filePath; }).first();
            if (target && target.length) {
                highlightNode(target);
                cy.animate({ center: { eles: target }, zoom: Math.max(cy.zoom(), 1.8) },
                    { duration: 500, easing: 'ease-in-out-cubic' });
            }
        }
    }
    if (filePath) {
        setTimeout(async () => {
            await loadFileInPanel(filePath);
            if (line) setTimeout(() => {
                const el = document.getElementById(`cl-${line - 1}`);
                if (el) {
                    document.querySelectorAll('.code-line.fn-highlight').forEach(e => e.classList.remove('fn-highlight'));
                    el.classList.add('fn-highlight');
                    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }
            }, 320);
        }, 150);
    }
}

// ── Keyboard active highlight ─────────────────────────────────────────────────
function _srUpdateActive() {
    const el = document.getElementById('sr-results');
    if (!el) return;
    // Support both old sr-row style and new sr-fi-row style
    el.querySelectorAll('.sr-row[data-rtype="top"], .sr-fi-row').forEach(row => {
        const idx = parseInt(row.dataset.idx, 10);
        row.classList.toggle('sr-active', idx === _srState.activeIdx);
    });
    const active = el.querySelector('.sr-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
}

// ── Close ─────────────────────────────────────────────────────────────────────
function _srClose() {
    const panel = document.getElementById('sr-panel');
    if (panel) panel.classList.remove('visible');
    _srState.activeIdx = -1;
    if (cy) cy.elements().removeClass('faded hl');
}

// ── onSearch (called from input event) ───────────────────────────────────────
function onSearch(e) {
    const q = (e.target.value || '').trim();
    _srState.query = q;
    _srState.activeIdx = -1;
    _srState._openGroups = new Set();

    if (!q) {
        // Clear query but DON'T close panel — user may still want to see it
        if (_srStream) { _srStream.close(); _srStream = null; }
        _srState._contentGroups = [];
        _srState._contentTotal = 0;
        _srState._contentFiles = 0;
        _srState._contentLoading = false;
        _srState._contentDone = true;
        _srState.results = [];
        _srRenderPanel();
        if (cy) cy.elements().removeClass('faded hl');
        return;
    }

    _srBuildIndex();

    if (_srState.mode === 'files') {
        _srState.results = _srSearchFiles(q);
        _srRenderPanel();
    } else {
        _srState.results = [];
        _srState._streamRendered = false;
        _srState._streamRenderMode = _srState.viewMode;
        _srRenderPanel();   // show panel with loading state immediately
        _srDebounce(q);
    }

    // Graph node fade-highlight
    if (cy && state.level <= 1) {
        cy.elements().addClass('faded');
        cy.nodes().forEach(n => {
            const f = n.data('_f');
            const lbl = (f ? f.label : n.data('label')) || '';
            if (lbl.toLowerCase().includes(q.toLowerCase())) n.removeClass('faded').addClass('hl');
        });
    }

    if (_srState.mode === 'files') _srRenderPanel();
}

// ── Mode toggle ───────────────────────────────────────────────────────────────
function _srSetMode(mode) {
    _srState.mode = mode;
    document.querySelectorAll('.sr-mode').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    const input = document.getElementById('search');
    const filters = document.getElementById('sr-filters');
    if (input) input.placeholder = mode === 'files' ? T('searchPlaceholderFiles') : T('searchPlaceholderCode');
    if (filters) filters.classList.toggle('visible', mode === 'code');
    // Force panel skeleton rebuild on mode switch
    const panel = document.getElementById('sr-panel');
    if (panel) panel.innerHTML = '';
    if (_srState.query) {
        _srBuildIndex();
        if (mode === 'files') {
            _srState.results = _srSearchFiles(_srState.query);
            _srRenderPanel();
        } else {
            _srState.results = [];
            _srDebounce(_srState.query);
        }
    }
}

// ── initSearch ────────────────────────────────────────────────────────────────
function initSearch() {
    const input = document.getElementById('search');
    if (!input) return;

    // Mode pills
    document.querySelectorAll('.sr-mode').forEach(btn => {
        btn.addEventListener('click', () => _srSetMode(btn.dataset.mode));
    });

    // Toggle buttons (Aa / ab / .*)
    const toggleMap = {
        'srt-case': 'matchCase',
        'srt-word': 'wholeWord',
        'srt-regex': 'isRegex',
    };
    Object.entries(toggleMap).forEach(([id, key]) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener('click', () => {
            _srState[key] = !_srState[key];
            btn.classList.toggle('active', _srState[key]);
            // isRegex and wholeWord are mutually exclusive
            if (key === 'isRegex' && _srState[key] && _srState.wholeWord) {
                _srState.wholeWord = false;
                document.getElementById('srt-word').classList.remove('active');
            }
            if (key === 'wholeWord' && _srState[key] && _srState.isRegex) {
                _srState.isRegex = false;
                document.getElementById('srt-regex').classList.remove('active');
            }
            if (_srState.query) onSearch({ target: input });
        });
    });

    // Keyboard shortcuts for toggles
    input.addEventListener('keydown', e => {
        if (e.altKey) {
            if (e.key === 'c' || e.key === 'C') { e.preventDefault(); document.getElementById('srt-case').click(); }
            if (e.key === 'w' || e.key === 'W') { e.preventDefault(); document.getElementById('srt-word').click(); }
            if (e.key === 'r' || e.key === 'R') { e.preventDefault(); document.getElementById('srt-regex').click(); }
        }
    });

    // Include / Exclude filter inputs
    ['sr-include', 'sr-exclude'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            _srState.include = document.getElementById('sr-include')?.value.trim() || '';
            _srState.exclude = document.getElementById('sr-exclude')?.value.trim() || '';
            if (_srState.query && _srState.mode === 'code') _srDebounce(_srState.query);
        });
        // Prevent search navigation keys from leaving filter input
        el.addEventListener('keydown', e => {
            if (e.key === 'Escape') { el.value = ''; el.dispatchEvent(new Event('input')); }
        });
    });

    // Main input events
    input.addEventListener('input', onSearch);

    // Keyboard navigation
    input.addEventListener('keydown', e => {
        if (e.altKey) return;  // handled above
        const allResults = _srState.results;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            _srState.activeIdx = Math.min(_srState.activeIdx + 1, allResults.length - 1);
            _srUpdateActive();
            if (allResults[_srState.activeIdx]) _srHoverResult(allResults[_srState.activeIdx]);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            _srState.activeIdx = Math.max(_srState.activeIdx - 1, 0);
            _srUpdateActive();
            if (allResults[_srState.activeIdx]) _srHoverResult(allResults[_srState.activeIdx]);
        } else if (e.key === 'Enter') {
            const r = allResults[_srState.activeIdx] || (allResults.length === 1 ? allResults[0] : null);
            if (r) _srSelectResult(r);
        } else if (e.key === 'Escape') {
            input.value = '';
            _srState.query = '';
            _srClose();
            if (cy) cy.elements().removeClass('faded hl');
            input.blur();
        } else if (e.key === 'Tab') {
            e.preventDefault();
            _srSetMode(_srState.mode === 'files' ? 'code' : 'files');
        }
    });

    // Panel stays open while user interacts — only close on Escape or clicking graph canvas
    document.getElementById('cy').addEventListener('click', () => {
        if (_srState.query) return; // only close if no active query
        _srClose();
    });

    // Click outside search area → temporarily hide panel (re-focus to restore)
    document.addEventListener('click', e => {
        const panel = document.getElementById('sr-panel');
        if (!panel || !panel.classList.contains('visible')) return;
        // All elements that are part of the search UI
        const searchUiIds = ['sr-panel', 'search-wrap', 'sr-modes', 'sr-toggles', 'sr-filters', 'search'];
        const inside = searchUiIds.some(id => {
            const el = document.getElementById(id);
            return el && el.contains(e.target);
        });
        if (!inside) {
            panel.classList.remove('visible');
            // Don't clear query — re-focusing input will restore panel
        }
    }, true); // capture phase

    // Reopen on focus
    input.addEventListener('focus', () => {
        if (_srState.query) _srRenderPanel();
    });
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────
function onKey(e) {
    const tag = e.target.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA';
    if (e.key === '/') {
        if (!inInput) { e.preventDefault(); document.getElementById('search').focus(); }
        return;
    }
    if (inInput) return;
    if (e.key === 'Escape') {
        const srPanel = document.getElementById('sr-panel');
        if (srPanel && srPanel.classList.contains('visible')) {
            document.getElementById('search').value = '';
            _srState.query = '';
            _srClose();
            if (cy) cy.elements().removeClass('faded hl');
            return;
        }
        document.getElementById('search').value = '';
        if (cy) cy.elements().removeClass('faded hl');
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
    if (tooltipHideTimer) clearTimeout(tooltipHideTimer);

    const d = e.target.data();
    if (!d || !d.tt) return;

    window._currentHoverNode = e.target.isNode() ? e.target : null;

    let html = '';

    if (e.target.isNode()) {
        const outCount = e.target.outgoers('edge').length;
        const inCount = e.target.incomers('edge').length;

        if (d._t === 'ext_func') {
            const fileRel = d._f || '';
            const funcName = d.fn || '';
            html += `<div class="tip-title" title="${escapeHtml(funcName)}">${escapeHtml(funcName)}</div>`;
            html += fileRel
                ? `<div class="tip-body">${escapeHtml(fileRel)}</div>`
                : `<div class="tip-body">${escapeHtml(T('tooltipUnknownTarget'))}</div>`;
            html += `<div class="tip-actions">` +
                `<button class="tip-btn" data-action="open" data-file="${encodeURIComponent(fileRel)}" data-func="${encodeURIComponent(funcName)}">${escapeHtml(T('tooltipOpenLocation'))}</button>` +
                `<button class="tip-btn" data-action="view" data-file="${encodeURIComponent(fileRel)}" data-func="${encodeURIComponent(funcName)}">${escapeHtml(T('tooltipViewFile'))}</button>` +
                `</div>`;
        } else {

            // 取得 tooltip 原文字的第一行 (標題/路徑) 和剩餘內容
            const lines = d.tt ? d.tt.split('\n') : [];
            const titleRaw = lines[0] || '';
            const bodyLines = lines.slice(1).join('<br>').trim();

            // 1. 處理檔名過長 (使用 css ellipsis 或截斷)
            html += `<div class="tip-title" title="${escapeHtml(titleRaw)}">${escapeHtml(titleRaw)}</div>`;

            if (bodyLines) {
                html += `<div class="tip-body">${bodyLines}</div>`;
            }
        }

        // 2. 處理 dependencies 文字和顏色
        if (outCount > 0 || inCount > 0) {
            html += `<div style="margin-top:10px; border-top:1px solid #334155; padding-top:6px;">`;
            html += `<div style="font-weight:bold; margin-bottom:4px">${T('dependencies')}:</div>`;

            const OUT_MAP = {
                'Inc': T('relInclude'), 'owns': T('relOwns'), 'Src': T('relSources'), 'Pkg': T('relPackage'), 'Lib': T('relLibrary'),
                'ELINK': T('relElink'), 'Comp': T('relComponent'), 'GUID': T('relGuidRef'),
                'Strings': T('relStrings'), 'ASL': T('relAslInclude'), 'Callback': T('relCallback'),
                'HII-Pkg': T('relHiiPkg'), 'Depex': T('relDepex'),
                'Import': T('relImports'),
                'ext': T('relExternalCalls'), 'group': T('relGroup'),
                '': state.level === 2 ? T('relCalls') : T('relIncludes')
            };
            const IN_MAP = {
                'Inc': T('relIncludedBy'), 'owns': T('relOwnedBy'), 'Src': T('relSourceOf'), 'Pkg': T('relPackagedIn'), 'Lib': T('relUsedAsLibBy'),
                'ELINK': T('relElinkParentOf'), 'Comp': T('relUsedAsCompBy'), 'GUID': T('relReferencedGuidBy'),
                'Strings': T('relReferencedAsStringBy'), 'ASL': T('relIncludedByAsl'), 'Callback': T('relTriggeredBy'),
                'HII-Pkg': T('relPackagedInHii'), 'Depex': T('relDependedBy'),
                'Import': T('relImportedBy'),
                'ext': T('relExternalCallers'), 'group': T('relGroup'),
                '': state.level === 2 ? T('relCalledBy') : T('relIncludedBy')
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
    if (document.getElementById('node-modal-backdrop')?.classList.contains('show')) {
        return; // Don't show tooltip if modal is open
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    tip.style.left = (e.originalEvent.clientX + 14) + 'px';
    tip.style.top = (e.originalEvent.clientY + 14) + 'px';
}
function hideTooltip() { document.getElementById('tooltip').style.display = 'none'; }

function scheduleHideTooltip() {
    if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
    tooltipHideTimer = setTimeout(() => {
        if (!tooltipPinned) {
            hideTooltip();
            clearHighlight();
        }
    }, 120);
}

// ─── Loading ──────────────────────────────────────────────────────────────────
function showLoading(v, msg) {
    const el = document.getElementById('loading');
    const sp = document.querySelector('#loading .spinner');
    el.classList.toggle('show', v);
    if (v && msg) document.getElementById('loading-msg').textContent = msg;
    if (sp) sp.style.display = '';
    const cancelBtn = document.getElementById('loading-cancel-btn');
    if (cancelBtn) cancelBtn.style.display = v ? '' : 'none';
}

function cancelRender() {
    _renderToken++; // invalidate any in-flight render
    showLoading(false);
    showToast('已取消渲染 (Render cancelled)', 'info');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function dedupeBy(arr, key) { return [...new Map(arr.map(x => [x[key], x])).values()]; }
function fmtSize(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + 'MB' : b > 1e3 ? (b / 1e3).toFixed(0) + 'KB' : b + 'B'; }

// ─── Path Distance ────────────────────────────────────────────────────────────
// Steps-up from a to common ancestor + steps-down to b.
// e.g. A/B/C/F ↔ A/D/E/F  →  shared=1  →  (3-1)+(3-1) = 4
// Color thresholds: 0=blue  ≤2=green  ≤4=amber  >4=red
function _pathDist(a, b) {
    if (!a || !b) return a === b ? 0 : 99;
    if (a === b) return 0;
    const pa = a.replace(/\\/g, '/').split('/');
    const pb = b.replace(/\\/g, '/').split('/');
    let shared = 0;
    const ml = Math.min(pa.length, pb.length);
    for (let i = 0; i < ml; i++) {
        if (pa[i] === pb[i]) shared++;
        else break;
    }
    return (pa.length - shared) + (pb.length - shared);
}

function _distColor(d) {
    if (d === 0) return '#38bdf8'; // blue  — same file / same module
    if (d <= 2) return '#10b981'; // green — nearby (same folder/package)
    if (d <= 4) return '#f59e0b'; // amber — different subfolder
    if (d >= 99) return '#64748b'; // grey  — unknown
    return '#f87171';               // red   — far / cross-package
}

function _distLabel(d) {
    if (d === 0) return 'same file';
    if (d >= 99) return 'external';
    return `${d} layer${d !== 1 ? 's' : ''} away`;
}

// ─── Graph Legend ─────────────────────────────────────────────────────────────
const LEGEND_EDGES = [
    // elKey = value stored in edge.data('el')
    { type: 'include', label: 'Include', color: '#c084fc', style: 'solid', elKey: 'Inc' },
    { type: 'import', label: 'Import', color: '#10b981', style: 'dashed', elKey: 'Import' },
    { type: 'sources', label: 'Src', color: '#ffd700', style: 'solid', elKey: 'Src' },
    { type: 'package', label: 'Pkg', color: '#00d4ff', style: 'dashed', elKey: 'Pkg' },
    { type: 'library', label: 'Lib', color: '#a78bfa', style: 'dashed', elKey: 'Lib' },
    { type: 'cif_own', label: 'owns', color: '#34d399', style: 'solid', elKey: 'owns' },
    { type: 'component', label: 'Comp', color: '#60a5fa', style: 'solid', elKey: 'Comp' },
    { type: 'guid_ref', label: 'GUID', color: '#fb923c', style: 'dashed', elKey: 'GUID' },
    { type: 'elink', label: 'ELINK', color: '#ff6b35', style: 'dotted', elKey: 'ELINK' },
    { type: 'str_ref', label: 'Strings', color: '#e879f9', style: 'dashed', elKey: 'Strings' },
    { type: 'hii_pkg', label: 'HII-Pkg', color: '#94a3b8', style: 'solid', elKey: 'HII-Pkg' },
    { type: 'callback_ref', label: 'Callback', color: '#f87171', style: 'dotted', elKey: 'Callback' },
    { type: 'asl_include', label: 'ASL', color: '#818cf8', style: 'solid', elKey: 'ASL' },
    { type: 'depex', label: 'Depex', color: '#f472b6', style: 'dotted', elKey: 'Depex' },
];
const LEGEND_NODES = [
    // exts = file extensions (lowercase, with dot) that map to this legend entry
    { shape: '◆', label: '.inf', color: '#ffd700', exts: ['.inf'] },
    { shape: '⬡', label: '.dec', color: '#00d4ff', exts: ['.dec'] },
    { shape: '⬟', label: '.sdl', color: '#34d399', exts: ['.sdl'] },
    { shape: '▣', label: '.cif', color: '#60a5fa', exts: ['.cif'] },
    { shape: '●', label: '.c/.h', color: '#3b82f6', exts: ['.c', '.h'] },
    { shape: '▲', label: '.asm', color: '#f59e0b', exts: ['.asm', '.s', '.nasm'] },
    { shape: '⬠', label: '.dsc', color: '#e2e8f0', exts: ['.dsc'] },
    { shape: '‣', label: '.vfr/.hfr', color: '#f472b6', exts: ['.vfr', '.hfr'] },
    { shape: '□', label: '.uni', color: '#fb923c', exts: ['.uni'] },
    { shape: '▷', label: '.asl', color: '#a78bfa', exts: ['.asl', '.aslc'] },
    { shape: '⬦', label: '.py', color: '#4584c3', exts: ['.py'] },
    { shape: '◱', label: '.js/.mjs', color: '#f0c040', exts: ['.js', '.mjs', '.cjs'] },
    { shape: '◱', label: '.jsx', color: '#61dafb', exts: ['.jsx'] },
    { shape: '⬔', label: '.ts/.tsx', color: '#3b8fd4', exts: ['.ts', '.tsx'] },
    { shape: '⬡', label: '.go', color: '#00c6db', exts: ['.go'] },
];

// ─── SVG edge preview helper (shared) ────────────────────────────────────────
function _edgeLine(col, style) {
    const dash = style === 'dashed' ? '6,4' : style === 'dotted' ? '2,3' : 'none';
    const strokeDash = dash !== 'none' ? `stroke-dasharray="${dash}"` : '';
    return `<svg width="32" height="10" style="vertical-align:middle;overflow:visible">
        <line x1="0" y1="5" x2="32" y2="5" stroke="${col}" stroke-width="2" ${strokeDash}/>
        <polygon points="28,2 34,5 28,8" fill="${col}"/>
    </svg>`;
}

function buildLegend() {
    // Only created dynamically in refreshLegend now
}

// ─── Dynamic Legend Refresh ───────────────────────────────────────────────────
// Call after any graph (re)render in L1. Reads cy elements and shows only the
// edge types / node shapes that actually appear in the current view.
function refreshLegend() {
    // 1. Collect edge el-keys present in the graph
    const usedEdgeKeys = new Set();
    cy.edges().forEach(edge => {
        const el = edge.data('el');
        if (el != null) usedEdgeKeys.add(el);
    });

    // 2. Collect file extensions present in file/dep_ext_file nodes
    const usedExts = new Set();
    cy.nodes().forEach(node => {
        const t = node.data('_t');
        if (t !== 'file' && t !== 'dep_ext_file') return;
        const f = node.data('_f');
        const path = (f && f.path) || node.data('label') || '';
        if (!path) return;
        const dotIdx = path.lastIndexOf('.');
        if (dotIdx !== -1) usedExts.add(path.slice(dotIdx).toLowerCase());
    });

    // 3. Filter legend arrays
    const activeEdges = LEGEND_EDGES.filter(e => usedEdgeKeys.has(e.elKey));
    const activeNodes = LEGEND_NODES.filter(n => n.exts.some(ext => usedExts.has(ext)));

    const wrap = document.getElementById('graph-wrap');
    if (!wrap) return;

    let leg = document.getElementById('graph-legend');

    if (activeEdges.length === 0 && activeNodes.length === 0) {
        if (leg) leg.remove();
        return;
    }

    // Ensure legend container exists
    if (!leg) {
        leg = document.createElement('div');
        leg.id = 'graph-legend';
        leg.className = 'legend-collapsed';
        leg.innerHTML = `
<div id="legend-title" class="legend-title" onclick="this.parentElement.classList.toggle('legend-collapsed')">
  <span>⬡</span> ${T('sidebarLegend')} <span class="legend-toggle">▾</span>
</div>
<div class="legend-body" id="legend-body"></div>`;
        wrap.appendChild(leg);
    }

    const body = document.getElementById('legend-body');
    if (!body) return;
    // Otherwise show it
    // (no-op, handled by recreating the leg element if needed)
    // 4. Render
    let html = '';
    if (activeEdges.length) {
        html += `<div class="legend-section-label">${T('edgeTypes')}</div>`;
        html += activeEdges.map(e => `
  <div class="legend-row">
    ${_edgeLine(e.color, e.style)}
    <span class="legend-label" style="color:${e.color}">${T(e.type) || e.label}</span>
  </div>`).join('');
    }
    if (activeNodes.length) {
        html += `<div class="legend-section-label" style="margin-top:8px">${T('nodeShapes')}</div>`;
        html += activeNodes.map(n => `
  <div class="legend-row">
    <span class="legend-shape" style="color:${n.color}">${n.shape}</span>
    <span class="legend-label" style="color:${n.color}">${n.label}</span>
  </div>`).join('');
    }
    body.innerHTML = html;
}

// Call on init
document.addEventListener('DOMContentLoaded', buildLegend);

// ═══════════════════════════════════════════════════════════════════════════════
// VIZCODE DASHBOARD — Analytics Overlay
// All chart instances stored here for destroy/recreate on resize
// ═══════════════════════════════════════════════════════════════════════════════

const _dashCharts = {};   // id → Chart instance
let _dashBuilt = false;

// ── Chart.js global defaults ──────────────────────────────────────────────────
function _applyChartDefaults() {
    if (typeof Chart === 'undefined') return;
    Chart.defaults.color = '#64748b';
    Chart.defaults.borderColor = '#1a2535';
    Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.padding = 14;
    Chart.defaults.plugins.tooltip.backgroundColor = '#0d1520';
    Chart.defaults.plugins.tooltip.borderColor = '#1a2535';
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.plugins.tooltip.titleColor = '#e2e8f0';
    Chart.defaults.plugins.tooltip.bodyColor = '#94a3b8';
    Chart.defaults.plugins.tooltip.padding = 10;
}

// ── DOM builder ───────────────────────────────────────────────────────────────
function _buildDashboardDOM() {
    if (document.getElementById('dashboard-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'dashboard-overlay';
    overlay.innerHTML = `
<div id="dashboard-panel">
  <div id="dashboard-header">
    <span class="dash-logo-text">VIZCODE</span>
    <span class="dash-logo-sep">|</span>
    <span class="dash-logo-sub">📊 Analytics Dashboard</span>
    <button id="dashboard-close" data-tip="${T('dashClose')}">✕</button>
  </div>
  <div id="dashboard-scroll">

    <!-- ── Stat Strip ── -->
    <div class="dash-stat-strip" id="dash-stat-strip"></div>

    <!-- ── Row 1: File Types + ${T('dashFilesPerModule')} ── -->
    <div class="dash-section-label">${T('dashCodebaseComposition')}</div>
    <div class="dash-grid dash-grid-2" style="margin-bottom:16px">
      <div class="dash-card">
        <div class="dash-card-title"><span class="dash-card-title-dot"></span>${T('dashFileTypeDistribution')}</div>
        <div class="dash-chart-wrap" style="min-height:240px"><canvas id="chart-file-types"></canvas></div>
      </div>
      <div class="dash-card">
        <div class="dash-card-title"><span class="dash-card-title-dot" style="background:#ffd700"></span>${T('dashFilesPerModule')}</div>
        <div class="dash-chart-wrap" style="min-height:240px"><canvas id="chart-files-per-mod"></canvas></div>
      </div>
    </div>

    <!-- ── Row 2: Functions + Edge Types ── -->
    <div class="dash-section-label">${T('dashStructureConnectivity')}</div>
    <div class="dash-grid dash-grid-2" style="margin-bottom:16px">
      <div class="dash-card">
        <div class="dash-card-title"><span class="dash-card-title-dot" style="background:#a78bfa"></span>${T('dashFunctionsPerModule')}</div>
        <div class="dash-chart-wrap" style="min-height:220px"><canvas id="chart-funcs-per-mod"></canvas></div>
      </div>
      <div class="dash-card">
        <div class="dash-card-title"><span class="dash-card-title-dot" style="background:#fb923c"></span>${T('dashDependencyEdgeTypes')}</div>
        <div class="dash-chart-wrap" style="min-height:220px"><canvas id="chart-edge-types"></canvas></div>
      </div>
    </div>

    <!-- ── Row 3: Top Lists ── -->
    <div class="dash-section-label">${T('dashTopRankings')}</div>
    <div class="dash-grid dash-grid-2" style="margin-bottom:16px">
      <div class="dash-card">
        <div class="dash-card-title"><span class="dash-card-title-dot" style="background:#34d399"></span>${T('dashLargestFiles')}</div>
        <div class="dash-list" id="list-largest-files"></div>
      </div>
      <div class="dash-card">
        <div class="dash-card-title"><span class="dash-card-title-dot" style="background:#f472b6"></span>${T('dashMostFunctions')}</div>
        <div class="dash-list" id="list-most-funcs"></div>
      </div>
    </div>

    <!-- ── Row 4: Module Size Treemap ── -->
    <div class="dash-section-label">${T('dashModuleSizeMap')}</div>
    <div class="dash-card" style="margin-bottom:16px">
      <div class="dash-card-title"><span class="dash-card-title-dot" style="background:#60a5fa"></span>Module Footprint — proportional to total file size</div>
      <div class="dash-treemap" id="dash-treemap" style="min-height:120px"></div>
    </div>

  </div>
</div>`;
    document.body.appendChild(overlay);

    document.getElementById('dashboard-close').addEventListener('click', closeDashboard);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeDashboard(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.style.display !== 'none') closeDashboard(); });
}

// ── Entry points ──────────────────────────────────────────────────────────────
function openDashboard() {
    _buildDashboardDOM();
    _applyChartDefaults();
    const overlay = document.getElementById('dashboard-overlay');
    overlay.style.display = 'block';
    if (!_dashBuilt) { _renderDashboard(); _dashBuilt = true; }
}

function closeDashboard() {
    const overlay = document.getElementById('dashboard-overlay');
    if (overlay) overlay.style.display = 'none';
}

// ── Data helpers ──────────────────────────────────────────────────────────────
function _flatFiles() {
    // Returns flat array of all file objects from files_by_module
    if (!window.DATA) return [];
    const out = [];
    for (const [, files] of Object.entries(DATA.files_by_module || {})) {
        for (const f of files) out.push(f);
    }
    return out;
}

function _allEdges() {
    // Returns flat array of all file edge objects {s,t,type}
    if (!window.DATA) return [];
    const out = [];
    for (const [, edges] of Object.entries(DATA.file_edges_by_module || {})) {
        for (const e of edges) out.push(e);
    }
    return out;
}

function _fmtBytes(b) {
    if (b === 0) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
}

function _fmtNum(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(n);
}

// ── Stat Strip ────────────────────────────────────────────────────────────────
function _buildStatStrip() {
    const s = DATA.stats;
    const allF = _flatFiles();
    const totalSize = allF.reduce((a, f) => a + (f.size || 0), 0);
    const edges = _allEdges();

    // Estimated LOC: average 40 bytes/line heuristic for code
    const estLOC = Math.round(totalSize / 40);

    const cards = [
        {
            label: T('dashStatFiles'),
            value: _fmtNum(s.files),
            sub: T('dashStatFilesSub', { count: s.other_files || 0 }),
            accent: '#00d4ff',
        },
        {
            label: T('dashStatFunctions'),
            value: _fmtNum(s.functions),
            sub: T('dashStatFunctionsSub', { count: s.calls.toLocaleString() }),
            accent: '#a78bfa',
        },
        {
            label: T('dashStatSize'),
            value: _fmtBytes(totalSize),
            sub: `~${_fmtNum(estLOC)} lines estimated`,
            accent: '#34d399',
        },
        {
            label: 'Dependency Edges',
            value: _fmtNum(edges.length),
            sub: T('dashStatSizeSub', { count: s.modules }),
            accent: '#fb923c',
        },
    ];

    const strip = document.getElementById('dash-stat-strip');
    if (!strip) return;
    strip.innerHTML = cards.map(c => `
<div class="dash-stat-card" style="--ds-accent:${c.accent}">
  <div class="dash-stat-label">${c.label}</div>
  <div class="dash-stat-value">${c.value}</div>
  <div class="dash-stat-sub">${c.sub}</div>
</div>`).join('');
}

// ── Chart helpers ─────────────────────────────────────────────────────────────
function _mkChart(id, type, data, options) {
    if (_dashCharts[id]) { _dashCharts[id].destroy(); delete _dashCharts[id]; }
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    _dashCharts[id] = new Chart(ctx, { type, data, options });
    return _dashCharts[id];
}

// Palette used across charts
const DASH_PALETTE = [
    '#00d4ff', '#a78bfa', '#34d399', '#ffd700', '#fb923c',
    '#f472b6', '#60a5fa', '#e879f9', '#10b981', '#f87171',
    '#38bdf8', '#c084fc', '#4ade80', '#facc15', '#ff6b35',
];

// ── Chart: ${T('dashFileTypeDistribution')} ─────────────────────────────────────────────
function _chartFileTypes() {
    const tc = DATA.stats.type_counts || {};
    const sorted = Object.entries(tc).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(([k]) => k.replace('_', ' '));
    const vals = sorted.map(([, v]) => v);
    const colors = sorted.map((_, i) => DASH_PALETTE[i % DASH_PALETTE.length]);

    _mkChart('chart-file-types', 'doughnut', {
        labels,
        datasets: [{
            data: vals, backgroundColor: colors.map(c => c + 'cc'),
            borderColor: colors, borderWidth: 1.5, hoverOffset: 6
        }],
    }, {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: {
            legend: { position: 'right', labels: { color: '#94a3b8', boxWidth: 10, padding: 12 } },
            tooltip: {
                callbacks: {
                    label: ctx => ` ${ctx.label}: ${ctx.parsed} file${ctx.parsed !== 1 ? 's' : ''}`,
                }
            },
        },
    });
}

// ── Chart: ${T('dashFilesPerModule')} ───────────────────────────────────────────────────
function _chartFilesPerMod() {
    const mods = (DATA.modules || []).slice().sort((a, b) => b.file_count - a.file_count).slice(0, 18);
    const labels = mods.map(m => m.label.length > 18 ? m.label.slice(0, 16) + '…' : m.label);
    const vals = mods.map(m => m.file_count);
    const colors = mods.map(m => m.color || '#00d4ff');

    _mkChart('chart-files-per-mod', 'bar', {
        labels,
        datasets: [{
            label: T('chartFiles'), data: vals,
            backgroundColor: colors.map(c => c + '99'),
            borderColor: colors, borderWidth: 1.5, borderRadius: 3
        }],
    }, {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            x: { grid: { color: '#1a253588' }, ticks: { color: '#64748b' } },
            y: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10 } } },
        },
    });
}

// ── Chart: ${T('dashFunctionsPerModule')} ───────────────────────────────────────────────
function _chartFuncsPerMod() {
    const mods = (DATA.modules || []).slice().sort((a, b) => b.func_count - a.func_count).slice(0, 18);
    const labels = mods.map(m => m.label.length > 18 ? m.label.slice(0, 16) + '…' : m.label);
    const vals = mods.map(m => m.func_count);
    const colors = mods.map(m => m.color ? m.color.replace('#', '') : 'a78bfa');

    _mkChart('chart-funcs-per-mod', 'bar', {
        labels,
        datasets: [{
            label: T('chartFunctions'), data: vals,
            backgroundColor: '#a78bfa55',
            borderColor: '#a78bfa', borderWidth: 1.5, borderRadius: 3
        }],
    }, {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            x: { grid: { color: '#1a253588' }, ticks: { color: '#64748b' } },
            y: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 10 } } },
        },
    });
}

// ── Chart: Edge Types ─────────────────────────────────────────────────────────
function _chartEdgeTypes() {
    const edges = _allEdges();
    const counts = {};
    for (const e of edges) counts[e.type] = (counts[e.type] || 0) + 1;
    if (!Object.keys(counts).length) return;

    const edgeDefs = DATA.edge_types || {};
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(([k]) => edgeDefs[k]?.label || k);
    const vals = sorted.map(([, v]) => v);
    const colors = sorted.map(([k]) => edgeDefs[k]?.color || '#00d4ff');

    _mkChart('chart-edge-types', 'doughnut', {
        labels,
        datasets: [{
            data: vals,
            backgroundColor: colors.map(c => c + 'cc'),
            borderColor: colors, borderWidth: 1.5, hoverOffset: 5
        }],
    }, {
        responsive: true, maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
            legend: { position: 'right', labels: { color: '#94a3b8', boxWidth: 10, padding: 10, font: { size: 10 } } },
            tooltip: {
                callbacks: {
                    label: ctx => ` ${ctx.label}: ${ctx.parsed.toLocaleString()}`,
                }
            },
        },
    });
}

// ── Top Lists ─────────────────────────────────────────────────────────────────
function _buildLargestFiles() {
    const el = document.getElementById('list-largest-files');
    if (!el) return;
    const files = _flatFiles().filter(f => f.size > 0).sort((a, b) => b.size - a.size).slice(0, 10);
    const max = files[0]?.size || 1;
    el.innerHTML = files.map((f, i) => `
<div class="dash-list-row" data-tip="${f.path}">
  <span class="dash-list-rank">${i + 1}</span>
  <span class="dash-list-name">${f.label}</span>
  <div class="dash-list-bar" style="width:${Math.round(f.size / max * 60)}px;background:#34d399"></div>
  <span class="dash-list-val" style="color:#34d399">${_fmtBytes(f.size)}</span>
</div>`).join('') || `<div class="dash-empty">${T('dashNoData')}</div>`;
}

function _buildMostFuncFiles() {
    const el = document.getElementById('list-most-funcs');
    if (!el) return;
    const files = _flatFiles().filter(f => (f.func_count || 0) > 0)
        .sort((a, b) => (b.func_count || 0) - (a.func_count || 0)).slice(0, 10);
    const max = files[0]?.func_count || 1;
    el.innerHTML = files.map((f, i) => `
<div class="dash-list-row" data-tip="${f.path}">
  <span class="dash-list-rank">${i + 1}</span>
  <span class="dash-list-name">${f.label}</span>
  <div class="dash-list-bar" style="width:${Math.round(f.func_count / max * 60)}px;background:#f472b6"></div>
  <span class="dash-list-val" style="color:#f472b6">${T('countFunctions', { count: f.func_count })}</span>
</div>`).join('') || `<div class="dash-empty">${T('dashNoFunctionData')}</div>`;
}

// ── Module Treemap ─────────────────────────────────────────────────────────────
function _buildTreemap() {
    const el = document.getElementById('dash-treemap');
    if (!el) return;
    const mods = (DATA.modules || []).map(m => {
        const files = (DATA.files_by_module[m.id] || []);
        const totalSz = files.reduce((a, f) => a + (f.size || 0), 0);
        return { ...m, totalSz };
    }).filter(m => m.totalSz > 0).sort((a, b) => b.totalSz - a.totalSz);

    const grand = mods.reduce((a, m) => a + m.totalSz, 0) || 1;

    el.innerHTML = mods.map(m => {
        const pct = m.totalSz / grand;
        // Width proportional to sqrt(size) for better visual distribution
        const flex = Math.max(0.5, Math.sqrt(pct) * 10);
        const color = m.color || '#00d4ff';
        const h = Math.max(48, Math.round(pct * 300));
        const label = m.label.length > 14 ? m.label.slice(0, 12) + '…' : m.label;
        return `
<div class="dash-tm-cell" data-tip="${m.label}
${_fmtBytes(m.totalSz)}
${m.file_count} files"
     style="background:${color}22;border:1px solid ${color}55;flex:${flex};height:${h}px;min-width:${Math.round(flex * 10)}px;max-width:260px">
  <div>
    <div class="dash-tm-label" style="font-size:10px;font-weight:700;color:${color}">${label}</div>
    <div class="dash-tm-label" style="font-size:9px;color:rgba(255,255,255,0.4)">${_fmtBytes(m.totalSz)}</div>
  </div>
</div>`;
    }).join('');
}

// ── Master render ─────────────────────────────────────────────────────────────
function _renderDashboard() {
    if (!window.DATA) return;
    _buildStatStrip();
    _chartFileTypes();
    _chartFilesPerMod();
    _chartFuncsPerMod();
    _chartEdgeTypes();
    _buildLargestFiles();
    _buildMostFuncFiles();
    _buildTreemap();
}

// ── Init on DOMContentLoaded (after data parse, called from main init) ─────────
// The dashboard-btn is already in the HTML; openDashboard() is called by onclick.

// ─── Layout Switcher ─────────────────────────────────────────────────────────
const LAYOUT_PRESETS = [
    // ── Original presets (unchanged) ──────────────────────────────────────────
    {
        id: 'dagre-lr',
        icon: '→',
        label: 'Hierarchy LR',
        tip: 'Hierarchical Left → Right (DAG)',
        levels: [0, 1, 2],
        config: () => ({
            name: 'dagre', rankDir: 'LR',
            animate: true, animationDuration: 380,
            nodeSep: 28, rankSep: 90, padding: 45,
        }),
    },
    {
        id: 'dagre-tb',
        icon: '↓',
        label: 'Hierarchy TB',
        tip: 'Hierarchical Top → Bottom (DAG)',
        levels: [0, 1, 2],
        config: () => ({
            name: 'dagre', rankDir: 'TB',
            animate: true, animationDuration: 380,
            nodeSep: 22, rankSep: 80, padding: 45,
        }),
    },
    {
        id: 'cose',
        icon: '⚡',
        label: 'Force',
        tip: 'Force-Directed (CoSE) — physics simulation',
        levels: [0, 1, 2],
        config: () => ({
            name: 'cose',
            animate: true, animationDuration: 600,
            randomize: false,
            nodeRepulsion: 9000,
            idealEdgeLength: 160,
            nodeOverlap: 20,
            padding: 55,
            gravity: 0.25,
        }),
    },

    // ── Advanced presets ───────────────────────────────────────────────────────

    // ── Smart Cluster (fCoSE) ──────────────────────────────────────────────────
    // Best for: module-level graphs and hairball call graphs.
    // Beats plain CoSE: 2× faster, includes compound-node support, and supports
    // user-defined placement constraints (fixed position, alignment, relative placement).
    // Requires: cytoscape-fcose
    {
        id: 'fcose',
        icon: '🧩',
        label: 'Smart Cluster',
        tip: 'fCoSE — fastest force-directed, compound-aware, best for modules & hairball graphs (requires fcose CDN)',
        levels: [0, 1, 2],
        requires: 'fcose',
        config: () => {
            const nodeCount = cy ? cy.nodes().length : 50;
            const repulsion = Math.max(6000, Math.min(18000, nodeCount * 180));
            const edgeLen = Math.max(80, Math.min(220, nodeCount * 2.5));
            return {
                name: 'fcose',
                animate: true,
                animationDuration: 650,
                animationEasing: 'ease-out',
                quality: nodeCount > 150 ? 'default' : 'proof',
                randomize: false,
                packComponents: true,
                // Account for label sizes so nodes don't overlap their labels
                nodeDimensionsIncludeLabels: true,
                nodeRepulsion: () => repulsion,
                idealEdgeLength: () => edgeLen,
                edgeElasticity: () => 0.45,
                nestingFactor: 0.1,
                gravityRangeCompound: 1.5,
                gravityCompound: 1.0,
                gravity: 0.25,
                numIter: nodeCount > 200 ? 3500 : 2500,
                tile: true,
                tilingPaddingVertical: 12,
                tilingPaddingHorizontal: 12,
                padding: 55,
            };
        },
    },

    // ── Smooth Physics (Cola / WebCola) ──────────────────────────────────────────
    // Best for: L1 dependency map and L2 call-flow when graph < ~200 nodes.
    // Unique advantage: constraint-based (can enforce LR flow direction while still
    // being physically simulated), smoothest animation of all force layouts,
    // and almost no jitter in interactive dragging.
    // Requires: webcola + cytoscape-cola
    {
        id: 'cola',
        icon: '🧲',
        label: 'Smooth Physics',
        tip: 'Cola — constraint physics, smoothest animation, directed-flow aware, best for L1/L2 < 200 nodes (requires cola CDN)',
        levels: [1, 2],
        requires: 'cola',
        config: () => {
            const nodeCount = cy ? cy.nodes().length : 50;
            return {
                name: 'cola',
                animate: true,
                animationDuration: 500,
                refresh: 2,
                maxSimulationTime: Math.min(5000, nodeCount * 20),
                // Directed left→right flow constraint — mirrors how code is read
                flow: { axis: 'x', minSeparation: 90 },
                avoidOverlap: true,
                nodeDimensionsIncludeLabels: true,
                nodeSpacing: () => 14,
                edgeLength: () => Math.max(100, Math.min(200, nodeCount * 2)),
                convergenceThreshold: 0.005,
                padding: 50,
            };
        },
    },

    // ELK Flow — ELK's "layered" algorithm for directed call-flow graphs.
    // Best for: L1 dependency map, L2 call-flow (anything with clear direction).
    // Solves: dagre's mediocre crossing-minimisation and loose node placement.
    // Advantages over dagre: orthogonal edge routing, BRANDES_KOEPF placement,
    //   post-compaction, and proper cycle-breaking for circular imports.
    // Requires: cytoscape-elk (loaded via CDN in <head>)
    {
        id: 'elk-layered',
        icon: '⛓',
        label: 'ELK Flow',
        tip: 'ELK Layered — precise directed DAG with orthogonal edges, better than Dagre (requires elk CDN)',
        levels: [1, 2],   // Call-flow graphs only; L0 module graph has no fixed direction
        requires: 'elk',
        config: () => ({
            name: 'elk',
            animate: true,
            animationDuration: 550,
            animationEasing: 'ease-out',
            elk: {
                algorithm: 'layered',

                // Direction: 'RIGHT' mirrors the mental model of reading code left→right.
                // Change to 'DOWN' if you prefer top-down (like a traditional call tree).
                'elk.direction': 'RIGHT',

                // Inter-layer (column) and intra-layer (row) spacing
                'elk.layered.spacing.nodeNodeBetweenLayers': 90,
                'elk.spacing.nodeNode': 32,

                // ORTHOGONAL routing: edges become clean right-angle paths instead of
                // diagonal spaghetti. Makes the graph look far more professional.
                'elk.edgeRouting': 'ORTHOGONAL',

                // LAYER_SWEEP crossing minimisation — the best general strategy for
                // reducing the number of edge crossings in a layered graph.
                'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',

                // BRANDES_KOEPF node placement: produces compact, well-aligned layers.
                // Much tighter than ELK's default LINEAR_SEGMENTS.
                'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',

                // Post-layout compaction: shorten edges as much as possible while
                // keeping the orthogonal shape, removing unnecessary whitespace.
                'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',

                // GREEDY cycle-breaking: handles Python circular imports and similar
                // patterns by reversing a minimal set of back-edges.
                'elk.layered.cycleBreaking.strategy': 'GREEDY',

                // Allow multiple edges between the same pair of nodes to be merged
                // visually, keeping the graph cleaner.
                'elk.mergeEdges': 'true',
            },
        }),
    },

    // ── ELK Stress ────────────────────────────────────────────────────────────
    // Best for: 300+ node graphs — prevents hairball AND avoids "too tall/wide".
    // Nodes placed so canvas distance ∝ hop distance (MDS/stress majorization).
    // Requires: cytoscape-elk
    {
        id: 'elk-stress',
        icon: '🌐',
        label: 'ELK Stress',
        tip: 'ELK Stress — best for 300+ node graphs, distance-proportional placement, no hairball (requires elk CDN)',
        levels: [0, 1, 2],
        requires: 'elk',
        config: () => {
            const nodeCount = cy ? cy.nodes().length : 100;
            const iterations = Math.max(200, Math.min(800, nodeCount * 2.5));
            return {
                name: 'elk',
                animate: true,
                animationDuration: 700,
                animationEasing: 'ease-out',
                elk: {
                    algorithm: 'stress',
                    'elk.stress.desiredEdgeLength': 140,
                    'elk.stress.epsilon': 0.00001,
                    'elk.stress.iterationLimit': iterations,
                    'elk.nodeSize.constraints': 'MINIMUM_SIZE',
                    'elk.spacing.nodeNode': 40,
                    'elk.stress.fixedStartPosition': 'false',
                },
            };
        },
    },
];

const layoutSwitcherState = {
    currentId: 'dagre-lr',   // default for L1/L2
    collapsed: false,
};

function initLayoutSwitcher() {
    const wrap = document.getElementById('graph-wrap');
    if (!wrap) return;

    const panel = document.createElement('div');
    panel.id = 'layout-switcher';
    panel.innerHTML = _buildLayoutSwitcherHTML();
    wrap.appendChild(panel);

    // Toggle collapse on header click
    panel.querySelector('.ls-header').addEventListener('click', () => {
        layoutSwitcherState.collapsed = !layoutSwitcherState.collapsed;
        panel.classList.toggle('ls-collapsed', layoutSwitcherState.collapsed);
    });

    // Layout button clicks — delegated so re-renders don't break listeners
    panel.querySelector('.ls-btns').addEventListener('click', e => {
        const btn = e.target.closest('.ls-btn');
        if (!btn) return;
        const id = btn.dataset.layoutId;
        if (id) applyLayoutPreset(id);
    });
}

// Call this after every level change (loadLevel0, drillToModule, renderFilesFlat, etc.)
// to refresh which layout buttons are visible for the current level.
function refreshLayoutSwitcher() {
    const panel = document.getElementById('layout-switcher');
    if (!panel) return;
    const collapsed = layoutSwitcherState.collapsed;
    panel.innerHTML = _buildLayoutSwitcherHTML();
    panel.classList.toggle('ls-collapsed', collapsed);
    // Re-bind BOTH listeners (innerHTML wipe removes old ones)
    panel.querySelector('.ls-header').addEventListener('click', () => {
        layoutSwitcherState.collapsed = !layoutSwitcherState.collapsed;
        panel.classList.toggle('ls-collapsed', layoutSwitcherState.collapsed);
    });
    panel.querySelector('.ls-btns').addEventListener('click', e => {
        const btn = e.target.closest('.ls-btn');
        if (!btn) return;
        const id = btn.dataset.layoutId;
        if (id) applyLayoutPreset(id);
    });
}

function _buildLayoutSwitcherHTML() {
    // Filter presets to those valid for the current level
    const visiblePresets = LAYOUT_PRESETS.filter(p => !p.levels || p.levels.includes(state.level));

    return `
        <div class="ls-header">
            <span class="ls-header-icon">⊞</span>
            <span class="ls-header-text">${T('layoutLabel')}</span>
            <span class="ls-chevron">▾</span>
        </div>
        <div class="ls-btns">
            ${visiblePresets.map(p => {
        // Check if required extension is loaded
        const unavailable = p.requires && !_isLayoutAvailable(p.requires);
        const lName = _layoutLabel(p);
        const lTip = _layoutTip(p);

        return `
                <button class="ls-btn${p.id === layoutSwitcherState.currentId ? ' active' : ''}${unavailable ? ' ls-unavailable' : ''}"
                        data-layout-id="${p.id}"
                        data-tip="${lTip}${unavailable ? '\n⚠ CDN 未載入' : ''}">
                    <span class="ls-icon">${p.icon}</span>
                    <span class="ls-name">${lName}</span>
                    ${unavailable ? '<span class="ls-warn">!</span>' : ''}
                </button>`;
    }).join('')}
        </div>
    `;
}


function applyLayoutPreset(id) {
    const preset = LAYOUT_PRESETS.find(p => p.id === id);
    if (!preset || !cy) return;

    // Guard: if this preset requires an extension that wasn't loaded, warn and bail
    if (preset.requires && !_isLayoutAvailable(preset.requires)) {
        showToast(`⚠ Layout "${preset.label}" requires cytoscape-${preset.requires} — CDN script may not have loaded`, 'error');
        console.warn(`[layout] "${preset.requires}" extension not registered. Add the CDN script to analyze_viz.py <head>.`);
        return;
    }

    layoutSwitcherState.currentId = id;

    // Update active button visuals
    document.querySelectorAll('#layout-switcher .ls-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.layoutId === id);
    });

    showLoading(true, 'Applying layout…');
    const config = preset.config();
    const lay = cy.layout(config);
    lay.one('layoutstop', () => {
        showLoading(false);
        cy.animate({ fit: { eles: cy.elements(), padding: 40 }, duration: 300 });
    });
    lay.run();

    showToast(T('layoutApplied', { label: _layoutLabel(preset) }), 'info');
}

// Called by loadLevel0 / renderFilesFlat to sync the active indicator
function _syncLayoutIndicator(id) {
    layoutSwitcherState.currentId = id;
    document.querySelectorAll('#layout-switcher .ls-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.layoutId === id);
    });
}


