@echo off
setlocal
cd /d "%~dp0"
title wb-ssh connection manager (visible)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js, or edit this file to point at node.exe directly.
  pause
  exit /b 1
)

echo Starting the wb-ssh connection manager in VISIBLE mode...
echo Keep this window open. Press Ctrl+C here to stop the server.
echo Running this file twice is safe: the second one just reopens the page.
echo.
node ui.mjs --port 7812 --host 0.0.0.0

echo.
echo Done. Press any key to close this window.
pause >nul
