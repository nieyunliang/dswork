#!/bin/sh
# 上下文缓存命中 e2e（验收标准任务 2-C）
# 复用与前端相同的 agentLoop/buildSystemMessages 代码（编译产物）+ 真实 DeepSeek API。
# 场景 A：字节级前缀扩展断言（本地，无需 API key）
# 场景 B：真实 API 缓存命中（第二次请求 prompt_cache_hit_tokens > 0）
# 场景 C：工具调用多轮场景（第 2 步起每次 cacheReadTokens > 0）
# 依赖：~/.dswork/config.json 已配置有效 API Key（场景 B/C；无 key 时跳过并提示）
# 用法：scripts/cache-e2e/run.sh
set -e
cd "$(dirname "$0")/../.."
rm -rf scripts/agent-loop-smoke/out
npx tsc src/utils/agentLoop.ts src/utils/message.ts src/tools.ts \
  --outDir scripts/agent-loop-smoke/out \
  --module commonjs --target es2022 --skipLibCheck --jsx react-jsx
find scripts/agent-loop-smoke/out -name "*.js" -exec sh -c 'mv "$1" "${1%.js}.cjs"' _ {} \;
find scripts/agent-loop-smoke/out -name "*.cjs" -exec sed -i '' 's|require("\./\([A-Za-z0-9]*\)")|require("./\1.cjs")|g' {} \;
node scripts/cache-e2e/cache-e2e.mjs
