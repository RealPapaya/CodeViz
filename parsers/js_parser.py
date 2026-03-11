#!/usr/bin/env python3
"""
parsers/js_parser.py — VIZCODE JavaScript & TypeScript Parser

Extracts:
  imports        → module specifiers from ES6 import / CommonJS require
  funcdefs       → named function declarations, arrow functions, class methods
  funccalls      → all call expressions
  func_calls_by_func → per-function call lists (body-scoped via brace matching)
  symbol_defs    → structured symbol table [{kind, name, line, bases, parent}, ...]
"""

import re

# ─── JS/TS keywords to ignore ─────────────────────────────────────────────────
JS_KEYWORDS = {
    'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'return',
    'typeof', 'instanceof', 'new', 'delete', 'void', 'in', 'of',
    'class', 'extends', 'import', 'export', 'from', 'const', 'let',
    'var', 'function', 'async', 'await', 'try', 'catch', 'finally',
    'throw', 'undefined', 'null', 'true', 'false', 'this', 'super',
    'yield', 'default', 'break', 'continue', 'debugger', 'with',
    # Common globals
    'console', 'process', 'require', 'module', 'exports', 'window',
    'document', 'Math', 'JSON', 'Array', 'Object', 'String', 'Number',
    'Boolean', 'Promise', 'Error', 'Set', 'Map', 'Symbol', 'BigInt',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'fetch', 'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach',
}

# ─── Regex patterns ───────────────────────────────────────────────────────────

# ES6:  import X from 'module'  /  import { X } from 'module'
RE_JS_IMPORT = re.compile(
    r"""(?:^|;|\})\s*import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]""",
    re.MULTILINE
)
# CommonJS: require('module')
RE_JS_REQUIRE = re.compile(r"""\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)""")

# Named function declarations:  function myFunc(  /  async function myFunc(
RE_JS_FUNC_DECL = re.compile(
    r'(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(',
    re.MULTILINE
)
# Arrow / function-expression assignments:
#   const myFunc = (...) =>  /  const myFunc = function(
RE_JS_ARROW = re.compile(
    r'(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w]+)\s*=>',
    re.MULTILINE
)
RE_JS_FUNC_EXPR = re.compile(
    r'(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\*?\s*\(',
    re.MULTILINE
)
# Class method:  methodName( ... ) {  (indented, not a keyword)
RE_JS_METHOD = re.compile(
    r'^\s{2,}(?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?(\w+)\s*\([^)]*\)\s*(?:\:\s*\w[\w<>|&,\[\]\s]*\s*)?\{',
    re.MULTILINE
)

# Call sites
RE_JS_CALL = re.compile(r'\b([A-Za-z_$][\w$]*)\s*\(')

# Class declarations
RE_JS_CLASS = re.compile(
    r'(?:^|\s)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)'
    r'(?:\s+extends\s+([\w.]+))?(?:\s+implements\s+([\w,\s.]+))?\s*\{',
    re.MULTILINE
)

# Strip // and /* */ comments (very rough, ignores strings — adequate for import/def extraction)
RE_LINE_COMMENT   = re.compile(r'//[^\n]*')
RE_BLOCK_COMMENT  = re.compile(r'/\*.*?\*/', re.DOTALL)


def _strip_comments(src: str) -> str:
    src = RE_BLOCK_COMMENT.sub(' ', src)
    src = RE_LINE_COMMENT.sub('', src)
    return src


def _parse_imports(src: str) -> list:
    refs = []
    for m in RE_JS_IMPORT.finditer(src):
        spec = m.group(1)
        # Relative: './utils' → 'utils', '../foo/bar' → 'bar'
        if spec.startswith('.'):
            part = spec.rstrip('/').split('/')[-1]
            # strip extension if present
            part = part.rsplit('.', 1)[0] if '.' in part else part
        else:
            # npm: 'react-dom' → 'react-dom', '@org/pkg' → '@org/pkg'
            part = spec.split('/')[0] if not spec.startswith('@') else '/'.join(spec.split('/')[:2])
        if part:
            refs.append(part)
    for m in RE_JS_REQUIRE.finditer(src):
        spec = m.group(1)
        if spec.startswith('.'):
            part = spec.rstrip('/').split('/')[-1].rsplit('.', 1)[0]
        else:
            part = spec.split('/')[0]
        if part:
            refs.append(part)
    return list(set(refs))


def _brace_body(src: str, open_idx: int) -> str:
    """Return the text inside the outermost { } starting at open_idx."""
    depth = 0
    for i in range(open_idx, len(src)):
        c = src[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return src[open_idx + 1:i]
    return ''


def _extract_calls(text: str) -> list:
    return [
        m.group(1) for m in RE_JS_CALL.finditer(text)
        if m.group(1) not in JS_KEYWORDS and len(m.group(1)) >= 2
    ]


def _parse_symbol_defs(src: str, clean: str) -> list:
    """Extract class + method symbols from JS/TS source."""
    symbols = []
    # Classes
    for m in RE_JS_CLASS.finditer(clean):
        name = m.group(1)
        extends = m.group(2)
        implements_raw = m.group(3) or ''
        line_no = src[:m.start()].count('\n') + 1
        bases = []
        if extends:
            bases.append(extends.strip())
        for iface in implements_raw.split(','):
            iface = iface.strip()
            if iface:
                bases.append(iface)
        symbols.append({
            'kind':      'class',
            'name':      name,
            'line':      line_no,
            'end_line':  line_no,  # rough; full end-detection is complex in JS
            'bases':     bases,
            'parent':    None,
            'is_public': not name.startswith('_'),
        })
        # Methods inside the class body
        open_idx = clean.find('{', m.end() - 1)
        body = _brace_body(clean, open_idx) if open_idx != -1 else ''
        for mm in RE_JS_METHOD.finditer(body):
            mname = mm.group(1)
            if mname in JS_KEYWORDS:
                continue
            mline = line_no + body[:mm.start()].count('\n')
            symbols.append({
                'kind':      'method',
                'name':      mname,
                'line':      mline,
                'end_line':  mline,
                'bases':     [],
                'parent':    name,
                'is_public': not mname.startswith('_'),
            })
    # Top-level functions not inside a class
    class_ranges = set()
    for s in symbols:
        if s['kind'] == 'class':
            # Mark approximate line range as class-owned
            class_ranges.add(s['line'])
    for m in RE_JS_FUNC_DECL.finditer(clean):
        fname = m.group(1)
        if fname in JS_KEYWORDS:
            continue
        line_no = src[:m.start()].count('\n') + 1
        symbols.append({
            'kind':      'function',
            'name':      fname,
            'line':      line_no,
            'end_line':  line_no,
            'bases':     [],
            'parent':    None,
            'is_public': not fname.startswith('_'),
        })
    return symbols


def scan_js(src: str) -> tuple:
    """
    JavaScript file analysis.

    Returns: (imports, funcdefs, all_calls, extra_dict, func_calls_by_func, symbol_defs)
    """
    clean = _strip_comments(src)
    imports = _parse_imports(clean)

    funcdefs = []
    func_calls_by_func = []

    # Collect (match_obj, name, is_private) for all function patterns
    candidates = []

    for m in RE_JS_FUNC_DECL.finditer(clean):
        name = m.group(1)
        if name and name not in JS_KEYWORDS:
            candidates.append((m, name, name[0].islower()))

    for m in RE_JS_ARROW.finditer(clean):
        name = m.group(1)
        if name and name not in JS_KEYWORDS and len(name) >= 2:
            candidates.append((m, name, name[0].islower()))

    for m in RE_JS_FUNC_EXPR.finditer(clean):
        name = m.group(1)
        if name and name not in JS_KEYWORDS and len(name) >= 2:
            candidates.append((m, name, name[0].islower()))

    for m in RE_JS_METHOD.finditer(clean):
        name = m.group(1)
        if name and name not in JS_KEYWORDS and name not in ('constructor', 'render'):
            candidates.append((m, name, name.startswith('_') or name[0].islower()))

    # De-duplicate by name, keep first occurrence
    seen = set()
    for m, name, is_priv in candidates:
        if name in seen:
            continue
        seen.add(name)
        funcdefs.append({
            'label':     name,
            'is_efiapi': False,
            'is_static': is_priv,
        })
        # Try to extract body via brace matching
        open_idx = clean.find('{', m.end())
        body = _brace_body(clean, open_idx) if open_idx != -1 else ''
        func_calls_by_func.append(_extract_calls(body))

    all_calls = _extract_calls(clean)
    symbol_defs = _parse_symbol_defs(src, clean)

    extra = {'imports': imports, 'lang': 'javascript'}
    return imports, funcdefs, all_calls, extra, func_calls_by_func, symbol_defs


def scan_ts(src: str) -> tuple:
    """TypeScript — delegate to JS scanner (TS is a superset)."""
    imports, funcdefs, calls, extra, fcbf, sym_defs = scan_js(src)
    extra['lang'] = 'typescript'
    return imports, funcdefs, calls, extra, fcbf, sym_defs
