@echo off
setlocal

set HOST=%~1
set PORT=%~2
set FEATURE_FLAGS=%~3
set DETECT_PROVIDER=%~4
set OCR_PROVIDER=%~5

if "%HOST%"=="" set HOST=127.0.0.1
if "%PORT%"=="" set PORT=8091
if "%DETECT_PROVIDER%"=="" set DETECT_PROVIDER=auto
if "%OCR_PROVIDER%"=="" set OCR_PROVIDER=auto

if "%FEATURE_FLAGS%"=="" (
  echo Missing feature flags.
  echo Expected something like: --enable-detect
  exit /b 1
)

cd /d "%~dp0\.."
py -3 launcher.py %FEATURE_FLAGS% --detect-provider %DETECT_PROVIDER% --ocr-provider %OCR_PROVIDER% --host %HOST% --port %PORT%
