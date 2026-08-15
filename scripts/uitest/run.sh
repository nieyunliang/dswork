#!/bin/sh
# 无头浏览器 UI 冒烟测试（验收 U1–U7 / C1/C5/C7 / 2.4 / B6 的可自动化部分）
# 依赖：系统 Chrome（/Applications/Google Chrome.app）+ Node 24
# 用法：scripts/uitest/run.sh
set -e
cd "$(dirname "$0")/../.."

# 若 vite dev 未在 1420 运行，则临时启动
VITE_UP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:1420/ 2>/dev/null || true)
VITE_PID=""
if [ "$VITE_UP" != "200" ]; then
  echo "启动 vite dev…"
  pnpm dev > /tmp/dswork-uitest-vite.log 2>&1 &
  VITE_PID=$!
  for i in $(seq 1 40); do
    sleep 0.5
    if [ "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:1420/ 2>/dev/null || true)" = "200" ]; then
      break
    fi
  done
fi

node scripts/uitest/run-uitest.mjs
STATUS=$?

if [ -n "$VITE_PID" ]; then
  kill "$VITE_PID" 2>/dev/null || true
fi
exit $STATUS
