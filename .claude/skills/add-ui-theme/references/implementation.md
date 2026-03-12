# Implementation Guide: Add UI Theme

This guide provides the exact steps for registering a new theme in `themes.css` and updating UI toggles.

## Implementation Checklist

### 1. Define Theme Variables in `themes.css`

All themes must reside in the shared static stylesheet. Create a new `[data-theme="theme_name"]` block.

```css
[data-theme="my-new-theme"] {
    --bg: #ffffff;
    --panel: #f5f5f5;
    --panel2: #e0e0e0;
    --border: #cccccc;
    --card-bg: #fafafa;
    --accent: #2563eb;
    --accent2: #1d4ed8;
    --text: #1a1a1a;
    --muted: #6b7280;
}
```

### 2. Extend Global Overrides

If your new theme requires specific component overrides (e.g., hover states, borders for tabs, scrollbars), do so using the `data-theme` attribute selector just below the variable definition.

```css
[data-theme="my-new-theme"] .tab.active,
[data-theme="my-new-theme"] .tab:hover {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
}

[data-theme="my-new-theme"] ::-webkit-scrollbar-thumb {
    background: var(--border);
}
```

### 3. Add to the Theme Carousel / Switcher

If an HTML/JS selector exists (e.g., in `launcher.html` or `viz.js`), add an option for the new theme.
Ensure `document.documentElement.setAttribute('data-theme', 'my-new-theme')` is fired upon selection so the CSS variables apply instantly.

### 4. Verify Common Mistakes

| Mistake | Fix |
|---|---|
| Hardcoding `color: #ff0000;` on a `.btn` | Use `color: var(--accent);` |
| Forgetting hover states | Ensure `.tab:hover` and `.btn:hover` are mapped to `--accent2` or similar. |
| Missing scrollbar colors | Add `::-webkit-scrollbar-thumb` override for the theme. |
| Forgetting to use `.sr-fuzzy-mark` logic | Verify search result highlights are readable on the new `--bg`. |
