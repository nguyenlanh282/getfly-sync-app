@echo off
echo 🚀 Khởi động Getfly Sync...
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo ❌ Chua cai Node.js! Tai tai: https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo 📦 Dang cai dependencies...
  npm install
)

echo ✅ Mo trinh duyet: http://localhost:3000
start http://localhost:3000
node server.js
pause
