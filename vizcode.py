#!/usr/bin/env python3
"""
vizcode.py — VIZCODE Interactive CLI Launcher
Zero pip dependencies — pure Python stdlib only.
Compatible: Python 3.6+, Windows cp950/UTF-8, Mac, Linux

TUI Architecture
────────────────
  Row 1-11  : FIXED HEADER  (printed once at startup, never touched again)
              blank / banner×6 / subtitle / blank / server-badge / blank
  Row 12+   : CONTENT ZONE  (cleared & repainted per screen)

Screen transitions only erase/rewrite rows 12 onward.
The banner is NEVER reprinted.
Animation loop: 30 fps — HTTP poll every 5 frames (~6 Hz).
Virtual file counter: animates toward real count between polls.
"""

import sys, os, json, time, socket, subprocess, webbrowser, threading
import urllib.request, urllib.error
from pathlib import Path
from typing import Optional, List, Dict

# ─── Force UTF-8 output on Windows ───────────────────────────────────────────
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    os.system("chcp 65001 >nul 2>&1")

# ─── Config ───────────────────────────────────────────────────────────────────
SCRIPT_DIR     = Path(__file__).resolve().parent
LOCAL_DATA_DIR = SCRIPT_DIR / ".local"
LOCAL_DATA_DIR.mkdir(exist_ok=True)
SERVER_PY    = SCRIPT_DIR / "server.py"
HISTORY_FILE = LOCAL_DATA_DIR / "vizcode_history.json"
SERVER_LOG   = LOCAL_DATA_DIR / "vizcode_server.log"
DEFAULT_PORT = 7777
PORT         = DEFAULT_PORT
BASE_URL     = f"http://localhost:{PORT}"

# ─── ANSI ─────────────────────────────────────────────────────────────────────
IS_WIN = sys.platform == "win32"

def _enable_win_ansi() -> bool:
    try:
        import ctypes
        ctypes.windll.kernel32.SetConsoleMode(
            ctypes.windll.kernel32.GetStdHandle(-11), 7)
        return True
    except Exception:
        return False

USE_COLOR = _enable_win_ansi() if IS_WIN else (
    hasattr(sys.stdout, "isatty") and sys.stdout.isatty()
)

def _c(t, code): return f"\033[{code}m{t}\033[0m" if USE_COLOR else t
def orange(t): return _c(t, "38;5;214")
def cyan(t):   return _c(t, "38;5;51")
def yellow(t): return _c(t, "38;5;226")
def green(t):  return _c(t, "38;5;84")
def dim(t):    return _c(t, "2")
def bold(t):   return _c(t, "1")
def red(t):    return _c(t, "38;5;203")

HIDE_C = "\033[?25l" if USE_COLOR else ""
SHOW_C = "\033[?25h" if USE_COLOR else ""

def _goto(row: int, col: int = 1) -> str:
    return f"\033[{row};{col}H" if USE_COLOR else ""

def _erase_line() -> str:
    return "\033[2K" if USE_COLOR else ""

def _clear_screen_and_scrollback() -> str:
    """
    \\033[3J  erase scrollback buffer  (Windows Terminal, xterm, iTerm2)
    \\033[2J  erase visible screen
    \\033[H   cursor to top-left
    """
    return "\033[3J\033[2J\033[H" if USE_COLOR else ""

# ─── Animation ────────────────────────────────────────────────────────────────
# Braille spinner on POSIX; ASCII fallback on Windows
SPINNER_FRAMES = ["|", "/", "-", "\\"] if IS_WIN else \
                 ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]

ANALYSIS_STAGES = [
    ('scan',     'Scan source files'),
    ('detect',   'Detect project type'),
    ('analysis', 'Analyze source files'),
    ('node',     'Build nodes and indexes'),
    ('edge',     'Resolve dependencies and calls'),
    ('finalize', 'Finalize output'),
]
ANALYSIS_STAGE_INDEX = {k: i for i, (k, _) in enumerate(ANALYSIS_STAGES)}

FPS        = 30           # animation frame rate
POLL_EVERY = 5            # HTTP poll every N frames  →  ~6 Hz
FRAME_SEC  = 1.0 / FPS   # 0.0333 s per frame

# ─── Fixed header row map (1-indexed terminal rows) ──────────────────────────
# Row  1 : blank
# Row  2 : banner[0]   ─┐
# Row  3 : banner[1]    │
# Row  4 : banner[2]    │  printed once, never touched again
# Row  5 : banner[3]    │
# Row  6 : banner[4]    │
# Row  7 : banner[5]   ─┘
# Row  8 : subtitle
# Row  9 : blank
# Row 10 : server badge  ← only dynamic row in header
# Row 11 : blank
# Row 12+: CONTENT ZONE  ← all screens live here
BADGE_ROW     = 10
CONTENT_START = 12

# ─── Keypress ─────────────────────────────────────────────────────────────────
if IS_WIN:
    import msvcrt
    def _getch() -> str:
        ch = msvcrt.getwch()
        if ch in ('\x00', '\xe0'):
            return {'H':'UP','P':'DOWN','M':'RIGHT','K':'LEFT'}.get(msvcrt.getwch(),'OTHER')
        if ch == '\r':   return 'ENTER'
        if ch == '\x03': raise KeyboardInterrupt
        if ch == '\x1b': return 'ESC'
        return ch
else:
    import tty, termios
    def _getch() -> str:
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd)
        try:
            tty.setraw(fd)
            ch = sys.stdin.read(1)
            if ch == '\x1b':
                rest = sys.stdin.read(2)
                return {'[A':'UP','[B':'DOWN','[C':'RIGHT','[D':'LEFT'}.get(rest,'ESC')
            if ch in ('\r','\n'): return 'ENTER'
            if ch == '\x03':      raise KeyboardInterrupt
            return ch
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)

# ─── Banner ───────────────────────────────────────────────────────────────────
BANNER_LINES = [
    r" ██╗   ██╗██╗███████╗ ██████╗ ██████╗ ██████╗ ███████╗",
    r" ██║   ██║██║╚══███╔╝██╔════╝██╔═══██╗██╔══██╗██╔════╝",
    r" ██║   ██║██║  ███╔╝ ██║     ██║   ██║██║  ██║█████╗  ",
    r" ╚██╗ ██╔╝██║ ███╔╝  ██║     ██║   ██║██║  ██║██╔══╝  ",
    r"  ╚████╔╝ ██║███████╗╚██████╗╚██████╔╝██████╔╝███████╗",
    r"   ╚═══╝  ╚═╝╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
]

# ─── Utilities ────────────────────────────────────────────────────────────────
def _fmt(v) -> str:
    try:   return f"{int(v):,}"
    except: return "0"

def _progress_bar(pct: int, width: int = 36) -> str:
    pct    = max(0, min(100, int(pct or 0)))
    filled = int(width * pct / 100)
    bar    = orange("█" * filled) + dim("░" * (width - filled))
    return f"[{bar}] {pct:>3}%"

# ═══════════════════════════════════════════════════════════════════════════════
# TUI — single global renderer
# ═══════════════════════════════════════════════════════════════════════════════
class TUI:
    """
    Fixed-header TUI.
      startup()      one-time: clear scrollback + draw header
      show_menu()    draw menu in content zone
      show_analysis()  draw analysis skeleton in content zone
      show_text()    draw arbitrary lines in content zone
      upd_*()        overwrite individual dynamic rows in-place
      flush()        park cursor + flush stdout
    """

    def __init__(self):
        self._bottom: int        = CONTENT_START
        self._named:  Dict[str, int] = {}
        self._irows:  Dict[int, int] = {}
        self._mitems: List[str]      = []

    # ── primitives ─────────────────────────────────────────────────────────

    def _w(self, *parts):
        sys.stdout.write("".join(str(p) for p in parts))

    def _at(self, row: int, text: str):
        self._w(_goto(row), _erase_line(), text)

    def flush(self):
        self._w(_goto(self._bottom))
        sys.stdout.flush()

    # ── one-time startup ───────────────────────────────────────────────────

    def startup(self):
        """Clear screen + scrollback, draw fixed header. Called once."""
        self._w(
            _clear_screen_and_scrollback(),
            HIDE_C,
            "\n",                                           # row 1
        )
        for line in BANNER_LINES:
            self._w(orange(line), "\n")                    # rows 2-7
        self._w(
            dim(f"  Universal Code Visualizer  v4.0  |  {BASE_URL}"), "\n",  # row 8
            "\n",                                           # row 9
            f"  {dim('○')} Server not started\n",          # row 10 badge
            "\n",                                           # row 11
        )
        sys.stdout.flush()

    # ── server badge (header row 10, always visible) ───────────────────────

    def update_badge(self, state: str):
        """state: 'none' | 'starting' | 'ready'"""
        if state == 'ready':
            t = f"  {green('●')} Server running  {dim(BASE_URL)}"
        elif state == 'starting':
            t = f"  {yellow('◌')} Starting server…  {dim(BASE_URL)}"
        else:
            t = f"  {dim('○')} Server not started"
        self._at(BADGE_ROW, t)

    # ── content zone helpers ───────────────────────────────────────────────

    def _clear_zone(self):
        for r in range(CONTENT_START, self._bottom + 3):
            self._w(_goto(r), _erase_line())
        self._named.clear()
        self._irows.clear()

    def _reg(self, key: str, row: int, text: str):
        self._named[key] = row
        self._at(row, text)

    def _set(self, key: str, text: str):
        r = self._named.get(key)
        if r is not None:
            self._at(r, text)

    # ══════════════════════════════════════════════════════════════════════
    # MENU SCREEN
    # ══════════════════════════════════════════════════════════════════════

    def show_menu(self, title: str, items: List[str], hint: str, sel: int):
        self._clear_zone()
        self._mitems = items
        r = CONTENT_START
        self._at(r, f"  {bold(title)}");  r += 1
        self._at(r, f"  {dim(hint)}");    r += 1
        self._at(r, "");                   r += 1
        for i, label in enumerate(items):
            self._irows[i] = r
            self._at(r, self._item_txt(i, i == sel))
            r += 1
        self._at(r, ""); r += 1
        self._bottom = r
        self.flush()

    def _item_txt(self, idx: int, sel: bool) -> str:
        label = self._mitems[idx]
        if label.startswith("-"):   return f"  {dim(label)}"
        if sel: return f"  {orange('▶')} {orange(bold(label))}"
        return f"    {label}"

    def move_menu(self, old: int, new: int):
        """Repaint only the two changed rows — no zone clear."""
        self._at(self._irows[old], self._item_txt(old, False))
        self._at(self._irows[new], self._item_txt(new, True))
        self.flush()

    # ══════════════════════════════════════════════════════════════════════
    # ANALYSIS SCREEN
    # ══════════════════════════════════════════════════════════════════════

    def show_analysis(self, path: str):
        self._clear_zone()
        r = CONTENT_START
        self._reg('title',        r, f"  {cyan(SPINNER_FRAMES[0])} {bold('Initializing…')}"); r += 1
        short = path if len(path) <= 72 else "…" + path[-70:]
        self._at(r, f"  {dim(short)}");           r += 1   # static path
        self._at(r, "");                           r += 1
        self._reg('progress',     r, f"  {_progress_bar(0)}  {dim('Waiting…')}"); r += 1
        self._reg('msg',          r, f"  {dim('Queued…')}"); r += 1
        self._reg('project_type', r, f"  Project Type: {dim('Detecting…')}"); r += 1
        self._at(r, "");                           r += 1
        self._at(r, f"  {bold('Stages')}");        r += 1
        for i, (_, label) in enumerate(ANALYSIS_STAGES):
            self._reg(f'stage_{i}', r, f"  {dim('○')} {dim(label)}"); r += 1
        self._at(r, "");                           r += 1
        self._reg('error', r, "");                 r += 1
        self._bottom = r
        self.flush()

    def upd_title(self, fi: int, label: str, done=False, error=False):
        f    = SPINNER_FRAMES[fi % len(SPINNER_FRAMES)]
        lead = green('✓') if done else red('✗') if error else cyan(f)
        self._set('title', f"  {lead} {bold(label)}")

    def upd_progress(self, pct: int, stage_label: str):
        self._set('progress', f"  {_progress_bar(pct)}  {bold(stage_label)}")

    def upd_analyzed(self, virt_analyzed: int, total: int):
        """Animated analyzed-files counter in the msg row."""
        if total:
            t = f"  {cyan(_fmt(virt_analyzed))} {dim('/')} {dim(_fmt(total))} {dim('files analyzed')}"
        elif virt_analyzed:
            t = f"  {dim('scanning…')} {cyan(_fmt(virt_analyzed))} {dim('files')}"
        else:
            t = f"  {dim('Queued…')}"
        self._set('msg', t)

    def upd_project_type(self, project: dict):
        if project and project.get('name'):
            t = f"  Project Type: {project.get('emoji','')} {bold(project.get('name',''))}"
        else:
            t = f"  Project Type: {dim('Detecting…')}"
        self._set('project_type', t)

    def upd_stages(self, cur: int, done: bool, error: bool, fi: int):
        f = SPINNER_FRAMES[fi % len(SPINNER_FRAMES)]
        for i, (_, label) in enumerate(ANALYSIS_STAGES):
            if done or i < cur:      marker, text = green('✓'), label
            elif i == cur:           marker = red('✗') if error else cyan(f); text = bold(label)
            else:                    marker, text = dim('○'), dim(label)
            self._set(f'stage_{i}', f"  {marker} {text}")

    def upd_error(self, err: Optional[str]):
        self._set('error', f"  {red('✗')} {red(str(err)[:100])}" if err else "")

    # ══════════════════════════════════════════════════════════════════════
    # GENERIC TEXT SCREEN  (help / inline messages)
    # ══════════════════════════════════════════════════════════════════════

    def show_text(self, lines: List[str]):
        self._clear_zone()
        r = CONTENT_START
        for line in lines:
            self._at(r, line); r += 1
        self._at(r, ""); r += 1
        self._bottom = r
        self.flush()

    # ── restore cursor after TUI session ──────────────────────────────────

    def restore(self):
        self._w(_goto(self._bottom), SHOW_C)
        sys.stdout.flush()


# ─── module-level TUI singleton ───────────────────────────────────────────────
_tui = TUI()

# ─── Server ───────────────────────────────────────────────────────────────────
_server_proc = None

def _probe_server(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1.0) as r:
            body = r.read(4096).decode("utf-8", errors="replace")
        return any(k in body for k in ("VIZCODE", "launcher-app", "Universal Code Visualizer"))
    except Exception:
        return False

def _port_free(port: int) -> bool:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:    s.bind(("127.0.0.1", port)); return True
        finally: s.close()
    except OSError: return False

def _select_port() -> int:
    global PORT, BASE_URL
    for c in range(DEFAULT_PORT, DEFAULT_PORT + 100):
        if _probe_server(c) or _port_free(c):
            PORT = c; BASE_URL = f"http://localhost:{c}"; return c
    raise RuntimeError(f"No available port in range {DEFAULT_PORT}–{DEFAULT_PORT+99}.")

def is_server_running() -> bool:
    return _probe_server(PORT)

def start_server(tui: TUI):
    global _server_proc
    port = _select_port()
    if is_server_running():
        tui.update_badge('ready'); tui.flush(); return

    try: SERVER_LOG.write_text("", encoding="utf-8")
    except: pass
    log_fp = open(str(SERVER_LOG), "a", encoding="utf-8", errors="replace")

    def _close():
        try: log_fp.flush(); log_fp.close()
        except: pass

    kw: dict = dict(cwd=str(SCRIPT_DIR), stdout=log_fp, stderr=log_fp)
    if IS_WIN:
        cnw = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if cnw: kw["creationflags"] = cnw
    _server_proc = subprocess.Popen([sys.executable, str(SERVER_PY), str(port)], **kw)

    tui.update_badge('starting')
    for attempt in range(60):
        tui.upd_title(attempt, "Starting server…")
        tui.flush()
        if is_server_running():
            _close(); tui.update_badge('ready'); tui.flush(); return
        if _server_proc.poll() is not None: break
        time.sleep(0.1)

    _close()
    if not is_server_running():
        details = ""
        try:    details = SERVER_LOG.read_text(encoding="utf-8", errors="replace").strip()
        except: pass
        raise RuntimeError(
            f"Server failed to start on port {PORT}."
            + (("\n" + details[-1200:]) if details else "")
        )

def stop_server():
    global _server_proc
    if _server_proc:
        _server_proc.terminate()
        try: _server_proc.wait(timeout=3)
        except: pass
        _server_proc = None

# ─── Analysis ─────────────────────────────────────────────────────────────────
def trigger_analysis(path: str) -> Optional[str]:
    try:
        payload = json.dumps({"path": path}).encode()
        req = urllib.request.Request(
            f"{BASE_URL}/analyze", data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())["job_id"]
    except Exception:
        return None

def poll_job(job_id: str) -> dict:
    try:
        with urllib.request.urlopen(
                f"{BASE_URL}/progress?job={job_id}", timeout=5) as r:
            return json.loads(r.read())
    except: return {}

def run_analysis_with_progress(path: str):
    tui = _tui
    tui.show_analysis(path)

    try:
        start_server(tui)
    except Exception as e:
        tui.upd_error(str(e)); tui.restore()
        r = tui._bottom + 1
        tui._at(r, red(f"  ✗ {e}"))
        tui._bottom = r
        tui.flush()
        return

    tui.upd_title(0, "Analyzing Project"); tui.flush()

    job_id = trigger_analysis(path)
    if not job_id:
        tui.upd_error("Failed to start analysis job."); tui.restore(); return
    save_history(path)

    job: dict = {
        'pct': 0, 'msg': 'Queued…', 'done': False, 'error': None,
        'stage': 'scan', 'stage_label': 'Scan source files',
        'project_type': None, 'total_files': 0, 'analyzed_files': 0,
        'module_count': 0, 'function_count': 0, 'node_count': 0,
        'file_edge_count': 0, 'func_edge_count': 0, 'edge_count': 0,
        'other_files': 0,
    }

    frame_idx   = 0
    stage_floor = 0

    # Background poll thread
    # HTTP poll runs in a daemon thread so the 30-fps loop is never blocked.
    _poll_lock    = __import__("threading").Lock()
    _latest_poll  = {}
    _poll_stop    = __import__("threading").Event()

    def _poll_worker():
        while not _poll_stop.is_set():
            result = poll_job(job_id)
            if result:
                with _poll_lock:
                    _latest_poll.update(result)
            for _ in range(17):          # ~6 Hz, short sleeps stay responsive
                if _poll_stop.is_set(): return
                time.sleep(0.01)

    import threading as _th
    _poll_thread = _th.Thread(target=_poll_worker, daemon=True)
    _poll_thread.start()

    # Virtual analyzed-files counter
    # Tracks analyzed_files with smooth sub-integer steps so the display
    # ticks +1 every few frames rather than jumping on each poll.
    virt_analyzed: float = 0.0
    real_analyzed: int   = 0
    real_total:    int   = 0
    fake_running:  bool  = True
    _fake_speed:   float = 0.06     # files/frame, grows gradually

    while True:
        # Consume latest poll (non-blocking lock snapshot)
        with _poll_lock:
            if _latest_poll:
                job.update(_latest_poll)
                _latest_poll.clear()

        real_total    = int(job.get('total_files') or 0)
        new_analyzed  = int(job.get('analyzed_files') or 0)
        if new_analyzed > 0 and fake_running:
            fake_running  = False
            real_analyzed = new_analyzed
            if virt_analyzed > real_analyzed:
                virt_analyzed = float(real_analyzed)
        elif new_analyzed > real_analyzed:
            real_analyzed = new_analyzed

        # Always sub-integer steps => smooth +1 ticks on screen
        if fake_running:
            _fake_speed   = min(_fake_speed + 0.0022, 0.8)
            virt_analyzed = min(virt_analyzed + _fake_speed, 9_999.0)
        else:
            if job.get('done'):
                virt_analyzed = float(real_analyzed)
            else:
                gap = real_analyzed - virt_analyzed
                if gap > 0:
                    step = max(0.12, min(gap * 0.04, 2.0))
                    virt_analyzed = min(virt_analyzed + step, float(real_analyzed))

        # Resolve current stage
        stage_floor = max(
            stage_floor,
            ANALYSIS_STAGE_INDEX.get(job.get('stage') or 'scan', 0),
        )
        raw_idx     = ANALYSIS_STAGE_INDEX.get(job.get('stage') or 'scan', 0)
        current_idx = min(max(stage_floor, raw_idx), len(ANALYSIS_STAGES) - 1)
        _, default_label = ANALYSIS_STAGES[current_idx]
        stage_label = (
            job.get('stage_label')
            if raw_idx == current_idx and job.get('stage_label')
            else default_label
        )

        done  = bool(job.get('done')) and not job.get('error')
        error = job.get('error')
        pct   = max(0, min(100, int(job.get('pct', 0) or 0)))
        msg   = (job.get('msg') or 'Working…').strip()

        # Batch all row writes -> single flush
        tui.upd_title(frame_idx, "Analyzing Project", done=done, error=bool(error))
        tui.upd_progress(pct, stage_label)
        tui.upd_analyzed(int(virt_analyzed), real_total)
        tui.upd_project_type(job.get('project_type') or {})
        tui.upd_stages(current_idx, done, bool(error), frame_idx)
        tui.upd_error(error)
        tui.flush()

        if error or done: break

        frame_idx += 1
        time.sleep(FRAME_SEC)   # 30 fps, never blocked by network

    _poll_stop.set()
    _poll_thread.join(timeout=1.0)

    tui.restore()

    if not job.get('error'):
        result_url = f"{BASE_URL}/result?job={job_id}"
        r = tui._bottom + 1
        tui._at(r, f"  {green('✓')} Done!  Opening browser…"); r += 1
        tui._at(r, f"  {dim(result_url)}"); r += 1
        tui._bottom = r
        tui.flush()
        time.sleep(0.4)
        webbrowser.open(result_url)

# ─── History ─────────────────────────────────────────────────────────────────
def load_history() -> List[str]:
    try:    return json.loads(HISTORY_FILE.read_text(encoding="utf-8"))[:8]
    except: return []

def save_history(path: str):
    hist = load_history()
    path = str(Path(path).resolve())
    if path in hist: hist.remove(path)
    hist.insert(0, path)
    try: HISTORY_FILE.write_text(json.dumps(hist[:8]), encoding="utf-8")
    except: pass

# ─── Menu & screens ───────────────────────────────────────────────────────────

def run_menu(title: str, items: List[str],
             hint: str = "↑↓ move   Enter select   Esc quit") -> Optional[int]:
    tui = _tui
    sel = 0
    n   = len(items)
    while items[sel].startswith("-"): sel = (sel + 1) % n

    tui.update_badge('ready' if is_server_running() else 'none')
    tui.show_menu(title, items, hint, sel)

    try:
        while True:
            key = _getch()
            if key == 'UP':
                prev = sel; sel = (sel - 1) % n
                while items[sel].startswith("-"): sel = (sel - 1) % n
                tui.move_menu(prev, sel)
            elif key == 'DOWN':
                prev = sel; sel = (sel + 1) % n
                while items[sel].startswith("-"): sel = (sel + 1) % n
                tui.move_menu(prev, sel)
            elif key == 'ENTER': return sel
            elif key in ('ESC', 'q', 'Q'): return None
    except KeyboardInterrupt:
        return None

def prompt_path(msg: str) -> str:
    r = _tui._bottom + 1
    _tui._at(r, f"  {cyan('❯')} {bold(msg)}")
    r += 1
    _tui._at(r, "  → ")
    _tui._bottom = r
    _tui._w(_goto(r, 6), SHOW_C)
    sys.stdout.flush()
    try:    return input().strip().strip('"\'')
    except: return ""

# ─── Actions ─────────────────────────────────────────────────────────────────

def action_analyze_new():
    path = prompt_path("Enter the project folder path:")
    if not path: return
    p = Path(path).expanduser()
    if not p.is_dir():
        _tui.show_text(["", f"  {red('✗')} Not a valid directory:", f"  {dim(path)}"])
        time.sleep(1.5); return
    run_analysis_with_progress(str(p.resolve()))
    _press_enter()

def action_recent():
    hist = load_history()
    if not hist:
        _tui.show_text(["", f"  {dim('No recent projects yet.')}"])
        time.sleep(1.5); return
    items = hist + ["-" * 40, "<- Back"]
    idx   = run_menu("Recent Projects", items, "↑↓ move   Enter select")
    if idx is None or items[idx].startswith("-") or items[idx] == "<- Back": return
    path = items[idx]
    if not Path(path).is_dir():
        _tui.show_text(["", f"  {red('✗')} Directory no longer exists.", f"  {dim(path)}"])
        time.sleep(1.5); return
    run_analysis_with_progress(path)
    _press_enter()

def action_open_browser():
    if not is_server_running():
        _tui.show_text(["", f"  {yellow('!')} Server not running — analyze a project first."])
        time.sleep(1.8); return
    webbrowser.open(BASE_URL)

def action_help():
    _tui.update_badge('ready' if is_server_running() else 'none')
    _tui.show_text([
        "",
        f"  {bold(cyan('How to use VIZCODE'))}",
        "",
        f"  {yellow('1.')} Analyze a Project  — pick a folder, VIZCODE scans all code,",
        f"                         then auto-opens the visualizer in your browser.",
        f"  {yellow('2.')} Recent Projects     — re-run on a previously scanned project.",
        f"  {yellow('3.')} Open Browser        — jump to localhost:{PORT} (server must be running).",
        "",
        f"  {bold(cyan('Supported languages:'))}",
        f"    🔲 UEFI / AMI BIOS    🐍 Python    ⚡ JS / TS    🔵 Go",
        "",
        f"  {bold(cyan('Quick start:'))}",
        f"    {dim('python vizcode.py /path/to/project')}",
        "",
        f"  {dim('Press Enter to return to menu…')}",
    ])
    while True:
        try:
            if _getch() == 'ENTER': break
        except: break

def action_exit():
    r = _tui._bottom + 1
    _tui._at(r, f"  {dim('Stopping server…')}"); _tui.flush()
    stop_server()
    _tui._at(r, f"  {dim('Server stopped.')}"); r += 1
    _tui._at(r, ""); r += 1
    _tui._at(r, f"  {orange('Goodbye! 👋')}"); r += 1
    _tui._bottom = r
    _tui.restore()
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(0)

def _press_enter():
    r = _tui._bottom + 2
    _tui._at(r, f"  {dim('Press Enter to return to menu…')}")
    _tui._bottom = r
    _tui.flush()
    while True:
        try:
            if _getch() == 'ENTER': break
        except: break

# ─── Main ─────────────────────────────────────────────────────────────────────
MENU = [
    ("📂  Analyze a Project", action_analyze_new),
    ("🕑  Recent Projects",   action_recent),
    ("🌐  Open Browser",      action_open_browser),
    ("-" * 35,                None),
    ("❓  Help",              action_help),
    ("✖   Exit",              action_exit),
]

def main():
    # One-time TUI init: clear scrollback + draw fixed header
    _tui.startup()

    if len(sys.argv) > 1:
        path = sys.argv[1]
        if Path(path).is_dir():
            run_analysis_with_progress(str(Path(path).resolve()))
            _press_enter()
        else:
            _tui.show_text([f"  {red('✗')} Not a directory: {path}"])
            _tui.restore(); sys.exit(1)
        return

    labels = [label for label, _ in MENU]
    while True:
        idx = run_menu("What would you like to do?", labels)
        if idx is None: action_exit()
        fn = MENU[idx][1]
        if fn: fn()

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        action_exit()
