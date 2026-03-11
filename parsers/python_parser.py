#!/usr/bin/env python3
"""
parsers/python_parser.py — VIZCODE Python Language Parser

Extracts:
  imports        → module names from 'import X' / 'from X import Y'
  funcdefs       → function definitions (top-level & class methods)
  funccalls      → all call expressions
  func_calls_by_func → per-function call lists (indexed parallel to funcdefs)
  symbol_defs    → structured symbol table [{kind, name, line, end_line, bases, parent}, ...]
"""

import re

# ─── Python keywords / builtins to ignore in call extraction ─────────────────
PY_KEYWORDS = {
    'if', 'else', 'elif', 'while', 'for', 'try', 'except', 'with',
    'class', 'return', 'import', 'from', 'def', 'pass', 'break',
    'continue', 'raise', 'yield', 'lambda', 'True', 'False', 'None',
    'self', 'cls', 'super', 'async', 'await', 'global', 'nonlocal',
    # builtins
    'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter',
    'type', 'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr',
    'delattr', 'dir', 'vars', 'repr', 'str', 'int', 'float', 'bool',
    'list', 'dict', 'set', 'tuple', 'sorted', 'reversed', 'iter',
    'next', 'open', 'input', 'format', 'id', 'hash', 'abs', 'min',
    'max', 'sum', 'round', 'any', 'all', 'staticmethod', 'classmethod',
    'property', 'object', 'NotImplemented',
}

# ─── Regex patterns ───────────────────────────────────────────────────────────
RE_PY_IMPORT_FROM = re.compile(
    r'^[ \t]*from\s+([\w.]+)\s+import\s+', re.MULTILINE)
RE_PY_IMPORT = re.compile(
    r'^[ \t]*import\s+([\w., \t]+)', re.MULTILINE)
RE_PY_FUNCDEF = re.compile(
    r'^([ \t]*)(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(', re.MULTILINE)
RE_PY_CLASSDEF = re.compile(
    r'^([ \t]*)class[ \t]+(\w+)[ \t]*(?:\(([^)]*)\))?[ \t]*:', re.MULTILINE)
RE_PY_CALL = re.compile(r'\b([A-Za-z_]\w*)\s*\(')
RE_PY_DECORATOR = re.compile(r'^\s*@\w+', re.MULTILINE)


def _parse_imports(src: str) -> list:
    """Extract unique top-level module names from import statements."""
    modules = []
    for m in RE_PY_IMPORT_FROM.finditer(src):
        top = m.group(1).split('.')[0]
        if top:
            modules.append(top)
    for m in RE_PY_IMPORT.finditer(src):
        for raw in m.group(1).split(','):
            token = raw.strip().split(' ')[0].split('.')[0]
            if token:
                modules.append(token)
    return list(set(modules))


def _extract_calls(text: str) -> list:
    return [
        m.group(1) for m in RE_PY_CALL.finditer(text)
        if m.group(1) not in PY_KEYWORDS and len(m.group(1)) >= 2
    ]


def _parse_symbol_defs(src: str) -> list:
    """
    Build structured symbol list combining classes and functions.
    Returns list of dicts:
      { kind, name, line, end_line, bases, parent, qualified }
    where parent is the enclosing class name (or None for top-level items).
    """
    lines = src.splitlines()
    n = len(lines)

    # Collect all class and def positions with their indent
    items = []  # (line_no_0based, indent, kind, name, bases_str)

    for m in RE_PY_CLASSDEF.finditer(src):
        indent = len(m.group(1).expandtabs(4))
        name = m.group(2)
        bases_str = m.group(3) or ''
        line_no = src[:m.start()].count('\n')
        items.append((line_no, indent, 'class', name, bases_str))

    for m in RE_PY_FUNCDEF.finditer(src):
        indent = len(m.group(1).expandtabs(4))
        name = m.group(2)
        line_no = src[:m.start()].count('\n')
        items.append((line_no, indent, 'def', name, ''))

    items.sort(key=lambda x: x[0])

    symbols = []
    for i, (line_no, indent, kind, name, bases_str) in enumerate(items):
        # Find end line: next item at same-or-lesser indent, or EOF
        end_line = n - 1
        for j in range(i + 1, len(items)):
            nxt_line, nxt_indent, *_ = items[j]
            if nxt_indent <= indent:
                # end is one line before next peer/ancestor
                end_line = nxt_line - 1
                break

        # Determine parent class (nearest enclosing class with lower indent)
        parent = None
        for j in range(i - 1, -1, -1):
            p_line, p_indent, p_kind, p_name, _ = items[j]
            if p_indent < indent and p_kind == 'class':
                parent = p_name
                break

        # Parse bases
        bases = []
        if bases_str.strip():
            for b in bases_str.split(','):
                b = b.strip().split('(')[0].split('[')[0]
                if b and b not in ('object', ''):
                    bases.append(b)

        # Determine final kind
        if kind == 'class':
            sym_kind = 'class'
        elif parent:
            sym_kind = 'method'
        else:
            sym_kind = 'function'

        is_private = name.startswith('_') or (sym_kind == 'function' and indent > 0)

        symbols.append({
            'kind':      sym_kind,
            'name':      name,
            'line':      line_no + 1,    # 1-based
            'end_line':  end_line + 1,   # 1-based
            'bases':     bases,
            'parent':    parent,
            'is_public': not is_private,
        })

    return symbols


def scan_python(src: str) -> tuple:
    """
    Full Python file analysis.

    Returns:
      (imports, funcdefs, all_calls, extra_dict, func_calls_by_func, symbol_defs)

    Where funcdefs is a list of {'label': name, 'is_efiapi': False, 'is_static': bool}
    and func_calls_by_func is a parallel list of [callee_name, ...].
    symbol_defs is the extended symbol table for Phase 1.
    """
    imports = _parse_imports(src)

    # ── Function definition extraction with body scope ───────────────────────
    lines = src.splitlines()
    n = len(lines)

    funcdefs = []
    func_calls_by_func = []

    def_positions = []
    for m in RE_PY_FUNCDEF.finditer(src):
        indent = len(m.group(1).expandtabs(4))
        name   = m.group(2)
        line_no = src[:m.start()].count('\n')
        def_positions.append((line_no, indent, name))

    for pos_i, (line_no, indent, name) in enumerate(def_positions):
        is_private = (indent > 0) or name.startswith('_')
        funcdefs.append({
            'label':     name,
            'is_efiapi': False,
            'is_static': is_private,
        })

        body_lines = []
        j = line_no + 1
        next_boundary = n
        if pos_i + 1 < len(def_positions):
            next_line, next_indent, _ = def_positions[pos_i + 1]
            if next_indent <= indent:
                next_boundary = next_line

        while j < min(next_boundary, n):
            ln = lines[j]
            stripped = ln.strip()
            if stripped == '' or stripped.startswith('#'):
                j += 1
                continue
            ln_indent = len(ln.expandtabs(4)) - len(ln.expandtabs(4).lstrip())
            if ln_indent <= indent and stripped:
                break
            body_lines.append(ln)
            j += 1

        calls = _extract_calls('\n'.join(body_lines))
        func_calls_by_func.append(calls)

    all_calls = _extract_calls(src)
    symbol_defs = _parse_symbol_defs(src)

    extra = {
        'imports': imports,
        'lang':    'python',
    }
    return imports, funcdefs, all_calls, extra, func_calls_by_func, symbol_defs
