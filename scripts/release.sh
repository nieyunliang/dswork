#!/usr/bin/env bash
# =============================================================================
# dswork 一键发布脚本
#
# 用法:  ./scripts/release.sh <版本号|patch|minor|major>
#        pnpm release 0.2.0          （或 pnpm release patch）
#
# 流程:  同步版本号(pnpm bump) → 提交 → 推送 main → 打 tag v<版本> → 推送 tag
#        （推送 v* tag 触发 GitHub Actions 自动构建签名并发布 draft Release，
#          见 docs/auto-update.md）
#
# 前置:  1) 已配置远程 origin（git remote add origin https://github.com/nieyunliang/dswork.git）
#        2) 已配置 GitHub Secrets: TAURI_SIGNING_PRIVATE_KEY
#        3) 工作区无未提交改动（脚本会强制检查）
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "用法: $0 <版本号|patch|minor|major>" >&2
  echo "示例: $0 0.2.0 / $0 minor" >&2
  exit 1
fi

# 守卫 1: 远程仓库必须已配置
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "错误: 尚未配置远程 origin，请先执行:" >&2
  echo "  git remote add origin https://github.com/nieyunliang/dswork.git" >&2
  exit 1
fi

# 守卫 2: 工作区必须干净（防止把未提交改动混进 release 提交）
if [[ -n "$(git status --porcelain)" ]]; then
  echo "错误: 工作区有未提交的改动，请先提交或 stash:" >&2
  git status --short >&2
  exit 1
fi

OLD_VERSION="$(node -p "require('./package.json').version")"
echo "==> 版本号 $OLD_VERSION → $VERSION"
pnpm bump "$VERSION"
NEW_VERSION="$(node -p "require('./package.json').version")"

echo "==> 提交 release v$NEW_VERSION"
git add -A
git commit -m "release v$NEW_VERSION"

echo "==> 推送 main"
git push origin main

echo "==> 打 tag v$NEW_VERSION 并推送（触发 CI）"
git tag "v$NEW_VERSION"
git push origin "v$NEW_VERSION"

echo ""
echo "✅ 已触发发布: v$NEW_VERSION"
echo "   下一步: 等 CI 构建完成后，到 https://github.com/nieyunliang/dswork/releases"
echo "           检查各平台资产 → 编辑说明 → 点击 Publish release（用户端才会检测到更新）"
