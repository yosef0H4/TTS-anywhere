@echo off
setlocal EnableExtensions

set "HOST=%~1"
set "PORT=%~2"
if "%HOST%"=="" set "HOST=127.0.0.1"
if "%PORT%"=="" set "PORT=8011"

cd /d "%~dp0\.."

set "BUNDLED_UV=%LOCALAPPDATA%\Programs\TTS Anywhere\resources\bin\uv.exe"
set "UV_CMD="
set "UV_MODE=path"
if exist "%BUNDLED_UV%" (
  set "UV_CMD=%BUNDLED_UV%"
  set "UV_MODE=bundled"
) else (
  where uv >nul 2>nul
  if not errorlevel 1 (
    set "UV_CMD=uv"
    set "UV_MODE=global"
  )
)
if "%UV_CMD%"=="" (
  echo No uv installed. Install TTS Anywhere or add uv to PATH.
  exit /b 1
)

set "PYTHON_VERSION="
set /p PYTHON_VERSION=<.python-version
if "%PYTHON_VERSION%"=="" (
  echo Missing .python-version
  exit /b 1
)

set "UV_PROJECT_ENVIRONMENT=%CD%\.venv"
set "ENV_PYTHON=%UV_PROJECT_ENVIRONMENT%\Scripts\python.exe"
set "CREATE_ENV=0"
if not exist "%ENV_PYTHON%" set "CREATE_ENV=1"

if defined DRY_RUN (
  echo SERVICE=piper
  echo PYTHON_VERSION=%PYTHON_VERSION%
  echo BUNDLED_UV=%BUNDLED_UV%
  echo UV_CMD=%UV_CMD%
  echo UV_PROJECT_ENVIRONMENT=%UV_PROJECT_ENVIRONMENT%
  if "%CREATE_ENV%"=="1" (
    if "%UV_MODE%"=="global" (
      echo UV_VENV=uv venv "%UV_PROJECT_ENVIRONMENT%" --python %PYTHON_VERSION%
    ) else (
      echo UV_VENV="%UV_CMD%" venv "%UV_PROJECT_ENVIRONMENT%" --python %PYTHON_VERSION%
    )
  ) else (
    echo UV_VENV=skip
  )
  echo RUN="%UV_CMD%" run tts-piper serve --host %HOST% --port %PORT%
  exit /b 0
)

if "%CREATE_ENV%"=="1" (
  if "%UV_MODE%"=="global" (
    call uv venv "%UV_PROJECT_ENVIRONMENT%" --python %PYTHON_VERSION%
  ) else (
    call "%UV_CMD%" venv "%UV_PROJECT_ENVIRONMENT%" --python %PYTHON_VERSION%
  )
  if errorlevel 1 exit /b 1
)

if "%UV_MODE%"=="global" (
  call uv run tts-piper serve --host %HOST% --port %PORT%
) else (
  call "%UV_CMD%" run tts-piper serve --host %HOST% --port %PORT%
)
