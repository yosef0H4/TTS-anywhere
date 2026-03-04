@echo off
setlocal

REM Rapid Text Processing (Windows)
REM - Creates/uses .venv-win
REM - Syncs dependencies
REM - Runs server on 127.0.0.1:8092

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

set "UV_PROJECT_ENVIRONMENT=.venv-win"

echo [rapid] Using UV_PROJECT_ENVIRONMENT=%UV_PROJECT_ENVIRONMENT%
where uv >nul 2>nul
if errorlevel 1 (
  echo [rapid] ERROR: 'uv' not found in PATH.
  echo [rapid] Install uv first: https://docs.astral.sh/uv/
  exit /b 1
)

echo [rapid] Syncing dependencies...
uv sync
if errorlevel 1 (
  echo [rapid] ERROR: uv sync failed.
  exit /b 1
)

echo [rapid] Starting server on http://127.0.0.1:8092 ...
uv run rapid-text-processing serve --host 127.0.0.1 --port 8092
set "EXIT_CODE=%ERRORLEVEL%"

echo [rapid] Server exited with code %EXIT_CODE%.
exit /b %EXIT_CODE%
