#!/bin/sh
# 冒烟测试（验收标准 §1.3/§1.4 与 §2.3–2.5 的可自动化部分）
# 编译纯函数模块（无 React 依赖）后用 node 运行两套脚本：
#   smoke.cjs           — runAgentLoop（循环抽取）
#   taskLoop.smoke.cjs  — runTaskLoop（任务两阶段编排）
# （package.json 是 type:module，编译产物统一改 .cjs 供 require 使用）
set -e
cd "$(dirname "$0")/../.."
rm -rf scripts/agent-loop-smoke/out
npx tsc src/utils/agentLoop.ts src/utils/message.ts src/utils/taskPlan.ts src/utils/taskLoop.ts \
  --outDir scripts/agent-loop-smoke/out \
  --module commonjs --target es2022 --skipLibCheck --jsx react-jsx
find scripts/agent-loop-smoke/out -name "*.js" -exec sh -c 'mv "$1" "${1%.js}.cjs"' _ {} \;
# 编译产物内部的相对 require 为扩展名缺失形式（如 require("./message")），统一改写为 .cjs
find scripts/agent-loop-smoke/out -name "*.cjs" -exec sed -i '' 's|require("\./\([A-Za-z0-9]*\)")|require("./\1.cjs")|g' {} \;
node scripts/agent-loop-smoke/smoke.cjs
node scripts/agent-loop-smoke/taskLoop.smoke.cjs
