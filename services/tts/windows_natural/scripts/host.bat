@echo off
setlocal EnableExtensions

set "HOST=%~1"
set "PORT=%~2"
if "%HOST%"=="" set "HOST=127.0.0.1"
if "%PORT%"=="" set "PORT=8016"

cd /d "%~dp0\.."
uv run python launcher.py --host %HOST% --port %PORT%
