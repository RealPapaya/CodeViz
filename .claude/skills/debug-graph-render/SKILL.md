---
name: debug-graph-render
description: Debug and fix rendering issues in the D3.js graph visualizer (viz.js). Use this skill whenever there are visual bugs in the dependency graph — including node positioning, edge rendering, color/shape incorrect, click events not working, zoom/pan broken, label truncation, or any canvas-related bugs in launcher.html/viz.js.
---

# SKILL: Debug Graph Render Issues

Debugging the D3.js visualizer in `static/viz.js`. The frontend is a single-file SPA with no build step — changes to `static/viz.js` or `static/viz.css` take effect immediately on browser refresh.

## Architecture Quick Reference

```
launcher.html          — Entry SPA, loads static assets, shows progress bar
static/viz.js          — THE frontend heart: D3 layout, node rendering, events, filters
static/viz.css         — All visual styles (colors, shapes via CSS classes)
static/i18n.js         — Translation strings (zh/en)
```

Data flow: `server.py /result` → `build_html()` in `analyze_viz.py` → JSON embedded in HTML → `viz.js` parses and renders.

## Diagnostic Checklist

Before changing any code, run through these checks:

### 1. Console errors
Open DevTools → Console. Look for:
- `TypeError` / `ReferenceError` → JavaScript syntax/logic bug
- `400/500` from fetch calls → backend issue, check `server.py`
- D3 warnings about NaN positions → data has `null` nodes or circular refs

### 2. Identify which layer is broken

| Symptom | Likely Layer | File |
|---------|-------------|------|
| Nodes at (0,0) or overlapping | Layout engine | `viz.js` force simulation params |
| Wrong color/shape | Styling | `viz.css` or `extColor()`/`FILE_TYPE_SHAPE` in `viz.js` |
| Click/hover does nothing | Event handler | `viz.js` `on('click', ...)` bindings |
| Edges missing or wrong direction | Edge resolution | `analyze_viz.py` `add_edge()` |
| Graph blank but no error | Data empty | Check `/result` response JSON structure |
| Zoom broken | D3 zoom | `viz.js` zoom behavior setup |

### 3. Inspect the data
In browser console:
```javascript
// After graph loads, the data is usually stored in a global:
window._graphData   // or look for the variable in viz.js
```

## Common Fixes

### Nodes stuck at origin (0, 0)
The force simulation isn't warming up enough or has `NaN` in positions:
```javascript
// In viz.js, increase simulation ticks or alpha
simulation.alphaDecay(0.02).alphaMin(0.001)
```
Or check if node `x`/`y` are being initialized to `undefined`.

### Edge not appearing
1. Check if `add_edge()` in `analyze_viz.py` created the edge in the JSON
2. Check if `viz.js` filters it out (look for `edge_type` filter logic)
3. Check if both source/target node IDs exist in the nodes array

### Node color wrong
Colors are assigned in two places:
- `extColor(ext)` function in `viz.js` — maps file extension → color hex
- `module_color` dict in `analyze_viz.py` → passed as `color` field per module

CSS classes on `<circle>` or `<path>` elements override D3 inline styles if specificity is higher.

### Click event not firing
D3 event binding uses `.on('click', handler)`. Common issues:
- Another element is intercepting the click (check z-index / pointer-events in CSS)
- The node element has `pointer-events: none` in CSS
- The event was bound before data was ready (use `.call()` or wait for simulation end)

### Labels truncated or overlapping
`viz.js` has a `MAX_LABEL_LEN` constant — adjust it. For overlap, check the `charge` force strength in the simulation.

## Testing After Fix

1. Open `http://localhost:7777`
2. Analyze the `testproject/` directory — it's small and exercises all node types
3. Verify in browser DevTools → Network that `/result` returns valid JSON
4. Check Console for errors

## File Modification Rules

- **`static/viz.js`**: Only file that controls canvas rendering. No backend changes needed for pure visual bugs.
- **`static/viz.css`**: Only for static appearance. Don't put layout logic here.
- **`analyze_viz.py`**: Only if the data in the JSON is wrong (wrong edges, missing nodes). This means the bug is in graph construction, not rendering.
- **`server.py`**: Only if the API response is malformed or the wrong data is being sent.
