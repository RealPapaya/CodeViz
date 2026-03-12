---
name: add-api-endpoint
description: Add a new API endpoint to server.py. Use this skill whenever adding a new GET or POST route — including new data queries, file operations, or any HTTP handler in the VIZCODE local server.
---

# SKILL: Add API Endpoint to server.py

`server.py` uses Python's stdlib `http.server.BaseHTTPRequestHandler`. There's no framework — routing is done manually inside `do_GET` and `do_POST`.

## Anatomy of the Handler

```python
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        p = parsed.path          # e.g. '/my-endpoint'
        qs = parse_qs(parsed.query)  # query params as dict[str, list[str]]

        if p == '/my-endpoint':
            # handle it
            ...

        elif p == '/other':
            ...

        else:
            self.json_resp({'error': 'Not found'}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        p = parsed.path
        if p == '/my-post':
            length = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(length))
            ...
```

## Helper Methods (already on Handler)

```python
self.json_resp(data: dict, status: int = 200)  # sends JSON response
self.serve_disk(filename: str, mime: str)       # serves a file from SCRIPT_DIR
self.html_error(message: str)                   # sends plain HTML error page
```

## Step-by-Step: Adding a GET Endpoint

**1. Pick a path** — use kebab-case, e.g. `/my-data`

**2. Add the `elif` block inside `do_GET`** — always before the final `else` block:

```python
elif p == '/my-data':
    jid = qs.get('job', [''])[0]
    with JOBS_LOCK:
        job = JOBS.get(jid, {})
    if not job:
        self.json_resp({'error': 'Unknown job'}, 404)
        return
    # your logic here
    result = compute_something(job)
    self.json_resp(result)
```

**3. If the handler needs the job's graph data**, access it via:
```python
graph_data = job.get('data') or {}
nodes = graph_data.get('nodes', [])
```

**4. Access query params** with safe defaults:
```python
param = qs.get('param_name', ['default'])[0]
limit = int(qs.get('limit', ['50'])[0])
```

## Step-by-Step: Adding a POST Endpoint

```python
elif p == '/my-action':
    length = int(self.headers.get('Content-Length', 0))
    try:
        body = json.loads(self.rfile.read(length))
    except Exception:
        self.json_resp({'error': 'Invalid JSON'}, 400)
        return
    # validate required fields
    required_field = body.get('field', '').strip()
    if not required_field:
        self.json_resp({'error': 'Missing field'}, 400)
        return
    # do work
    self.json_resp({'ok': True, 'result': ...})
```

## Background Jobs

If your endpoint kicks off a long-running task:

```python
elif p == '/my-job':
    jid = str(uuid.uuid4())[:8]
    with JOBS_LOCK:
        JOBS[jid] = {'done': False, 'result': None, 'error': None}
    t = threading.Thread(target=_my_background_task, args=(jid,), daemon=True)
    t.start()
    self.json_resp({'job_id': jid})

def _my_background_task(jid: str):
    try:
        result = do_heavy_work()
        with JOBS_LOCK:
            JOBS[jid].update({'done': True, 'result': result})
    except Exception as e:
        with JOBS_LOCK:
            JOBS[jid].update({'done': True, 'error': str(e)})
```

## Rules

- **Always** acquire `JOBS_LOCK` when reading or writing `JOBS`
- **Never** do heavy work inside the handler itself — use threads for anything that might take > 100ms
- **Never** import third-party packages — stdlib only
- **Security**: If you accept file paths from the client, always validate they stay within the project root (path traversal check, see the `/file` endpoint for the pattern)
- Return consistent JSON shapes: on success `{'ok': True, ...}`, on error `{'error': 'message'}` with an appropriate HTTP status code

## After Adding

Test the endpoint manually:
```powershell
# GET
Invoke-WebRequest http://localhost:7777/my-data?job=abc123 | Select-Object -Expand Content

# POST
Invoke-WebRequest -Method POST -Uri http://localhost:7777/my-action `
  -ContentType 'application/json' -Body '{"field":"value"}' | Select-Object -Expand Content
```
