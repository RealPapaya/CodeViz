#!/usr/bin/env python3
"""
vizcode.py — VIZCODE Interactive CLI Launcher
Zero pip dependencies — pure Python stdlib only.
Compatible: Python 3.6+, Windows cp950/UTF-8, Mac, Linux

Usage:
    python vizcode.py
    python vizcode.py /path/to/project
"""

import sys, os, json, time, socket, subprocess, webbrowser
import urllib.request, urllib.error
from pathlib import Path
from typing import Optional, List

# ─── Force UTF-8 output on Windows ───────────────────────────────────────────
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    # Also set console code page to UTF-8
    os.system("chcp 65001 >nul 2>&1")

# ─── Config ──────────────────────────────────────────────────────────────────
SCRIPT_DIR   = Path(__file__).resolve().parent
LOCAL_DATA_DIR = SCRIPT_DIR / ".local"
LOCAL_DATA_DIR.mkdir(exist_ok=True)
SERVER_PY    = SCRIPT_DIR / "server.py"
HISTORY_FILE = LOCAL_DATA_DIR / "vizcode_history.json"
SERVER_LOG   = LOCAL_DATA_DIR / "vizcode_server.log"
DEFAULT_PORT = 7777
PORT         = DEFAULT_PORT
BASE_URL     = f"http://localhost:{PORT}"

# ─── ANSI colors ─────────────────────────────────────────────────────────────
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

def _c(text, code): return f"\033[{code}m{text}\033[0m" if USE_COLOR else text
def orange(t): return _c(t, "38;5;214")
def cyan(t):   return _c(t, "38;5;51")
def yellow(t): return _c(t, "38;5;226")
def green(t):  return _c(t, "38;5;84")
def dim(t):    return _c(t, "2")
def bold(t):   return _c(t, "1")
def red(t):    return _c(t, "38;5;203")

CLEAR  = "\033[2J\033[H" if USE_COLOR else ""
HIDE_C = "\033[?25l"     if USE_COLOR else ""
SHOW_C = "\033[?25h"     if USE_COLOR else ""

SPINNER_FRAMES = ["|", "/", "-", "\\"]
ANALYSIS_STAGES = [
    ('scan', 'Scan source files'),
    ('detect', 'Detect project type'),
    ('analysis', 'Analyze source files'),
    ('node', 'Build nodes and indexes'),
    ('edge', 'Resolve dependencies and calls'),
    ('finalize', 'Finalize output'),
]
ANALYSIS_STAGE_INDEX = {key: idx for idx, (key, _) in enumerate(ANALYSIS_STAGES)}

# ─── Cross-platform single keypress ──────────────────────────────────────────
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

def print_banner():
    print(CLEAR, end="")
    print()
    for line in BANNER_LINES:
        print(orange(line))
    print(dim(f"  Universal Code Visualizer  v4.0  |  {BASE_URL}"))
    print()

# ─── Interactive arrow-key menu ───────────────────────────────────────────────
def run_menu(title: str, items: List[str], hint: str = "Up/Down to move   Enter to select   Esc to quit") -> Optional[int]:
    sel = 0
    n   = len(items)
    while items[sel].startswith("-"): sel = (sel + 1) % n

    def _render():
        print(CLEAR, end="")
        print_banner()
        print_server_badge()
        print(f"  {bold(title)}")
        print(f"  {dim(hint)}\n")
        for i, label in enumerate(items):
            if label.startswith("-"):
                print(f"  {dim(label)}")
            elif i == sel:
                print(f"  {orange('▶')} {orange(bold(label))}")
            else:
                print(f"    {label}")
        print()
        sys.stdout.flush()

    print(HIDE_C, end="", flush=True)
    try:
        while True:
            _render()
            key = _getch()
            if key == 'UP':
                sel = (sel - 1) % n
                while items[sel].startswith("-"): sel = (sel - 1) % n
            elif key == 'DOWN':
                sel = (sel + 1) % n
                while items[sel].startswith("-"): sel = (sel + 1) % n
            elif key == 'ENTER':
                return sel
            elif key in ('ESC', 'q', 'Q'):
                return None
    except KeyboardInterrupt:
        return None
    finally:
        print(SHOW_C, end="", flush=True)

# ─── Path input ───────────────────────────────────────────────────────────────
def prompt_path(msg: str) -> str:
    print(SHOW_C, end="", flush=True)
    sys.stdout.write(f"\n  {cyan('❯')} {bold(msg)}\n  → ")
    sys.stdout.flush()
    try:    return input().strip().strip('"\'')
    except: return ""

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

# ─── Server ───────────────────────────────────────────────────────────────────
_server_proc = None

def _probe_vizcode_server(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1.0) as r:
            body = r.read(4096).decode("utf-8", errors="replace")
        return "VIZCODE" in body or "launcher-app" in body or "Universal Code Visualizer" in body
    except Exception:
        return False

def _is_port_available(port: int) -> bool:
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind(("127.0.0.1", port))
            return True
        finally:
            sock.close()
    except OSError:
        return False

def _select_port() -> int:
    global PORT, BASE_URL
    for candidate in range(DEFAULT_PORT, DEFAULT_PORT + 100):
        if _probe_vizcode_server(candidate):
            PORT = candidate
            BASE_URL = f"http://localhost:{PORT}"
            return candidate
        if _is_port_available(candidate):
            PORT = candidate
            BASE_URL = f"http://localhost:{PORT}"
            return candidate
    raise RuntimeError(f"No available local port found in range {DEFAULT_PORT}-{DEFAULT_PORT + 99}.")

def is_server_running() -> bool:
    return _probe_vizcode_server(PORT)

def start_server(status_cb=None):
    global _server_proc
    port = _select_port()
    if is_server_running():
        if status_cb:
            status_cb(0, f"Server ready on port {port}", True)
        return
    try:
        SERVER_LOG.write_text("", encoding="utf-8")
    except Exception:
        pass
    log_fp = open(str(SERVER_LOG), "a", encoding="utf-8", errors="replace")

    def _close_log():
        try:
            log_fp.flush()
            log_fp.close()
        except Exception:
            pass

    kwargs = dict(cwd=str(SCRIPT_DIR), stdout=log_fp, stderr=log_fp)
    if IS_WIN:
        create_no_window = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if create_no_window:
            kwargs["creationflags"] = create_no_window
    _server_proc = subprocess.Popen([sys.executable, str(SERVER_PY), str(port)], **kwargs)
    for attempt in range(50):
        if status_cb:
            status_cb(attempt, f"Starting server on port {port}...", False)
        if is_server_running():
            _close_log()
            if status_cb:
                status_cb(attempt, f"Server ready on port {port}", True)
            return
        if _server_proc.poll() is not None:
            _close_log()
            break
        time.sleep(0.1)
    _close_log()
    if not is_server_running():
        details = ""
        try:
            details = SERVER_LOG.read_text(encoding="utf-8", errors="replace").strip()
        except Exception:
            details = ""
        if details:
            details = "\n" + details[-1200:]
        raise RuntimeError(f"Server failed to start on port {PORT}.{details}")

def stop_server():
    global _server_proc
    if _server_proc:
        _server_proc.terminate()
        try:
            _server_proc.wait(timeout=3)
        except Exception:
            pass
        _server_proc = None

# ─── Analysis ─────────────────────────────────────────────────────────────────
def _fmt_count(value) -> str:
    try:
        return f"{int(value):,}"
    except (TypeError, ValueError):
        return "0"


def _progress_bar(pct: int, width: int = 30) -> str:
    pct = max(0, min(100, int(pct or 0)))
    filled_len = int(width * pct / 100)
    filled = orange("#" * filled_len)
    empty = dim("-" * (width - filled_len))
    return f"[{filled}{empty}] {pct:>3}%"


def _render_startup_status(path: str, frame_idx: int, message: str, ready: bool = False):
    frame = green('v') if ready else cyan(SPINNER_FRAMES[frame_idx % len(SPINNER_FRAMES)])
    print_banner()
    badge = green('*') if ready else dim('o')
    badge_text = 'Server running' if ready else 'Starting server'
    print(f"  {badge} {badge_text}  {dim(BASE_URL)}\n")
    print(f"  {frame} {bold(message)}")
    print(f"  {dim(path)}\n")
    sys.stdout.flush()


def _render_analysis_progress(path: str, job: dict, frame_idx: int, stage_floor: int = 0):
    frame = SPINNER_FRAMES[frame_idx % len(SPINNER_FRAMES)]
    pct = max(0, min(100, int(job.get('pct', 0) or 0)))
    raw_stage = job.get('stage') or 'scan'
    raw_idx = ANALYSIS_STAGE_INDEX.get(raw_stage, 0)
    current_idx = min(max(stage_floor, raw_idx), len(ANALYSIS_STAGES) - 1)
    _, default_stage_label = ANALYSIS_STAGES[current_idx]
    stage_label = job.get('stage_label') if raw_idx == current_idx and job.get('stage_label') else default_stage_label
    done = bool(job.get('done')) and not job.get('error')
    error = job.get('error')

    print_banner()
    print(f"  {green('*')} Server running  {dim(BASE_URL)}\n")
    lead = green('v') if done else red('!') if error else cyan(frame)
    print(f"  {lead} {bold('Analyzing Project')}")
    print(f"  {dim(path)}\n")
    print(f"  {_progress_bar(pct)}  {bold(stage_label)}")
    msg = (job.get('msg') or 'Working...').strip()
    if msg:
        print(f"  {dim(msg)}")

    project = job.get('project_type') or {}
    if project.get('name'):
        print(f"  Project Type: {project.get('emoji', '')} {project.get('name')}")
    else:
        print(f"  Project Type: {dim('Detecting...')}")

    total_files = int(job.get('total_files') or 0)
    analyzed_files = int(job.get('analyzed_files') or 0)
    module_count = int(job.get('module_count') or 0)
    function_count = int(job.get('function_count') or 0)
    node_count = int(job.get('node_count') or 0)
    other_files = int(job.get('other_files') or 0)
    file_edge_count = int(job.get('file_edge_count') or 0)
    func_edge_count = int(job.get('func_edge_count') or 0)
    edge_count = int(job.get('edge_count') or 0)

    summary_parts = []
    if total_files:
        if analyzed_files:
            summary_parts.append(f"analysis {_fmt_count(analyzed_files)}/{_fmt_count(total_files)} files")
        else:
            summary_parts.append(f"scan {_fmt_count(total_files)} files")
    if module_count:
        summary_parts.append(f"modules {_fmt_count(module_count)}")
    if function_count:
        summary_parts.append(f"functions {_fmt_count(function_count)}")
    if node_count:
        summary_parts.append(f"nodes {_fmt_count(node_count)}")
    if edge_count:
        summary_parts.append(f"edges {_fmt_count(edge_count)}")
    else:
        if file_edge_count:
            summary_parts.append(f"file edges {_fmt_count(file_edge_count)}")
        if func_edge_count:
            summary_parts.append(f"call edges {_fmt_count(func_edge_count)}")
    if other_files:
        summary_parts.append(f"other {_fmt_count(other_files)}")
    if summary_parts:
        print(f"  {dim(' | '.join(summary_parts))}")

    print()
    print(f"  {bold('Stages')}")
    for idx, (_, label) in enumerate(ANALYSIS_STAGES):
        if done or idx < current_idx:
            marker = green('v')
            stage_text = label
        elif idx == current_idx:
            marker = red('!') if error else cyan(frame)
            stage_text = bold(label)
        else:
            marker = dim('o')
            stage_text = dim(label)
        print(f"  {marker} {stage_text}")

    if error:
        print(f"\n  {red('[!]')} {red(str(error))}")
    print()
    sys.stdout.flush()


def trigger_analysis(path: str) -> Optional[str]:
    try:
        payload = json.dumps({"path": path}).encode()
        req = urllib.request.Request(
            f"{BASE_URL}/analyze", data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())["job_id"]
    except Exception as e:
        print(red(f"\n  [!] Failed to start analysis: {e}\n"))
        return None


def poll_job(job_id: str) -> dict:
    try:
        with urllib.request.urlopen(f"{BASE_URL}/progress?job={job_id}", timeout=5) as r:
            return json.loads(r.read())
    except:
        return {}


def run_analysis_with_progress(path: str):
    for tick in range(2):
        _render_startup_status(path, tick, 'Preparing analysis...', False)
        time.sleep(0.05)
    try:
        start_server(lambda tick, message, ready=False: _render_startup_status(path, tick, message, ready))
    except Exception as e:
        print(red(f"\n  [!] {e}\n"))
        return

    job_id = trigger_analysis(path)
    if not job_id:
        return
    save_history(path)

    job = {
        'pct': 0,
        'msg': 'Queued...',
        'done': False,
        'error': None,
        'stage': 'scan',
        'stage_label': 'Scan source files',
        'project_type': None,
        'total_files': 0,
        'analyzed_files': 0,
        'module_count': 0,
        'function_count': 0,
        'node_count': 0,
        'file_edge_count': 0,
        'func_edge_count': 0,
        'edge_count': 0,
        'other_files': 0,
    }
    frame_idx = 0
    stage_floor = 0

    while True:
        polled = poll_job(job_id)
        if polled:
            job.update(polled)
        stage_floor = max(stage_floor, ANALYSIS_STAGE_INDEX.get(job.get('stage') or 'scan', 0))
        _render_analysis_progress(path, job, frame_idx, stage_floor)

        if job.get('error'):
            return
        if job.get('done'):
            break

        frame_idx += 1
        time.sleep(0.15)

    result_url = f"{BASE_URL}/result?job={job_id}"
    print(f"  {green('OK')} Opening browser...")
    print(f"  {dim(result_url)}\n")
    time.sleep(0.4)
    webbrowser.open(result_url)


def print_server_badge():
    if is_server_running():
        print(f"  {green('●')} Server running  {dim(BASE_URL)}\n")
    else:
        print(f"  {dim('○')} Server not started\n")

# ─── Actions ──────────────────────────────────────────────────────────────────
def action_analyze_new():
    print(CLEAR, end="")
    print_banner()
    path = prompt_path("Enter the project folder path:")
    if not path: return
    p = Path(path).expanduser()
    if not p.is_dir():
        print(red(f"\n  [!] Not a valid directory: {path}\n"))
        time.sleep(1.5); return
    run_analysis_with_progress(str(p.resolve()))
    _press_enter()

def action_recent():
    hist = load_history()
    if not hist:
        print(CLEAR, end=""); print_banner()
        print(f"\n  {dim('No recent projects yet.')}\n")
        time.sleep(1.5); return
    items = hist + ["-" * 40, "<- Back"]
    idx   = run_menu("Recent Projects", items, "Up/Down to move   Enter to select")
    if idx is None or items[idx].startswith("-") or items[idx] == "<- Back": return
    path = items[idx]
    if not Path(path).is_dir():
        print(red(f"\n  [!] Directory no longer exists.\n"))
        time.sleep(1.5); return
    run_analysis_with_progress(path)
    _press_enter()

def action_open_browser():
    if not is_server_running():
        print(CLEAR, end=""); print_banner()
        print(yellow(f"\n  [!] Server not running - analyze a project first.\n"))
        time.sleep(1.8); return
    webbrowser.open(BASE_URL)

def action_help():
    print(CLEAR, end=""); print_banner()
    print(f"  {bold(cyan('How to use VIZCODE'))}\n")
    print(f"  {yellow('1.')} Analyze a Project  -- pick a folder, VIZCODE scans all code,")
    print(f"                         then auto-opens the visualizer in your browser.")
    print(f"  {yellow('2.')} Recent Projects     -- re-run on a previously scanned project.")
    print(f"  {yellow('3.')} Open Browser        -- jump to localhost:{PORT} (server must be running).\n")
    print(f"  {bold(cyan('Supported languages:'))}")
    print(f"    🔲 UEFI / AMI BIOS    🐍 Python    ⚡ JS / TS    🔵 Go\n")
    print(f"  {bold(cyan('Quick start:'))}")
    print(f"    {dim('python vizcode.py /path/to/project')}\n")
    _press_enter()

def action_exit():
    print(CLEAR, end=""); print_banner()
    print(f"  {dim('Stopping server...')}")
    stop_server()
    print(f"  {orange('Goodbye! 👋')}\n")
    sys.exit(0)

def _press_enter():
    print(f"\n  {dim('Press Enter to return to menu...')}", end="", flush=True)
    try: input()
    except: pass

# ─── Main ─────────────────────────────────────────────────────────────────────
MENU = [
    ("📂  Analyze a Project",  action_analyze_new),
    ("🕑  Recent Projects",    action_recent),
    ("🌐  Open Browser",       action_open_browser),
    ("-" * 35,                 None),
    ("❓  Help",               action_help),
    ("✖   Exit",               action_exit),
]

def main():
    if len(sys.argv) > 1:
        path = sys.argv[1]
        if Path(path).is_dir():
            print(CLEAR, end=""); print_banner()
            run_analysis_with_progress(str(Path(path).resolve()))
            _press_enter()
        else:
            print(red(f"Not a directory: {path}")); sys.exit(1)

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


