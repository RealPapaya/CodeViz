"""
parsers/bios_parser.py — BIOS / UEFI / AMI Firmware Parser

Handles all BIOS-related file types:
  C/C++ / Assembly    .c .cpp .h .hpp .asm .s .S .nasm
  EDK2 build system   .inf .dec .dsc .fdf
  AMI BIOS            .sdl .sd .cif .mak
  HII (Setup UI)      .vfr .hfr .uni
  ACPI                .asl

Entry point:
  scan_bios(src, ext) → (refs, funcdefs, funccalls, extra_dict, func_calls_by_func)

All individual scan_xxx(src) functions are also importable if needed.
"""

import re
from collections import defaultdict

# ─── C keywords / UEFI types (not function names) ─────────────────────────────
C_KEYWORDS = {
    'if','else','while','for','do','switch','case','return','sizeof','typeof',
    'EFIAPI','EFI_STATUS','IN','OUT','OPTIONAL','VOID','UINTN','INTN',
    'UINT8','UINT16','UINT32','UINT64','BOOLEAN','TRUE','FALSE','NULL',
    'PEI_SERVICES','EFI_BOOT_SERVICES','EFI_RUNTIME_SERVICES','ASSERT_EFI_ERROR',
    'static','inline','extern','const','struct','union','enum','typedef',
    'printf','sprintf','memset','memcpy','strlen','strcmp','malloc','free',
}

# ─── Regex ─────────────────────────────────────────────────────────────────────
RE_INCLUDE  = re.compile(r'#\s*include\s+["<]([^">]+)[">]')
RE_FUNCDEF  = re.compile(
    r'^(?:(?:static|inline|extern|EFIAPI|EFI_STATUS|VOID|UINTN|INTN|UINT8|UINT16|UINT32|UINT64|BOOLEAN)\s+)*'
    r'(EFIAPI\s+)?'
    r'[\w\s\*]+\b(\w+)\s*\([^)]*\)\s*(?://[^\n]*)?\s*\{',
    re.MULTILINE
)
RE_FUNCCALL = re.compile(r'\b([A-Za-z_]\w+)\s*\(')
RE_STATIC   = re.compile(r'\bstatic\b')
RE_ASM_INC  = re.compile(r'%include\s+["\'"]([^"\']+)["\'"]|EXTERN\s+(\w+)', re.IGNORECASE)

# INF / DEC / DSC / FDF section header
RE_SECTION  = re.compile(r'^\s*\[([^\]]+)\]', re.MULTILINE)
# INF Sources line: bare filename or path
RE_INF_FILE = re.compile(r'^\s*([\w./\\-]+\.\w+)', re.MULTILINE)
# .sdl INFComponent
RE_SDL_INF  = re.compile(
    r'INFComponent\s*\n(?:\s+\w+\s*=\s*[^\n]*\n)*\s+File\s*=\s*"([^"]+)"',
    re.IGNORECASE
)
# .sdl LibraryMapping
RE_SDL_LIB  = re.compile(
    r'LibraryMapping\s*\n(?:\s+\w+\s*=\s*[^\n]*\n)*\s+Instance\s*=\s*"([^"]+)"',
    re.IGNORECASE
)
# .sdl TOKEN name
RE_SDL_TOKEN = re.compile(r'^TOKEN\s*\n\s+Name\s*=\s*"([^"]+)"', re.MULTILINE | re.IGNORECASE)
# .sdl ELINK Parent
RE_SDL_ELINK = re.compile(
    r'ELINK\s*\n(?:\s+\w+\s*=\s*[^\n]*\n)*?\s+Parent\s*=\s*"([^"]+)"',
    re.IGNORECASE
)
# .cif section markers
RE_CIF_INF   = re.compile(r'^\[INF\](.*?)(?=^\[|\Z)', re.MULTILINE | re.DOTALL | re.IGNORECASE)
RE_CIF_FILES = re.compile(r'^\[files\](.*?)(?=^\[|\Z)', re.MULTILINE | re.DOTALL | re.IGNORECASE)
RE_CIF_PARTS = re.compile(r'^\[parts\](.*?)(?=^\[|\Z)', re.MULTILINE | re.DOTALL | re.IGNORECASE)
RE_QUOTED    = re.compile(r'"([^"]+)"')

# ─── C/C++ Symbol extraction (for symbol_defs / struct view) ──────────────────
# class/struct declaration:  class Foo  /  struct Bar  /  class Foo : public Base
RE_C_CLASS = re.compile(
    r'^(?:typedef\s+)?'
    r'(?:class|struct)\s+(\w+)'
    r'(?:\s*:\s*(?:public|protected|private)?\s*([\w:]+))?'
    r'\s*(?:\{|$)',
    re.MULTILINE
)
# C++ scoped method definition:  void Foo::Bar(...)  {
RE_C_METHOD = re.compile(
    r'^(?:(?:static|inline|virtual|override|explicit|const|'
    r'EFIAPI|EFI_STATUS|VOID|UINTN|INTN|UINT8|UINT16|UINT32|UINT64|BOOLEAN)\s+)*'
    r'[\w\s\*<>:]+\b(\w+)::(\w+)\s*\([^)]*\)\s*(?:const\s*)?\{',
    re.MULTILINE
)
# typedef struct { ... } TypeName;
RE_C_TYPEDEF = re.compile(
    r'typedef\s+(?:struct|union)\s*\w*\s*\{[^}]*\}\s*(\w+)\s*;',
    re.DOTALL
)

# VFR/HFR (shared)
_RE_STR_TOKEN   = re.compile(r'\bSTRING_TOKEN\s*\(\s*(\w+)\s*\)', re.IGNORECASE)
_RE_VFR_FORMSET = re.compile(
    r'\bformset\s+guid\s*=\s*\{([^}]+)\}\s*,\s*title\s*=\s*STRING_TOKEN\s*\(\s*(\w+)\s*\)',
    re.IGNORECASE | re.DOTALL
)
_RE_VFR_FORM    = re.compile(
    r'\bform\s+formid\s*=\s*(\d+)\s*,\s*title\s*=\s*STRING_TOKEN\s*\(\s*(\w+)\s*\)',
    re.IGNORECASE
)
_RE_VFR_CB      = re.compile(
    r'(?:AMI_CALLBACK_KEY\s*\(\s*(\w+)\s*\)|\bkey\s*=\s*(0x[0-9A-Fa-f]+|\d+)\b)',
    re.IGNORECASE
)
_RE_VFR_LABEL   = re.compile(r'\blabel\s+(0x[0-9A-Fa-f]+|\w+)', re.IGNORECASE)


def _parse_c_symbol_defs(src: str, clean: str) -> list:
    """
    Extract struct/class/method/function symbols from C/C++ source.
    Returns list of symbol dicts compatible with analyze_viz.py symbol_index format.
    """
    symbols = []
    seen_names = set()

    # ── 1. Struct / Class declarations ──────────────────────────────────────
    for m in RE_C_CLASS.finditer(clean):
        name = m.group(1)
        if name in C_KEYWORDS or len(name) < 2:
            continue
        base = m.group(2)
        line_no = src[:m.start()].count('\n') + 1
        symbols.append({
            'kind':      'class',
            'name':      name,
            'line':      line_no,
            'end_line':  line_no,
            'bases':     [base.split('::')[-1]] if base else [],
            'parent':    None,
            'is_public': not name.startswith('_'),
        })
        seen_names.add(name)

    # ── 2. typedef struct { ... } TypeName; ─────────────────────────────────
    for m in RE_C_TYPEDEF.finditer(clean):
        name = m.group(1)
        if name in C_KEYWORDS or len(name) < 2 or name in seen_names:
            continue
        line_no = src[:m.start()].count('\n') + 1
        symbols.append({
            'kind':      'class',
            'name':      name,
            'line':      line_no,
            'end_line':  line_no,
            'bases':     [],
            'parent':    None,
            'is_public': not name.startswith('_'),
        })
        seen_names.add(name)

    # ── 3. C++ scoped methods:  Foo::Bar(...) { ──────────────────────────────
    seen_methods = set()
    for m in RE_C_METHOD.finditer(clean):
        parent_name = m.group(1)
        method_name = m.group(2)
        if method_name in C_KEYWORDS or len(method_name) < 2:
            continue
        key = f'{parent_name}::{method_name}'
        if key in seen_methods:
            continue
        seen_methods.add(key)
        line_no = src[:m.start()].count('\n') + 1
        symbols.append({
            'kind':      'method',
            'name':      method_name,
            'line':      line_no,
            'end_line':  line_no,
            'bases':     [],
            'parent':    parent_name,
            'is_public': not method_name.startswith('_'),
        })

    # ── 4. Top-level functions (RE_FUNCDEF, not already captured as methods) ─
    method_keys = {f"{s['parent']}::{s['name']}" for s in symbols if s['kind'] == 'method'}
    for m in RE_FUNCDEF.finditer(clean):
        name = m.group(2)
        if name in C_KEYWORDS or len(name) < 2:
            continue
        # Skip if it's a C++ method we already captured
        # (detect "ClassName::name" in the surrounding text)
        prefix = clean[max(0, m.start() - 60):m.start()]
        is_method = bool(re.search(r'\w+::\s*$', prefix.rstrip()))
        if is_method:
            continue
        line_no = src[:m.start()].count('\n') + 1
        line_before = clean[:m.start()].rstrip()
        last_line = line_before.split('\n')[-1] if '\n' in line_before else line_before
        is_static = bool(RE_STATIC.search(last_line))
        symbols.append({
            'kind':      'function',
            'name':      name,
            'line':      line_no,
            'end_line':  line_no,
            'bases':     [],
            'parent':    None,
            'is_public': not is_static and not name.startswith('_'),
        })

    return symbols


# ─── C source utilities ────────────────────────────────────────────────────────

def strip_comments(src: str) -> str:
    """Remove // and /* */ comments while preserving string literals."""
    result, i, n = [], 0, len(src)
    while i < n:
        if src[i:i+2] == '//':
            while i < n and src[i] != '\n':
                i += 1
        elif src[i:i+2] == '/*':
            i += 2
            while i < n and src[i-1:i+1] != '*/':
                i += 1
            i += 1
        elif src[i] in '"\'':
            q = src[i]; result.append(src[i]); i += 1
            while i < n and src[i] != q:
                if src[i] == '\\': result.append(src[i]); i += 1
                result.append(src[i]); i += 1
            if i < n: result.append(src[i]); i += 1
        else:
            result.append(src[i]); i += 1
    return ''.join(result)


def mask_string_literals(src: str) -> str:
    """Replace string/char contents with spaces to avoid brace confusion."""
    out = []
    i, n = 0, len(src)
    while i < n:
        ch = src[i]
        if ch in ('"', "'"):
            q = ch
            out.append(' ')
            i += 1
            while i < n:
                c = src[i]
                if c == '\\':
                    out.append(' '); i += 1
                    if i < n: out.append(' '); i += 1
                    continue
                out.append(' '); i += 1
                if c == q:
                    break
        else:
            out.append(ch); i += 1
    return ''.join(out)


def find_matching_brace(src: str, open_idx: int) -> int:
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == '{':   depth += 1
        elif src[i] == '}': depth -= 1
        if depth == 0:      return i
    return -1


# ─── INF/DEC/DSC/FDF ini-style section helpers ────────────────────────────────

def _parse_ini_sections(src: str) -> dict:
    """Parse [Section] key=val style files into a dict of lists."""
    sections = defaultdict(list)
    current  = None
    for line in src.splitlines():
        line = line.strip()
        line = re.sub(r'\s*#.*$', '', line)
        if not line:
            continue
        m = re.match(r'^\[([^\]]+)\]', line)
        if m:
            current = m.group(1).strip().lower()
            continue
        if current is not None:
            sections[current].append(line)
    return dict(sections)


def _section_files(lines: list) -> list:
    """Extract bare filenames/paths from section lines."""
    result = []
    for ln in lines:
        ln = re.sub(r'\$\([^)]+\)', '', ln).strip()
        if ln and not ln.startswith('#'):
            token = re.split(r'[\s|]', ln)[0]
            if token:
                result.append(token)
    return result


# ─── EDK2 parsers ──────────────────────────────────────────────────────────────

def scan_inf(src: str) -> dict:
    """
    Parse EDK2 INF module description.
    Returns: sources, packages, libraries, guids, protocols, ppis, depex, meta
    """
    secs = _parse_ini_sections(src)
    meta = {}
    for ln in secs.get('defines', []):
        if '=' in ln:
            k, _, v = ln.partition('=')
            meta[k.strip()] = v.strip()
    sources   = _section_files(secs.get('sources', []))
    packages  = _section_files(secs.get('packages', []))
    libraries = _section_files(secs.get('libraryclasses', []))
    guids     = _section_files(secs.get('guids', []))
    protocols = _section_files(secs.get('protocols', []))
    ppis      = _section_files(secs.get('ppis', []))
    depex     = ' '.join(secs.get('depex', [])).strip()
    return {
        'sources': sources, 'packages': packages,
        'libraries': libraries, 'guids': guids,
        'protocols': protocols, 'ppis': ppis,
        'depex': depex, 'meta': meta,
    }


def scan_dec(src: str) -> dict:
    """Parse EDK2 DEC package declaration. Returns: guids, protocols, ppis, meta."""
    secs = _parse_ini_sections(src)
    meta = {}
    for ln in secs.get('defines', []):
        if '=' in ln:
            k, _, v = ln.partition('=')
            meta[k.strip()] = v.strip()
    return {
        'guids':     _section_files(secs.get('guids', [])),
        'protocols': _section_files(secs.get('protocols', [])),
        'ppis':      _section_files(secs.get('ppis', [])),
        'meta':      meta,
    }


def scan_dsc(src: str) -> dict:
    """Parse EDK2 DSC platform description. Returns: components (list of .inf paths)."""
    secs = _parse_ini_sections(src)
    components = []
    for key, lines in secs.items():
        if key.startswith('components'):
            for ln in lines:
                ln = re.sub(r'\$\([^)]+\)', '', ln).strip()
                if ln and not ln.startswith('#') and ln.lower().endswith('.inf'):
                    components.append(ln.split('{')[0].strip())
    return {'components': components}


def scan_fdf(src: str) -> dict:
    """Parse EDK2 FDF flash descriptor. Returns: infs (list of .inf paths in FV sections)."""
    infs = []
    for ln in src.splitlines():
        ln = ln.strip()
        if ln.upper().startswith('INF') and '.inf' in ln.lower():
            parts = ln.split(None, 1)
            if len(parts) >= 2:
                infs.append(parts[1].strip())
    return {'infs': infs}


# ─── AMI parsers ───────────────────────────────────────────────────────────────

def scan_sdl(src: str) -> dict:
    """
    Parse AMI SDL module list.
    Returns: inf_components, lib_mappings, tokens, elink_parents
    """
    return {
        'inf_components': [m.group(1) for m in RE_SDL_INF.finditer(src)],
        'lib_mappings':   [m.group(1) for m in RE_SDL_LIB.finditer(src)],
        'tokens':         [m.group(1) for m in RE_SDL_TOKEN.finditer(src)],
        'elink_parents':  [m.group(1) for m in RE_SDL_ELINK.finditer(src)],
    }


def scan_sd(src: str) -> dict:
    """
    Parse AMI SD file (hybrid C struct + VFR form fragments).
    Returns: includes, setup_fields, form_sections, form_items, string_tokens, goto_ids
    """
    includes = RE_INCLUDE.findall(src)

    RE_SD_BLOCK = re.compile(
        r'#ifdef\s+SETUP_DATA_DEFINITION\b(.*?)#endif',
        re.DOTALL | re.IGNORECASE
    )
    setup_fields = []
    for block in RE_SD_BLOCK.finditer(src):
        for m in re.finditer(
            r'\b(UINT8|UINT16|UINT32|UINT64|BOOLEAN|UINTN|INTN)\s+(\w+)',
            block.group(1)
        ):
            setup_fields.append(m.group(2))

    KNOWN_GUARDS = [
        'ADVANCED_FORM_SET', 'MAIN_FORM_SET', 'CHIPSET_FORM_SET',
        'SECURITY_FORM_SET', 'BOOT_FORM_SET', 'POWER_FORM_SET',
        'FORM_SET_GOTO', 'FORM_SET_FORM',
    ]
    form_sections = [g for g in KNOWN_GUARDS if re.search(r'#ifdef\s+' + g + r'\b', src)]

    RE_VFR_ITEM = re.compile(
        r'\b(oneof|checkbox|numeric|string|date|time|password)\s+varid\s*=\s*([\w.]+)',
        re.IGNORECASE
    )
    form_items = [(m.group(1).lower(), m.group(2)) for m in RE_VFR_ITEM.finditer(src)]
    str_tokens = list(set(_RE_STR_TOKEN.findall(src)))
    goto_ids   = list(set(re.findall(r'\bgoto\s+(\w+)', src, re.IGNORECASE)))

    return {
        'includes':      includes,
        'setup_fields':  setup_fields,
        'form_sections': form_sections,
        'form_items':    form_items,
        'string_tokens': str_tokens,
        'goto_ids':      goto_ids,
    }


def scan_cif(src: str) -> dict:
    """
    Parse AMI CIF component index.
    Returns: infs, files, parts, meta
    """
    meta = {}
    for m in re.finditer(r'(\w+)\s*=\s*"([^"]*)"', src.split('[')[0]):
        meta[m.group(1).lower()] = m.group(2)

    def _extract_quoted(pattern, text):
        m = pattern.search(text)
        return RE_QUOTED.findall(m.group(1)) if m else []

    return {
        'infs':  _extract_quoted(RE_CIF_INF,   src),
        'files': _extract_quoted(RE_CIF_FILES,  src),
        'parts': _extract_quoted(RE_CIF_PARTS,  src),
        'meta':  meta,
    }


def scan_mak(src: str) -> dict:
    """Light Makefile analysis — extract generated .h targets."""
    generated = []
    for ln in src.splitlines():
        ln = ln.strip()
        if ln.endswith('.h') or ('BUILD_DIR' in ln and '.h' in ln):
            m = re.search(r'\(BUILD_DIR\)/(\w+\.h)', ln)
            if m: generated.append(m.group(1))
    return {'generated': generated}


# ─── HII parsers ───────────────────────────────────────────────────────────────

def _parse_vfr_hfr(src: str) -> dict:
    """Shared core parser for VFR and HFR files."""
    includes     = RE_INCLUDE.findall(src)
    uni_includes = [f for f in includes if f.lower().endswith('.uni')]
    hfr_includes = [f for f in includes if f.lower().endswith('.hfr')]
    str_refs     = list(set(_RE_STR_TOKEN.findall(src)))
    formsets     = [
        {'guid': m.group(1).strip(), 'title_token': m.group(2)}
        for m in _RE_VFR_FORMSET.finditer(src)
    ]
    forms        = [
        {'formid': m.group(1), 'title_token': m.group(2)}
        for m in _RE_VFR_FORM.finditer(src)
    ]
    cb_keys      = [m.group(1) or m.group(2) for m in _RE_VFR_CB.finditer(src) if m.group(1) or m.group(2)]
    labels       = _RE_VFR_LABEL.findall(src)
    return {
        'includes': includes, 'uni_includes': uni_includes, 'hfr_includes': hfr_includes,
        'str_refs': str_refs, 'formsets': formsets, 'forms': forms,
        'cb_keys': cb_keys, 'labels': labels,
    }


def scan_vfr(src: str) -> dict:
    """Parse UEFI standard VFR (Visual Forms Representation)."""
    return _parse_vfr_hfr(src)


def scan_hfr(src: str) -> dict:
    """
    Parse AMI HFR (HII Form Resource) — VFR extension with AMI macros.
    Adds formset_guids from #define HII_FORMSET_GUID blocks.
    """
    data = _parse_vfr_hfr(src)
    RE_HFR_GUID = re.compile(r'#define\s+\w*FORMSET_GUID\s+\{([^}]+)\}', re.IGNORECASE)
    data['formset_guids'] = [m.group(1).strip() for m in RE_HFR_GUID.finditer(src)]
    return data


def scan_uni(src: str) -> dict:
    """
    Parse UEFI UNI Unicode String Package.
    Returns: string_names, languages, lang_defs, token_count
    """
    src = src.lstrip('\ufeff')
    RE_STR_DECL = re.compile(r'^#string\s+(\w+)',    re.MULTILINE | re.IGNORECASE)
    RE_LANG     = re.compile(r'^#language\s+(\S+)',  re.MULTILINE | re.IGNORECASE)
    RE_LANGDEF  = re.compile(r'^#langdef\s+(\S+)\s+"([^"]*)"', re.MULTILINE | re.IGNORECASE)
    string_names = list(set(RE_STR_DECL.findall(src)))
    languages    = list(set(RE_LANG.findall(src)))
    lang_defs    = [(m.group(1), m.group(2)) for m in RE_LANGDEF.finditer(src)]
    return {
        'string_names': string_names, 'languages': languages,
        'lang_defs': lang_defs, 'token_count': len(string_names),
    }


# ─── ACPI parser ───────────────────────────────────────────────────────────────

def scan_asl(src: str) -> dict:
    """
    Parse ACPI ASL source.
    Returns: includes, externals, tablename
    """
    RE_ASL_INC  = re.compile(r'\bInclude\s*\(\s*"([^"]+)"\s*\)', re.IGNORECASE)
    RE_EXTERNAL = re.compile(r'\bExternal\s*\(\s*\\?(\w[\w.]+)', re.IGNORECASE)
    RE_DEFBLOCK = re.compile(r'\bDefinitionBlock\s*\(\s*"[^"]*"\s*,\s*"([^"]+)"', re.IGNORECASE)
    includes  = RE_ASL_INC.findall(src) + RE_INCLUDE.findall(src)
    externals = RE_EXTERNAL.findall(src)
    tablename = next((m.group(1) for m in RE_DEFBLOCK.finditer(src)), None)
    return {'includes': includes, 'externals': externals, 'tablename': tablename}


# ─── scan_c — C/C++ / ASM source ───────────────────────────────────────────────

def scan_c(src: str, ext: str):
    """
    Parse C/C++ or Assembly source.
    Returns standard 6-tuple: (refs, funcdefs, funccalls, extra, func_calls_by_func, symbol_defs)
    """
    if ext in ('.asm', '.s', '.nasm'):
        refs = [m.group(1) or m.group(2) for m in RE_ASM_INC.finditer(src)]
        return refs, [], [], None, [], []

    clean  = strip_comments(src)
    masked = mask_string_literals(clean)
    refs   = RE_INCLUDE.findall(clean)

    funcdefs, funccalls, func_calls_by_func = [], [], []
    for m in RE_FUNCDEF.finditer(clean):
        is_efiapi = bool(m.group(1))
        name      = m.group(2)
        if name in C_KEYWORDS or len(name) < 2:
            continue
        line_before = clean[:m.start()].rstrip()
        is_static   = bool(RE_STATIC.search(
            line_before.split('\n')[-1] if '\n' in line_before else line_before
        ))
        funcdefs.append({'label': name, 'is_efiapi': is_efiapi, 'is_static': is_static})
        open_idx  = m.end() - 1
        close_idx = find_matching_brace(masked, open_idx)
        body      = masked[open_idx + 1:close_idx] if close_idx > open_idx else ''
        calls     = [
            cm.group(1) for cm in RE_FUNCCALL.finditer(body)
            if cm.group(1) not in C_KEYWORDS and len(cm.group(1)) >= 2
        ]
        func_calls_by_func.append(calls)

    funccalls = [
        m.group(1) for m in RE_FUNCCALL.finditer(clean)
        if m.group(1) not in C_KEYWORDS and len(m.group(1)) >= 2
    ]
    symbol_defs = _parse_c_symbol_defs(src, clean)
    return refs, funcdefs, funccalls, None, func_calls_by_func, symbol_defs


# ─── Main entry point ──────────────────────────────────────────────────────────

# Extensions handled by this parser
BIOS_EXTENSIONS = {
    '.c','.cpp','.cc','.h','.hpp',
    '.asm','.s','.S','.nasm',
    '.inf','.dec','.dsc','.fdf',
    '.sdl','.sd','.cif','.mak',
    '.vfr','.hfr','.uni','.asl',
}


def scan_bios(src: str, ext: str):
    """
    Unified BIOS/UEFI/AMI parser entry point.

    Args:
        src: file text content
        ext: lowercase file extension (e.g. '.inf', '.c')

    Returns:
        (refs, funcdefs, funccalls, extra_dict, func_calls_by_func, symbol_defs)
        — same 6-tuple as all other parsers.  symbol_defs is a list of
        {kind, name, line, end_line, bases, parent, is_public} dicts; it is
        non-empty only for C/C++ source files.
    """
    ext = ext.lower()

    if ext in ('.asm', '.s', '.nasm'):
        refs = [m.group(1) or m.group(2) for m in RE_ASM_INC.finditer(src)]
        return refs, [], [], None, [], []

    if ext == '.inf':
        data = scan_inf(src)
        return data['sources'] + data['packages'], [], [], data, [], []

    if ext == '.dec':
        data = scan_dec(src)
        return [], [], [], data, [], []

    if ext == '.dsc':
        data = scan_dsc(src)
        return data['components'], [], [], data, [], []

    if ext == '.fdf':
        data = scan_fdf(src)
        return data['infs'], [], [], data, [], []

    if ext == '.sdl':
        data = scan_sdl(src)
        return data['inf_components'], [], [], data, [], []

    if ext == '.sd':
        data = scan_sd(src)
        return data['includes'], [], [], data, [], []

    if ext == '.cif':
        data = scan_cif(src)
        return data['infs'] + data['files'], [], [], data, [], []

    if ext == '.mak':
        data = scan_mak(src)
        return [], [], [], data, [], []

    if ext == '.vfr':
        data = scan_vfr(src)
        return data['includes'], [], [], data, [], []

    if ext == '.hfr':
        data = scan_hfr(src)
        return data['includes'], [], [], data, [], []

    if ext == '.uni':
        data = scan_uni(src)
        return [], [], [], data, [], []

    if ext == '.asl':
        data = scan_asl(src)
        return data['includes'], [], [], data, [], []

    # C / C++ / Assembly fallback
    return scan_c(src, ext)
