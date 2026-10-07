@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo   Wallvia for Codex Desktop
echo ============================================================
echo.
echo Mirroring your current Wallpaper Engine wallpaper into Codex.
echo Extra options are passed through, for example:
echo     start-wallpaper.cmd --glass 85 --dim 30
echo     start-wallpaper.cmd --no-kill
echo.

node "src\cli.mjs" watch %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo [FAILED] exit code %RC%. Things to check:
  echo    * Node.js 22 or newer must be on PATH.
  echo    * Codex must be closed, or let this script close it.
  echo      Use --no-kill if you want to close Codex yourself first.
  echo    * Port busy? Try:  start-wallpaper.cmd --port 9334
  echo    * No Wallpaper Engine? Pin one image instead:
  echo         cd /d "%~dp0" ^&^& npm run image -- "C:\path\to\image.jpg"
) else (
  echo Keeper started - Codex will follow your Wallpaper Engine wallpaper.
  echo Stop it later with: stop-wallpaper.cmd
)

echo.
pause
