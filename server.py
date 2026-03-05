#!/usr/bin/env python3
"""
server.py — VIZCODE Local Server V4
Serves launcher.html and runs analyze_viz.py on demand.
Backward compatible: still works if analyze_bios.py is present.
stdlib only: http.server, threading, json, uuid
Usage: python server.py [port]   (default port 7777)
"""

import sys, os, json, threading, uuid, time
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# Import sibling module — prefer analyze_viz (new), fall back to analyze_bios
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import analyze_viz as analyze_bios
except ImportError:
    import analyze_bios

PORT = 7777
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# job_id -> { pct, msg, done, error, stats, data, root }
JOBS: dict = {}
JOBS_LOCK = threading.Lock()

# Cleanup old .result_*.html files left from previous server design
for _f in Path(SCRIPT_DIR).glob('.result_*.html'):
    _f.unlink(missing_ok=True)


# ─── HTTP Handler ─────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress default access log

    # ── GET ───────────────────────────────────────────────────────────────────
    def do_GET(self):
        parsed = urlparse(self.path)
        p = parsed.path
        qs = parse_qs(parsed.query)

        if p == '/':
            self.serve_disk('launcher.html', 'text/html')

        elif p.startswith('/static/'):
            filename = p[len('/static/'):]
            ext = filename.rsplit('.', 1)[-1] if '.' in filename else ''
            mime = {'css':'text/css','js':'application/javascript',
                    'html':'text/html','json':'application/json'}.get(ext, 'text/plain')
            self.serve_disk(os.path.join('static', filename), mime)

        elif p == '/progress':
            jid = qs.get('job', [''])[0]
            with JOBS_LOCK:
                job = JOBS.get(jid)
            if not job:
                self.json_resp({'error': 'Unknown job'}, 404)
            else:
                # Strip 'data' (graph payload) — not needed by frontend, and may contain non-serialisable types
                safe = {k: v for k, v in job.items() if k != 'data'}
                self.json_resp(safe)

        elif p == '/result':
            jid = qs.get('job', [''])[0]
            with JOBS_LOCK:
                job = JOBS.get(jid, {})
            data = job.get('data')
            if not data:
                if job.get('error'):
                    self.html_error(job['error'])
                else:
                    self.html_error('Result not ready — analysis may still be running')
                return
            try:
                html = analyze_bios.build_html(data, job_id=jid)
                body = html.encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', len(body))
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self.html_error(f'Failed to render HTML: {e}')

        elif p == '/file':
            # Serve raw source file content for the code panel
            jid = qs.get('job', [''])[0]
            rel = qs.get('path', [''])[0]
            with JOBS_LOCK:
                job = JOBS.get(jid, {})
            root = job.get('root', '')
            if not root or not rel:
                self.json_resp({'error': 'Missing job or path param'}, 400)
                return
            try:
                abs_path = os.path.normpath(os.path.join(root, rel))
                root_norm = os.path.normpath(root)
                # Security: path must stay within root
                if not (abs_path.startswith(root_norm + os.sep) or abs_path == root_norm):
                    self.json_resp({'error': 'Path traversal not allowed'}, 403)
                    return

                import base64
                ext = Path(abs_path).suffix.lower()

                # ── Image files → base64 ──────────────────────────────────────
                IMAGE_EXTS = {
                    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                    '.png': 'image/png',  '.bmp': 'image/bmp',
                    '.gif': 'image/gif',  '.ico': 'image/x-icon',
                    '.tiff': 'image/tiff', '.tif': 'image/tiff',
                    '.webp': 'image/webp',
                }
                if ext in IMAGE_EXTS:
                    raw = Path(abs_path).read_bytes()
                    b64 = base64.b64encode(raw).decode('ascii')
                    self.json_resp({
                        'content_type': 'image',
                        'mime': IMAGE_EXTS[ext],
                        'data': b64,
                        'size': len(raw),
                        'path': rel,
                    })
                    return

                # ── Known binary / object files → hex dump ───────────────────
                BINARY_EXTS = {
                    '.bin', '.rom', '.efi', '.lib', '.obj',
                    '.veb', '.map', '.pdb', '.exe', '.dll',
                }
                if ext in BINARY_EXTS:
                    MAX_HEX = 8192   # show first 8 KB
                    raw = Path(abs_path).read_bytes()
                    chunk = raw[:MAX_HEX]
                    lines = []
                    for i in range(0, len(chunk), 16):
                        row = chunk[i:i+16]
                        hex_part  = ' '.join(f'{b:02X}' for b in row)
                        hex_pad   = hex_part.ljust(47)
                        ascii_part = ''.join(chr(b) if 32 <= b < 127 else '.' for b in row)
                        lines.append(f'{i:08X}  {hex_pad}  |{ascii_part}|')
                    truncated = len(raw) > MAX_HEX
                    self.json_resp({
                        'content_type': 'binary',
                        'content': '\n'.join(lines),
                        'size': len(raw),
                        'truncated': truncated,
                        'path': rel,
                    })
                    return

                # ── PDF files → base64 embed ──────────────────────────────────
                PDF_EXTS = {'.pdf'}
                if ext in PDF_EXTS:
                    raw = Path(abs_path).read_bytes()
                    b64 = base64.b64encode(raw).decode('ascii')
                    self.json_resp({
                        'content_type': 'pdf',
                        'data': b64,
                        'size': len(raw),
                        'path': rel,
                    })
                    return

                # ── XML / plain-text variants → serve as text with type hint ──
                TEXT_FORCE_EXTS = {
                    '.xml', '.txt', '.bat', '.cmd', '.sh', '.py',
                    '.md', '.yaml', '.yml', '.toml', '.json',
                    '.cmake', '.mk', '.gitignore', '.editorconfig',
                }
                if ext in TEXT_FORCE_EXTS:
                    content = Path(abs_path).read_text(encoding='utf-8', errors='replace')
                    self.json_resp({
                        'content_type': 'text',
                        'content': content,
                        'lang_hint': ext.lstrip('.'),
                        'path': rel,
                    })
                    return

                # ── Default: attempt UTF-8 text; fall back to hex dump ────────
                raw = Path(abs_path).read_bytes()
                # Heuristic: if >30% non-printable bytes → treat as binary
                printable = sum(1 for b in raw[:512] if 32 <= b < 127 or b in (9, 10, 13))
                is_text = len(raw) == 0 or (printable / min(len(raw), 512)) > 0.70
                if is_text:
                    content = raw.decode('utf-8', errors='replace')
                    self.json_resp({'content_type': 'text', 'content': content, 'path': rel})
                else:
                    chunk = raw[:8192]
                    lines = []
                    for i in range(0, len(chunk), 16):
                        row = chunk[i:i+16]
                        hex_part  = ' '.join(f'{b:02X}' for b in row)
                        ascii_part = ''.join(chr(b) if 32 <= b < 127 else '.' for b in row)
                        lines.append(f'{i:08X}  {hex_part:<47}  |{ascii_part}|')
                    self.json_resp({
                        'content_type': 'binary',
                        'content': '\n'.join(lines),
                        'size': len(raw),
                        'truncated': len(raw) > 8192,
                        'path': rel,
                    })



            except FileNotFoundError:
                self.json_resp({'error': f'File not found: {rel}'}, 404)
            except Exception as e:
                self.json_resp({'error': str(e)}, 500)

        elif p == '/search':
            # Full-text content search — ALL readable files in codebase, grouped by file
            jid    = qs.get('job',    [''])[0]
            q      = qs.get('q',      [''])[0].strip()
            offset = int(qs.get('offset', ['0'])[0])  # for pagination (file-group level)

            if not jid or not q or len(q) < 2:
                self.json_resp({'groups': [], 'total_matches': 0, 'total_files': 0, 'has_more': False})
                return

            with JOBS_LOCK:
                job = JOBS.get(jid, {})
            root = job.get('root', '')
            if not root:
                self.json_resp({'groups': [], 'total_matches': 0, 'total_files': 0, 'has_more': False})
                return

            import re as _re

            # Support regex toggle: prefix q with 'r/' to enable
            use_regex = q.startswith('r/')
            raw_q = q[2:] if use_regex else q
            try:
                if use_regex:
                    pattern = _re.compile(raw_q, _re.IGNORECASE)
                else:
                    pattern = _re.compile(_re.escape(raw_q), _re.IGNORECASE)
            except _re.error as e:
                self.json_resp({'error': f'Regex error: {e}', 'groups': [], 'total_matches': 0,
                                'total_files': 0, 'has_more': False})
                return

            MAX_LINE_LEN   = 300   # chars per line to return
            MAX_LINES_FILE = 100   # max match-lines per file
            PAGE_FILES     = 50    # file groups returned per page
            SKIP_DIRS  = {
                'Build','build','.git','__pycache__','node_modules','.next','dist',
                'out','.venv','venv','.cache','.nyc_output','vendor','.idea','.vscode',
            }
            BINARY_EXTS = {
                '.bin','.rom','.efi','.lib','.obj','.exe','.dll','.pdb',
                '.so','.a','.o','.png','.jpg','.jpeg','.gif','.ico','.bmp',
                '.webp','.tiff','.pdf','.zip','.tar','.gz','.7z','.rar',
            }

            # ── Walk ALL files ────────────────────────────────────────────────
            total_matches  = 0
            total_files    = 0
            all_groups     = []   # [{path, label, module, ext, matches:[{line,text,ms,me}]}]

            # Retrieve module colour map from graph data if available
            graph_data = job.get('data') or {}
            mod_colors = {}
            for mod in graph_data.get('modules', []):
                mod_colors[mod['id']] = mod.get('color', '#64748b')

            root_norm = os.path.normpath(root)

            for dirpath, dirnames, filenames in os.walk(root):
                # Prune skip dirs in-place
                dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]

                for fname in sorted(filenames):
                    ext = Path(fname).suffix.lower()
                    if ext in BINARY_EXTS:
                        continue

                    abs_path = os.path.join(dirpath, fname)
                    rel = os.path.relpath(abs_path, root).replace('\\', '/')

                    # Heuristic: skip large files > 2 MB
                    try:
                        if os.path.getsize(abs_path) > 2 * 1024 * 1024:
                            continue
                    except OSError:
                        continue

                    matches = []
                    try:
                        with open(abs_path, encoding='utf-8', errors='replace') as fh:
                            # Quick pre-screen: read whole file, check if pattern exists
                            content = fh.read()
                            if not pattern.search(content):
                                continue
                            # Now collect per-line matches
                            for lineno, line in enumerate(content.split('\n'), 1):
                                m = pattern.search(line)
                                if m:
                                    text = line.rstrip('\r')
                                    # Clamp display
                                    if len(text) > MAX_LINE_LEN:
                                        # centre the match in the window
                                        start = max(0, m.start() - 60)
                                        text = ('…' if start > 0 else '') + text[start:start + MAX_LINE_LEN]
                                        adj = m.start() - start + (1 if start > 0 else 0)
                                        ms = max(0, adj)
                                        me = ms + len(raw_q)
                                    else:
                                        ms = m.start()
                                        me = m.end()
                                    matches.append({
                                        'line': lineno,
                                        'text': text,
                                        'ms':   ms,
                                        'me':   me,
                                    })
                                    if len(matches) >= MAX_LINES_FILE:
                                        break   # cap per file
                    except Exception:
                        continue

                    if not matches:
                        continue

                    total_files   += 1
                    total_matches += len(matches)
                    mod_id = rel.split('/')[0] if '/' in rel else '_root'
                    all_groups.append({
                        'path':    rel,
                        'label':   fname,
                        'module':  mod_id,
                        'ext':     ext,
                        'color':   mod_colors.get(mod_id, '#64748b'),
                        'count':   len(matches),
                        'matches': matches,
                    })

            # ── Sort: most matches first ──────────────────────────────────────
            all_groups.sort(key=lambda g: -g['count'])

            # ── Paginate ──────────────────────────────────────────────────────
            page_groups = all_groups[offset: offset + PAGE_FILES]
            has_more    = (offset + PAGE_FILES) < len(all_groups)

            self.json_resp({
                'groups':        page_groups,
                'total_matches': total_matches,
                'total_files':   total_files,
                'has_more':      has_more,
                'next_offset':   offset + PAGE_FILES,
                'query':         q,
            })

        elif p == '/jobs':
            with JOBS_LOCK:
                snapshot = [(k, {kk: vv for kk, vv in v.items() if kk != 'data'})
                            for k, v in JOBS.items()]
            self.json_resp([{'id': k, **v} for k, v in snapshot])

        else:
            self.json_resp({'error': 'Not found'}, 404)

    # ── POST ──────────────────────────────────────────────────────────────────
    def do_POST(self):
        parsed = urlparse(self.path)
        p = parsed.path

        if p == '/analyze':
            length = int(self.headers.get('Content-Length', 0))
            try:
                body = json.loads(self.rfile.read(length))
            except Exception:
                self.json_resp({'error': 'Invalid JSON'}, 400)
                return

            root = body.get('path', '').strip().strip('"\'')
            if not root or not os.path.isdir(root):
                self.json_resp({'error': f'Path not found or not a directory: {root}'}, 400)
                return

            jid = str(uuid.uuid4())[:8]

            with JOBS_LOCK:
                JOBS[jid] = {
                    'pct': 0, 'msg': 'Queued...', 'done': False,
                    'error': None, 'stats': None, 'data': None,
                    'root': root, 'started': time.time(),
                }

            def run():
                try:
                    def cb(pct, msg, **kwargs):
                        with JOBS_LOCK:
                            JOBS[jid].update({'pct': pct, 'msg': msg})
                            if kwargs:
                                JOBS[jid].update(kwargs)

                    graph_data = analyze_bios.build_graph(root, progress_cb=cb)

                    s = graph_data['stats']
                    with JOBS_LOCK:
                        JOBS[jid].update({
                            'pct': 100, 'done': True,
                            'msg': f"Done! {s['files']} files, {s['functions']} functions",
                            'data': graph_data,
                            'stats': {k: (sorted(s[k]) if isinstance(s[k], (set, frozenset)) else s[k])
                                      for k in (
                        'files', 'modules', 'functions', 'calls',
                        'other_files', 'binary_files',
                        'total_visible_files', 'total_all_files',
                        'total_dirs', 'total_dirs_skipped',
                        'skipped_files', 'skipped_dir_names',
                    ) if k in s},
                        })
                    print(f'\n[DONE] Job {jid}: {s["files"]} files, {s["functions"]} funcs')

                except Exception as e:
                    import traceback
                    tb = traceback.format_exc()
                    print(f'\n[ERROR] Job {jid}: {e}\n{tb}')
                    with JOBS_LOCK:
                        JOBS[jid].update({
                            'done': True, 'error': str(e), 'pct': 0,
                            'msg': f'Error: {e}',
                        })

            t = threading.Thread(target=run, daemon=True)
            t.start()
            print(f'[START] Job {jid}: {root}')
            self.json_resp({'job_id': jid})

        elif p == '/cancel':
            self.json_resp({'ok': True})

        else:
            self.json_resp({'error': 'Not found'}, 404)

    # ── Helpers ───────────────────────────────────────────────────────────────
    def serve_disk(self, filepath, content_type):
        if not os.path.isabs(filepath):
            filepath = os.path.join(SCRIPT_DIR, filepath)
        try:
            data = Path(filepath).read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', f'{content_type}; charset=utf-8')
            self.send_header('Content-Length', len(data))
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self.json_resp({'error': f'File not found: {filepath}'}, 404)

    def html_error(self, msg):
        body = f'<!DOCTYPE html><html><body style="background:#050a0f;color:#f87171;font-family:monospace;padding:40px"><h2>BIOSVIZ Error</h2><pre>{msg}</pre><a href="/" style="color:#00d4ff">← Back</a></body></html>'.encode()
        self.send_response(500)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def json_resp(self, data, code=200):
        def _default(o):
            if isinstance(o, (set, frozenset)): return sorted(o)
            raise TypeError(f'Not serialisable: {type(o)}')
        body = json.dumps(data, ensure_ascii=False, default=_default).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)


# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    server = HTTPServer(('127.0.0.1', port), Handler)
    url = f'http://localhost:{port}'
    print(f'┌─────────────────────────────────────────┐')
    print(f'│  VIZCODE V4   →  {url:<22} │')
    print(f'│  BIOS · Python · JS/TS · Go             │')
    print(f'└─────────────────────────────────────────┘')
    print(f'Open Chrome and go to: {url}')
    print(f'Press Ctrl+C to stop\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')


if __name__ == '__main__':
    main()