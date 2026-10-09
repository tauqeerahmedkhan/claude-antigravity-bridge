@echo off
setlocal
title Claude-Antigravity Agent Bridge - Install
cd /d "%~dp0"

if not exist "%~dp0setup.js" goto notextracted
if not exist "%~dp0server\dist\server.mjs" goto notextracted

call :findnode
if not defined NODE_OK (
  echo Node.js was not found. Installing Node.js LTS with winget...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs;%LOCALAPPDATA%\Programs\nodejs"
  call :findnode
)
if not defined NODE_OK goto nonode

node "%~dp0setup.js" %*
echo.
pause
exit /b

:findnode
set "NODE_OK="
where node >nul 2>nul && set "NODE_OK=1"
exit /b

:notextracted
echo.
echo  Please extract the zip first (right-click the zip ^> Extract All),
echo  then double-click Install.bat inside the extracted folder.
echo.
pause
exit /b 1

:nonode
echo.
echo  Could not install Node.js automatically.
echo  Install the LTS version from https://nodejs.org, then double-click Install.bat again.
echo.
pause
exit /b 1
