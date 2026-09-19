@echo off
REM One-shot launcher: installs deps if needed, builds the UI, starts the engine + API.
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo [setup] installing dependencies...
  call npm install || goto :err
)
if not exist dist\index.html (
  echo [setup] building web UI...
  call npm run build || goto :err
)
echo.
echo ============================================================
echo  Workflow engine running:
echo    API  : http://localhost:8787/api/health
echo    UI   : http://localhost:8787/
echo  Press Ctrl+C to stop.
echo ============================================================
node --import tsx src/server/main.ts
goto :eof
:err
echo startup failed.
exit /b 1
