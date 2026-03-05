@echo off
setlocal

set TEXT=%1
set OUT=%2
set VOICE=%3

if "%TEXT%"=="" (
  echo Usage: client.bat "text" [out.wav] [voice]
  exit /b 1
)

if "%OUT%"=="" set OUT=out.wav

cd /d "%~dp0\.."
if "%VOICE%"=="" (
  uv run tts-kokoro synth --text %TEXT% --out %OUT%
) else (
  uv run tts-kokoro synth --text %TEXT% --out %OUT% --voice %VOICE%
)
