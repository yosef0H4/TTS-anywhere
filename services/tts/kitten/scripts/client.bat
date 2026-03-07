@echo off
setlocal

set TEXT=%1
set OUT=%2
set MODEL=%3
set VOICE=%4

if "%TEXT%"=="" (
  echo Usage: client.bat "text" [out.wav] [model] [voice]
  exit /b 1
)

if "%OUT%"=="" set OUT=out.wav
if "%MODEL%"=="" set MODEL=KittenML/kitten-tts-nano-0.8-fp32
if "%VOICE%"=="" set VOICE=Bella

cd /d "%~dp0\.."
uv run tts-kitten synth --text %TEXT% --out %OUT% --model %MODEL% --voice %VOICE%
