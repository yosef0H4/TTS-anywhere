@echo off
setlocal

set HOST=%1
set PORT=%2
if "%HOST%"=="" set HOST=127.0.0.1
if "%PORT%"=="" set PORT=8012

cd /d "%~dp0\.."
uv run tts-edge serve --host %HOST% --port %PORT%
