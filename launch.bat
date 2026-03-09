@echo off
chcp 65001 >nul
title VIZCODE V4 - Universal Code Visualizer

cd /d "%~dp0"

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.8+
    pause
    exit /b 1
)

:: Launch interactive CLI
python vizcode.py
