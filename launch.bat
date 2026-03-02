@echo off
chcp 65001 >nul
title BIOSVIZ Server

cd /d "%~dp0"

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.8+
    pause
    exit /b 1
)

:: Kill any existing process on port 7777
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":7777 "') do (
    taskkill /F /PID %%a >nul 2>&1
)

:: Open browser after 2 seconds (in background)
start /B cmd /C "timeout /t 2 /nobreak >nul && start chrome http://localhost:7777 2>nul"

echo.
echo  BIOSVIZ V2  -  http://localhost:7777
echo  Close this window to stop the server.
echo.

:: Run server (blocking - keeps window open)
python server.py
