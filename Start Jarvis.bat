@echo off
rem Starts Jarvis (if it is not running already) and opens the page to talk to it.
cd /d "%~dp0"
netstat -ano | findstr ":5210 " | findstr LISTENING >nul || start "" /min wscript scripts\start-hidden.vbs
timeout /t 3 >nul
start "" msedge --new-window http://localhost:5210/voice?listen
