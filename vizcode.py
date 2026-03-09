#!/usr/bin/env python3
"""
vizcode.py — VIZCODE Interactive CLI Launcher
Zero pip dependencies — pure Python stdlib only.
Compatible: Python 3.8+, Windows cp950/UTF-8, Mac, Linux

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
SERVER_PY    = SCRIPT_DIR / "server.py"
HISTORY_FILE = SCRIPT_DIR / ".vizcode_history.json"
PORT         = 7777
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

def is_server_running() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
            return True
    except OSError:
        return False

def start_server():
    global _server_proc
    if is_server_running(): return
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"]       = "1"        # Python 3.7+ UTF-8 mode
    kwargs = dict(cwd=str(SCRIPT_DIR), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if IS_WIN: kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    _server_proc = subprocess.Popen([sys.executable, str(SERVER_PY)], **kwargs)
    for _ in range(50):
        if is_server_running(): return
        time.sleep(0.1)

def stop_server():
    global _server_proc
    if _server_proc:
        _server_proc.terminate()
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
    except Exception as e:
        print(red(f"\n  [!] Failed to start analysis: {e}\n"))
        return None

def poll_job(job_id: str) -> dict:
    try:
        with urllib.request.urlopen(f"{BASE_URL}/progress?job={job_id}", timeout=5) as r:
            return json.loads(r.read())
    except: return {}

def run_analysis_with_progress(path: str):
    print(CLEAR, end="")
    print_banner()
    print(f"  {cyan('▶')} Starting server...")
    start_server()
    print(f"  {cyan('▶')} Analyzing: {dim(path)}\n")

    job_id = trigger_analysis(path)
    if not job_id: return
    save_history(path)

    BAR = 30
    def _bar(pct):
        f = int(BAR * pct / 100)
        filled = orange("█" * f)
        empty  = dim("░" * (BAR - f))
        return f"[{filled}{empty}] {pct:>3}%"

    last_pct = -1
    while True:
        job  = poll_job(job_id)
        pct  = job.get("pct", 0)
        msg  = (job.get("msg") or "")[:50]
        if pct != last_pct:
            sys.stdout.write(f"\r  {_bar(pct)}  {dim(msg)}   ")
            sys.stdout.flush()
            last_pct = pct
        if job.get("done"):
            sys.stdout.write(f"\r  {_bar(100)}  {green('✓ Done!')}            \n")
            sys.stdout.flush()
            break
        if job.get("error"):
            print(red(f"\n  [!] {job['error']}"))
            return
        time.sleep(0.3)

    result_url = f"{BASE_URL}/result?job={job_id}"
    print(f"\n  {green('✓')} Opening browser...")
    print(f"  {dim(result_url)}\n")
    time.sleep(0.4)
    webbrowser.open(result_url)

# ─── Server badge ─────────────────────────────────────────────────────────────
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
