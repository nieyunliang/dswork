# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
pnpm dev          # Start Vite dev server on port 1420 (frontend only)
pnpm tauri:dev    # Start full Tauri app with hot reload

# Build
pnpm build        # TypeScript check + Vite bundle
pnpm tauri build  # Build distributable desktop app (script `tauri` is the bare CLI)

# Preview
pnpm preview      # Preview production frontend build
```

Use `pnpm` as the package manager (not npm/yarn).

## Architecture

This is a Tauri v2 desktop app: a React/TypeScript frontend communicating with a Rust backend via IPC.

**Frontend (`src/`)** — React 19 + the bui design system (no external UI library). Key files:
- `App.tsx` — root component, session/conversation state
- `types.ts` — shared TypeScript types
- `modelOptions.ts` — DeepSeek model definitions
- `components/bui/` — the component library: design-system components (SidebarNav, PromptBar, ToolChips, StreamingText, CodeBlock, ApprovalCard, …) + `tokens.css`, the compiled design-token stylesheet (CSS variables for both themes via the `.dark` class on `<html>`, plus all utility classes used by the components)
- `components/ui/` — bui-styled primitives (Button, TextInput, Select, Modal, Drawer, Tooltip, Dropdown, Steps, Alert, Tag, Text, Stack, Divider, Spinner, ToastProvider/useToast) with its own small `ui.css` supplement
- `components/message/` — per-role message renderers behind a registry (`register`/`getComponent`)
- `hooks/useDeepSeekConfig.ts` — API key and model config management

**Theming:** `hooks/useTheme.tsx` toggles the `dark` class on `<html>`; both themes are defined as CSS variables in `components/bui/tokens.css`. Do not hardcode colors — use the CSS variables (`var(--surface)`, `var(--ink)`, …) or the tokens.css utility classes.

**Backend (`src-tauri/src/`)** — Rust with Tauri v2.
- `lib.rs` — Tauri commands (IPC handlers), HTTP calls to DeepSeek API via `reqwest`, file-system storage for config
- `main.rs` — app entry point

**IPC pattern:** Frontend calls Tauri commands with `invoke('command_name', { ...args })`. All external API calls (DeepSeek) go through the Rust backend to keep the API key off the renderer process.

**Streaming:** DeepSeek responses are streamed from Rust to the frontend via Tauri events (`tauri::Emitter`).

**Working directory (cwd):** Each session carries a persisted working directory (default `~`, selectable in the chat header via `update_session_cwd`, browsed with `tauri-plugin-dialog`). The frontend pins the session cwd at turn start and passes it with every tool call (`ExecuteToolInput.cwd`) and as a trailing system message (`AgentLoopDeps.cwd`). Backend tools resolve relative paths against it (`resolve_path` in `tools.rs`) and `run_shell` sets `current_dir`. Tasks inherit the cwd of their source session (`TaskRun.cwd`, resolved in `create_task`).

## Key Constraints

- TypeScript strict mode is on (`noUnusedLocals`, `noUnusedParameters`) — unused imports will fail the build.
- `tokens.css` is a compiled artifact: it only contains classes used by the bui component sources. New utility classes belong in `components/ui/ui.css` (or inline styles), not in tokens.css.
- Vite dev server is hardcoded to port 1420; Tauri expects this port in `tauri.conf.json`.
- The project targets DeepSeek models (including R1 reasoning/think tokens); model IDs live in `src/modelOptions.ts`.
