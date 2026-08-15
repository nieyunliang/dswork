export interface DeepSeekConfig {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  lastTestedAt?: string;
  status: "missing" | "saved" | "valid" | "invalid";
}

export interface SaveConfigInput {
  baseUrl: string;
  model: string;
  apiKey?: string;
  status: string;
  lastTestedAt?: string;
}

export interface TestConnectionInput {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
}

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ExecuteToolInput {
  name: string;
  arguments: string;
  /** 会话工作目录（随每次工具调用透传后端）：run_shell 在其下执行，
      路径类工具的相对路径基于它解析；缺省时后端回退进程 cwd。 */
  cwd?: string;
}

export interface ExecuteToolResult {
  output: string;
  is_error: boolean;
}

export interface Skill {
  name: string;
  description: string;
  tools?: string[] | null;
  systemPrompt: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  tools?: string[] | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** 检索上下文片段（RAG chunk），由 ContextCards 渲染。
    仅用于展示与持久化；发给模型前由后端剥离，不会进入对话请求体。 */
export interface ContextChunk {
  /** 稳定唯一 key（同一来源的多个片段 title 可能相同，必须提供唯一 id） */
  id?: string;
  title: string;
  body: string;
  source: string;
  badge: string;
  /** tokens.css 中的彩色底 token；缺省时组件使用中性 accent 底色 */
  tone?: "bg-red" | "bg-green" | "bg-orange" | "bg-accent";
  /** 字符数文案（如 "290 characters"）；缺省时组件不渲染 */
  chars?: string;
}

export interface Session extends SessionSummary {
  messages: ChatMessage[];
  /** 会话已激活的 skill 名（持久化）：切换会话/重启后恢复 system 前缀，避免缓存静默断裂 */
  activeSkills: string[];
  /** 会话工作目录（绝对路径）：工具执行与相对路径解析的基准；新建会话默认 `~` */
  cwd: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  /** 模型流式输出的推理文本（reasoning_content）。工具轮与最终内容轮都会捕获，
      由 ToolGroup / AssistantMessage 以 ThinkingState 的 Reasoning 变体展示。 */
  reasoning?: string;
  /** 检索上下文片段（assistant 消息可选携带），由 ContextCards 渲染；
     字段缺失 = 未发生检索（不渲染任何 UI），空数组 = 检索过但无结果（渲染空态）。 */
  context?: ContextChunk[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  arguments?: string;
  /** 该轮请求的 token 用量与上下文缓存统计（assistant 消息携带，由缓存统计徽标/头部汇总渲染；
     字段缺失 = 端点未返回 usage（如旧会话），不渲染任何统计 UI）。 */
  usage?: UsageStats;
}

/** 推理等级：PromptBar 模型菜单底部可选，随每轮请求透传后端（与 api.rs 双端镜像）。 */
export type ReasoningLevel = "off" | "high" | "max";

export interface ChatCompletionInput {
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** 推理等级：off=关闭思考，high=标准推理（DeepSeek 默认），max=深度推理。
      映射为请求体 thinking: { type, reasoning_effort }；缺省时后端不发送该参数。 */
  reasoningLevel?: ReasoningLevel;
}

export interface ChatCompletionResult {
  content: string | null;
  tool_calls?: ToolCall[];
  /** 本次请求的 token 用量与上下文缓存统计；端点未返回时为 undefined。 */
  usage?: UsageStats;
}

/** 单次请求的 token 用量与上下文缓存统计（与后端 src-tauri/src/api.rs 的 UsageStats 双端镜像）。 */
export interface UsageStats {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** 命中上下文缓存的 prompt tokens（计费价更低） */
  prompt_cache_hit_tokens: number;
  /** 未命中缓存的 prompt tokens（按原价计费） */
  prompt_cache_miss_tokens: number;
}

/** 流式响应事件（后端 api.rs StreamEvent 双端镜像，内部标签 { type, ... }）。
 * 每个请求通过独立的 Tauri Channel 下发，互不串台；usage 与 done 同通道有序到达。 */
export type StreamEvent =
  | { type: "chunk"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "usage";
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      prompt_cache_hit_tokens: number;
      prompt_cache_miss_tokens: number;
    }
  | { type: "done"; tool_calls: ToolCall[] }
  | { type: "error"; message: string };

// ── 任务执行模块（与后端 src-tauri/src/tasks.rs 双端镜像） ──

export type TaskRunStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export type TaskStepStatus = "pending" | "running" | "done" | "failed";

export interface TaskRun {
  id: string;
  /** 临时标题 + LLM 生成（generate_task_title），步骤边界随 update_task 落盘 */
  title: string;
  /** 任务目标，发给 LLM 的指令 */
  goal: string;
  status: TaskRunStatus;
  steps: TaskStep[];
  /** 全部步骤完成后的总结性答复（抽屉里展示） */
  result?: string;
  /** 任务级错误（如"应用重启导致中断"） */
  error?: string;
  /** 可选：关联的聊天会话 */
  sessionId?: string;
  /** 任务工作目录：从关联会话继承，无会话时默认主目录（与聊天会话同语义） */
  cwd?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskStep {
  id: string;
  /** TaskRows 的 label（如 "读取项目结构"） */
  label: string;
  /** 模型对该步的规划说明（TaskRows details） */
  plan: string;
  status: TaskStepStatus;
  /** 该步发起的工具调用（参数，TaskRows details） */
  toolCalls: ToolCall[];
  /** 工具执行结果（截断后，TaskRows details；完整历史由循环内存维护） */
  outputs: string[];
  error?: string;
}

/** list_tasks 的返回项（左侧任务列表用） */
export interface TaskSummary {
  id: string;
  title: string;
  status: TaskRunStatus;
  stepCount: number;
  doneCount: number;
  createdAt: number;
  updatedAt: number;
}
