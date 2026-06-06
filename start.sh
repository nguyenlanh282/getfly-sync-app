#!/bin/bash
echo "🚀 Khởi động Getfly Sync..."
cd "$(dirname "$0")"

# Kiểm tra Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Chưa cài Node.js! Tải tại: https://nodejs.org"
  exit 1
fi

# Cài package nếu chưa có
if [ ! -d "node_modules" ]; then
  echo "📦 Đang cài dependencies..."
  npm install
fi

echo "✅ Mở trình duyệt: http://localhost:3000"
# Mở trình duyệt (Mac/Linux)
if command -v open &> /dev/null; then
  open http://localhost:3000
elif command -v xdg-open &> /dev/null; then
  xdg-open http://localhost:3000
fi

node server.js
