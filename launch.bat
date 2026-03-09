@echo off
chcp 65001 >nul
title VIZCODE V4

cd /d "%~dp0"

python --version >nul 2>&1
if not errorlevel 1 goto check_passed

echo [ERROR] Python is not installed.
set /p INSTALL_PYTHON="Do you want to install Python 3.12 via winget now? (Y/N): "
if /i "%INSTALL_PYTHON%"=="Y" goto opt_yes
goto opt_no

:opt_yes
echo Installing Python 3.12...
winget install --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
echo =========================================
echo Installation complete! Please close and reopen this window, then run the script again.
echo =========================================
pause
exit /b 0

:opt_no
echo Python 3.6+ is required to run this program. Please install it manually.
pause
exit /b 1

:check_passed

set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

cls

python vizcode.py %*
