#!/usr/bin/env python3
"""
detector.py — VIZCODE Project Type Detector
Fingerprints a directory's file composition to identify what kind of
codebase it is, then returns a rich descriptor for display and UI theming.
"""

# ─── Project type registry ────────────────────────────────────────────────────
# Each entry:  key → { name, emoji, badge_color, accent, description, exts }
PROJECT_TYPES = {
    'uefi_bios': {
        'key':         'uefi_bios',
        'name':        'UEFI / AMI BIOS Firmware',
        'emoji':       '🔲',
        'badge_color': '#ffd700',
        'accent':      '#00d4ff',
        'description': 'EDK2 / AMI BIOS firmware project with INF, DEC, DSC, SDL and CIF module manifests',
        'exts':        {'.inf', '.sdl', '.cif', '.dec', '.dsc', '.fdf'},
    },
    'python': {
        'key':         'python',
        'name':        'Python',
        'emoji':       '🐍',
        'badge_color': '#4584c3',
        'accent':      '#ffd343',
        'description': 'Python project — modules, packages, def-based functions, import graph',
        'exts':        {'.py'},
    },
    'javascript': {
        'key':         'javascript',
        'name':        'JavaScript / Node.js',
        'emoji':       '⚡',
        'badge_color': '#f0c040',
        'accent':      '#f0c040',
        'description': 'JavaScript / Node.js project with ES6 imports and CommonJS require',
        'exts':        {'.js', '.mjs', '.cjs'},
    },
    'typescript': {
        'key':         'typescript',
        'name':        'TypeScript',
        'emoji':       '🔷',
        'badge_color': '#3178c6',
        'accent':      '#3b82f6',
        'description': 'TypeScript project with static typing and ES module imports',
        'exts':        {'.ts', '.tsx'},
    },
    'react': {
        'key':         'react',
        'name':        'React / JSX',
        'emoji':       '⚛️',
        'badge_color': '#61dafb',
        'accent':      '#61dafb',
        'description': 'React project with JSX / TSX component files',
        'exts':        {'.jsx', '.tsx'},
    },
    'go': {
        'key':         'go',
        'name':        'Go (Golang)',
        'emoji':       '🔵',
        'badge_color': '#00add8',
        'accent':      '#00c6db',
        'description': 'Go project — packages, exported/unexported functions, import paths',
        'exts':        {'.go'},
    },
    'c_cpp': {
        'key':         'c_cpp',
        'name':        'C / C++',
        'emoji':       '⚙️',
        'badge_color': '#3b82f6',
        'accent':      '#60a5fa',
        'description': 'C / C++ project with header includes and function call analysis',
        'exts':        {'.c', '.cpp', '.cc', '.h', '.hpp'},
    },
    'mixed': {
        'key':         'mixed',
        'name':        'Multi-Language',
        'emoji':       '🔀',
        'badge_color': '#a78bfa',
        'accent':      '#c084fc',
        'description': 'Multi-language project with significant code in multiple languages',
        'exts':        set(),
        'components':  [],
    },
}


def detect_project_type(ext_counts: dict) -> dict:
    """
    Given a dict of {ext: file_count}, fingerprint the project type.

    Returns a copy of the matching PROJECT_TYPES entry, enriched with
    a 'score' field and optional 'components' for mixed projects.
    """
    def _score(exts_set):
        return sum(ext_counts.get(e, 0) for e in exts_set)

    # BIOS indicator files are UNIQUE to BIOS firmware — any presence wins
    bios_indicator = _score({'.inf', '.sdl', '.cif', '.dec', '.dsc', '.fdf'})
    if bios_indicator > 0:
        result = dict(PROJECT_TYPES['uefi_bios'])
        result['score'] = bios_indicator
        return result

    # Now rank other language families
    go_score   = _score({'.go'})
    ts_score   = _score({'.ts', '.tsx'})
    jsx_score  = _score({'.jsx', '.tsx'})
    js_score   = _score({'.js', '.mjs', '.cjs'})
    py_score   = _score({'.py'})
    c_score    = _score({'.c', '.cpp', '.cc', '.h', '.hpp'})

    scores = [
        ('go',         go_score),
        ('typescript', ts_score),
        ('react',      jsx_score   if jsx_score > 0 and jsx_score > ts_score * 0.5 else 0),
        ('javascript', js_score),
        ('python',     py_score),
        ('c_cpp',      c_score),
    ]

    ranked = [(k, s) for k, s in scores if s > 0]
    ranked.sort(key=lambda x: -x[1])

    if not ranked:
        result = dict(PROJECT_TYPES['c_cpp'])
        result['score'] = 0
        return result

    top_key, top_score = ranked[0]

    # Mixed: second language contributes > 35% of top-language score
    if len(ranked) >= 2:
        second_key, second_score = ranked[1]
        if second_score / top_score > 0.35:
            result = dict(PROJECT_TYPES['mixed'])
            result['score'] = top_score
            result['components'] = [top_key, second_key]
            result['component_names'] = [
                PROJECT_TYPES.get(top_key, {}).get('name', top_key),
                PROJECT_TYPES.get(second_key, {}).get('name', second_key),
            ]
            return result

    result = dict(PROJECT_TYPES[top_key])
    result['score'] = top_score
    return result


def fmt_detection_banner(ptype: dict) -> list:
    """Return list of progress messages to display during scanning."""
    name  = ptype.get('name', 'Unknown')
    desc  = ptype.get('description', '')
    components = ptype.get('component_names', [])

    lines = [
        "----------------------------------------",
        f"  PROJECT DETECTED: {name.upper()}",
    ]
    if components:
        lines.append(f"     Primary: {components[0]} / Secondary: {components[1]}")
    if desc:
        lines.append(f"     {desc}")
    lines.append("----------------------------------------")
    return lines


