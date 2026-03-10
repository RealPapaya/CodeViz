# Implementation Guide: Stateful UI Default-Behaviour

This guide provides the exact implementation steps and code examples for the stateful default-behaviour pattern.

## Implementation Checklist

### 1. Preference Registry

Add every default-behaviour toggle to the central preferences object. Defaults belong here, not scattered across render functions.

```js
const _PREFS = {
    KEYS: {
        extFiles:  'biosviz_ext_files',   // show/hide external file nodes (L1)
        extFuncs:  'biosviz_ext_funcs',   // show/hide external func nodes (L2)
        extExpand: 'biosviz_ext_expand',  // expand all groups by default?
    },
    DEFAULTS: {
        extFiles: false, extFuncs: false, extExpand: true,
    },
    get(k)  { /* localStorage with fallback to DEFAULTS */ },
    set(k,v){ /* localStorage.setItem */ },
};
```

### 2. One Initialization Flag Per Graph Level

Each graph level (e.g., L1 dependency map, L2 call graph) needs its own "have I applied defaults yet?" flag. This ensures the first render initialises expand state and subsequent re-renders (collapse group, toggle filter, etc.) do not reset it.

**L1 (depMapState):**
```js
const depMapState = {
    expandedExtModules: new Set(),
    _extModsInitialized: false,   // ← add this flag
    currentModId: null,
    // ...
};
```

**L2 (l2State):**
```js
const l2State = {
    expandedModules: new Set(),
    _expandInitialized: false,    // already existed; now correctly gated
    // ...
};
```

### 3. Reset the Flag on Fresh Navigation

When navigating to a **new** module/file (not via history), reset the init flag **before** the render function runs:

```js
// drillToModule (L1)
if (depMapState.currentModId !== modId) {
    depMapState.expandedExtModules = new Set();
    depMapState._extModsInitialized = false;   // ← reset here
    depMapState.currentModId = modId;
}

// renderL2Flowchart (L2)
if (l2State.activeFile !== fileRel) {
    resetL2State(fileRel);          // sets _expandInitialized = false inside
}
```

### 4. Apply Default Inside the Render Function (One-Shot)

Inside the render function, after computing the full set of groups, apply the default **once**:

```js
// ── L1: renderFilesFlat ──────────────────────────────────────────────────────
depMapState.currentExtModules = Array.from(extModMap.keys());

if (!depMapState._extModsInitialized) {
    depMapState._extModsInitialized = true;
    if (_PREFS.get('extExpand')) {
        depMapState.expandedExtModules = new Set(extModMap.keys()); // expand all
    }
    // extExpand=false → keep expandedExtModules as new Set() (collapse all)
}

// ── L2: renderL2Flowchart ────────────────────────────────────────────────────
if (!l2State._expandInitialized) {
    l2State._expandInitialized = true;

    // Only expand if external funcs are actually visible
    const shouldExpand = l2State.showExternalFuncs && _PREFS.get('extExpand');
    l2State.expandedModules = shouldExpand ? new Set(extMap.keys()) : new Set();

    if (!l2State.expandedSysCategories) l2State.expandedSysCategories = new Set();
    if (shouldExpand) {
        sysMap.forEach((_, cat) => l2State.expandedSysCategories.add(cat));
        if (unkMap.size > 0) l2State.expandedSysCategories.add('__unk__');
    }
}
```

**Crucially:** `showExternalFuncs` being OFF gates the whole expand logic — if the user doesn't want external nodes at all, their expand/collapse state is irrelevant.

### 5. History Navigation Must Bypass the Flag

Prev/Next history handlers must **restore a snapshot** before calling the render function, not after. Because the init flag is false only on fresh visits, restoring a snapshot must set `_expandInitialized = true` (via the snapshot field or a flag carried through). This ensures the "apply default" block is skipped:

```js
function goL2Prev() {
    _saveL2Snapshot();              // save current slot first
    l2State.fileHistoryIdx -= 1;
    _applyL2Snapshot(l2State.fileHistoryIdx);  // ← restores expandedModules, viewport
    openL2File(fileRel, { pushHistory: false });
    // renderL2Flowchart sees _expandInitialized=true → skips default block ✓
}

function _applyL2Snapshot(idx) {
    const snap = l2State.fileHistorySnapshots[idx];
    if (!snap) return;
    l2State.expandedModules          = new Set(snap.expandedModules);
    l2State.expandedSysCategories    = new Set(snap.expandedSysCategories);
    l2State.activeFuncIdx            = snap.activeFuncIdx;
    l2State.preserveViewport         = { pan: snap.pan, zoom: snap.zoom };
    l2State.expandOriginPos          = null;
    // _expandInitialized must be true after snapshot restore so default is NOT reapplied
    l2State._expandInitialized       = true;   // ← add this line
}
```

### 6. Preference UI Wiring

```js
// In initPreferences:
_syncCheck('pref-ext-files',  _PREFS.get('extFiles'));
_syncCheck('pref-ext-funcs',  _PREFS.get('extFuncs'));
_syncCheck('pref-ext-expand', _PREFS.get('extExpand'));

_bindCheck('pref-ext-files',  'extFiles',  v => { depMapState.showExternalFiles = v; updateDepMapExtToggle(); });
_bindCheck('pref-ext-funcs',  'extFuncs',  v => { l2State.showExternalFuncs = v; l2State.showExternalEdges = v; updateExternalFuncsToggle?.(); });
_bindCheck('pref-ext-expand', 'extExpand', _v => { /* saved; takes effect on next file/module load */ });
```

HTML checkbox to add to the preference modal:
```html
<label class="pref-check">
  <input type="checkbox" id="pref-ext-expand">
  <span class="pref-check-label">Expand external groups by default</span>
  <span class="pref-check-desc">When opening a file or module, expand all external groups automatically.</span>
</label>
```

---

## Common Mistakes to Avoid

| Mistake | Fix |
|---|---|
| Applying the default every time `renderL2Flowchart` is called | Gate with `!_expandInitialized` flag |
| Forgetting to reset the flag in `drillToModule` when the module changes | `_extModsInitialized = false` before render |
| Expand default ignoring `showExternalFuncs` state | `const shouldExpand = showExternalFuncs && _PREFS.get('extExpand')` |
| History restore calling render before restoring snapshot | Always `_applyL2Snapshot()` → then `openL2File()` |
| Snapshot restore not setting `_expandInitialized = true` | Add it to `_applyL2Snapshot` |
| Sys-API category groups not included in expand-all default | Iterate `sysMap` and add each category in `_expandInitialized` block |
