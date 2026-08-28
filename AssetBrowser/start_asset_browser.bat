@echo off
setlocal

rem Launches the Asset Browser server on Windows.
rem
rem Installs dependencies on first run, warns (without blocking) if the F3D
rem CLI isn't available for server-side thumbnail generation, starts the
rem server, and opens it in your default browser once it's up.

cd /d "%~dp0"

if not defined PORT set PORT=4747
set URL=http://localhost:%PORT%

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found on PATH. Install it from https://nodejs.org and try again. 1>&2
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 (
    echo npm install failed. 1>&2
    pause
    exit /b 1
  )
)

set F3D_FOUND=
if defined F3D_BIN set F3D_FOUND=1
if not defined F3D_FOUND (
  where f3d >nul 2>nul
  if not errorlevel 1 set F3D_FOUND=1
)
if not defined F3D_FOUND (
  echo Warning: no 'f3d' executable found on PATH and F3D_BIN is not set. 1>&2
  echo          3D model thumbnails will fail to generate until F3D is installed ^(https://f3d.app^). 1>&2
  echo          Everything else - indexing, tagging, search, the in-browser 3D/image/audio previews - is unaffected. 1>&2
)

rem Give the server a moment to start listening before opening the tab.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%URL%'"

echo Starting Asset Browser at %URL% (Ctrl+C to stop)
node server.js
