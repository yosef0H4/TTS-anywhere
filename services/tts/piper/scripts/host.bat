@echo off
setlocal

set HOST=%1
set PORT=%2
if "%HOST%"=="" set HOST=127.0.0.1
if "%PORT%"=="" set PORT=8011

cd /d "%~dp0\.."
uv run tts-piper serve --host %HOST% --port %PORT%
