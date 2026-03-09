import importlib.util
import pathlib
import sys
import traceback

log = pathlib.Path(r'd:\Google\CodeViz\CodeViz\_debug_run_server.out')
try:
    p = pathlib.Path(r'd:\Google\CodeViz\CodeViz\server.py')
    spec = importlib.util.spec_from_file_location('cv_server', str(p))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    sys.argv = ['server.py', '7778']
    mod.main()
except BaseException:
    log.write_text(traceback.format_exc(), encoding='utf-8')
    raise
