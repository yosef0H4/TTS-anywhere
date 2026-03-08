@echo off
setlocal

set HOST=%~1
set PORT=%~2
set FEATURE_FLAGS=%~3
set DETECT_DEVICE=%~4
set OCR_DEVICE=%~5

if "%HOST%"=="" set HOST=127.0.0.1
if "%PORT%"=="" set PORT=8093
if "%DETECT_DEVICE%"=="" set DETECT_DEVICE=auto
if "%OCR_DEVICE%"=="" set OCR_DEVICE=auto

if "%FEATURE_FLAGS%"=="" (
  echo Missing feature flags.
  echo Expected something like: --enable-detect
  exit /b 1
)

cd /d "%~dp0\.."
py -3 launcher.py %FEATURE_FLAGS% --detect-device %DETECT_DEVICE% --ocr-device %OCR_DEVICE% --host %HOST% --port %PORT%
