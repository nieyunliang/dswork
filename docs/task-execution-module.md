# 任务执行模块规划

> 状态：**已实现**（2025-08，实现轮 1-6；验收状态见 `task-module-acceptance.md` §5）
> 背景：`src/components/bui/TaskRows.tsx` 是 bui 设计系统的通用"任务列表"展示组件（数据驱动化已完成），
> 当前无真实用途。本模块为其提供恰当的落点：一个**用户显式发起、可跟踪、可持续**的多步骤任务执行模块。

## 1. 定位

任务与聊天内的即时工具调用是两回事：

| 维度 | 聊天工具调用（现状） | 任务执行（本模块） |
|---|---|---|
| 发起者 | 模型在对话中自主调用 | 用户显式发起（或从聊天"升级"） |
| 粒度 | 单次工具调用，随聊天流持久化 | 一个目标 → 先**规划**出步骤列表 → 逐步执行 |
| 状态 | pending / done / error，随流更新 | 任务级 + 步骤级状态机，可中断/重试/继续 |
| 展示 | ToolGroup / ThinkingState Steps | **TaskRows**（序号徽章、完成/失败 pill、可展开参数与输出） |
| 生命周期 | 随会话 | 独立于会话，持久化于 `~/.dswork/tasks.json` |

典型用例："重构这个项目"——模型先规划（梳理结构 → 改 A 文件 → 跑测试），
每步一个 TaskRow，用户随时能看到哪步在跑、哪步失败、失败时看参数/输出并可重试。

## 2. 关键决策

### 2.1 执行引擎位置：前端共享循环（而非后端独立引擎）

聊天真正的 agent 循环已经在前端 `src/hooks/useChat.ts` 里打磨过了：
长上下文压缩（`maybeCompact`）、`load_skill` 动态技能激活与工具白名单计算、错误恢复
（剥离残缺 tool 消息）、自动命名。如果任务引擎放在 Rust 后端，这些逻辑要**整份重写**，双端维护两套循环。

因此本模块采用：**抽取共享 agent 循环 + 前端驱动 + 后端只做持久化**。

| 维度 | 后端独立循环（旧方案） | 前端共享循环（本方案） |
|---|---|---|
| 代码复用 | 在 Rust 重写整个循环 + skill/压缩逻辑 | 抽取 `runAgentLoop` 后聊天/任务共用 |
| 工具执行 | 进程内直接调用 registry | 每次工具调用走一次 IPC（现状 chat 已验证可行） |
| 取消 | 能真正中断 in-flight 的 reqwest 流 | 只能"当前轮完成后停"（MVP 可接受） |
| dev 下前端 HMR/刷新 | 不受影响 | 全量刷新会杀任务（生产无此问题） |
| 迭代速度 | 每改一处要 `cargo build` | TS HMR |

> **回退条件**：若后续需要"应用重启后继续运行"或"硬中断 in-flight 请求"，再回到后端循环；
> 届时先抽取 `api.rs` 的 SSE 解析为公共函数复用。详见 §12 备选方案。

### 2.2 步骤模型：先规划后执行（两阶段）

- **阶段 1 规划**：一次 LLM 请求，要求输出编号步骤列表（JSON，如 `[{label, description}]`），
  全部步骤以 `pending` 写入 TaskRows——用户立刻看到完整路线图。
- **阶段 2 执行**：逐步执行，每步一次 LLM 轮 + 工具调用，步骤结束时更新状态。
- **兜底**：JSON 解析失败时退化为**单步模式**（整个目标一次性执行，工具调用归入这唯一一步）。

好处：TaskRows 的序号徽章/"第 N 步"语义成立；`retry_step` 有明确语义（只重跑失败步，后续重置）；
失败不会推翻整个计划。代价只是一次额外 LLM 往返。

## 3. 数据模型

```ts
// 前端 src/types.ts 与后端 tasks.rs 各一份（沿用现有 ChatMessage 的双端镜像模式）
interface TaskRun {
  id: string;                    // crate::generate_id()
  title: string;                 // 临时标题 + LLM 生成（复用 auto_title 模式）
  goal: string;                  // 任务目标，发给 LLM 的指令
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  steps: TaskStep[];
  result?: string;               // 全部步骤完成后的总结性答复（抽屉里展示）
  sessionId?: string;            // 可选：关联的聊天会话
  createdAt: number;
  updatedAt: number;
}

interface TaskStep {
  id: string;
  label: string;                 // TaskRows 的 label（如 "读取项目结构"）
  plan: string;                  // 模型对该步的规划说明（TaskRows details）
  status: "pending" | "running" | "done" | "failed";
  toolCalls: ToolCall[];         // 该步发起的工具调用（参数，TaskRows details）
  outputs: string[];             // 工具执行结果（**截断后**，TaskRows details）
  error?: string;
}

interface TaskSummary {          // list_tasks 的返回项（左侧任务列表用）
  id: string;
  title: string;
  status: TaskRun["status"];
  stepCount: number;             // steps.length
  doneCount: number;             // status === "done" 的步骤数（进度展示）
  createdAt: number;
  updatedAt: number;
}
```

- 步骤为**有序扁平列表**，顺序执行，无并行依赖（`dependsOn` 之类本期不做）。
- 注意"双份内容"：`TaskStep.outputs` 存**截断版**（用于展示与持久化）；
  循环内存中另维护 `Vec<ChatMessage>` 完整历史（含完整工具输出），供下一轮 LLM 决策。

### TaskRows 富详情改造（前置）

`TaskRows.tsx:15` 现状是 `type TaskDetail = { label: string; meta: string }`，
而步骤详情里的 `toolCalls`/`outputs` 是数组/结构化内容，不能直接塞进单行 string。改造为：

```ts
export type TaskDetail = {
  label: string;
  kind: "text" | "json" | "code"; // json 用 pretty-print，code 走 CodeBlock
  content: string;
  language?: string;              // kind === "code" 时用
};
```

参数/输出由前端 `JSON.stringify(_, null, 2)` 后以 `json`/`code` 渲染（复用 `components/bui/CodeBlock.tsx`），
而非塞进单行 `break-all`（长 JSON 单行不可读）。

## 4. 后端设计（src-tauri/src/tasks.rs — 仅持久化）

### 4.1 存储

- 文件：`~/.dswork/tasks.json`（复用 `crate::dswork_dir()`、`crate::generate_id()`）
- **内存权威副本**：`Mutex<HashMap<String, TaskRun>>` 作为权威状态。
  理由：任务有两个写者（后台循环 + cancel/delete 命令），sessions.rs 的"每命令读改写整个文件"模式
  会让循环执行中的 `get_task` 读到旧文件；内存副本更简单正确。
- **落盘节流归前端**：前端在**步骤边界**才调 `update_task`（幂等全量替换，提交完整 TaskRun）；后端收到即更新内存并写盘，
  不做后端 debounce（节流只在调用侧，避免两端各做一遍）。
- 并发：所有落盘用 `TASKS_LOCK: Mutex<()>`；沿用 `auto_title_session` 的**两阶段模式**（无锁计算 → 持锁落盘），
  避免 `list_tasks`/`get_task` 在长步骤执行期间被阻塞。
- 结构：`StoredTasks { migrated: bool, tasks: Vec<StoredTask> }`，含迁移钩子（同 sessions.rs 模式）。
- **启动恢复**：加载时把遗留的 `status: "running"` 任务重置为 `failed`，`error` 标注"应用重启导致中断"。
  （真正的跨重启 resume 需要完整对话历史落盘，本期不做，见 §12。）

### 4.2 IPC 命令

```
create_task(goal, sessionId?) -> TaskRun     // 创建并落盘，返回后由前端启动循环
list_tasks() -> TaskSummary[]                 // 按 updated_at 倒序
get_task(id) -> TaskRun
delete_task(id)                               // 删除前若在运行，先取消其循环
cancel_task(id)                               // 置 cancelled（前端据此停止循环）
update_task(id, task)                        // 循环推进时的全量写入（幂等，提交完整 TaskRun）
```

> 标题复用 `api::generate_title`，生成成功后在步骤边界随 `update_task` 一起落盘。

## 5. 执行引擎（前端共享循环）

### 5.1 抽取 runAgentLoop

把 `useChat.ts` 的 `send()` 核心抽成共享纯函数 `runAgentLoop(history, deps)`，放 `src/utils/agentLoop.ts`。
**完整签名与实现见 `agent-loop-extraction.md` §4/§5**（此处不再重复伪签名，避免两文档签名漂移）。

关键注入点：`deps.complete`（= `sendChatCompletion` 的 SSE 消费）、`deps.executeTool`、
`deps.getSkill`（`load_skill` 拦截）、`deps.baseSystemPrompt`（聊天/任务各传各的引导）、
`deps.maxRounds`（任务轮数上限）、`deps.onToolResult`（任务填充 TaskStep.outputs）、
`deps.onToolCalls`（步骤边界）、`deps.shouldStop`（取消）、`deps.compact`（压缩）。

内部复用 `useDeepSeekConfig.sendChatCompletion` 的 SSE 消费、`execute_tool`、`load_skill` 拦截、
`maybeCompact` 与错误恢复（剥离残缺 tool 消息）。聊天与任务作为两个消费端。

### 5.2 任务循环：两阶段

```
createTask(goal)
  → invoke("create_task") 得到 TaskRun（steps 为空）
  → 阶段 1 规划：runAgentLoop(planPrompt + 只读工具) 输出步骤 JSON → 解析 → 落盘 steps（全 pending）
  → 阶段 2 执行：for step of steps：
       status = running（落盘 + 前端状态）
       runAgentLoop({ goal + 已完成步骤的 plan/outputs 摘要 + 本步 label }，全量工具)
       每轮工具调用 → toolCalls/outputs 归入当前步（节流落盘）
       步成功 → done；步失败 → failed（error 落盘），任务置 failed
  → 收尾：runAgentLoop(总结 prompt + 只读工具) 生成 result
  → 全部完成：status = done + result = 最终答复（落盘 + 前端收尾）
```

- 工具集：`TOOLS` 去除 `ask_user`（任务在后台时用户未必在看抽屉，oneshot 会卡死循环），保留 `load_skill`。
- 规划/收尾阶段用**只读工具子集**（read_file/list_dir/grep/file_search/web_search/web_fetch/read_pdf_or_image），
  避免规划阶段产生写副作用（探查结果只影响规划结论，不落任务步骤）；执行阶段用全量（仍无 ask_user）。
- 上限：`max_steps`（如 30）+ 每步 `maxRounds`（复用 `deps.maxRounds`）+ 单步超时，防止后台无限烧 token。
  工具级失败本就不终止循环（模型收到 `错误:` 继续），无需单独"连续失败次数"上限。

### 5.3 取消 / 重试

- 取消：`shouldStop` 标志由 `useTasks.cancelTask` 置位；循环只在**轮次边界**检查（当前 in-flight 请求无法硬中断，MVP 接受）。
- 重试：`retry_step(taskId, stepId)` 把该步及其后重置为 `pending`，调用 `resumeTask(task, stepIndex)`
  **跳过阶段 1**，从失败步重新进入阶段 2；上下文由前序 done 步骤的 `label + plan + toolCalls + outputs` 重建。
  useTasks 需在内存保留每步完整 `messages`（`Map<stepId, ChatMessage[]>`）供重试用；未保留（如重启后）则回退截断版 outputs 重建。

## 6. 前端设计

### 6.1 状态层

- `src/hooks/useTasks.tsx`：`TasksProvider`，提供 `tasks / currentTask / createTask / cancelTask / retryStep / refresh`。
- 任务循环直接驱动 React 状态（前端驱动，无需后端事件推送）；`update_task` 只负责持久化。
- 防串台：沿用 useChat 的 `turnRef` 思路（切任务/新任务后旧循环不再写当前视图）。

### 6.2 UI 落点（推荐：任务抽屉，MVP）

- 入口：ChatHeader 增加"任务"按钮（或聊天消息右上"升级为任务"）。
- 形态：`TaskDrawer`（参照 SettingsDrawer 的 Drawer 模式），左侧任务列表（标题 + 状态 + 时间），
  右侧当前任务的 **TaskRows** 步骤视图 + 取消/重试按钮 + `result` 总结区。
- 后续可选：侧边栏"任务"分区（SidebarNav 已支持 sections）、任务详情页。

### 6.3 TaskRows 接入

- `TaskDrawer` 内 `<TaskRows variant="List" tasks={stepRows} label={...} working={...} doneLabel="完成" failedLabel="失败" />`。
- 步骤数多时天然可滚动；展开看规划/参数/输出（富详情走 CodeBlock，长内容前端截断）。

## 7. 执行流程（时序）

```
用户: 输入 goal → 点击"发起任务"
  → invoke("create_task") → 后端落盘空 TaskRun 并返回
  → 阶段 1 规划：runAgentLoop 产出步骤列表 → update_task(steps)
  → 阶段 2：逐步执行（每步 running → done / failed，节流 update_task）
  → 全部完成 update_task(status=done, result) 或 用户 cancel_task / 步骤失败
前端: useTasks 持有循环状态 → 更新 TaskRows 行状态 → 标题/任务列表同步刷新
```

## 8. 与现有架构的接缝

| 需求 | 复用点 |
|---|---|
| ID / 数据目录 / 存储 | `dswork_dir()`、`generate_id()`、sessions.rs 的两阶段锁模式 |
| LLM 流式 + 工具循环 | useChat 的 `send()`（抽取为 `runAgentLoop`，见 `agent-loop-extraction.md`）、`api::generate_title`（任务命名） |
| 工具执行 | `tools.rs` 注册表 + 前端 `src/tools.ts` 的 `TOOLS`（裁剪 ask_user） |
| 前端状态/防串台 | useSessions 的 Provider 模式、useChat 的 turnRef 模式 |
| 富文本展示 | `components/bui/CodeBlock.tsx`（TaskRows 富详情） |

## 9. 前置改造（依赖本模块的前提）

1. **TaskRows 富详情**：`TaskDetail` 增加 `kind`，参数/输出走 CodeBlock（§3）。
2. **抽取 runAgentLoop**：按 `agent-loop-extraction.md` 从 `useChat.ts` 抽出共享循环，聊天行为不变（仅错误清理一处修正，见其 §6），回归验证后再接任务。
3. **`run_shell` 异步化**（`tools.rs:200`）：`std::process::Command::output()` 会同步阻塞 tokio worker；
   任务场景常跑 `pnpm test` 这类长命令，改为 `tokio::process::Command` 并支持 kill（供未来硬取消）。

## 10. 实施步骤（增量，每步可交付）

1. **前置**：TaskRows 富详情 + 抽取 runAgentLoop（聊天行为不变）+ run_shell 异步化
2. **后端骨架**：tasks.rs 数据模型 + CRUD + 内存权威副本 + 节流落盘 + 启动恢复（含 `lib.rs` 注册）
3. **任务循环**：useTasks 驱动两阶段循环（规划 → 逐步执行 + 取消/重试/上限）
4. **UI**：TaskDrawer + TaskRows 接入 + 发起/取消/重试交互
5. **打磨**：失败重试、任务命名、从聊天升级入口、（可选）侧边栏分区

## 11. 验证

- 后端：`cargo check` + 存储读写/启动恢复冒烟；前端：`tsc --noEmit` + `pnpm build`
- 手动：发起一个多步骤任务 → 观察规划阶段步骤全列 → 逐步流转（pending→running→done）→ 中途取消 → 失败后重试
- 异常路径：无 API Key、规划 JSON 解析失败（退化单步）、单步失败、循环超上限、启动后 running→failed

## 12. 备选方案（后端执行引擎）

若后续需要"应用重启后继续运行"或"硬中断 in-flight 请求"，回退到 Rust 后端循环。届时：

- 先抽取 `api.rs` 的 SSE 解析为公共函数（`stream_chat_completion() -> {content, tool_calls}`），聊天命令与任务循环共用；
- 任务循环持 `tokio_util::sync::CancellationToken`（新增依赖），reqwest 流靠 drop 中断，`run_shell` 用 tokio::process 支持 kill；
- 长上下文压缩、skill 激活、错误恢复需在 Rust 重写一份，接受双端维护成本。

## 13. 明确不做（本期范围外）

- 并发执行多个任务（同一时刻只跑一个任务）
- 任务步骤的人工编辑（只读追溯 + 重试）
- 任务的跨设备同步
- 跨应用重启的任务续跑（`running` 一律标记为 `failed`）
- 任务内的 `ask_user`（后台无人应答，工具集裁剪）
