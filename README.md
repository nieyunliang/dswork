# dswork

DeepSeek 驱动的桌面 AI 智能体（Tauri v2 + React 19 + Rust）。

dswork 是一个本地优先的 AI 工作台：在桌面端与 DeepSeek 模型对话，模型可调用文件系统、Shell、搜索等工具直接操作你的工作目录，支持会话级工作目录、技能（skills）、多步骤任务执行，并利用 DeepSeek 磁盘上下文缓存降低费用。

## 功能特性

- **DeepSeek 对话**：支持 `deepseek-v4-pro` / `deepseek-v4-flash`（默认 flash），流式输出、思考过程展示
- **Agent 工具调用**：`read_file` / `write_file` / `list_dir` / `run_shell` / `http_get` / `web_search` / `web_fetch` / `ask_user` / `file_search` / `grep` / `screenshot` / `read_pdf_or_image` / `load_skill`
- **会话工作目录（cwd）**：每个会话携带持久化的工作目录，工具相对路径按 cwd 解析，Shell 在 cwd 下执行
- **技能（Skills）**：从 `~/.dswork/skills/` 与共享的 `~/.agents/skills/` 扫描加载，模型可动态加载技能获得系统提示词与工具集
- **任务执行**：用户显式发起的多步骤任务——模型先规划步骤列表再逐步执行，可中断 / 重试 / 继续，持久化于 `~/.dswork/tasks.json`（详见 `docs/task-execution-module.md`）
- **上下文缓存**：利用 DeepSeek 64-token 粒度磁盘前缀缓存，请求前缀字节级稳定以命中低价缓存，界面展示缓存命中统计
- **多会话管理**：会话列表、自动标题、重命名、删除
- **自动更新**：GitHub Releases + tauri-plugin-updater，启动静默检查、每 4 小时复查、设置中手动检查
- **主题**：亮 / 暗双主题（CSS 变量驱动）

## 技术架构

- **前端（`src/`）**：React 19 + TypeScript strict + Vite；UI 基于自研 bui 设计系统（`src/components/bui/`，含 `tokens.css` 编译产物）与 `src/components/ui/` 基础组件
- **后端（`src-tauri/src/`）**：Rust + Tauri v2；所有外部 API 调用（DeepSeek）走 Rust 后端，API key 不进入渲染进程
- **IPC**：前端经 `invoke('command_name', ...)` 调用 Tauri commands；流式响应通过 Tauri events（`tauri::Emitter`）推送
- **数据存储**：`~/.dswork/`（会话、配置、技能、任务）；API key 仅存于本地配置文件
- **模型配置**：`src/hooks/useDeepSeekConfig.tsx` + `src-tauri/src/config.rs`（base_url / model / api_key，含连通性测试）

## 开发

```bash
pnpm dev          # 仅前端 Vite dev server（端口 1420）
pnpm tauri:dev    # 完整 Tauri 应用 + 热重载
pnpm build        # TypeScript 检查 + Vite 构建
pnpm preview      # 预览生产构建
pnpm tauri build  # 构建可分发的桌面应用
```

要求：Node ≥ 22，pnpm ≥ 10（`packageManager: pnpm@10.33.2`）。

## 本地打包 macOS

不发布到 GitHub，直接在本地打包 macOS 应用：

```bash
pnpm build:macos                # 打包当前架构（arm64/x86_64），产出 .app 与 .dmg
pnpm build:macos 0.2.0          # 先同步版本号（也支持 patch/minor/major）再打包
pnpm build:macos --both         # 同时打包 arm64 + x86_64
pnpm build:macos --open         # 打包完成后在 Finder 中显示产物目录
pnpm build:macos --commit       # 打包成功后 git commit 版本号改动
```

产物位于 `src-tauri/target/<arch>-apple-darwin/release/bundle/`（`macos/dswork.app` 与 `dmg/dswork_<版本>_<架构>.dmg`）。仅本地打包，不 push、不打 tag、不产生 GitHub Release。

## 项目结构

```
src/                  # React 前端
  components/bui/     # bui 设计系统组件 + tokens.css（编译产物，勿手改）
  components/message/ # 按角色分发的消息渲染器（registry）
  hooks/              # useChat / useSessions / useTasks / useSkills / useTheme / useUpdater ...
  modelOptions.ts     # DeepSeek 模型定义
  tools.ts            # 工具 schema 定义
src-tauri/src/        # Rust 后端
  lib.rs              # Tauri commands 注册与入口
  api.rs              # DeepSeek API 调用（流式）
  config.rs           # API key / 模型配置
  sessions.rs         # 会话与消息持久化
  tasks.rs            # 任务执行持久化
  skills.rs           # 技能扫描与加载
  tools.rs            # 工具执行（含路径解析）
scripts/              # build-macos.sh、bump-version.mjs 及开发自测脚本
docs/                 # 设计文档（见下）
```

## 文档

- `docs/agent-loop-extraction.md` — Agent 循环设计
- `docs/context-cache-architecture.md` / `docs/context-cache-acceptance.md` — 上下文缓存架构与验收
- `docs/context-cards-integration.md` — 上下文卡片
- `docs/task-execution-module.md` / `docs/task-module-acceptance.md` — 任务执行模块
- `docs/auto-update.md` — 自动更新与发布流程

## 推荐 IDE 配置

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
