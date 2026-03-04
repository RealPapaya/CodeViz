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
    showExternalEdges: true,
};

// ─── Dependency Map (L1) external-files state ─────────────────────────────────
const depMapState = {
    showExternalFiles: false,
    expandedExtModules: new Set(),
    currentExtModules: [],   // populated after each render
    currentModId: null,
    pendingFocusFile: null,  // file path to pan+highlight after next layout
};

// File-ID → module/file lookup, built once after DATA is parsed
let _fileIdToModule = {};
let _fileIdToFile   = {};

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
    rawLines: [],      // cache raw contents for exact callsite matching
};

let cy = null;
let tooltipPinned = false;
let tooltipHideTimer = null;
const DEFAULT_CODE_FONT = "'JetBrains Mono', monospace";
const EXT_DOUBLE_CLICK_MS = 260;
let extClickLastId = null;
let extClickLastTime = 0;

function getSavedFont() {
    try {
        const saved = localStorage.getItem('biosviz_code_font');
        return (saved && saved.trim()) ? saved : DEFAULT_CODE_FONT;
    } catch (_) {
        return DEFAULT_CODE_FONT;
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
                const totalFiles = s.files + (s.other_files || 0);
                document.getElementById('st-files').textContent = totalFiles.toLocaleString();
                document.getElementById('st-mods').textContent = s.modules;
                document.getElementById('st-funcs').textContent = s.functions.toLocaleString();

                buildSidebar();
                buildFileIdLookup();
                initCy();
                loadLevel0();

                document.getElementById('search').addEventListener('input', onSearch);
                document.addEventListener('keydown', onKey);
                document.addEventListener('click', () => hideCtxMenu());

                // Code panel init
                initCodePanel();

                // Preferences init
                initPreferences();

                // L1 toolbar init
                initL1Toolbar();

                // L2 toolbar init
                initL2Toolbar();

                // Tooltip actions init
                initTooltipActions();

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

// ─── Preferences ─────────────────────────────────────────────────────────────
function applyFont(font) {
    document.documentElement.style.setProperty('--code-font', font);
    document.documentElement.style.setProperty('--ui-font', font);
    document.body.style.fontFamily = font + ', Inter, sans-serif';

    applyCyFont(font);
}

function initPreferences() {
    const prefBtn = document.getElementById('pref-btn');
    const prefModal = document.getElementById('pref-modal');
    const closeX = document.getElementById('pref-close-x');
    const closeBtn = document.getElementById('pref-close-btn');
    const fontSelect = document.getElementById('font-select');

    if (!prefBtn || !prefModal) return;

    // Load saved font from localStorage or use default
    const savedFont = getSavedFont();
    applyFont(savedFont);
    if (fontSelect) {
        fontSelect.value = savedFont;
        fontSelect.style.fontFamily = savedFont;
    }

    prefBtn.addEventListener('click', () => {
        prefModal.style.display = 'flex';
    });
    prefBtn.addEventListener('mouseenter', () => { prefBtn.style.color = 'var(--accent)'; });
    prefBtn.addEventListener('mouseleave', () => { prefBtn.style.color = 'var(--muted)'; });

    const closeModal = () => {
        prefModal.style.display = 'none';
    };

    if (closeX) closeX.addEventListener('click', closeModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    // Close on outside click
    prefModal.addEventListener('click', (e) => {
        if (e.target === prefModal) closeModal();
    });

    // Handle font change
    if (fontSelect) {
        fontSelect.addEventListener('change', (e) => {
            const font = e.target.value;
            applyFont(font);
            localStorage.setItem('biosviz_code_font', font);
            fontSelect.style.fontFamily = font;
        });
    }
}

// ─── L1 Toolbar (Dependency Map) ─────────────────────────────────────────────
function initL1Toolbar() {
    const toggleBtn  = document.getElementById('l1-toggle-ext');
    const expandBtn  = document.getElementById('l1-expand-all-ext');
    const collapseBtn = document.getElementById('l1-collapse-all-ext');

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
}

function setL1ToolbarVisible(v) {
    const bar = document.getElementById('l1-toolbar');
    if (!bar) return;
    bar.classList.toggle('hidden', !v);
}

function updateDepMapExtToggle() {
    const btn = document.getElementById('l1-toggle-ext');
    if (!btn) return;
    btn.textContent = depMapState.showExternalFiles ? 'Ext Files: On' : 'Ext Files: Off';
    btn.classList.toggle('active', depMapState.showExternalFiles);
}

function updateL1Toolbar(modId, fileCount) {
    const labelEl = document.getElementById('l1-mod-label');
    if (labelEl) { labelEl.textContent = modId || 'No module'; labelEl.title = modId || ''; }
    const statsEl = document.getElementById('l1-stats');
    if (statsEl) statsEl.textContent = `${fileCount} files`;
}

function toggleDepMapExtGroup(extModId) {
    if (depMapState.expandedExtModules.has(extModId)) {
        depMapState.expandedExtModules.delete(extModId);
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
    const toggleExtBtn = document.getElementById('l2-toggle-ext');
    const expandBtn = document.getElementById('l2-expand-all');
    const collapseBtn = document.getElementById('l2-collapse-all');

    if (prevBtn) prevBtn.addEventListener('click', goL2Prev);
    if (nextBtn) nextBtn.addEventListener('click', goL2Next);
    if (toggleExtBtn) {
        toggleExtBtn.addEventListener('click', () => {
            l2State.showExternalEdges = !l2State.showExternalEdges;
            updateExternalToggle();
            applyExternalEdgeVisibility();
        });
    }

    if (expandBtn) {
        expandBtn.addEventListener('click', () => {
            if (!l2State.activeFile) return;
            l2State.expandedModules = new Set(l2State.externalModules || []);
            renderL2Flowchart(l2State.activeFile);
        });
    }

    if (collapseBtn) {
        collapseBtn.addEventListener('click', () => {
            if (!l2State.activeFile) return;
            l2State.expandedModules = new Set();
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
            if (nodeType === 'dep_ext_file' || nodeType === 'dep_ext_group') {
                const extMod  = decodeURIComponent(btn.dataset.mod  || '');
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
                    alert('請先選擇一個檔案 (Please select a file first)');
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
                // dep_ext_file / dep_ext_group → navigate to that module's Dependency Map (L1)
                if (nodeType === 'dep_ext_file' || nodeType === 'dep_ext_group') {
                    const extMod  = decodeURIComponent(btn.dataset.mod  || '');
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
        subtitle = escapeHtml(d._f || 'Unknown target');
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
        html += `<div style="margin-bottom: 8px; font-weight: bold; color: #a78bfa;">POSSIBLE FILES:</div>`;
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
    } else if (d._t === 'dep_ext_file' || d._t === 'dep_ext_group') {
        // Show subtitle lines + a distance badge on the same block
        const extMod = d.mod || '';
        const dist = _pathDist(state.activeModule || '', extMod);
        const distColor = dist === 0 ? '#38bdf8'
            : dist === 1 ? '#10b981'
            : dist === 2 ? '#f59e0b'
            : '#f87171';
        const distLabel = dist === 0 ? 'same module' : `distance: ${dist}`;
        html += `<div class="tip-body" style="font-size: 11px; margin-top: 8px; font-family: monospace; text-transform: uppercase; line-height: 1.6; color: rgba(255,255,255,0.85);">`;
        if (subtitle) html += subtitle + '<br>';
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
        ">⬡ ${distLabel}</span>`;
        html += `</div>`;
    } else if (subtitle) {
        html += `<div class="tip-body" style="font-size: 11px; margin-top: 8px; font-family: monospace; text-transform: uppercase; line-height: 1.4; color: rgba(255,255,255,0.85);">${subtitle}</div>`;
    }

    // Actions
    html += `<div class="tip-actions" style="margin-top: 16px;">`;
    if (d._t === 'potential_func') {
        html += `<button class="tip-btn" data-action="open-ambiguous" data-func="${encodeURIComponent(d.fn || '')}">Open Location</button>` +
            `<button class="tip-btn" data-action="view-ambiguous" data-func="${encodeURIComponent(d.fn || '')}">View File</button>`;
    } else {
        html += `<button class="tip-btn" data-action="open" data-file="${encodeURIComponent(d._f?.path || d._f || '')}" data-func="${encodeURIComponent(d.fn || '')}" data-node-type="${d._t || ''}" data-mod="${encodeURIComponent(d.mod || '')}">Open Location</button>` +
            `<button class="tip-btn" data-action="view" data-file="${encodeURIComponent(d._f?.path || d._f || '')}" data-func="${encodeURIComponent(d.fn || '')}">View File</button>`;
    }
    html += `</div>`;
    html += `</div>`;

    // Dependencies
    const outEdges = node.outgoers('edge');
    const inEdges = node.incomers('edge');

    if (outEdges.length > 0 || inEdges.length > 0) {
        html += `<div class="modal-deps">`;
        html += `<div style="font-weight:bold; margin: 20px 0 12px; padding-top:16px; border-top: 1px solid var(--border); font-size: 14px;">Dependencies:</div>`;

        const OUT_MAP = {
            'Inc': 'Include', 'owns': 'owns', 'Src': 'sources', 'Pkg': 'package', 'Lib': 'library',
            'ELINK': 'elink', 'Comp': 'component', 'GUID': 'guid ref',
            'Strings': 'strings', 'ASL': 'asl include', 'Callback': 'callback',
            'HII-Pkg': 'hii pkg', 'Depex': 'depex',
            'ext': 'external calls', 'group': 'group',
            '': state.level === 2 ? 'calls' : 'includes'
        };
        const IN_MAP = {
            'Inc': 'Included by', 'owns': 'owned by', 'Src': 'source of', 'Pkg': 'packaged in', 'Lib': 'used as lib by',
            'ELINK': 'elink parent of', 'Comp': 'used as comp by', 'GUID': 'referenced guid by',
            'Strings': 'referenced as string by', 'ASL': 'included by asl', 'Callback': 'triggered by',
            'HII-Pkg': 'packaged in hii', 'Depex': 'depended by',
            'ext': 'external callers', 'group': 'group',
            '': state.level === 2 ? 'called by' : 'included by'
        };

        const outGroups = {};
        outEdges.forEach(edge => {
            const lbl = edge.data('el') || '';
            const col = edge.data('ec') || '#f59e0b';
            const outTxt = OUT_MAP[lbl] || lbl || 'outgoing';
            const key = outTxt + '|' + col;
            if (!outGroups[key]) outGroups[key] = [];
            outGroups[key].push(edge.target());
        });

        const inGroups = {};
        inEdges.forEach(edge => {
            const lbl = edge.data('el') || '';
            const col = edge.data('ec') || '#10b981';
            const inTxt = IN_MAP[lbl] || lbl || 'incoming';
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
                        nSub = nd._f?.ext ? nd._f.ext.toUpperCase() : 'FILE';
                    }

                    // ── Distance badge for external dep-map nodes ─────────────
                    let distBadge = '';
                    const isExtNode = nd._t === 'dep_ext_file' || nd._t === 'dep_ext_group';
                    if (isExtNode) {
                        const extMod = nd.mod || '';
                        const dist = _pathDist(state.activeModule || '', extMod);
                        const distColor = dist === 0 ? '#38bdf8'
                            : dist === 1 ? '#10b981'
                            : dist === 2 ? '#f59e0b'
                            : '#f87171';
                        const distLabel = dist === 0 ? 'same' : `d=${dist}`;
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
    const btn = document.getElementById('l2-toggle-ext');
    if (!btn) return;
    btn.textContent = l2State.showExternalEdges ? 'Ext Lines: On' : 'Ext Lines: Off';
    btn.classList.toggle('active', l2State.showExternalEdges);
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

function goL2Prev() {
    if (l2State.fileHistoryIdx <= 0) return;
    l2State.fileHistoryIdx -= 1;
    const fileRel = l2State.fileHistory[l2State.fileHistoryIdx];
    if (!fileRel) return;
    openL2File(fileRel, { pushHistory: false });
}

function goL2Next() {
    if (l2State.fileHistoryIdx < 0 || l2State.fileHistoryIdx >= l2State.fileHistory.length - 1) return;
    l2State.fileHistoryIdx += 1;
    const fileRel = l2State.fileHistory[l2State.fileHistoryIdx];
    if (!fileRel) return;
    openL2File(fileRel, { pushHistory: false });
}

function setL2ToolbarVisible(v) {
    const bar = document.getElementById('l2-toolbar');
    if (!bar) return;
    bar.classList.toggle('hidden', !v);
}

function updateL2Toolbar(fileRel, stats) {
    const label = document.getElementById('l2-file-label');
    const statsEl = document.getElementById('l2-stats');
    if (label) {
        label.textContent = fileRel || 'No file';
        label.title = fileRel || '';
    }
    if (statsEl && stats) {
        const parts = [];
        parts.push(`${stats.funcs || 0} funcs`);
        parts.push(`${stats.internalEdges || 0} edges`);
        if (stats.extModules) parts.push(`${stats.extModules} modules`);
        if (stats.extFuncs) parts.push(`${stats.extFuncs} ext funcs`);
        if (stats.legacy) parts.push('legacy edges');
        statsEl.textContent = parts.join(' | ');
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
    l2State.externalModules = [];
}

function resetL2History() {
    l2State.fileHistory = [];
    l2State.fileHistoryIdx = -1;
}

function resolveModuleForFile(fileRel) {
    if (!fileRel || !DATA) return null;
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
    const { center = false } = opts;
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
    _syncCodePanel(fileRel, funcs[idx].label);
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
    if (l2State.expandedModules.has(modName)) l2State.expandedModules.delete(modName);
    else l2State.expandedModules.add(modName);
    renderL2Flowchart(l2State.activeFile);
}

function openL2File(fileRel, opts = {}) {
    const { pushHistory = true, newSession = false, focusFunc = null } = opts;
    if (!fileRel) return;
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
    showLoading(true, 'Rendering call flow...');
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

    // Distance between two module path strings (slash-separated hierarchy)
    function moduleDistance(modA, modB) {
        if (!modA || !modB || modA === modB) return modA === modB ? 0 : 99;
        const pa = modA.split('/'), pb = modB.split('/');
        let shared = 0;
        const minLen = Math.min(pa.length, pb.length);
        for (let i = 0; i < minLen; i++) { if (pa[i] === pb[i]) shared++; else break; }
        return pa.length + pb.length - 2 * shared;
    }

    // Edge color by distance (0=same module blue, 1=near green, 2=mid amber, 3+=far red)
    function distColor(targetMod) {
        const d = moduleDistance(currentModule, targetMod);
        if (d === 0) return '#38bdf8';
        if (d === 1) return '#10b981';
        if (d === 2) return '#f59e0b';
        return '#f87171';
    }

    const fidMap = new Map();
    funcs.forEach((f, i) => fidMap.set(f.label, i));

    const els = [];
    funcs.forEach((f, i) => {
        const isPublic = !!f.is_public;
        const isEfi = !!f.is_efiapi;
        const bg = isEfi ? '#3d2e00' : isPublic ? '#0b2745' : '#1e2433';
        const bc = isEfi ? '#fbbf24' : isPublic ? '#60a5fa' : '#94a3b8';
        const access = isPublic ? 'public' : 'static';
        els.push({
            data: {
                id: `fn-${i}`, label: f.label, bg, bc, w: 150, h: 38,
                sh: 'roundrectangle', lvl: 2, _t: 'func', fn: f.label, _f: fileRel,
                idx: i, access, tt: `Function: ${f.label}\n${access}${isEfi ? ' EFIAPI' : ''}`,
            }
        });
    });

    // extMap:  modName → Map<funcName, { files[], callers:Set }>
    // potMap:  key     → { callee, files[], callers:Set }   (ambiguous)
    // unkMap:  callee  → callers:Set                         (truly unresolvable)
    const extMap = new Map();
    const potMap = new Map();
    const unkMap = new Map();
    let internalEdgeCount = 0;

    function addExt(modName, callee, targetFiles, callerIdx) {
        if (!extMap.has(modName)) extMap.set(modName, new Map());
        const fm = extMap.get(modName);
        if (!fm.has(callee)) fm.set(callee, { files: targetFiles, callers: new Set() });
        fm.get(callee).callers.add(callerIdx);
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
                if (nameToFiles[callee]) {
                    // Ambiguous: multiple possible files
                    const k = `pot:${callee}`;
                    if (!potMap.has(k)) potMap.set(k, { callee, files: nameToFiles[callee], callers: new Set() });
                    potMap.get(k).callers.add(i);
                    continue;
                }
                const targetFile = nameToFile[callee] || null;
                if (!targetFile) {
                    if (!unkMap.has(callee)) unkMap.set(callee, new Set());
                    unkMap.get(callee).add(i);
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
        const ec = distColor(modName);

        if (!isExpanded) {
            // Unexpanded: show the big group node and aggregate edges
            els.push({
                data: {
                    id: modId, label: `${modName}\n${funcCount} funcs`,
                    bg: '#111827', bc: modColor, w: 170, h: 52, sh: 'roundrectangle', lvl: 2,
                    _t: 'ext_group', mod: modName,
                    tt: `External Module: ${modName}\nFunctions: ${funcCount}\nClick to expand`,
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
                els.push({
                    data: {
                        id: fnId,
                        label: `${funcName}\n(${modName})`,
                        bg: '#0f172a', bc: modColor,
                        w: 160, h: 42, sh: 'roundrectangle', lvl: 2,
                        _t: 'ext_func', fn: funcName, _f: tf, mod: modName, _drilled: false,
                        tt: `${funcName}\n${tf || '(file unknown)'}\nModule: ${modName}\n\nDouble-click to drill in →\nClick to collapse module`,
                    }
                });
                info.callers.forEach(callerIdx => {
                    els.push({
                        data: {
                            id: `extc-${modId}-${callerIdx}-${_hashId(funcName)}`,
                            source: `fn-${callerIdx}`, target: fnId,
                            w: 1.5, ec, es: 'solid', el: 'ext',
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
        const ec = firstMod ? distColor(firstMod) : '#a78bfa';
        els.push({
            data: {
                id: potId, label: `${callee}\n(${files.length} paths)`,
                bg: '#1a1040', bc: '#a78bfa', w: 160, h: 44, sh: 'roundrectangle', lvl: 2,
                _t: 'potential_func', fn: callee, _files: files,
                tt: `Ambiguous: ${callee}\nPossible files:\n${files.join('\n')}`,
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

    // ─── True unknown (system / compiler) ────────────────────────────────────
    if (unkMap.size > 0) {
        const unkId = 'extmod-unknown';
        els.push({
            data: {
                id: unkId, label: `System / Unknown\n${unkMap.size} funcs`,
                bg: '#2a1515', bc: '#64748b', w: 170, h: 52, sh: 'roundrectangle', lvl: 2,
                _t: 'ext_group', mod: 'Unknown',
                tt: `System calls or unresolved symbols\nCount: ${unkMap.size}`,
            }
        });
        const callerSet = new Map();
        unkMap.forEach(callers => callers.forEach(idx => callerSet.set(idx, (callerSet.get(idx) || 0) + 1)));
        callerSet.forEach((count, callerIdx) => {
            els.push({
                data: {
                    id: `unke-${callerIdx}`, source: `fn-${callerIdx}`, target: unkId,
                    w: Math.min(3, 1 + count / 3), ec: '#64748b', es: 'dotted', el: 'ext',
                    tt: `→ system calls (${count})`,
                }
            });
        });
    }

    cy.elements().remove();
    cy.add(els);
    applyCyFont(getSavedFont());
    applyExternalEdgeVisibility();

    const lay = cy.layout({ name: 'dagre', rankDir: 'LR', animate: false, nodeSep: 26, rankSep: 80, padding: 50 });
    lay.one('layoutstop', () => {
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
        focusL2Func(fileRel, l2State.activeFuncIdx || 0, { center: false });
        cy.animate({ fit: { eles: cy.elements(), padding: 50 }, duration: 400 });
        renderL2Legend();
    });
    lay.run();
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
// Dynamically expands the callees of the target function into the current canvas.
function drillDownExtFunc(node) {
    const d = node.data();
    const targetFile = d._f || null;
    const funcName = d.fn || null;
    if (!targetFile || !funcName) return;
    if (d._drilled) return;   // already expanded

    // Mark as drilled so we don't double-expand
    node.data('_drilled', true);
    node.data('label', funcName + '\n↳');
    node.style('border-style', 'double');

    const funcs = DATA.funcs_by_file[targetFile] || [];
    const callList = DATA.func_calls_by_file?.[targetFile] || null;
    const nameToFile = DATA.func_name_to_file || {};
    const nameToFiles = DATA.func_name_to_files || {};
    const fileToModule = DATA.file_to_module || {};
    const moduleColorMap = {};
    (DATA.modules || []).forEach(m => { moduleColorMap[m.id] = m.color; });

    const targetMod = fileToModule[targetFile] || '';
    const fidIdx = funcs.findIndex(f => f.label === funcName);
    if (fidIdx < 0 || !Array.isArray(callList)) return;

    const callees = new Set(Array.isArray(callList[fidIdx]) ? callList[fidIdx] : []);
    const nodeId = node.id();
    const newEls = [];
    let added = 0;

    function distColor2(tMod) {
        function dist(a, b) {
            if (!a || !b || a === b) return a === b ? 0 : 99;
            const pa = a.split('/'), pb = b.split('/');
            let s = 0, ml = Math.min(pa.length, pb.length);
            for (let i = 0; i < ml; i++) { if (pa[i] === pb[i]) s++; else break; }
            return pa.length + pb.length - 2 * s;
        }
        const d = dist(targetMod, tMod);
        if (d === 0) return '#38bdf8';
        if (d === 1) return '#10b981';
        if (d === 2) return '#f59e0b';
        return '#f87171';
    }

    for (const callee of callees) {
        const childId = `drill-${_hashId(nodeId)}-${_hashId(callee)}`;
        if (cy.$id(childId).length) continue;  // already in graph

        let tf = null, modName = '', ec = '#64748b', bc = '#64748b';
        if (nameToFiles[callee]) {
            tf = nameToFiles[callee][0];
            modName = fileToModule[tf] || '';
            ec = bc = '#a78bfa';   // ambiguous — purple
        } else if (nameToFile[callee]) {
            tf = nameToFile[callee];
            modName = fileToModule[tf] || '';
            ec = bc = distColor2(modName);
        }

        newEls.push({
            data: {
                id: childId, label: callee,
                bg: '#0d1f33', bc: bc || '#64748b',
                w: 140, h: 30, sh: 'roundrectangle', lvl: 2,
                _t: 'drilled_func', fn: callee, _f: tf, mod: modName, _drilled: false,
                tt: tf ? `${callee}\n${tf}\n\nDouble-click to drill further` : `${callee}\n(no file found)`,
            }
        });
        newEls.push({
            data: {
                id: `drille-${_hashId(nodeId)}-${_hashId(callee)}`,
                source: nodeId, target: childId,
                w: 1.4, ec: ec || '#64748b', es: 'solid', el: '',
                tt: `${funcName} → ${callee}`,
            }
        });
        added++;
    }

    if (!added) {
        // No outgoing calls — mark as leaf
        node.data('label', funcName + '\n(leaf)');
        return;
    }

    cy.add(newEls);
    // Re-run layout incrementally
    cy.layout({
        name: 'dagre', rankDir: 'LR', animate: true, animationDuration: 300,
        nodeSep: 26, rankSep: 80, padding: 50
    }).run();
}

// ─── Call Flow Legend ─────────────────────────────────────────────────────────
const L2_LEGEND_ITEMS = [
    { color: '#38bdf8', label: 'Internal call', style: 'solid' },
    { color: '#10b981', label: 'Near module (d=1)', style: 'solid' },
    { color: '#f59e0b', label: 'Mid module (d=2)', style: 'solid' },
    { color: '#f87171', label: 'Far module (d≥3)', style: 'solid' },
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
  <div class="legend-row"><span style="font-size:10px;margin-right:4px">↳</span><span class="legend-label" style="color:#94a3b8">Double-click to drill</span></div>
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

    if (!codeState.jobId) {
        showCpError('No job ID — code preview only available via the local server (launch.bat).');
        return;
    }

    if (filePath === codeState.currentFile) {
        showCpLoading(false);
        if (funcName) jumpToFunc(funcName);
        return;
    }

    try {
        const url = `/file?job=${encodeURIComponent(codeState.jobId)}&path=${encodeURIComponent(filePath)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) { showCpError('Could not load file: ' + data.error); return; }
        codeState.currentFile = filePath;
        renderFileContent(data, ext, fname);
        showCpLoading(false);
        if (funcName) setTimeout(() => jumpToFunc(funcName), 80);
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
        '.sdl': '#34d399', '.sd': '#10b981', '.cif': '#60a5fa', '.mak': '#94a3b8',
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
    'ami_sd': { sh: 'concave-hexagon', w: 170, h: 54 },  // Setup Data — hybrid C+VFR
    'ami_cif': { sh: 'barrel', w: 160, h: 56 },
    'makefile': { sh: 'tag', w: 150, h: 46 },
    // HII ecosystem
    'hii_vfr': { sh: 'round-tag', w: 165, h: 50 },  // UEFI 標準 VFR 表單
    'hii_hfr': { sh: 'round-tag', w: 165, h: 50 },  // AMI HFR 擴充 (相同形狀但較深籉红色)
    'hii_form': { sh: 'round-tag', w: 165, h: 50 },  // backward compat
    'hii_string': { sh: 'round-rectangle', w: 155, h: 44 },  // UNI 字串包
    'acpi_asl': { sh: 'pentagon', w: 160, h: 56 },
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
};

function fileNodeData(f, modColor) {
    const ft = f.file_type || 'other';
    const shape = FILE_TYPE_SHAPE[ft] || FILE_TYPE_SHAPE['other'];
    const baseColor = extColor(f.ext);

    // Build tooltip with BIOS metadata
    const bm = f.bios_meta || {};
    let ttLines = [`${f.path}`];
    ttLines.push(`File Type: ${f.ext.toUpperCase() || 'FILE'}`);
    ttLines.push(`File Size: ${fmtSize(f.size)}`);
    if (f.func_count > 0) ttLines.push(`Funcs: ${f.func_count}`);
    if (bm.MODULE_TYPE || bm.module_type) ttLines.push(`Mod Type: ${bm.MODULE_TYPE || bm.module_type}`);
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
      <div>Browser cannot display PDF inline.</div>
      <div style="margin-top:8px"><a href="${url}" download style="color:var(--accent)">Download PDF</a></div>
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
        // C / ASM
        '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.h': 'cpp', '.hpp': 'cpp',
        '.asm': 'x86asm', '.s': 'x86asm', '.S': 'x86asm',
        // UEFI module metadata — ini-like sections
        '.inf': 'ini', '.dec': 'ini', '.dsc': 'ini', '.fdf': 'ini',
        // AMI specific — ini-like
        '.sdl': 'ini', '.sd': 'ini', '.cif': 'ini', '.mak': 'makefile',
        // HII / ACPI
        '.vfr': 'c', '.hfr': 'c',
        '.uni': 'plaintext',
        '.asl': 'c',
        // Extra types
        '.xml': 'xml', '.bat': 'bat', '.cmd': 'bat',
        '.sh': 'bash', '.py': 'python',
        '.md': 'markdown', '.yaml': 'yaml', '.yml': 'yaml',
        '.json': 'json', '.toml': 'ini',
        '.cmake': 'cmake', '.mk': 'makefile',
    };
    // langHint from server takes priority (e.g. 'xml', 'python')
    const lang = (langHint && langHint !== 'plaintext') ? langHint
        : hlExt[ext] || 'plaintext';

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
    // Double-tap ext/drilled/potential func nodes → lazy drill-down
    cy.on('dbltap', 'node', e => {
        const d = e.target.data();
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
    { key: 'ami_sd', label: '.sd', exts: ['.sd'] },
    { key: 'ami_cif', label: '.cif', exts: ['.cif'] },
    { key: 'makefile', label: '.mak', exts: ['.mak'] },
    { key: 'hii_vfr', label: '.vfr', exts: ['.vfr'] },
    { key: 'hii_hfr', label: '.hfr', exts: ['.hfr'] },
    { key: 'hii_string', label: '.uni', exts: ['.uni'] },
    { key: 'acpi_asl', label: '.asl', exts: ['.asl'] },
    // ── files not deeply analysed ──────────────────────────────────
    { key: 'other', label: 'Other (undef)', exts: [], isExtra: true },
    { key: 'binary', label: 'Binary/Obj', exts: [], isExtra: true },
];
// 預設全部勾選顯示
const ftActiveFilter = new Set([
    'c_source', 'header', 'assembly', 'module_inf', 'package_dec',
    'platform_dsc', 'flash_desc', 'ami_sdl', 'ami_sd', 'ami_cif', 'makefile',
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
    // Also check other_files_by_module
    const otherByMod = DATA.other_files_by_module || {};
    Object.values(otherByMod).forEach(files =>
        files.forEach(f => presentTypes.add(f.file_type || 'other'))
    );

    // Count other/binary totals for display
    const otherTotal = (DATA.stats?.other_files || 0) - (DATA.stats?.binary_files || 0);
    const binaryTotal = DATA.stats?.binary_files || 0;

    const groups = FT_GROUPS.filter(g => {
        if (g.isExtra) {
            if (g.key === 'other') return otherTotal > 0;
            if (g.key === 'binary') return binaryTotal > 0;
        }
        return presentTypes.has(g.key);
    });
    if (!groups.length) return;

    const analysed = groups.filter(g => !g.isExtra);
    const extra = groups.filter(g => g.isExtra);

    function chipHtml(g) {
        const col = g.isExtra ? '#4b5563' : extColor(g.exts[0]);
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

    wrap.innerHTML =
        '<div class="ft-filter-title">File Types</div>' +
        analysed.map(chipHtml).join('') +
        (extra.length
            ? '<div class="ft-separator" title="These files are visible in the graph but not deeply analysed for dependencies">— unanalysed —</div>' +
            extra.map(chipHtml).join('')
            : '');

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
            `<span class="mod-count" title="${m.file_count} analysed${m.other_count ? ` + ${m.other_count} other` : ''}">${m.file_count}${m.other_count ? `<span class="mod-count-extra">+${m.other_count}</span>` : ''}</span>`;

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
    renderFilesFlat(modId, filtered, subPath);
    updateBreadcrumb();
}

// ─── L0: Module View ──────────────────────────────────────────────────────────
function loadLevel0() {
    showLoading(true, 'Rendering modules...');
    hideFuncView();
    state.level = 0; state.activeModule = null; state.activeFile = null; state.activeSubDir = null;
    updateBreadcrumb(); setSidebarActive(null);
    setL1ToolbarVisible(false);

    const els = [];
    DATA.modules.forEach(m => {
        const otherCount = m.other_count || 0;
        const totalLabel = otherCount
            ? `${m.id}\n${m.file_count} + ${otherCount} files`
            : `${m.id}\n${m.file_count} files`;
        const ttExtra = otherCount ? `\nOther/binary: ${otherCount}` : '';
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

    const lay = cy.layout({
        name: 'cose', animate: false, randomize: true,
        nodeRepulsion: 10000, idealEdgeLength: 200, nodeOverlap: 20, padding: 60,
    });
    lay.one('layoutstop', () => showLoading(false));
    lay.run();
}

// ─── L1: Module → show ALL files flat (no folder nodes ever) ─────────────────
function drillToModule(modId, opts) {
    // opts: { focusFile?: string, closeExt?: bool }
    if (state.level === 0) state.history.push({ level: 0 });
    state.level = 1; state.activeModule = modId; state.activeSubDir = null;
    showLoading(true, `Loading ${modId}...`);
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
    updateL1Toolbar(modId, allFiles.length);

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
            return;
        }
    }

    renderFilesFlat(modId, allFiles);
}

// Render flat file nodes in graph — the only graph view for L1
function renderFilesFlat(modId, files, subPath) {
    // Apply File Type Filter (for fully-analysed files)
    const visible = files.filter(f => ftActiveFilter.has(f.file_type || 'other') || ftActiveFilter.size === 0);

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
            const modSlug  = _safeId(extModId) + '-' + _hashId(extModId);
            const groupId  = `depext-${modSlug}`;
            const fileCount = fileMap.size;
            const isExpanded = depMapState.expandedExtModules.has(extModId);
            const modColor  = moduleColorMap[extModId] || '#64748b';

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
                    const ft    = f.file_type || 'other';
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
        const expandBtn   = document.getElementById('l1-expand-all-ext');
        const collapseBtn = document.getElementById('l1-collapse-all-ext');
        if (expandBtn)   expandBtn.style.display   = hasExt ? '' : 'none';
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
        const expandBtn   = document.getElementById('l1-expand-all-ext');
        const collapseBtn = document.getElementById('l1-collapse-all-ext');
        if (expandBtn)   expandBtn.style.display   = 'none';
        if (collapseBtn) collapseBtn.style.display = 'none';
        depMapState.currentExtModules = [];

        // Update stats (files only)
        const statsEl = document.getElementById('l1-stats');
        if (statsEl) statsEl.textContent = `${capped.length} files`;
    }

    cy.elements().remove();
    cy.add(els);
    applyCyFont(getSavedFont());

    // ── Two-pass layout ──────────────────────────────────────────────────────
    // Pass 1: dagre on ONLY the analysed nodes (no extra nodes yet positioned)
    // Pass 2: grid-wrap the extra nodes below the analysed bounding box

    const mainEls = cy.elements().filter(el => !el.data('isExtra'));
    const extraEls = cy.nodes().filter(n => n.data('isExtra'));

    if (extraEls.length === 0) {
        // Simple path: no extras, just run dagre normally
        const lay = cy.layout({ name: 'dagre', rankDir: 'LR', animate: false, nodeSep: 30, rankSep: 90, padding: 40 });
        lay.one('layoutstop', () => { updateBreadcrumb(); showLoading(false); _applyPendingFocus(); });
        lay.run();
        return;
    }

    // Hide extra nodes while dagre runs so they don't affect the layout
    extraEls.style('display', 'none');

    const layMain = cy.layout({
        name: 'dagre', rankDir: 'LR', animate: false,
        nodeSep: 30, rankSep: 90, padding: 40,
    });

    layMain.one('layoutstop', () => {
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

        cy.fit(cy.elements(), 40);
        updateBreadcrumb();
        showLoading(false);
        _applyPendingFocus();
    });

    layMain.run();
}

// ── After layout: pan+zoom to pendingFocusFile node with flash highlight ───────
function _applyPendingFocus() {
    const targetPath = depMapState.pendingFocusFile;
    if (!targetPath) return;
    depMapState.pendingFocusFile = null;

    // Find the node whose _f.path matches
    const target = cy.nodes().filter(n => {
        const f = n.data('_f');
        return f && (f.path === targetPath);
    }).first();

    if (!target || !target.length) return;

    // First fit to full graph, then animate to target
    cy.fit(cy.elements(), 40);

    setTimeout(() => {
        highlightNode(target);
        cy.animate({
            center: { eles: target },
            zoom: Math.max(cy.zoom(), 1.8),
        }, {
            duration: 700,
            easing: 'ease-in-out-cubic',
            complete: () => {
                // Flash the node border 3 times to draw attention
                let count = 0;
                const originalBc = target.data('bc');
                const flashInterval = setInterval(() => {
                    count++;
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
}

// ─── L2: Function View ────────────────────────────────────────────────────────
function drillToFile(fileRel) {
    state.history.push({ level: 1, activeModule: state.activeModule });
    state.level = 2; state.activeFile = fileRel;
    updateBreadcrumb();
    setL1ToolbarVisible(false);

    // showFuncView handles code panel sync — do NOT call loadFileInPanel separately
    openL2File(fileRel, { newSession: true, pushHistory: true });
    document.getElementById('graph-toggle-btn')?.classList.add('active');
}

// Dedicated code-panel sync — called only from showFuncView to avoid race conditions
async function _syncCodePanel(fileRel, funcName, targetCallText = null) {
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
            requestAnimationFrame(() => jumpToFunc(funcName, targetCallText));
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
        renderFileContent(data, ext, fname);
        showCpLoading(false);
        if (funcName) requestAnimationFrame(() => jumpToFunc(funcName, targetCallText));
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
    clearFuncOverlay();
    setL2ToolbarVisible(false);
    clearL2Legend();
    l2State.activeFile = null;
    l2State.activeFuncIdx = 0;
    l2State.expandedModules = new Set();
    l2State.externalModules = [];
    l2State._expandInitialized = false;
    // Clear graph-toggle active state when leaving L2
    document.getElementById('graph-toggle-btn')?.classList.remove('active');
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
        if (d._t === 'ext_func') {
            const now = performance.now();
            const sameNode = extClickLastId === node.id();
            const isDouble = sameNode && (now - extClickLastTime) < EXT_DOUBLE_CLICK_MS;

            extClickLastId = node.id();
            extClickLastTime = now;
            highlightNode(node);
            if (isDouble) {
                focusL2External({ file: d._f || null, func: d.fn, mod: d.mod, nodeId: node.id() }, { center: true });
            } else {
                const callerIdx = pickCallerIdxForExternal(node);
                if (callerIdx != null) l2State.activeFuncIdx = callerIdx;
                syncActiveL2FuncCode(d.fn);
            }
            return;
        }
        if (d._t === 'potential_func') {
            const now = performance.now();
            const sameNode = extClickLastId === node.id();
            const isDouble = sameNode && (now - extClickLastTime) < EXT_DOUBLE_CLICK_MS;

            extClickLastId = node.id();
            extClickLastTime = now;
            highlightNode(node);
            if (isDouble) {
                drillDownExtFunc(node);
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
            // Single click → code panel preview
            if (d._f?.path) loadFileInPanel(d._f.path);
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
    addSeg('Modules', () => { state.history = []; loadLevel0(); }, state.level === 0, 'Modules');

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
                : `<div class="tip-body">Unknown target</div>`;
            html += `<div class="tip-actions">` +
                `<button class="tip-btn" data-action="open" data-file="${encodeURIComponent(fileRel)}" data-func="${encodeURIComponent(funcName)}">Open Location</button>` +
                `<button class="tip-btn" data-action="view" data-file="${encodeURIComponent(fileRel)}" data-func="${encodeURIComponent(funcName)}">View File</button>` +
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
            html += `<div style="font-weight:bold; margin-bottom:4px">Dependencies:</div>`;

            const OUT_MAP = {
                'Inc': 'Include', 'owns': 'owns', 'Src': 'sources', 'Pkg': 'package', 'Lib': 'library',
                'ELINK': 'elink', 'Comp': 'component', 'GUID': 'guid ref',
                'Strings': 'strings', 'ASL': 'asl include', 'Callback': 'callback',
                'HII-Pkg': 'hii pkg', 'Depex': 'depex',
                'ext': 'external calls', 'group': 'group',
                '': state.level === 2 ? 'calls' : 'includes'
            };
            const IN_MAP = {
                'Inc': 'Included by', 'owns': 'owned by', 'Src': 'source of', 'Pkg': 'packaged in', 'Lib': 'used as lib by',
                'ELINK': 'elink parent of', 'Comp': 'used as comp by', 'GUID': 'referenced guid by',
                'Strings': 'referenced as string by', 'ASL': 'included by asl', 'Callback': 'triggered by',
                'HII-Pkg': 'packaged in hii', 'Depex': 'depended by',
                'ext': 'external callers', 'group': 'group',
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
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function dedupeBy(arr, key) { return [...new Map(arr.map(x => [x[key], x])).values()]; }
function fmtSize(b) { return b > 1e6 ? (b / 1e6).toFixed(1) + 'MB' : b > 1e3 ? (b / 1e3).toFixed(0) + 'KB' : b + 'B'; }

// Path distance: count differing segments between two module/folder paths
function _pathDist(a, b) {
    if (!a || !b) return a === b ? 0 : 99;
    const pa = a.split('/'), pb = b.split('/');
    let shared = 0;
    const ml = Math.min(pa.length, pb.length);
    for (let i = 0; i < ml; i++) {
        if (pa[i] === pb[i]) shared++;
        else break;
    }
    return (pa.length - shared) + (pb.length - shared);
}

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
    { shape: '⬡', label: '.sd', color: '#10b981' },
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