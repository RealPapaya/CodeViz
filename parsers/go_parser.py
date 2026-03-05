#!/usr/bin/env python3
"""
parsers/go_parser.py — VIZCODE Go Language Parser

Extracts:
  imports        → package paths from 'import' statements
  funcdefs       → function declarations (top-level, methods, closures)
  funccalls      → all call expressions
  func_calls_by_func → per-function call lists (body-scoped via brace matching)

Go naming convention:
  UpperCase = exported (public)
  lowerCase = unexported (private, shown as 'static' in UI)
"""

import re

# ─── Go keywords / builtins to ignore ─────────────────────────────────────────
GO_KEYWORDS = {
    'if', 'else', 'for', 'range', 'return', 'func', 'var', 'const', 'type',
    'struct', 'interface', 'import', 'package', 'go', 'chan', 'select',
    'case', 'default', 'defer', 'break', 'continue', 'goto', 'fallthrough',
    'switch', 'map', 'make', 'new', 'len', 'cap', 'append', 'copy', 'close',
    'delete', 'panic', 'recover', 'print', 'println', 'true', 'false', 'nil',
    'iota', 'byte', 'rune', 'error', 'string', 'int', 'int8', 'int16',
    'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64',
    'bool', 'float32', 'float64', 'complex64', 'complex128', 'uintptr',
    'Println', 'Printf', 'Sprintf', 'Errorf', 'Fprintf',
}

# ─── Regex patterns ───────────────────────────────────────────────────────────
# Single-line import:  import "fmt"
RE_GO_IMPORT_SINGLE = re.compile(r'^import\s+"([^"]+)"', re.MULTILINE)
# Grouped import:  import (\n  "fmt"\n  "os"\n)
RE_GO_IMPORT_BLOCK  = re.compile(r'import\s*\((.*?)\)', re.DOTALL)
RE_GO_QUOTED        = re.compile(r'"([^"]+)"')

# Function declaration:
#   func FuncName(          — package-level function
#   func (r *Receiver) Method(   — method on a type
RE_GO_FUNCDEF = re.compile(
    r'^func\s+(?:\([^)]*\)\s+)?(\w+)\s*(?:\[[^\]]*\])?\s*\(',
    re.MULTILINE
)

# Call sites
RE_GO_CALL = re.compile(r'\b([A-Za-z_]\w*)\s*\(')

# Strip // and /* */ comments
RE_GO_LINE_CMT  = re.compile(r'//[^\n]*')
RE_GO_BLOCK_CMT = re.compile(r'/\*.*?\*/', re.DOTALL)


def _strip_comments(src: str) -> str:
    src = RE_GO_BLOCK_CMT.sub(' ', src)
    src = RE_GO_LINE_CMT.sub('', src)
    return src


def _parse_imports(src: str) -> list:
    """Return list of last-segment package names from import paths."""
    paths = []
    for m in RE_GO_IMPORT_SINGLE.finditer(src):
        paths.append(m.group(1))
    for m in RE_GO_IMPORT_BLOCK.finditer(src):
        block = m.group(1)
        for q in RE_GO_QUOTED.finditer(block):
            p = q.group(1).strip()
            # Skip alias lines like:  alias "pkg"
            if p:
                paths.append(p)
    # Return only the last path segment (package name) for stem matching
    result = []
    for p in paths:
        seg = p.rstrip('/').split('/')[-1]
        if seg and seg != '.':
            result.append(seg)
    return list(set(result))


def _brace_body(src: str, open_idx: int) -> str:
    """Return text inside the outermost { } starting at open_idx."""
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
        m.group(1) for m in RE_GO_CALL.finditer(text)
        if m.group(1) not in GO_KEYWORDS and len(m.group(1)) >= 2
    ]


def scan_go(src: str) -> tuple:
    """
    Go file analysis.

    Returns: (imports, funcdefs, all_calls, extra_dict, func_calls_by_func)
    """
    clean = _strip_comments(src)
    imports = _parse_imports(clean)

    funcdefs = []
    func_calls_by_func = []
    seen = set()

    for m in RE_GO_FUNCDEF.finditer(clean):
        name = m.group(1)
        if not name or name in GO_KEYWORDS or name in seen:
            continue
        seen.add(name)

        # Go visibility: uppercase = exported (public), lowercase = unexported (private)
        is_private = name[0].islower()

        funcdefs.append({
            'label':     name,
            'is_efiapi': False,
            'is_static': is_private,
        })

        # Extract body via brace matching
        open_idx = clean.find('{', m.end())
        body = _brace_body(clean, open_idx) if open_idx != -1 else ''
        func_calls_by_func.append(_extract_calls(body))

    all_calls = _extract_calls(clean)

    extra = {
        'imports': imports,
        'lang':    'go',
        'package': _parse_package(src),
    }
    return imports, funcdefs, all_calls, extra, func_calls_by_func


def _parse_package(src: str) -> str:
    """Extract 'package xxx' declaration."""
    m = re.search(r'^package\s+(\w+)', src, re.MULTILINE)
    return m.group(1) if m else ''
