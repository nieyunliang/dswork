#!/bin/sh
# 真实 API 端到端任务测试（验收剩余项：真实模型规划/执行/收尾）
# 复用与前端相同的 taskLoop/agentLoop/taskPlan 代码 + 真实 DeepSeek API + 真实文件工具
# 依赖：~/.dswork/config.json 中已配置有效 API Key；网络可达 api.deepseek.com
# 用法：scripts/realtest/run.sh
set -e
cd "$(dirname "$0")/../.."
rm -rf scripts/agent-loop-smoke/out
npx tsc src/utils/agentLoop.ts src/utils/message.ts src/utils/taskPlan.ts src/utils/taskLoop.ts src/tools.ts \
  --outDir scripts/agent-loop-smoke/out \
  --module commonjs --target es2022 --skipLibCheck --jsx react-jsx
find scripts/agent-loop-smoke/out -name "*.js" -exec sh -c 'mv "$1" "${1%.js}.cjs"' _ {} \;
find scripts/agent-loop-smoke/out -name "*.cjs" -exec sed -i '' 's|require("\./\([A-Za-z0-9]*\)")|require("./\1.cjs")|g' {} \;
node scripts/realtest/run-real-task.mjs
