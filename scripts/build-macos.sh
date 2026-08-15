#!/usr/bin/env bash
# =============================================================================
# dswork 本地打包 macOS 脚本
#
# 用法:
#   ./scripts/build-macos.sh                 # 打包当前架构（Apple Silicon/Intel）
#   ./scripts/build-macos.sh 0.2.0           # 先同步版本号再打包（也支持 patch/minor/major）
#   ./scripts/build-macos.sh --both          # 同时打包 arm64 + x86_64（需联网补装 rust target）
#   ./scripts/build-macos.sh --no-dmg        # 跳过 DMG，只产 app bundle + updater 资产（.app.tar.gz/.sig）
#   ./scripts/build-macos.sh --commit        # 打包成功后 git commit 版本号改动
#   ./scripts/build-macos.sh --open          # 打包完成后在 Finder 中显示产物目录
#   ./scripts/build-macos.sh 0.2.0 --both --commit   # 参数可组合
#
# 签名: 自动使用 ~/.tauri/dswork.key（密码为空）为 updater 产物签名；
#       缺失时警告并继续（产物将无法用于自动更新）。
#
# 产物:
#   src-tauri/target/<arch>-apple-darwin/release/bundle/macos/dswork.app
#   src-tauri/target/<arch>-apple-darwin/release/bundle/dmg/dswork_<版本>_<架构>.dmg
#   src-tauri/target/<arch>-apple-darwin/release/bundle/macos/dswork.app.tar.gz + .sig（updater 用）
#
# 说明: 仅本地打包 + 可选 git commit，不做 push/打 tag，不产生 GitHub Release。
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "错误: 本脚本仅支持在 macOS 上本地打包" >&2
  exit 1
fi

BOTH=0
OPEN=0
COMMIT=0
NO_DMG=0
VERSION=""

for arg in "$@"; do
  case "$arg" in
    --both) BOTH=1 ;;
    --open) OPEN=1 ;;
    --commit) COMMIT=1 ;;
    --no-dmg) NO_DMG=1 ;;
    -h | --help | help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
    *) VERSION="$arg" ;;
  esac
done

if [[ -n "$VERSION" ]]; then
  echo "==> 同步版本号到 $VERSION"
  pnpm bump "$VERSION"
fi

# 签名密钥：存在则自动用于 updater 产物签名（密码为空）
SIGN_KEY="$HOME/.tauri/dswork.key"
if [[ -f "$SIGN_KEY" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$SIGN_KEY")"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
  echo "==> 使用 $SIGN_KEY 签名（updater 产物可自动更新）"
else
  echo "警告: 未找到 $SIGN_KEY，产物将无法用于自动更新" >&2
fi

HOST_ARCH="$(uname -m)" # arm64 或 x86_64
case "$HOST_ARCH" in
  arm64) HOST_TARGET="aarch64-apple-darwin" ;;
  x86_64) HOST_TARGET="x86_64-apple-darwin" ;;
  *)
    echo "错误: 不支持的架构 $HOST_ARCH" >&2
    exit 1
    ;;
esac

if [[ "$BOTH" == "1" ]]; then
  TARGETS=(aarch64-apple-darwin x86_64-apple-darwin)
else
  TARGETS=("$HOST_TARGET")
fi

# 确保目标已安装（缺失时自动联网补装）
rustup target add "${TARGETS[@]}"

BUNDLES="app,dmg"
if [[ "$NO_DMG" == "1" ]]; then
  BUNDLES="app"
  echo "==> 跳过 DMG（--no-dmg），仅产出 app bundle + updater 资产"
fi

echo "==> 开始本地打包: ${TARGETS[*]}（bundles: $BUNDLES）"
for target in "${TARGETS[@]}"; do
  echo "---- [$target] ----"
  pnpm tauri build --bundles "$BUNDLES" --target "$target"
done

echo ""
echo "✅ 打包完成，产物如下:"
for target in "${TARGETS[@]}"; do
  find "src-tauri/target/$target/release/bundle" \
    \( -type d -name "*.app" \) -o \( -type f -name "*.dmg" \) \
    -o \( -type f -name "*.tar.gz" \) -o \( -type f -name "*.sig" \) 2>/dev/null
done | grep -v '/rw\.' | sort

if [[ "$COMMIT" == "1" ]]; then
  NEW_VERSION="$(node -p "require('./package.json').version")"
  if [[ -z "$(git status --porcelain)" ]]; then
    echo "==> 工作区无改动，跳过 git commit"
  else
    echo "==> git commit: release v$NEW_VERSION"
    git add -A
    git commit -m "release v$NEW_VERSION"
  fi
fi

if [[ "$OPEN" == "1" ]]; then
  DMG_DIR="$(dirname "$(find src-tauri/target -type f -name '*.dmg' -not -name 'rw.*' | head -1)")"
  if [[ -n "$DMG_DIR" && -d "$DMG_DIR" ]]; then
    open "$DMG_DIR"
  fi
fi
