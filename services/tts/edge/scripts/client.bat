@echo off
setlocal

set TEXT=%1
set OUT=%2
set VOICE=%3

if "%TEXT%"=="" (
  echo Usage: client.bat "text" [out.mp3] [voice]
  exit /b 1
)

if "%OUT%"=="" set OUT=out.mp3

cd /d "%~dp0\.."
if "%VOICE%"=="" (
  uv run tts-edge synth --text %TEXT% --out %OUT%
) else (
  uv run tts-edge synth --text %TEXT% --out %OUT% --voice %VOICE%
)
