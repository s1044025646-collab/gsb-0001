@echo off
REM Dev mode: Vite dev server (port 5173) with /api proxy + backend (8787)
setlocal
cd /d "%~dp0"
start "wf-api" cmd /c "node --import tsx src/server/main.ts"
timeout /t 2 /nobreak >nul
call npm exec vite
