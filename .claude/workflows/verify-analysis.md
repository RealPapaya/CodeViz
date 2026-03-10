---
description: Run the analyzer on testproject/ to validate that analysis output is correct after code changes
---

# Verify Analysis Output

Use `testproject/` as a smoke-test target — it's small, multilingual, and exercises all node/edge types.

1. Make sure the server is running (see `run-local` workflow)

2. Open the UI at `http://localhost:7777`

3. In the path input box, enter the full path to testproject:
```
d:\GOOGLE\CodeViz\testproject
```
Then click **Analyze**.

4. Watch the progress bar complete. When done, verify:
   - [ ] Graph renders with at least some nodes and edges
   - [ ] No error toast in the UI
   - [ ] The project type badge shows the correct language (Python, JS, etc.)
   - [ ] Node colors match the expected file types

5. **CLI/headless verification** — query the API directly after triggering analysis via UI:
```powershell
# Get list of jobs (grab the job_id from here)
Invoke-WebRequest http://localhost:7777/jobs | Select-Object -Expand Content

# Check a specific job's progress
$jid = "abc12345"   # replace with real job id
Invoke-WebRequest "http://localhost:7777/progress?job=$jid" | Select-Object -Expand Content
```

6. **Validate JSON structure** — the result must have all required top-level keys:
```powershell
$result = Invoke-WebRequest "http://localhost:7777/result?job=$jid" | Select-Object -Expand Content
# Pipe through python for quick key check:
echo $result | python -c "import json,sys; d=json.load(sys.stdin); print(list(d.keys()))"
# Expected keys: ['nodes', 'edges', 'modules', 'stats', 'functions', ...]
```

7. **Expected testproject stats** (approximate):
   - Modules: ≥ 1
   - Files/Nodes: depends on testproject content
   - Edges: > 0
   - No `error` field in the `/progress` response

## What to Check After Specific Changes

| Changed File | What to Verify |
|-------------|---------------|
| `analyze_viz.py` | Correct node/edge count, no Python exceptions in terminal |
| `parsers/*.py` | Nodes from that language appear, edges are resolved |
| `server.py` | All endpoints return valid HTTP 200 |
| `static/viz.js` | Graph renders, interaction works (click, zoom, filter) |
| `detector.py` | Project type badge is correct |
