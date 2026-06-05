@echo off
:: ==========================================================================
::  DeepSeek Local API Server – Windows Launcher
::  Starts the Flask server that bridges the Chrome extension to DeepSeek.
::  Run this batch file once; keep the window open while using the extension.
:: ==========================================================================

title DeepSeek Local API Server

:: Change to the folder where this batch file resides (so local_api.py is found)
cd /d "%~dp0"

:: Check if local_api.py exists
if not exist "local_api.py" (
    echo ERROR: local_api.py not found in current folder!
    pause
    exit /b 1
)

:: Verify Python is available
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Python is not installed or not in PATH.
    echo Please install Python from python.org and check "Add Python to PATH".
    pause
    exit /b 1
)

:: Check if requirements.txt exists
if not exist "requirements.txt" (
    echo ERROR: requirements.txt not found!
    pause
    exit /b 1
)

:: Install/update required packages from requirements.txt (first time only)
echo Installing required packages from requirements.txt ^(first time only^)...
pip install -r requirements.txt >nul 2>nul

if %errorlevel% neq 0 (
    echo WARNING: Some packages may not have installed correctly.
    echo Please try running: pip install -r requirements.txt
    pause
)

python local_api.py

echo.
echo Server stopped.
pause