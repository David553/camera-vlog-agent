@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 启动摄像头 AI 剪辑 agent（默认录制 60 秒，可用 run.cmd --seconds 120 调整）
node --env-file=.env src/main.ts %*
echo.
pause