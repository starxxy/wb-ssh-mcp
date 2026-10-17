@echo off
setlocal
title wb-ssh connection manager - stop

rem Normal path: the pid file ui.mjs writes once it is listening. Pass an
rem argument to point at a different one (WB_SSH_CONFIG moves where ui.pid sits).
set "PIDFILE=%USERPROFILE%\.workbuddy-ai\ssh\ui.pid"
if not "%~1"=="" set "PIDFILE=%~1"

set "PID="
if exist "%PIDFILE%" set /p PID=<"%PIDFILE%"
if not defined PID goto byport

rem Confirm the pid still belongs to node before killing it: Windows recycles
rem pids, and a stale file must never take down an unrelated program.
set "IMAGE="
for /f "tokens=1 delims=," %%n in ('tasklist /fi "PID eq %PID%" /nh /fo csv 2^>nul') do set "IMAGE=%%~n"
if /i not "%IMAGE%"=="node.exe" goto stale
goto kill

:byport
rem No usable pid file. That is normal for an instance started by the WMI
rem one-liner in DETAILS.md, or by a build older than the pid file itself --
rem both are hidden, so there is no window to press Ctrl+C in either. Fall
rem back to whoever listens on 7812, and still refuse to touch a non-node.
set "PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":7812 " ^| findstr "LISTENING"') do if not defined PID set "PID=%%p"
if not defined PID goto nothing

set "IMAGE="
for /f "tokens=1 delims=," %%n in ('tasklist /fi "PID eq %PID%" /nh /fo csv 2^>nul') do set "IMAGE=%%~n"
if /i not "%IMAGE%"=="node.exe" goto foreign

echo 端口 7812 由 node.exe（PID %PID%）占用，但它没有留下 PID 记录。
echo （多半是用 WMI 方式或更早的版本启动的 —— 同样没有窗口可以按 Ctrl+C。）
echo.
choice /c YN /m "结束这个进程吗"
if errorlevel 2 goto cancelled

:kill
taskkill /f /pid %PID% >nul 2>nul
if errorlevel 1 (
  echo 无法结束进程 %PID%，请打开任务管理器手动结束。
  pause
  exit /b 1
)
del "%PIDFILE%" >nul 2>nul
echo 已停止 wb-ssh 连接管理页面（PID %PID%）。
pause
exit /b 0

:stale
echo 记录中的进程 %PID% 已经不在运行了（现在占用这个 PID 的是 %IMAGE%）。
echo 已清理残留的 %PIDFILE%
del "%PIDFILE%" >nul 2>nul
pause
exit /b 0

:foreign
echo 端口 7812 被 %IMAGE%（PID %PID%）占用，不是本程序，不做处理。
pause
exit /b 1

:cancelled
echo 已取消。
pause
exit /b 0

:nothing
echo 端口 7812 上没有监听，服务没有在运行。
pause
exit /b 1
