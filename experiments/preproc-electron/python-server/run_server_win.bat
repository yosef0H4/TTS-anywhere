@echo off
setlocal

REM Run from script directory
cd /d "%~dp0"

set "VENV_DIR=.venv-win"
set "PYTHON_EXE=%VENV_DIR%\Scripts\python.exe"

REM Use a Windows-specific uv project environment to avoid Linux .venv conflicts
set "UV_PROJECT_ENVIRONMENT=%VENV_DIR%"

if not exist "%PYTHON_EXE%" (
  echo [setup] Creating Windows environment and syncing dependencies...
  uv sync
  if errorlevel 1 (
    echo [error] uv sync failed.
    exit /b 1
  )
) else (
  echo [setup] Using existing %VENV_DIR%.
)

echo [run] Starting preproc server on http://127.0.0.1:8091
uv run preproc-server serve --host 127.0.0.1 --port 8091
if errorlevel 1 (
  echo [error] Failed to start preproc server.
  exit /b 1
)

endlocal
