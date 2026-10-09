@echo off
title Agent Bridge - Uninstall
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js not found, so there is nothing to uninstall with. & pause & exit /b 1)
node "%~dp0setup.js" --uninstall %*
echo.
pause
