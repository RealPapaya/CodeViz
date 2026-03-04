#!/usr/bin/env python3
"""
analyze_bios.py V3 — BIOS Code Visualizer
Multi file-type support: .c/.h/.asm + .inf/.dec/.dsc/.fdf/.sdl/.cif/.mak/.vfr/.hfr/.uni/.asl
Hierarchical JSON output + cytoscape.js canvas renderer
"""

import os, re, json, sys, argparse
from pathlib import Path
from collections import defaultdict

# ─── Constants ───────────────────────────────────────────────────────────────
SKIP_DIRS  = {'Build','build','.git','__pycache__','Conf','DEBUG','RELEASE','.claude'}
BUILD_DIRS = {'Build','build','DEBUG','RELEASE'}
SCAN_EXT   = {
    # C/C++ / ASM
    '.c','.cpp','.cc','.h','.hpp','.asm','.s','.S','.nasm',
    # UEFI / EDK2 build system
    '.inf', '.dec', '.dsc', '.fdf',
    # AMI BIOS 特有
    '.sdl', '.sd', '.cif', '.mak',
    # HII (Human Interface Infrastructure)
    '.vfr',   # UEFI 標準 HII 表單語言
    '.hfr',   # AMI 擴充 HII Form Resource（類似 VFR）
    '.uni',   # Unicode 字串包
    # ACPI
    '.asl',   # ACPI Source Language
}
SKIP_EXT   = {'.veb','.lib','.obj','.efi','.rom','.bin','.log','.map'}

# ─── File type semantic categories ───────────────────────────────────────────
FILE_TYPE_MAP = {
    '.c': 'c_source', '.cpp': 'c_source', '.cc': 'c_source',
    '.h': 'header',   '.hpp': 'header',
    '.asm': 'assembly', '.s': 'assembly', '.S': 'assembly', '.nasm': 'assembly',
    '.inf': 'module_inf',
    '.dec': 'package_dec',
    '.dsc': 'platform_dsc',
    '.fdf': 'flash_desc',
    '.sdl': 'ami_sdl',
    '.sd':  'ami_sd',    # AMI Setup Data — hybrid C-struct + VFR form fragment
    '.cif': 'ami_cif',
    '.mak': 'makefile',
    '.vfr': 'hii_vfr',      # UEFI 標準 HII 表單
    '.hfr': 'hii_hfr',      # AMI 擴充 HII Form Resource
    '.uni': 'hii_string',   # Unicode 字串包
    '.asl': 'acpi_asl',
}

# ─── Edge type definitions ───────────────────────────────────────────────────
# 每種 edge type 決定前端的線條樣式
EDGE_TYPES = {
    'include':       {'label': 'Include',            'color': '#c084fc', 'style': 'solid'},
    'sources':       {'label': 'Sources',     'color': '#ffd700', 'style': 'solid'},
    'package':       {'label': 'Package',     'color': '#00d4ff', 'style': 'dashed'},
    'library':       {'label': 'Library',     'color': '#a78bfa', 'style': 'dashed'},
    'elink':         {'label': 'ELINK',       'color': '#ff6b35', 'style': 'dotted'},
    'cif_own':       {'label': 'owns',        'color': '#34d399', 'style': 'solid'},
    'component':     {'label': 'Component',   'color': '#60a5fa', 'style': 'solid'},
    'depex':         {'label': 'Depex',       'color': '#f472b6', 'style': 'dotted'},
    'guid_ref':      {'label': 'GUID',        'color': '#fb923c', 'style': 'dashed'},
    'str_ref':       {'label': 'Strings',     'color': '#e879f9', 'style': 'dashed'},
    'asl_include':   {'label': 'ASL',         'color': '#818cf8', 'style': 'solid'},
    'callback_ref':  {'label': 'Callback',    'color': '#f87171', 'style': 'dotted'},  # VFR/HFR 表單 → .c callback 函式
    'hii_pkg':       {'label': 'HII-Pkg',     'color': '#94a3b8', 'style': 'solid'},   # .inf → .vfr/.hfr/.uni
}

C_KEYWORDS = {
    'if','else','while','for','do','switch','case','return','sizeof','typeof',
    'EFIAPI','EFI_STATUS','IN','OUT','OPTIONAL','VOID','UINTN','INTN',
    'UINT8','UINT16','UINT32','UINT64','BOOLEAN','TRUE','FALSE','NULL',
    'PEI_SERVICES','EFI_BOOT_SERVICES','EFI_RUNTIME_SERVICES','ASSERT_EFI_ERROR',
    'static','inline','extern','const','struct','union','enum','typedef',
    'printf','sprintf','memset','memcpy','strlen','strcmp','malloc','free',
}

MODULE_COLORS = [
    '#00d4ff','#00ff9f','#ff6b35','#ffd700','#a78bfa',
    '#f472b6','#34d399','#fb923c','#60a5fa','#e879f9',
    '#4ade80','#facc15','#f87171','#38bdf8','#c084fc',
]

# ─── Regex ────────────────────────────────────────────────────────────────────
RE_INCLUDE  = re.compile(r'#\s*include\s+["<]([^">]+)[">]')
RE_FUNCDEF  = re.compile(
    r'^(?:(?:static|inline|extern|EFIAPI|EFI_STATUS|VOID|UINTN|INTN|UINT8|UINT16|UINT32|UINT64|BOOLEAN)\s+)*'
    r'(EFIAPI\s+)?'
    r'[\w\s\*]+\b(\w+)\s*\([^)]*\)\s*(?://[^\n]*)?\s*\{',
    re.MULTILINE
)
RE_FUNCCALL = re.compile(r'\b([A-Za-z_]\w+)\s*\(')
RE_STATIC   = re.compile(r'\bstatic\b')
RE_ASM_INC  = re.compile(r'%include\s+["\'"]([^"\']+)["\']|EXTERN\s+(\w+)', re.IGNORECASE)

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


# ─── strip_comments ───────────────────────────────────────────────────────────
def strip_comments(src: str) -> str:
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


# Remove string and char literals to avoid brace confusion
def mask_string_literals(src: str) -> str:
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
                    out.append(' ')
                    i += 1
                    if i < n:
                        out.append(' ')
                        i += 1
                    continue
                out.append(' ')
                i += 1
                if c == q:
                    break
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def find_matching_brace(src: str, open_idx: int) -> int:
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                return i
    return -1


# ─── INF section parser ───────────────────────────────────────────────────────
def _parse_ini_sections(src: str) -> dict:
    """Parse INF/DEC/DSC/FDF style [Section] key=val files into a dict of lists."""
    sections = defaultdict(list)
    current  = None
    for line in src.splitlines():
        line = line.strip()
        # strip inline comments
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
        # Strip GUID macros like $(FOO_BAR)
        ln = re.sub(r'\$\([^)]+\)', '', ln).strip()
        if ln and not ln.startswith('#'):
            # take only the first token (filename) before any whitespace or |
            token = re.split(r'[\s|]', ln)[0]
            if token:
                result.append(token)
    return result


# ─── scan_inf ─────────────────────────────────────────────────────────────────
def scan_inf(src: str) -> dict:
    """
    Returns:
      sources    → list of .c/.asm filenames from [Sources]
      packages   → list of .dec paths from [Packages]
      libraries  → list of library class names from [LibraryClasses]
      guids      → list of GUID variable names from [Guids]
      protocols  → list of Protocol variable names from [Protocols]
      ppis       → list of PPI variable names from [Ppis]
      depex      → raw depex expression string from [Depex]
      meta       → dict with BASE_NAME, MODULE_TYPE, FILE_GUID, ENTRY_POINT
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
    depex_lines = secs.get('depex', [])
    depex = ' '.join(depex_lines).strip()

    return {
        'sources': sources, 'packages': packages,
        'libraries': libraries, 'guids': guids,
        'protocols': protocols, 'ppis': ppis,
        'depex': depex, 'meta': meta,
    }


# ─── scan_dec ─────────────────────────────────────────────────────────────────
def scan_dec(src: str) -> dict:
    """Returns guids/ppis/protocols declared in a .dec package."""
    secs = _parse_ini_sections(src)
    meta = {}
    for ln in secs.get('defines', []):
        if '=' in ln:
            k, _, v = ln.partition('=')
            meta[k.strip()] = v.strip()
    guids     = _section_files(secs.get('guids', []))
    protocols = _section_files(secs.get('protocols', []))
    ppis      = _section_files(secs.get('ppis', []))
    return {'guids': guids, 'protocols': protocols, 'ppis': ppis, 'meta': meta}


# ─── scan_dsc ─────────────────────────────────────────────────────────────────
def scan_dsc(src: str) -> dict:
    """Returns list of component .inf paths from [Components] sections."""
    secs = _parse_ini_sections(src)
    components = []
    for key, lines in secs.items():
        if key.startswith('components'):
            for ln in lines:
                ln = re.sub(r'\$\([^)]+\)', '', ln).strip()
                if ln and not ln.startswith('#') and ln.lower().endswith('.inf'):
                    components.append(ln.split('{')[0].strip())
    return {'components': components}


# ─── scan_fdf ─────────────────────────────────────────────────────────────────
def scan_fdf(src: str) -> dict:
    """Returns list of .inf paths referenced inside FV sections."""
    infs = []
    for ln in src.splitlines():
        ln = ln.strip()
        if ln.upper().startswith('INF') and '.inf' in ln.lower():
            parts = ln.split(None, 1)
            if len(parts) >= 2:
                infs.append(parts[1].strip())
    return {'infs': infs}


# ─── scan_sdl ─────────────────────────────────────────────────────────────────
def scan_sdl(src: str) -> dict:
    """
    Parse AMI SDL file. Returns:
      inf_components → list of .inf File paths
      lib_mappings   → list of Instance strings (Pkg.LibClass)
      tokens         → list of token names
      elink_parents  → list of Parent strings from ELINK blocks
    """
    inf_components = [m.group(1) for m in RE_SDL_INF.finditer(src)]
    lib_mappings   = [m.group(1) for m in RE_SDL_LIB.finditer(src)]
    tokens         = [m.group(1) for m in RE_SDL_TOKEN.finditer(src)]
    elink_parents  = [m.group(1) for m in RE_SDL_ELINK.finditer(src)]
    return {
        'inf_components': inf_components,
        'lib_mappings':   lib_mappings,
        'tokens':         tokens,
        'elink_parents':  elink_parents,
    }



# ─── scan_sd ──────────────────────────────────────────────────────────────────
def scan_sd(src: str) -> dict:
    """
    Parse AMI .sd file.

    .sd files are a HYBRID of C struct declarations + VFR form fragments,
    guarded by C-preprocessor #ifdef blocks:

      #ifdef SETUP_DATA_DEFINITION       ← struct field: UINT8 MyOption;
      #endif

      #ifdef ADVANCED_FORM_SET           ← VFR-style form items
        #ifdef FORM_SET_GOTO
          goto MYFORM_ID, ...
        #endif
        #ifdef FORM_SET_FORM
          form formid = MYFORM_ID, ...
            oneof varid = SETUP_DATA.MyOption, ...
          endform;
        #endif
      #endif  // ADVANCED_FORM_SET

    Returns:
      includes         → list of #include paths
      setup_fields     → list of C field names declared in SETUP_DATA_DEFINITION
      form_sections    → list of guard names present (e.g. 'ADVANCED_FORM_SET')
      form_items       → list of (item_type, varid) tuples from VFR items
      string_tokens    → list of STRING_TOKEN references
      goto_ids         → list of form IDs referenced in GOTO
    """
    # #include references
    includes = RE_INCLUDE.findall(src)

    # Extract SETUP_DATA_DEFINITION block(s) → C struct fields
    RE_SD_BLOCK = re.compile(
        r'#ifdef\s+SETUP_DATA_DEFINITION\b(.*?)#endif',
        re.DOTALL | re.IGNORECASE
    )
    setup_fields = []
    for block in RE_SD_BLOCK.finditer(src):
        # Match C variable declarations: UINT8 Foo; / UINT16 Bar[4];
        for m in re.finditer(
            r'\b(UINT8|UINT16|UINT32|UINT64|BOOLEAN|UINTN|INTN)\s+(\w+)',
            block.group(1)
        ):
            setup_fields.append(m.group(2))

    # Detect which FORM_SET guard sections are present
    KNOWN_GUARDS = [
        'ADVANCED_FORM_SET', 'MAIN_FORM_SET', 'CHIPSET_FORM_SET',
        'SECURITY_FORM_SET', 'BOOT_FORM_SET', 'POWER_FORM_SET',
        'FORM_SET_GOTO', 'FORM_SET_FORM',
    ]
    form_sections = [g for g in KNOWN_GUARDS if re.search(r'#ifdef\s+' + g + r'\b', src)]

    # VFR-style form items: oneof, checkbox, numeric, string, date, time
    RE_VFR_ITEM = re.compile(
        r'\b(oneof|checkbox|numeric|string|date|time|password)\s+varid\s*=\s*([\w.]+)',
        re.IGNORECASE
    )
    form_items = [(m.group(1).lower(), m.group(2)) for m in RE_VFR_ITEM.finditer(src)]

    # STRING_TOKEN references
    str_tokens = list(set(_RE_STR_TOKEN.findall(src)))

    # goto <FORM_ID>
    RE_GOTO = re.compile(r'\bgoto\s+(\w+)', re.IGNORECASE)
    goto_ids = list(set(RE_GOTO.findall(src)))

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
    Parse AMI CIF component file. Returns:
      infs   → list of .inf filenames from [INF] section
      files  → list of other filenames from [files] section
      parts  → list of sub-component names from [parts] section
      meta   → dict (name, category, localRoot, refName)
    """
    meta = {}
    # Extract XML-style header attributes
    for m in re.finditer(r'(\w+)\s*=\s*"([^"]*)"', src.split('[')[0]):
        meta[m.group(1).lower()] = m.group(2)

    def _extract_quoted(pattern, text):
        m = pattern.search(text)
        if not m: return []
        return RE_QUOTED.findall(m.group(1))

    infs   = _extract_quoted(RE_CIF_INF,   src)
    files  = _extract_quoted(RE_CIF_FILES,  src)
    parts  = _extract_quoted(RE_CIF_PARTS,  src)
    return {'infs': infs, 'files': files, 'parts': parts, 'meta': meta}


# ─── scan_mak ─────────────────────────────────────────────────────────────────
def scan_mak(src: str) -> dict:
    """Very light Makefile analysis — just extract generated .h targets."""
    generated = []
    for ln in src.splitlines():
        ln = ln.strip()
        if ln.endswith('.h') or ('BUILD_DIR' in ln and '.h' in ln):
            # Grab the target name
            m = re.search(r'\(BUILD_DIR\)/(\w+\.h)', ln)
            if m: generated.append(m.group(1))
    return {'generated': generated}


# ─── scan_vfr ─────────────────────────────────────────────────────────────────
# Pre-compiled regexes for VFR/HFR (reused by both)
_RE_STR_TOKEN  = re.compile(r'\bSTRING_TOKEN\s*\(\s*(\w+)\s*\)', re.IGNORECASE)
_RE_VFR_FORMSET= re.compile(
    r'\bformset\s+guid\s*=\s*\{([^}]+)\}\s*,\s*title\s*=\s*STRING_TOKEN\s*\(\s*(\w+)\s*\)',
    re.IGNORECASE | re.DOTALL
)
# `form formid = N, title = STRING_TOKEN(...)`
_RE_VFR_FORM   = re.compile(
    r'\bform\s+formid\s*=\s*(\d+)\s*,\s*title\s*=\s*STRING_TOKEN\s*\(\s*(\w+)\s*\)',
    re.IGNORECASE
)
# Callback: `questionid = N, ... flags = ... INTERACTIVE, ... key = N`
# Maps to EFI_HII_CONFIG_ACCESS_PROTOCOL.Callback() — in .c files
# Also: `AMI_CALLBACK_KEY`，`INTERACTIVE` flags trigger callbacks
_RE_VFR_CB     = re.compile(
    r'(?:AMI_CALLBACK_KEY\s*\(\s*(\w+)\s*\)|\bkey\s*=\s*(0x[0-9A-Fa-f]+|\d+)\b)',
    re.IGNORECASE
)
# suppressif/grayif EFI_VAR token usage
_RE_VFR_LABEL  = re.compile(r'\blabel\s+(0x[0-9A-Fa-f]+|\w+)', re.IGNORECASE)


def _parse_vfr_hfr(src: str) -> dict:
    """
    Shared internal parser for VFR and HFR files.

    VFR/HFR structure:
      #include "SetupString.uni"          → pulls in string package
      #include "CommonSetup.hfr"          → pulls in shared form fragments

      formset guid  = { ... },
              title = STRING_TOKEN(STR_SETUP_TITLE),
              help  = STRING_TOKEN(STR_SETUP_HELP),
        form formid = 1,
             title  = STRING_TOKEN(STR_FORM_TITLE);
          ...
          oneof varid = Setup.BootMode,
                prompt = STRING_TOKEN(STR_BOOT_MODE),
                help   = STRING_TOKEN(STR_BOOT_MODE_HELP),
                flags  = INTERACTIVE,
                key    = KEY_BOOT_MODE;          ← triggers C callback
            ...
          endoneof;
        endform;
      endformset;
    """
    # #include "xxx.uni" or "xxx.hfr" or <xxx.h>
    includes = RE_INCLUDE.findall(src)

    # Separate .uni includes (those are the string packages)
    uni_includes = [f for f in includes if f.lower().endswith('.uni')]
    hfr_includes = [f for f in includes if f.lower().endswith('.hfr')]

    # All STRING_TOKEN references → these are keys into .uni files
    str_refs = list(set(_RE_STR_TOKEN.findall(src)))

    # formset blocks: (guid_raw, title_token)
    formsets = [
        {'guid': m.group(1).strip(), 'title_token': m.group(2)}
        for m in _RE_VFR_FORMSET.finditer(src)
    ]

    # form pages: (formid, title_token)
    forms = [
        {'formid': m.group(1), 'title_token': m.group(2)}
        for m in _RE_VFR_FORM.finditer(src)
    ]

    # Callback keys / AMI_CALLBACK_KEY macros
    cb_keys = [m.group(1) or m.group(2) for m in _RE_VFR_CB.finditer(src) if m.group(1) or m.group(2)]

    # Labels (used for goto and dynamic form updates)
    labels = _RE_VFR_LABEL.findall(src)

    return {
        'includes':      includes,
        'uni_includes':  uni_includes,
        'hfr_includes':  hfr_includes,
        'str_refs':      str_refs,
        'formsets':      formsets,
        'forms':         forms,
        'cb_keys':       cb_keys,
        'labels':        labels,
    }


def scan_vfr(src: str) -> dict:
    """
    Parse UEFI standard VFR (Visual Forms Representation) file.
    VFR defines HII Setup UI forms and is compiled into IFR binary.
    """
    return _parse_vfr_hfr(src)


# ─── scan_hfr ─────────────────────────────────────────────────────────────────
def scan_hfr(src: str) -> dict:
    """
    Parse AMI HFR (HII Form Resource) file.
    HFR is AMI's extension of VFR with additional macros:
    - DEFINE HII_FORMSET_GUID = { ... }
    - AMI_CALLBACK_KEY(KEY_xxx)
    - SUPPRESS_GRAYOUT_ENDIF
    - Often prefixed with large #define blocks for Setup variables

    HFR files are typically #include'd from a main .vfr or other .hfr files.
    They partition the BIOS Setup forms into manageable units.
    """
    data = _parse_vfr_hfr(src)
    # Additional HFR-specific: DEFINE HII_FORMSET_GUID
    RE_HFR_GUID = re.compile(r'#define\s+\w*FORMSET_GUID\s+\{([^}]+)\}', re.IGNORECASE)
    formset_guids = [m.group(1).strip() for m in RE_HFR_GUID.finditer(src)]
    data['formset_guids'] = formset_guids
    return data


# ─── scan_uni ─────────────────────────────────────────────────────────────────
def scan_uni(src: str) -> dict:
    """
    Parse UEFI UNI (Unicode String Package) file.

    UNI format:
      //-*- coding: utf-8 -*-        ← BOM/coding comment (optional)
      #langdef en-US "English"       ← language definition
      #string STR_MODULE_NAME        ← token name declaration
        #language en-US "Module Name"
        #language zh-Hant "模組名稱"

    This file is the 'string table' that VFR/HFR reference via STRING_TOKEN().
    Build tools compile it into HII String Packages embedded in the driver image.

    Returns:
      string_names  → list of all #string token names declared
      languages     → list of RFC4646 language codes (e.g. en-US, zh-Hant)
      lang_defs     → list of #langdef declarations
      token_count   → total number of unique tokens
    """
    # Strip UTF-8 BOM if present
    src = src.lstrip('\ufeff')

    RE_STR_DECL = re.compile(r'^#string\s+(\w+)', re.MULTILINE | re.IGNORECASE)
    RE_LANG     = re.compile(r'^#language\s+(\S+)', re.MULTILINE | re.IGNORECASE)
    RE_LANGDEF  = re.compile(r'^#langdef\s+(\S+)\s+"([^"]*)"', re.MULTILINE | re.IGNORECASE)

    string_names = list(set(RE_STR_DECL.findall(src)))
    languages    = list(set(RE_LANG.findall(src)))
    lang_defs    = [(m.group(1), m.group(2)) for m in RE_LANGDEF.finditer(src)]

    return {
        'string_names': string_names,
        'languages':    languages,
        'lang_defs':    lang_defs,
        'token_count':  len(string_names),
    }



# ─── scan_asl ─────────────────────────────────────────────────────────────────
def scan_asl(src: str) -> dict:
    """
    Parse ACPI ASL (ACPI Source Language) file.
    ASL uses:
      Include("file.asl")  — file include
      External(ObjectName, ...) — cross-table symbol reference
      DefinitionBlock("name", "SSDT", ...)

    Returns:
      includes  → list of included ASL filenames
      externals → list of external object names
      tablename → DSDT/SSDT identifier string
    """
    # Include("xxx.asl") — case insensitive
    RE_ASL_INC  = re.compile(r'\bInclude\s*\(\s*"([^"]+)"\s*\)', re.IGNORECASE)
    # External(ObjName, ...) — first arg is the cross-table symbol
    RE_EXTERNAL = re.compile(r'\bExternal\s*\(\s*\\?(\w[\w.]+)', re.IGNORECASE)
    # DefinitionBlock table name
    RE_DEFBLOCK = re.compile(r'\bDefinitionBlock\s*\(\s*"[^"]*"\s*,\s*"([^"]+)"', re.IGNORECASE)

    includes  = RE_ASL_INC.findall(src)
    externals = RE_EXTERNAL.findall(src)
    tablename = next((m.group(1) for m in RE_DEFBLOCK.finditer(src)), None)

    # Also grab standard C-style #include for ASL preprocessed files
    includes += RE_INCLUDE.findall(src)

    return {'includes': includes, 'externals': externals, 'tablename': tablename}


# ─── scan_file ────────────────────────────────────────────────────────────────
def scan_file(filepath: str, root: str):
    """
    Returns (includes_or_refs, funcdefs, funccalls, bios_extra_dict, func_calls_by_func)
    bios_extra_dict varies by file type; None for C/H/ASM.
    """
    try:
        src = Path(filepath).read_text(encoding='utf-8', errors='replace')
    except Exception:
        return [], [], [], None, []

    ext = Path(filepath).suffix.lower()

    if ext in ('.asm', '.s', '.S', '.nasm'):
        includes = [m.group(1) or m.group(2) for m in RE_ASM_INC.finditer(src)]
        return includes, [], [], None, []

    if ext == '.inf':
        data = scan_inf(src)
        refs = data['sources'] + data['packages']
        return refs, [], [], data, []

    if ext == '.dec':
        data = scan_dec(src)
        return [], [], [], data, []

    if ext == '.dsc':
        data = scan_dsc(src)
        return data['components'], [], [], data, []

    if ext == '.fdf':
        data = scan_fdf(src)
        return data['infs'], [], [], data, []

    if ext == '.sdl':
        data = scan_sdl(src)
        refs = data['inf_components']
        return refs, [], [], data, []

    if ext == '.sd':
        data = scan_sd(src)
        return data['includes'], [], [], data, []

    if ext == '.cif':
        data = scan_cif(src)
        refs = data['infs'] + data['files']
        return refs, [], [], data, []

    if ext == '.mak':
        data = scan_mak(src)
        return [], [], [], data, []

    # Phase C/D: VFR / HFR / UNI / ASL — specialized parsers
    if ext == '.vfr':
        data = scan_vfr(src)
        # Return all includes (uni_includes + hfr_includes + other)
        return data['includes'], [], [], data, []

    if ext == '.hfr':
        data = scan_hfr(src)
        return data['includes'], [], [], data, []

    if ext == '.uni':
        data = scan_uni(src)
        return [], [], [], data, []

    if ext == '.asl':
        data = scan_asl(src)
        return data['includes'], [], [], data, []

    # Remaining: .c, .cpp, .h, .hpp → C-like analysis
    clean = strip_comments(src)
    masked = mask_string_literals(clean)
    includes = RE_INCLUDE.findall(clean)

    funcdefs, funccalls, func_calls_by_func = [], [], []
    for m in RE_FUNCDEF.finditer(clean):
        is_efiapi = bool(m.group(1))
        name = m.group(2)
        if name in C_KEYWORDS or len(name) < 2:
            continue
        line_before = clean[:m.start()].rstrip()
        is_static = bool(RE_STATIC.search(line_before.split('\n')[-1] if '\n' in line_before else line_before))
        funcdefs.append({'label': name, 'is_efiapi': is_efiapi, 'is_static': is_static})

        open_idx = m.end() - 1  # regex ends at '{'
        close_idx = find_matching_brace(masked, open_idx)
        body = masked[open_idx + 1:close_idx] if close_idx > open_idx else ''
        calls = []
        if body:
            for cm in RE_FUNCCALL.finditer(body):
                cname = cm.group(1)
                if cname not in C_KEYWORDS and len(cname) >= 2:
                    calls.append(cname)
        func_calls_by_func.append(calls)

    for m in RE_FUNCCALL.finditer(clean):
        name = m.group(1)
        if name not in C_KEYWORDS and len(name) >= 2:
            funccalls.append(name)

    return includes, funcdefs, funccalls, None, func_calls_by_func


# ─── get_module ───────────────────────────────────────────────────────────────
def get_module(rel_path: str) -> str:
    parts = rel_path.replace('\\', '/').split('/')
    return parts[0] if len(parts) > 1 else '_root'


# ─── build_graph ─────────────────────────────────────────────────────────────
def build_graph(root_dir: str, progress_cb=None, include_build=False, include_dirs=None) -> dict:
    def _cb(pct, msg):
        print(f'[{pct:3d}%] {msg}', end='\r')
        if progress_cb: progress_cb(pct, msg)

    root = os.path.abspath(root_dir)
    all_files = []

    _cb(0, 'Scanning files...')
    skip_dirs = set(SKIP_DIRS)
    if include_build:
        skip_dirs -= BUILD_DIRS
    if include_dirs:
        skip_dirs -= set(include_dirs)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip_dirs]
        for fname in filenames:
            ext = Path(fname).suffix.lower()
            if ext in SCAN_EXT and ext not in SKIP_EXT:
                all_files.append(os.path.join(dirpath, fname))

    total = len(all_files)
    _cb(0, f'Found {total} files, analyzing...')

    file_meta   = {}  # rel_path → {label, ext, size, module, file_type, bios_meta}
    file_incs   = {}  # rel_path → [ref strings]
    file_defs   = {}  # rel_path → [{label, is_efiapi, is_static}]
    file_calls  = {}  # rel_path → [call names]
    file_extra  = {}  # rel_path → bios_extra dict (for .inf/.sdl/.cif etc.)

    file_func_calls = {}

    for i, fp in enumerate(all_files):
        if i % 50 == 0:
            pct = int(i / total * 60) if total else 0
            _cb(pct, f'{i}/{total} files analyzed')
        rel = os.path.relpath(fp, root).replace('\\', '/')
        inc, defs, calls, extra, func_calls_by_func = scan_file(fp, root)
        ext = Path(fp).suffix.lower()
        bios_meta = {}
        if extra and 'meta' in extra:
            bios_meta = extra['meta']

        file_meta[rel] = {
            'label':     os.path.basename(fp),
            'ext':       ext,
            'size':      os.path.getsize(fp),
            'module':    get_module(rel),
            'file_type': FILE_TYPE_MAP.get(ext, 'other'),
            'bios_meta': bios_meta,
        }
        file_incs[rel]  = inc
        file_defs[rel]  = defs
        file_calls[rel] = calls
        file_func_calls[rel] = func_calls_by_func
        file_extra[rel] = extra

    # ── Phase X: Collect ALL other files + count skipped dirs + total dirs ───────
    # Other files are not analysed for deps but shown in UI for full codebase picture.
    _cb(59, 'Scanning other files...')
    other_files_all: dict = {}
    _oth_idx = len(file_meta)

    total_dirs_scanned   = 0   # all subdirectory count (excluding skipped)
    total_dirs_skipped   = 0   # directories we skip entirely
    total_files_skipped  = 0   # files inside skipped directories

    # First count what's hidden inside SKIP_DIRS
    for _skip_name in sorted(skip_dirs):
        _skip_path = os.path.join(root, _skip_name)
        if not os.path.isdir(_skip_path):
            continue
        total_dirs_skipped += 1
        for _sdp, _sdn, _sfn in os.walk(_skip_path):
            total_dirs_skipped += len(_sdn)  # count sub-dirs inside skip dir
            total_files_skipped += len(_sfn)

    # Now scan the non-skipped tree for other files + count dirs
    for _dp, _dns, _fns in os.walk(root):
        _dns[:] = [d for d in _dns if d not in skip_dirs]
        total_dirs_scanned += len(_dns)
        for _fn in _fns:
            _fp  = os.path.join(_dp, _fn)
            _rel = os.path.relpath(_fp, root).replace('\\', '/')
            if _rel in file_meta:
                continue
            _ext = Path(_fn).suffix.lower()
            try:
                _sz = os.path.getsize(_fp)
            except OSError:
                _sz = 0
            _ft = 'binary' if _ext in SKIP_EXT else 'other'
            other_files_all[_rel] = {
                'id':        _oth_idx,
                'label':     _fn,
                'path':      _rel,
                'ext':       _ext,
                'size':      _sz,
                'module':    get_module(_rel),
                'file_type': _ft,
            }
            _oth_idx += 1

    # Group by module
    other_files_by_module: dict = defaultdict(list)
    for _rel, _meta in other_files_all.items():
        other_files_by_module[_meta['module']].append({
            k: _meta[k] for k in ('id','label','path','ext','size','file_type')
        })

    _cb(60, 'Building module index...')

    all_modules = sorted(set(m['module'] for m in file_meta.values()))
    module_color = {}
    fixed = {'AmiPkg':'#00d4ff','AsusModulePkg':'#00ff9f',
             'AsusProjectPkg':'#ff6b35','AmiChipsetPkg':'#ffd700'}
    color_idx = 0
    for mod in all_modules:
        if mod in fixed:
            module_color[mod] = fixed[mod]
        else:
            module_color[mod] = MODULE_COLORS[color_idx % len(MODULE_COLORS)]
            color_idx += 1

    # Build name-to-path index (basename, full rel path, and path stem)
    _cb(65, 'Building file index...')
    label_to_paths  = defaultdict(list)  # basename → [rel_path]
    stem_to_paths   = defaultdict(list)  # stem (no ext) → [rel_path]
    for rel in file_meta:
        label_to_paths[os.path.basename(rel)].append(rel)
        stem = Path(rel).stem.lower()
        stem_to_paths[stem].append(rel)

    rel_to_id = {rel: i for i, rel in enumerate(file_meta)}

    def resolve_ref(ref: str, src_dir: str = '') -> list:
        """Try to resolve a reference string to known rel_paths."""
        # Try exact basename first
        base = os.path.basename(ref)
        if base in label_to_paths:
            return label_to_paths[base]
        # Try stem match (for library class names like "AmiSbMiscLib")
        stem = Path(ref).stem.lower()
        if stem in stem_to_paths:
            return stem_to_paths[stem]
        return []

    # ── Phase B: Build GUID name → .dec file index ───────────────────────────
    # .dec files declare: gXxxGuid  =  { ... }   under [Guids]/[Ppis]/[Protocols]
    # We parse these names so .inf [Guids/Ppis] references can link to their .dec
    _cb(66, 'Building GUID index...')
    guid_name_to_dec = defaultdict(list)   # guid_var_name (lower) → [dec_rel_path]

    RE_GUID_DECL = re.compile(r'\b(g[A-Za-z_]\w+Guid|g[A-Za-z_]\w+Ppi|g[A-Za-z_]\w+Protocol)\b')

    for rel, extra in file_extra.items():
        if file_meta[rel]['ext'] != '.dec' or extra is None:
            continue
        src_text = ''
        try:
            src_text = Path(os.path.join(root, rel)).read_text(encoding='utf-8', errors='replace')
        except Exception:
            pass
        for m in RE_GUID_DECL.finditer(src_text):
            name_lower = m.group(1).lower()
            if rel not in guid_name_to_dec[name_lower]:
                guid_name_to_dec[name_lower].append(rel)
        # Also use names from the already-parsed extra data
        for name in extra.get('guids', []) + extra.get('ppis', []) + extra.get('protocols', []):
            name_lower = name.strip().lower()
            if name_lower and rel not in guid_name_to_dec[name_lower]:
                guid_name_to_dec[name_lower].append(rel)

    # Build per-module file lists + typed edges
    files_by_module      = defaultdict(list)
    file_edges_by_module = defaultdict(list)

    for rel, meta in file_meta.items():
        fid  = rel_to_id[rel]
        mod  = meta['module']
        files_by_module[mod].append({
            'id':         fid,
            'label':      meta['label'],
            'path':       rel,
            'ext':        meta['ext'],
            'size':       meta['size'],
            'func_count': len(file_defs.get(rel, [])),
            'file_type':  meta['file_type'],
            'bios_meta':  meta['bios_meta'],
        })

    _cb(70, 'Resolving file edges...')
    module_edge_counts = defaultdict(int)
    seen_file_edges    = set()

    def add_edge(src_rel, tgt_rel, edge_type):
        src_id  = rel_to_id[src_rel]
        tgt_id  = rel_to_id[tgt_rel]
        src_mod = file_meta[src_rel]['module']
        tgt_mod = file_meta[tgt_rel]['module']
        if src_id == tgt_id:
            return
        if src_mod != tgt_mod:
            key = (min(src_mod, tgt_mod), max(src_mod, tgt_mod))
            module_edge_counts[key] += 1
        ekey = (src_id, tgt_id, edge_type)
        if ekey not in seen_file_edges:
            seen_file_edges.add(ekey)
            file_edges_by_module[src_mod].append({'s': src_id, 't': tgt_id, 'type': edge_type})

    for src_rel, extra in file_extra.items():
        ext = file_meta[src_rel]['ext']
        src_dir = str(Path(src_rel).parent)

        if ext in ('.c', '.cpp', '.cc', '.h', '.hpp', '.vfr', '.asl'):
            # Standard #include edges
            for inc in file_incs.get(src_rel, []):
                for tgt in resolve_ref(inc, src_dir):
                    add_edge(src_rel, tgt, 'include')

        elif ext == '.asm' or ext in ('.s', '.S', '.nasm'):
            for inc in file_incs.get(src_rel, []):
                for tgt in resolve_ref(inc, src_dir):
                    add_edge(src_rel, tgt, 'include')

        elif ext == '.inf' and extra:
            # [Sources] → .c files
            for src_f in extra.get('sources', []):
                for tgt in resolve_ref(src_f, src_dir):
                    add_edge(src_rel, tgt, 'sources')
            # [Packages] → .dec files
            for pkg in extra.get('packages', []):
                for tgt in resolve_ref(pkg, src_dir):
                    add_edge(src_rel, tgt, 'package')
            # [LibraryClasses] → other .inf (by stem)
            for lib in extra.get('libraries', []):
                for tgt in resolve_ref(lib, src_dir):
                    if tgt != src_rel:
                        add_edge(src_rel, tgt, 'library')
            # [Guids/Ppis/Protocols] → .dec that declares them (Phase B)
            all_symbols = extra.get('guids', []) + extra.get('ppis', []) + extra.get('protocols', [])
            seen_dec = set()
            for sym in all_symbols:
                sym_lower = sym.strip().lower()
                for dec_rel in guid_name_to_dec.get(sym_lower, []):
                    if dec_rel not in seen_dec and dec_rel != src_rel:
                        seen_dec.add(dec_rel)
                        add_edge(src_rel, dec_rel, 'guid_ref')

        elif ext == '.dsc' and extra:
            for comp in extra.get('components', []):
                for tgt in resolve_ref(comp, src_dir):
                    add_edge(src_rel, tgt, 'component')

        elif ext == '.fdf' and extra:
            for inf_f in extra.get('infs', []):
                for tgt in resolve_ref(inf_f, src_dir):
                    add_edge(src_rel, tgt, 'component')

        elif ext == '.sdl' and extra:
            # INFComponent → .inf files
            for inf_f in extra.get('inf_components', []):
                for tgt in resolve_ref(inf_f, src_dir):
                    add_edge(src_rel, tgt, 'component')
            # LibraryMapping → .inf by Instance "Pkg.LibClass" → stem is LibClass
            for inst in extra.get('lib_mappings', []):
                stem = inst.split('.')[-1] if '.' in inst else inst
                for tgt in resolve_ref(stem, src_dir):
                    if tgt != src_rel:
                        add_edge(src_rel, tgt, 'library')
            # Phase C: ELINK parent chain — each ELINK parent points to a .sdl that owns it
            for parent in extra.get('elink_parents', []):
                for tgt in resolve_ref(parent, src_dir):
                    if tgt != src_rel:
                        add_edge(src_rel, tgt, 'elink')

        elif ext == '.cif' and extra:
            # [INF] section → .inf files
            for inf_f in extra.get('infs', []):
                for tgt in resolve_ref(inf_f, src_dir):
                    add_edge(src_rel, tgt, 'cif_own')
            # [files] section → any file
            for f in extra.get('files', []):
                for tgt in resolve_ref(f, src_dir):
                    add_edge(src_rel, tgt, 'cif_own')

        # Phase D: VFR → UNI (str_ref) / HFR (include) edges
        elif ext == '.vfr' and extra:
            # .uni string packages → str_ref (this VFR depends on that UNI for string tokens)
            for uni_f in extra.get('uni_includes', []):
                for tgt in resolve_ref(uni_f, src_dir):
                    add_edge(src_rel, tgt, 'str_ref')
            # .hfr sub-forms → include (this VFR includes that HFR form fragment)
            for hfr_f in extra.get('hfr_includes', []):
                for tgt in resolve_ref(hfr_f, src_dir):
                    add_edge(src_rel, tgt, 'include')
            # Other #include (e.g. .h header defines)
            for inc in extra.get('includes', []):
                ext_i = Path(inc).suffix.lower()
                if ext_i not in ('.uni', '.hfr'):  # already handled above
                    for tgt in resolve_ref(inc, src_dir):
                        add_edge(src_rel, tgt, 'include')

        # Phase D: HFR (AMI HII Form Resource) — same pattern as VFR
        elif ext == '.hfr' and extra:
            for uni_f in extra.get('uni_includes', []):
                for tgt in resolve_ref(uni_f, src_dir):
                    add_edge(src_rel, tgt, 'str_ref')
            for hfr_f in extra.get('hfr_includes', []):
                for tgt in resolve_ref(hfr_f, src_dir):
                    add_edge(src_rel, tgt, 'include')
            for inc in extra.get('includes', []):
                ext_i = Path(inc).suffix.lower()
                if ext_i not in ('.uni', '.hfr'):
                    for tgt in resolve_ref(inc, src_dir):
                        add_edge(src_rel, tgt, 'include')

        # Phase C: ASL → Include edges
        elif ext == '.asl' and extra:
            for inc in extra.get('includes', []):
                for tgt in resolve_ref(inc, src_dir):
                    add_edge(src_rel, tgt, 'asl_include')

    _cb(80, 'Building function index...')
    func_name_to_files = defaultdict(list)  # name → [rel_path, ...]
    for rel, defs in file_defs.items():
        for d in defs:
            func_name_to_files[d['label']].append(rel)

    func_name_to_file = {name: files[0] for name, files in func_name_to_files.items()}
    func_name_ambiguous = sorted(name for name, files in func_name_to_files.items() if len(files) > 1)

    funcs_by_file       = {}
    func_edges_by_file  = {}
    func_calls_by_file  = {}

    _cb(85, 'Resolving call edges...')
    for rel, defs in file_defs.items():
        if not defs:
            continue
        fid_map = {d['label']: i for i, d in enumerate(defs)}
        funcs_by_file[rel] = [
            {
                'id':        i,
                'label':     d['label'],
                'is_public': not d['is_static'],
                'is_efiapi': d['is_efiapi'],
            }
            for i, d in enumerate(defs)
        ]
        calls_by_func = file_func_calls.get(rel, [])
        if len(calls_by_func) < len(defs):
            calls_by_func = calls_by_func + ([[]] * (len(defs) - len(calls_by_func)))
        elif len(calls_by_func) > len(defs):
            calls_by_func = calls_by_func[:len(defs)]
        func_calls_by_file[rel] = calls_by_func

        edges = []
        seen_edge = set()
        for caller_idx, d in enumerate(defs):
            for callee in calls_by_func[caller_idx]:
                callee_idx = fid_map.get(callee)
                if callee_idx is None:
                    continue
                if callee_idx == caller_idx:
                    continue
                key = (caller_idx, callee_idx)
                if key not in seen_edge:
                    seen_edge.add(key)
                    edges.append({'s': caller_idx, 't': callee_idx,
                                  'p': int(d['is_static'])})
        func_edges_by_file[rel] = edges

    _cb(95, 'Assembling output...')
    modules = [
        {
            'id':          mod,
            'label':       mod,
            'color':       module_color[mod],
            'file_count':  len(files_by_module[mod]),
            'func_count':  sum(len(file_defs.get(f['path'], []))
                               for f in files_by_module[mod]),
            'other_count': len(other_files_by_module.get(mod, [])),
        }
        for mod in all_modules
    ]
    module_edges = [
        {'s': a, 't': b, 'weight': w}
        for (a, b), w in module_edge_counts.items()
    ]

    total_funcs = sum(len(v) for v in file_defs.values())
    total_calls = sum(len(v) for v in file_calls.values())

    total_other  = len(other_files_all)
    total_binary = sum(1 for m in other_files_all.values() if m['file_type'] == 'binary')

    # Total visible files = analysed + other (excludes skipped dirs content)
    total_visible_files = total + total_other
    # Grand total including skipped dirs
    total_all_files = total_visible_files + total_files_skipped

    # Count by file type for stats
    type_counts = defaultdict(int)
    for meta in file_meta.values():
        type_counts[meta['file_type']] += 1

    file_to_module = {rel: meta['module'] for rel, meta in file_meta.items()}

    _cb(100, 'Done!')
    print()
    return {
        'modules':              modules,
        'module_edges':         module_edges,
        'files_by_module':      dict(files_by_module),
        'file_edges_by_module': dict(file_edges_by_module),
        'other_files_by_module': dict(other_files_by_module),
        'funcs_by_file':        funcs_by_file,
        'func_edges_by_file':   func_edges_by_file,
        'func_calls_by_file':   func_calls_by_file,
        'func_name_to_file':    func_name_to_file,
        'func_name_to_files':   {k: v for k, v in func_name_to_files.items() if len(v) > 1},
        'func_name_ambiguous':  sorted(func_name_ambiguous),
        'file_to_module':       file_to_module,
        'edge_types':           EDGE_TYPES,
        'stats': {
            # ── Analysed (shown in graph) ──
            'files':              total,          # SCAN_EXT files actually analysed
            'modules':            len(modules),   # top-level dirs = "modules"
            'functions':          total_funcs,
            'calls':              total_calls,
            # ── Visibility breakdown ──
            'other_files':        total_other,    # non-SCAN_EXT, non-skipped files shown as grey nodes
            'binary_files':       total_binary,   # subset of other_files that are binary
            # ── Full codebase counts (matches Windows Properties) ──
            'total_visible_files':total_visible_files,  # analysed + other (no skip dirs)
            'total_all_files':    total_all_files,      # includes skipped-dir content
            'total_dirs':         total_dirs_scanned,   # non-skipped subdirectory count
            'total_dirs_skipped': total_dirs_skipped,   # dirs completely ignored
            'skipped_files':      total_files_skipped,  # files inside skipped dirs
            'skipped_dir_names':  sorted(skip_dirs),    # which dirs were skipped
            'type_counts':        dict(type_counts),
            'root':               root.replace('\\', '/'),
        }
    }


# ─── HTML Skeleton (CSS/JS loaded from static/) ───────────────────────────────
HTML_SKELETON = """\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VIZCODE — {root_name}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dagre/0.8.5/dagre.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.js"></script>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Fira+Code:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/c.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/cpp.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/x86asm.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/xml.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/python.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/bash.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/json.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/yaml.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/languages/markdown.min.js"></script>
<style>{CSS}</style>
</head>
<body>

<script>window.JOB_ID = {JOB_ID_JSON};</script>

<div id="topbar">
  <div class="logo">VIZCODE</div>
  <div class="stats-bar">
    <div class="stat">Files <strong id="st-files">0</strong></div>
    <div class="stat">Modules <strong id="st-mods">0</strong></div>
    <div class="stat">Functions <strong id="st-funcs">0</strong></div>
  </div>
  <div style="flex:1"></div>
  <div id="search-wrap" style="display:flex;align-items:center;position:relative;">
    <span class="search-icon" style="position:absolute;left:10px;color:var(--muted);font-size:14px;">🔍</span>
    <input id="search" type="text" placeholder="Search... (/)" style="background:var(--panel2);border:1px solid var(--border);color:var(--text);padding:8px 12px 8px 32px;border-radius:6px;font-size:13px;width:100%;outline:none;">
    <button id="pref-btn" title="Preferences" style="background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:18px;margin-left:12px;padding:4px;transition:color 0.2s;">⚙</button>
  </div>
</div>

<div id="breadcrumb">
  <span id="bc-items" style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;overflow:hidden"></span>
  <button id="back-btn" onclick="goBack()">← Back</button>
  <button id="graph-toggle-btn" title="View Call Graph for Selected File">⬡ Call Graph</button>
  <button id="code-toggle-btn" title="Toggle Code Panel (C)">&#60;&#47;&#62; Code</button>
</div>

<div id="layout">
  <div id="sidebar">
    <div id="sidebar-title">Modules</div>
    <div id="ft-filter"></div>
    <div id="module-list"></div>
  </div>
  <div id="sidebar-resizer"></div>
  <div id="graph-wrap">
    <div id="l1-toolbar" class="l2-toolbar hidden">
      <div class="l2-left">
        <div class="l2-title">Dependency Map</div>
        <div class="l2-sub" id="l1-mod-label">No module</div>
      </div>
      <div class="l2-actions">
        <button id="l1-prev" class="l2-btn" disabled>Prev</button>
        <button id="l1-next" class="l2-btn" disabled>Next</button>
        <button id="l1-toggle-ext" class="l2-btn">Ext Files: Off</button>
        <button id="l1-expand-all-ext" class="l2-btn" style="display:none">Expand All</button>
        <button id="l1-collapse-all-ext" class="l2-btn" style="display:none">Collapse All</button>
        <span id="l1-stats" class="l2-stats"></span>
      </div>
    </div>
    <div id="l2-toolbar" class="l2-toolbar hidden">
      <div class="l2-left">
        <div class="l2-title">Call Flow</div>
        <div class="l2-sub" id="l2-file-label">No file</div>
      </div>
      <div class="l2-actions">
        <button id="l2-prev" class="l2-btn">Prev</button>
        <button id="l2-next" class="l2-btn">Next</button>
        <button id="l2-toggle-ext" class="l2-btn">Ext Lines: On</button>
        <button id="l2-expand-all" class="l2-btn">Expand All</button>
        <button id="l2-collapse-all" class="l2-btn">Collapse All</button>
        <span id="l2-stats" class="l2-stats"></span>
      </div>
    </div>
    <div id="cy"></div>
    <div id="func-view"></div>
    <div id="loading"><div class="spinner"></div><span id="loading-msg">Loading...</span></div>
  </div>
  <!-- Resizer handle -->
  <div id="resizer" style="display:none"></div>
  <!-- Code Panel (Sourcetrail-style) -->
  <div id="code-panel">
    <div id="cp-header">
      <div id="cp-file-bar">
        <span id="cp-ext-badge">.C</span>
        <span id="cp-filename">No file selected</span>
        <button id="cp-close" title="Close">✕</button>
      </div>
      <div id="cp-func-bar">
        <span id="cp-func-name"></span>
        <span id="cp-func-badge" class="cp-func-badge cp-func-public">PUBLIC</span>
        <div id="cp-func-nav">
          <button class="cp-nav-btn" id="cp-prev-func" title="Prev function (←)">‹</button>
          <button class="cp-nav-btn" id="cp-next-func" title="Next function (→)">›</button>
        </div>
      </div>
    </div>
    <div id="cp-body">
      <div id="cp-loading">
        <div class="spinner"></div>
        <span style="font-size:12px;color:var(--muted)">Loading source...</span>
      </div>
      <div id="cp-empty" style="display:none">
        <div class="cp-empty-icon">📁</div>
        <p>Click a file node to view source</p>
        <small>Single-click → preview · Double-click → drill in</small>
      </div>
      <div id="cp-code-wrap" style="display:none"></div>
    </div>
  </div>
</div>

<!-- Old info-panel (hidden, kept for JS compat) -->
<div id="info-panel" style="display:none">
  <div id="info-inner"><div id="info-title"></div><div id="info-sub"></div></div>
</div>

<div id="ctx-menu">
  <div class="ctx-item" id="ctx-copy">📋 Copy path</div>
  <div class="ctx-item" id="ctx-open-code">📄 View source</div>
  <div class="ctx-item" id="ctx-vscode">↗ Open in VS Code</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" id="ctx-module-only">🔍 Only this module</div>
  <div class="ctx-item" id="ctx-pin">📌 Pin node</div>
</div>
<div id="tooltip"></div>

<!-- Preferences Modal -->
<div id="pref-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:999;align-items:center;justify-content:center;backdrop-filter:blur(2px);">
  <div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;width:320px;box-shadow:0 10px 30px rgba(0,0,0,0.7);display:flex;flex-direction:column;overflow:hidden;animation:flip-in-x 0.2s ease-out;">
    <div style="background:var(--panel2);padding:12px 16px;border-bottom:1px solid var(--border);font-weight:600;display:flex;justify-content:space-between;align-items:center;">
      <span>Preferences</span>
      <button id="pref-close-x" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;">✕</button>
    </div>
    <div style="padding:20px 16px;display:flex;flex-direction:column;gap:12px;">
      <div style="display:flex;flex-direction:column;gap:6px;">
        <label for="font-select" style="font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Code Editor Font</label>
        <select id="font-select" style="background:var(--panel2);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:6px;font-size:14px;outline:none;cursor:pointer;font-family:inherit;">
          <option value="'JetBrains Mono', monospace" style="font-family:'JetBrains Mono', monospace;font-size:14px;">JetBrains Mono</option>
          <option value="'Fira Code', monospace" style="font-family:'Fira Code', monospace;font-size:14px;">Fira Code</option>
          <option value="'Cascadia Code', monospace" style="font-family:'Cascadia Code', monospace;font-size:14px;">Cascadia Code</option>
          <option value="Consolas, monospace" style="font-family:Consolas, monospace;font-size:14px;">Consolas</option>
          <option value="'Space Mono', monospace" style="font-family:'Space Mono', monospace;font-size:14px;">Space Mono</option>
        </select>
      </div>
    </div>
    <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;">
      <button id="pref-close-btn" style="background:var(--accent);color:#000;border:none;padding:6px 16px;border-radius:6px;font-weight:600;font-size:13px;cursor:pointer;">Done</button>
    </div>
  </div>
</div>

<!-- Data embedded as JSON text — parsed by JSON.parse(), not JS engine (10x faster) -->
<script type="application/json" id="viz-data">{DATA}</script>
<script>(function(){{
  var l=document.getElementById('loading');
  var m=document.getElementById('loading-msg');
  if(l){{l.className='show';}}
  if(m){{m.textContent='⏳ Parsing graph data...';}}
  // Show resizer when code panel opens (handled by JS)
  document.getElementById('cp-loading').classList.add('hidden');
  document.getElementById('cp-empty').style.display='';
}})();</script>
<script>{JS}</script>
</body>
</html>"""

# Keep HTML_TEMPLATE as alias for backward compat (server.py uses it)
HTML_TEMPLATE = HTML_SKELETON


# ─── build_html ───────────────────────────────────────────────────────────────
def build_html(data: dict, job_id: str = None) -> str:
    """Read static/viz.{css,js} and embed them inline into the HTML skeleton."""
    base  = Path(__file__).parent / 'static'
    css_p = base / 'viz.css'
    js_p  = base / 'viz.js'

    if not css_p.exists() or not js_p.exists():
        raise FileNotFoundError(
            f'Missing static files. Expected:\n  {css_p}\n  {js_p}')

    css = css_p.read_text(encoding='utf-8')
    js  = js_p.read_text(encoding='utf-8')

    json_str     = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    root_name    = Path(data['stats']['root']).name or 'BIOS'
    job_id_json  = json.dumps(job_id)   # "null" or '"abc1234"'

    return HTML_SKELETON.format(
        CSS=css, JS=js,
        DATA=json_str,
        root_name=root_name,
        JOB_ID_JSON=job_id_json,
    )


# ─── inject_data (legacy, used by server.py) ─────────────────────────────────
def inject_data(html: str, data: dict) -> str:
    """Legacy helper — now calls build_html() directly."""
    return build_html(data, job_id=None)


# ─── main ─────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='BIOS Code Visualizer V3')
    parser.add_argument('root', help='Root directory of BIOS codebase')
    parser.add_argument('-o', '--output', default='bios_viz.html',
                        help='Output HTML file (default: bios_viz.html)')
    parser.add_argument('--include-build', action='store_true',
                        help='Include build output directories (Build/build/DEBUG/RELEASE)')
    parser.add_argument('--include-dir', action='append', default=[],
                        help='Directory name to include even if normally skipped (repeatable)')
    args = parser.parse_args()

    if not os.path.isdir(args.root):
        print(f'Error: "{args.root}" is not a directory', file=sys.stderr)
        sys.exit(1)

    print(f'BIOSVIZ V3 — analyzing: {args.root}')
    data = build_graph(args.root, include_build=args.include_build, include_dirs=args.include_dir)

    s = data['stats']
    print(f'\nAnalysis complete:')
    print(f'  Modules:   {s["modules"]}')
    print(f'  Files:     {s["files"]}')
    print(f'  Functions: {s["functions"]}')
    print(f'  Calls:     {s["calls"]}')
    if s.get('type_counts'):
        print(f'\n  File types:')
        for ft, cnt in sorted(s['type_counts'].items(), key=lambda x: -x[1]):
            print(f'    {ft:20s} {cnt}')

    try:
        html = build_html(data)
    except FileNotFoundError as e:
        print(f'\nWarning: {e}')
        print('Falling back to embedded template...')
        json_str = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
        html = HTML_SKELETON\
            .replace('{DATA}', json_str)\
            .replace('{CSS}', '')\
            .replace('{JS}', '')\
            .replace('{root_name}', 'BIOS')\
            .replace('{JOB_ID_JSON}', 'null')

    out = args.output
    Path(out).write_text(html, encoding='utf-8')
    size = Path(out).stat().st_size
    print(f'\nOutput: {out} ({size/1024:.0f} KB)')
    print(f'Open in Chrome: file:///{Path(out).absolute().as_posix()}')


if __name__ == '__main__':
    main()