@echo off
rem StoryForge for Windows: double-click, or run in a terminal. Anything after the name goes to the server (for example: StoryForge.cmd --library D:\Books).
rem Needs Node.js 22 or newer. The first run installs what StoryForge needs (npm ci) and builds the app; later runs go straight to the browser.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo StoryForge needs Node.js 22 or newer, and it was not found.
  echo Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node scripts\launch.mjs %*
if errorlevel 1 (
  echo.
  echo StoryForge stopped. The message above says why.
  pause
  exit /b 1
)
endlocal
