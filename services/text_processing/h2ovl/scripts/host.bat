@echo off
setlocal

set HOST=%1
set PORT=%2
if "%HOST%"=="" set HOST=127.0.0.1
if "%PORT%"=="" set PORT=8095

cd /d "%~dp0\.."
py launcher.py --host %HOST% --port %PORT%
