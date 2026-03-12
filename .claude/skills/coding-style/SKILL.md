---
name: coding-style
description: CodeViz 專案的程式碼風格規範。在新增或修改任何 Python 或 JavaScript 程式碼時必須遵守這些規則。Use this skill whenever writing or reviewing code in this project.
---

# CodeViz 程式碼風格規範

## 通用原則

- **零外部依賴**: 嚴禁引入任何需要 `pip install` 的第三方套件。只能使用 Python 標準函式庫。前端同理，只能使用已在 `launcher.html` 或 `static/` 載入的函式庫（目前有 D3.js、highlight.js）。
- **單一職責**: 每個函式只做一件事，超過 60 行就考慮分拆。
- **失效無聲 (Silent fail)**: Parser 裡的所有 I/O 和 regex 都要包在 `try/except` 中，解析失敗時返回空值，不要讓例外往上傳播並中斷整個分析。

---

## Python 規範

### 命名
```python
# 常數 → UPPER_SNAKE_CASE
SCAN_EXT = {'.py', '.js'}
MAX_FILE_BYTES = 2 * 1024 * 1024

# 函式/方法 → snake_case，私有函式加底線前綴
def scan_file(filepath: str, root: str): ...
def _build_search_index(jid: str, root: str): ...

# 類別 → PascalCase (本專案很少用)
class Handler(BaseHTTPRequestHandler): ...
```

### Import 順序
```python
# 1. 標準庫
import os, re, json, sys
from pathlib import Path
from typing import Dict, Optional

# 2. 本專案模組（用明確路徑，不要 wildcard import）
from parsers.bios_parser import scan_bios
```

### 型別標注
- 公開函式的參數和回傳值要加型別標注
- 複雜的 dict/list 結構用 `Dict[str, str]` 或 `list[dict]` 表示
- 不要為了型別標注而犧牲可讀性，內部輔助函式可省略

### 字串格式化
- 優先使用 f-string：`f'Found {total} files'`
- 多行字串用三引號，對齊縮排

### 錯誤處理
```python
# 好：明確捕捉，靜默失敗
try:
    src = Path(filepath).read_text(encoding='utf-8', errors='replace')
except Exception:
    return [], [], [], None, []

# 不好：空的 except 完全不知道發生什麼事
try:
    ...
except:
    pass
```

### 分節註解風格
用 `# ─── 標題 ───` 分隔大區塊（用 `─` 字元，Unicode U+2500）：
```python
# ─── Constants ───────────────────────────────────────────────────────────────
SKIP_DIRS = { ... }

# ─── HTTP Handler ─────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
```

### 字典對齊（選擇性）
在常數字典中，值對齊可以加强可讀性：
```python
EDGE_TYPES = {
    'include':   {'label': 'Include', 'color': '#c084fc'},
    'sources':   {'label': 'Sources', 'color': '#ffd700'},
    'import':    {'label': 'Import',  'color': '#10b981'},
}
```

---

## JavaScript 規範（`static/viz.js`、`static/i18n.js`）

### 命名
```javascript
// 常數 → UPPER_SNAKE_CASE
const FILE_TYPE_SHAPE = { ... };
const MAX_LABEL_LEN = 24;

// 函式 → camelCase
function extColor(ext) { ... }
function buildGraph(data) { ... }

// 私有輔助 → 底線前綴 + camelCase（選擇性，看上下文）
function _applyL2Snapshot(slot) { ... }
```

### DOM 操作
- 不要重複 `document.getElementById`，宣告在頂部常數或在初始化函式中快取
- 事件監聽器用 `addEventListener`，不用 inline `onclick`

### 非同步
- 用 `async/await` + `try/catch`，不用裸 `.then().catch()`
- fetch 的錯誤要同時處理 HTTP 錯誤和網路錯誤：
```javascript
async function fetchData(url) {
    try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    } catch (e) {
        console.error('[fetchData]', e);
        return null;
    }
}
```

### 模組組織
- 相關的常數、狀態、函式放在一起，用區塊注釋分隔：
```javascript
// ── Graph state ───────────────────────────────────────────────────────────────
let currentJobId = null;
let graphData = null;

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderGraph(data) { ... }
```

### 禁止事項
- 禁止使用 `var`，用 `const` 或 `let`
- 禁止全域污染：不要掛多餘的屬性到 `window` 上
- 禁止 `innerHTML` 拼接使用者輸入（XSS 風險），用 `textContent` 或 DOM API

---

## Parser 介面規範（新增或修改 parsers/ 時）

所有 `parsers/*.py` 的主函式必須回傳這個 tuple 格式：

```python
return (
    imports_or_refs,      # list[str]
    funcdefs,             # list[dict]: [{label, is_efiapi, is_static}, ...]
    funccalls,            # list[str]
    extra_dict,           # dict | None
    func_calls_by_func,   # list[list[str]]
)
```

**永遠不要** 在 parser 內部直接 import 或修改 `analyze_viz.py` 的常數。Parser 是純粹的文字轉換器，不知道外面的世界。
