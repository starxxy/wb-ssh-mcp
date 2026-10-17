@echo off
rem Double-click entry point. The real launcher is start-ui.vbs, which starts
rem the server with no console window; this file only exists so that the habit
rem of double-clicking start-ui.cmd keeps working, and it closes itself at once.
rem For a window that stays open and shows the output, use start-ui-debug.cmd.
wscript.exe "%~dp0start-ui.vbs"
