@echo off
setlocal
cd /d "%~dp0"

echo Stopping the Codex wallpaper keeper...
node "src\cli.mjs" stop
echo.
echo Done. The wallpaper disappears from Codex on its next window reload;
echo restart Codex normally (without the debug port) to fully restore it.
echo.
pause
