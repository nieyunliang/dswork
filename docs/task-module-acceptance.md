# 任务执行模块验收标准

> 对应方案：`task-execution-module.md`（任务执行模块）+ `agent-loop-extraction.md`（runAgentLoop 抽取）。
> 验收分两道门：**前置门**（循环抽取，聊天零回归）通过后，才能进入**功能门**（任务模块）。
> 每条标准均可独立判定（✅ 通过 / ❌ 不通过）；不通过项记录现象与复现路径后修复重测。

---

## 1. 前置门：runAgentLoop 抽取（聊天零回归）

### 1.1 构建门

- [ ] `tsc --noEmit` 无错误（严格模式，无未使用 import/变量）
- [ ] `pnpm build` 成功
- [ ] `src/utils/agentLoop.ts` 为纯函数模块：无 React/`invoke`/DOM 依赖，副作用全部走 `AgentLoopDeps` 回调
- [ ] `useChat.ts` 中主循环逻辑移除，仅剩会话编排 + 回调守卫（对照方案 §6 改造后形态）

### 1.2 行为回归（与改造前**逐字节一致**，逐项手动对照）

| # | 场景 | 验收点 |
|---|---|---|
| R1 | 普通问答（无工具调用） | 流式文本/推理展示、最终消息内容与改造前一致 |
| R2 | 多轮工具调用 | 每轮 assistant(tool_calls) + tool 消息完整、顺序一致，最终答复正常 |
| R3 | `/skill` 前缀 | 前缀剥离正确、skill 激活（activeSkillNames 更新）、激活后行为生效；无效 skill 保留原文发送 |
| R4 | 长上下文压缩 | 超过阈值（24 条 / 16000 字符）后触发摘要替换，会话内容可追溯，行为不异常 |
| R5 | 切换会话防串台 | 发送中切换会话：旧会话流式内容不再写入新视图，`sending`/`streaming` 状态正确复位 |
| R6 | API 错误提示 | 请求失败：追加"请求失败：…"用户可见消息并持久化，`lastError` 正确展示 |
| R7 | `load_skill` 拦截 | 循环内激活逻辑与原行为一致（激活成功/未找到/已激活/缺参四分支） |

### 1.3 错误清理修正（唯一有意的行为变更，专项验证）

- [ ] **场景 A**：一轮工具执行中请求失败 → 仅剥离**不完整** tool 组（末尾 assistant(tool_calls) 的工具响应不全时删除该组），历史其余部分保留
- [ ] **场景 B（原缺陷）**：请求失败发生在**轮次边界**（上一轮工具组已完整响应）→ 上一轮完整 tool 组**不得**被误删，上下文保留
- [ ] 清理后抛出的 `AgentLoopError` 携带清理后的 `messages`，聊天基于它追加错误消息并持久化

### 1.4 冒烟门（方案 §9 验证门 B）

- [ ] 写临时脚本/单测（不含 UI）：喂一个含 `read_file` 的目标，断言 `messages` 结构（assistant→tool 配对）与 `finalContent` 符合预期
- [ ] 聊天回归全绿后，`useChat.ts` 与 `agentLoop.ts` 的改动才允许进入任务模块开发

---

## 2. 功能门：任务执行模块

### 2.1 后端持久化（tasks.rs）

| # | 验收点 |
|---|---|
| B1 | 六条 IPC 命令齐全且签名正确：`create_task(goal, sessionId?)` / `list_tasks` / `get_task(id)` / `delete_task(id)` / `cancel_task(id)` / `update_task(id, task)`，已在 `lib.rs` 注册 |
| B2 | 数据落盘 `~/.dswork/tasks.json`，结构含迁移钩子（`StoredTasks { migrated, tasks }`） |
| B3 | 内存 `Mutex<HashMap>` 为权威副本：`get_task` 在任务执行中能读到最新状态（不读旧文件） |
| B4 | 并发正确：`TASKS_LOCK` 两阶段模式（无锁计算 → 持锁落盘），长步骤执行期间 `list_tasks`/`get_task` 不被阻塞 |
| B5 | `list_tasks` 按 `updated_at` 倒序返回 `TaskSummary`（含 stepCount/doneCount 进度字段） |
| B6 | `delete_task` 若任务在运行，先取消其循环再删除 |
| B7 | `cargo check` 通过；存储读写冒烟通过 |

### 2.2 启动恢复

- [ ] 模拟遗留 `running` 任务后重启应用 → 该任务自动变为 `failed`，error 标注"应用重启导致中断"
- [ ] `done`/`failed`/`cancelled` 状态任务重启后原样保留，进度数据不丢失

### 2.3 两阶段任务循环

| # | 验收点 |
|---|---|
| C1 | 发起任务 → 阶段 1 规划：TaskRows 一次列出**全部**步骤（`pending`），用户立刻看到完整路线图（编号徽章/第 N 步语义成立） |
| C2 | 阶段 2 逐步执行：每步状态流转 `pending → running → done`，步骤边界落盘（`update_task` 全量幂等写入） |
| C3 | 规划/收尾阶段仅使用只读工具子集（read_file/list_dir/grep/file_search/web_search/web_fetch/read_pdf_or_image），无写副作用 |
| C4 | 执行阶段使用全量工具集，且**不含 `ask_user`**；保留 `load_skill` |
| C5 | 全部步骤完成后：收尾轮生成 `result` 总结 → 任务 `status = done`，结果在抽屉展示 |
| C6 | 每步的 `toolCalls`（参数）与 `outputs`（截断后结果）正确归入对应 TaskStep，可在详情展开查看 |
| C7 | 单步失败：该步 `failed` 且 error 落盘，任务置 `failed`；**不**推翻已完成的其它步骤 |
| C8 | 规划 JSON 解析失败 → 退化单步模式：整个目标一次执行，工具调用归入唯一一步，任务仍可完成 |
| C9 | 上下文传递：后续步骤能看到前序步骤的 `label + plan + 工具调用摘要 + 关键输出摘要`（文件路径/目录树等关键产物不丢失） |

### 2.4 取消 / 重试

- [ ] 取消：执行中点击取消 → 任务置 `cancelled`，循环停在轮次边界（当前 in-flight 请求完成后停止，不硬中断）；已完成的步骤数据保留
- [ ] 取消后再发起新任务/切任务：旧循环不再写入当前视图（防串台，turnRef 机制）
- [ ] 重试：对失败步骤点重试 → 仅该步及其后重置为 `pending`，**跳过阶段 1** 直接从失败步重新执行
- [ ] 重试成功后：后续步骤继续执行，任务最终可 `done`；重试上下文由前序 done 步骤的 `label + plan + toolCalls + outputs` 重建（无内存历史时回退截断版 outputs，仍可用）

### 2.5 上限与防失控

- [ ] 步骤数超 `max_steps`（如 30）：规划阶段即受限，不产生超长步骤列表
- [ ] 单步轮数超 `maxRounds`：抛 `AgentLoopError("达到轮数上限")`，该步 `failed`、任务置 `failed`，不无限烧 token
- [ ] 单步超时生效，超时按失败处理
- [ ] 工具级失败不终止循环：模型收到 `错误: …` 后继续（仅当达到轮数/超时上限才终止）

### 2.6 UI（TaskDrawer + TaskRows 富详情）

| # | 验收点 |
|---|---|
| U1 | 入口可用：ChatHeader"任务"按钮（或消息"升级为任务"），点击打开展示当前任务列表 |
| U2 | 抽屉布局：左侧任务列表（标题 + 状态 + 时间，按更新时间排序），右侧当前任务 TaskRows 步骤视图 |
| U3 | TaskRows 富详情改造完成：`TaskDetail` 支持 `kind: text/json/code`，参数/输出以 pretty-print JSON / CodeBlock 渲染（可读，非单行 break-all），可展开/折叠 |
| U4 | 取消、重试按钮在对应状态可用且行为正确（未运行不可重试等） |
| U5 | `result` 总结区展示最终答复 |
| U6 | 任务标题自动生成（复用 `generate_title`），在步骤边界随 `update_task` 落盘，任务列表实时刷新 |
| U7 | 长任务列表/多步骤可滚动，UI 无布局破坏；深色/浅色主题均正常 |

### 2.7 异常路径

| # | 场景 | 预期 |
|---|---|---|
| E1 | 无 API Key 发起任务 | 明确错误提示，不崩溃、不留半死状态 |
| E2 | 空 goal / 非法输入 | 前端拦截或后端拒绝，任务不创建 |
| E3 | 规划 JSON 解析失败 | 退化单步模式（见 C8） |
| E4 | 单步失败 | 见 C7，可重试 |
| E5 | 循环超上限 | 见 2.5，标 failed 可重试 |
| E6 | 启动后 running→failed | 见 2.2 |
| E7 | 运行中删除任务 | 循环被取消，任务从列表消失，无残留写入 |
| E8 | 任务执行中 dev HMR/全量刷新 | 生产无此问题；dev 下允许任务被杀（已知限制，需在文档标注，不视为缺陷） |

### 2.8 性能与稳定性

- [ ] `run_shell` 异步化完成（`tools.rs` 改 `tokio::process::Command`）：任务中运行 `pnpm test` 等长命令期间，UI 不卡、其它 IPC 不被阻塞
- [ ] 长工具输出截断后落盘（`TaskStep.outputs` 无超大 JSON 撑爆文件），详情展示侧也有前端截断
- [ ] 任务运行中执行 `list_tasks`/`get_task`/`delete_task` 均即时响应

---

## 3. 明确不验收（范围外，方案 §13）

- 并发执行多个任务（同一时刻只跑一个——验收时不要求并行）
- 任务步骤的人工编辑（只读追溯 + 重试即可）
- 跨设备同步
- 跨应用重启的任务续跑（`running` 一律标记 `failed` 即符合标准）
- 任务内 `ask_user`（工具集裁剪即符合标准）
- 硬中断 in-flight 请求（轮次边界取消即符合 MVP 标准）

---

## 4. 验收操作指引（手动场景脚本）

### 前置门脚本

```
1. pnpm dev 启动 → 普通问答 3 轮（R1）
2. 触发含工具调用的请求：读文件/跑命令，观察多轮工具流转（R2）
3. 发送 "/技能名 内容" 激活技能（R3）
4. 长对话至压缩阈值，观察摘要生效（R4）
5. 发送中切换会话（R5）
6. 断网/错 Key 发请求，观察错误提示（R6）
7. 对照改造前 git 记录的截图/录屏比对输出
```

### 功能门脚本

```
1. 发起任务："重构这个项目"（含读文件/搜索/改文件/跑测试的多步骤目标）
2. 观察规划阶段：步骤全列 pending → 逐步流转 running → done
3. 中途点击取消 → 任务 cancelled，步骤数据保留
4. 构造会失败的步骤（如改不存在的文件）→ 该步 failed → 点重试 → 跳过规划直接重跑该步 → 后续步骤继续 → 任务 done
5. 故意让规划输出非法 JSON（可临时 mock）→ 单步模式兜底
6. 长命令步骤（pnpm test）运行中：UI 流畅、可同时 list_tasks
7. 重启应用：确认 running→failed 恢复逻辑与其它状态保留
8. 无 API Key、空 goal、运行中删除任务等异常路径走查（E1–E8）
```

---

## 5. 验证状态（截至实现轮 4）

### 自动化已验证 ✅（可复现命令）

| 验收项 | 验证方式 | 结果 |
|---|---|---|
| 1.1 构建门 | `npx tsc --noEmit` + `pnpm build` + `cargo check` + `cargo build` | ✅ |
| 1.3 错误清理修正（场景 A/B） | `scripts/agent-loop-smoke/run.sh`（smoke.cjs 测试 2/3） | ✅ |
| 1.4 冒烟门 | 同上（smoke.cjs 测试 1/4/5/6） | ✅ |
| B2/B7 存储读写与启动恢复 | `cargo test tasks`（storage_smoke_and_startup_recovery） | ✅ |
| C8 规划 JSON 退化单步 | smoke.cjs 测试 7 + taskLoop.smoke.cjs T2 | ✅ |
| C1/C2/C5/C6/C9 两阶段循环、上下文、聚合 | taskLoop.smoke.cjs T1 | ✅ |
| C3/C4 工具集切分（只读/全量去 ask_user） | taskLoop.smoke.cjs T1 | ✅ |
| C7/T3 单步失败 | taskLoop.smoke.cjs T3 | ✅ |
| 2.4 取消语义 | taskLoop.smoke.cjs T4（含已完步骤保留） | ✅ |
| 2.4 重试跳过规划 | taskLoop.smoke.cjs T5 | ✅ |
| 2.5 单步超时 / 轮数上限 | taskLoop.smoke.cjs T6/T7 | ✅ |
| 应用启动冒烟 | `pnpm tauri:dev` 进程稳定存活、vite 200 | ✅ |
| 2.8 run_shell 异步化 | cargo build + 代码审查（tokio::process） | ✅ |
| U1–U7 抽屉 UI 全流程 | `scripts/uitest/run.sh`（无头 Chrome + 模拟 Tauri IPC）：抽屉打开/步骤渲染/done+result/列表进度/自动标题/取消/失败重试/删除 | ✅ |
| R1–R6 聊天回归（代理） | 同上：R1 发送回复、R2 多轮工具（工具组渲染）、R3 /skill 前缀激活 chip、R4 压缩摘要系统消息、R5 发送中切会话防串台+后台持久化、R6 错误消息追加 | ✅ |
| E1 无 API Key 任务优雅失败 | 同上（场景 K：所有 LLM 请求报错 → 任务 failed + 明确错误提示，无半死状态） | ✅ |
| 全流程无 console.error | 同上（含 antd v6 Drawer `size` API 修正） | ✅ |
| **真实 DeepSeek API 端到端** | `scripts/realtest/run.sh`：与前端相同的 taskLoop/agentLoop 代码 + 真实模型（deepseek-v4-flash）+ 真实文件工具（scratch 目录隔离）：模型真实规划 5 步 → 真实 read_file/write_file/grep → b.txt 真实写入并验证 → done + result 总结 | ✅ |

### 修复记录（UI 测试发现）

- **useSessions 视图守卫过期闭包**（R5 暴露）：发送中切换会话后，旧回合结束时 `persistMessages` 用闭包里的旧 `currentSessionId` 判断，把旧会话消息写回新会话视图。改为 `currentSessionIdRef` 守卫（后端落盘不受影响）。
- **antd v6 Drawer**：`width`/`destroyOnClose` 已弃用 → `size`/`destroyOnHidden`。
- **taskLoop 日志分级**：规划/回合失败（AgentLoopError，如无 API Key）属预期路径 → `console.warn`；仅意外异常（代码缺陷类）→ `console.error`。

### 待手动 GUI 验证 ⏳（人工 QA 走查，逻辑均已自动化覆盖）

- 功能门手动场景脚本（§4 八步）的真机跑法：桌面运行 `pnpm tauri:dev`，按 §4 脚本逐项走查（聊天回归、任务全流程、取消、失败重试、重启恢复、异常路径）
- 多显示器/深色主题等环境性走查

---

## 6. 验收结论格式

每道门给出：**通过 / 不通过（附：不通过条目编号 + 现象 + 复现步骤）**。
两道门全部通过即本功能验收完成，标记对应 PR/里程碑为 done。
