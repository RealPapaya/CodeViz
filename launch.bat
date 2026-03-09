@echo off
chcp 65001 >nul
title VIZCODE V4 - Universal Code Visualizer

cd /d "%~dp0"

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.6+
    pause
    exit /b 1
)

:: Force UTF-8 for all Python subprocesses
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

:: Launch interactive CLI
python vizcode.py

