@echo off
chcp 65001 >nul
title B站收藏夹音乐播放器
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没找到 Node.js。请先安装：https://nodejs.org
  echo.
  pause
  exit /b 1
)

node server.js

echo.
echo   播放器已停止。
pause
