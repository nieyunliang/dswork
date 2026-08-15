#!/usr/bin/env bash
# =============================================================================
# dswork 本地打包 macOS 脚本（不发布到 GitHub，仅在本地构建产物）
#
# 用法:
#   ./scripts/build-macos.sh                 # 打包当前架构（Apple Silicon/Intel）
#   ./scripts/build-macos.sh 0.2.0           # 先同步版本号再打包（也支持 patch/minor/major）
#   ./scripts/build-macos.sh --both          # 同时打包 arm64 + x86_64（需联网补装 rust target）
#   ./scripts/build-macos.sh --open          # 打包完成后在 Finder 中显示产物目录
#   ./scripts/build-macos.sh patch --open    # 参数可组合
#
# 产物:
#   src-tauri/target/<arch>-apple-darwin/release/bundle/macos/dswork.app
#   src-tauri/target/<arch>-apple-darwin/release/bundle/dmg/dswork_<版本>_<架构>.dmg
#
# 说明: 仅本地打包，不做 git 提交/推送，不产生任何 GitHub Release/更新清单。
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "错误: 本脚本仅支持在 macOS 上本地打包" >&2
  exit 1
fi

BOTH=0
OPEN=0
VERSION=""

for arg in "$@"; do
  case "$arg" in
    --both) BOTH=1 ;;
    --open) OPEN=1 ;;
    -h | --help | help)
      sed -n '2,16p' "$0"
      exit 0
      ;;
    *) VERSION="$arg" ;;
  esac
done

if [[ -n "$VERSION" ]]; then
  echo "==> 同步版本号到 $VERSION"
  pnpm bump "$VERSION"
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

echo "==> 开始本地打包: ${TARGETS[*]}（bundles: app, dmg）"
for target in "${TARGETS[@]}"; do
  echo "---- [$target] ----"
  pnpm tauri build --bundles app,dmg --target "$target"
done

echo ""
echo "✅ 打包完成，产物如下:"
for target in "${TARGETS[@]}"; do
  find "src-tauri/target/$target/release/bundle" \
    \( -type d -name "*.app" \) -o \( -type f -name "*.dmg" \) 2>/dev/null
done | grep -v '/rw\.' | sort

if [[ "$OPEN" == "1" ]]; then
  DMG_DIR="$(dirname "$(find src-tauri/target -type f -name '*.dmg' -not -name 'rw.*' | head -1)")"
  if [[ -n "$DMG_DIR" && -d "$DMG_DIR" ]]; then
    open "$DMG_DIR"
  fi
fi
