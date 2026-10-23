@echo off
rem Signs another Claude account in for Jarvis, so the TV shows its session limits too.
rem Its login is kept in its own folder (data\claude-accounts\<name>); your main login is not touched.
cd /d "%~dp0"
echo.
set /p NAME=Name to show on the TV for this account (for example Esmael): 
if "%NAME%"=="" exit /b
for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-ChildItem $env:USERPROFILE\.vscode\extensions -Directory -Filter anthropic.claude-code-* | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName"') do set EXT=%%i
set "CLAUDE_CONFIG_DIR=%~dp0data\claude-accounts\%NAME%"
echo.
echo A browser window opens. Sign in there with the OTHER Claude account.
"%EXT%\resources\native-binary\claude.exe" auth login --claudeai
echo.
echo Done. The TV shows "%NAME%" within 5 minutes.
pause
