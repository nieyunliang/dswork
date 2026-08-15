# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## 本地打包 macOS

不发布到 GitHub，直接在本地打包 macOS 应用：

```bash
pnpm build:macos                # 打包当前架构（arm64/x86_64），产出 .app 与 .dmg
pnpm build:macos 0.2.0          # 先同步版本号（也支持 patch/minor/major）再打包
pnpm build:macos --both         # 同时打包 arm64 + x86_64
pnpm build:macos --open         # 打包完成后在 Finder 中显示产物目录
```

产物位于 `src-tauri/target/<arch>-apple-darwin/release/bundle/`（`macos/*.app` 与 `dmg/*.dmg`）。

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
