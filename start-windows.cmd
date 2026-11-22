@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js를 찾지 못했습니다.
  echo API 실행 도우미에는 Node.js 런타임이 필요합니다.
  echo 문서 추가와 로컬 예비 점검은 index.html을 직접 열어서 사용할 수 있습니다.
  pause
  exit /b 1
)
echo AI 심사팀장 큐리 v3.0.0 실행 도우미를 시작합니다.
echo 아래 주소를 브라우저에서 여세요: http://127.0.0.1:8765
echo.
node server.js
pause
