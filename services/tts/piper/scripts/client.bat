@echo off
setlocal

set MODEL=%1
set TEXT=%2
set OUT=%3

if "%TEXT%"=="" (
  echo Usage: client.bat [model] "text" [out.wav]
  exit /b 1
)

REM If only 1 arg, it's text, no model specified
if "%OUT%"=="" if "%MODEL%"=="" (
  set TEXT=%1
  set OUT=out.wav
  set MODEL=
) else if "%OUT%"=="" (
  REM If 2 args, could be model+text or text+out
  set OUT=out.wav
)

cd /d "%~dp0\.."
if "%MODEL%"=="" (
  uv run tts-piper synth --text %TEXT% --out %OUT%
) else (
  uv run tts-piper synth --model %MODEL% --text %TEXT% --out %OUT%
)
