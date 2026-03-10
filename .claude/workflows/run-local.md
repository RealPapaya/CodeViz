---
description: Start the VIZCODE local server and verify it's running correctly
---

# Run Local Server

1. Open a terminal in the project root (`d:\GOOGLE\CodeViz`)

2. Start the server:
```powershell
python vizcode.py
```
Or launch via the batch file (opens its own terminal window):
```powershell
.\launch.bat
```

3. Verify the server is up — wait for the banner and then check:
```powershell
Invoke-WebRequest http://localhost:7777 -UseBasicParsing | Select-Object StatusCode
# Expected: StatusCode 200
```

4. If port 7777 is already occupied:
```powershell
netstat -ano | findstr :7777
# Find the PID then:
taskkill /PID <PID> /F
```

5. Open the UI in Chrome:
```
http://localhost:7777
```

6. To stop the server, press `Ctrl+C` in the terminal running `vizcode.py`.

## Troubleshooting

- **`python` not found**: Use `py` or `python3` instead
- **Import errors on startup**: Make sure you're in the project root, not a subdirectory
- **Page loads but graph is blank**: Check browser DevTools Console for JS errors
