# runAgentLoop 抽取方案（详细设计）

> 状态：**已实现**（2025-08；`src/utils/agentLoop.ts` + `src/utils/taskLoop.ts` 已落地，
> 聊天零回归经无头浏览器 + 模拟 LLM 验证，任务两阶段循环经真实 API 端到端验证）。
> 前置依赖见 `task-execution-module.md` §9。
> 目标：把 `src/hooks/useChat.ts` 里的 agent 循环抽成与 React/会话无关的纯函数，
> 让聊天（useChat）与任务（useTasks）共用同一套「LLM ↔ 工具」编排，且**不改变聊天现有行为**。

## 1. 目标与原则

1. **行为零回归**：抽取后聊天表现逐字节一致，先重构后接新功能。
2. **传输无关**：循环不直接依赖 `invoke`/React 状态/会话，所有副作用通过注入的 `deps` 回调完成。
3. **调用方持有状态**：`turnRef`、`streamSessionRef`、`activeSkills` 等留在 hook 里，循环只读写传入的引用。
4. **错误上抛**：循环只做「剥离残缺 tool 组」这类通用正确性清理，错误**如何呈现**交给调用方。

## 2. 现状职责拆解（`useChat.ts` → 去向）

| # | 现有代码段 | 去向 | 理由 |
|---|---|---|---|
| 1 | `buildSkillIndexPrompt` | → `agentLoop.ts` | 纯函数，聊天/任务都要 |
| 2 | 工具集并集计算（`toolsForApi`） | → `agentLoop.ts::selectTools` | 纯函数，仅基集不同 |
| 3 | `while(true)` 主循环（system 组装 / 流式 / tool_calls 分支 / 最终答复分支） | → `agentLoop.ts::runAgentLoop` | 核心编排 |
| 4 | `load_skill` 拦截 | → `agentLoop.ts` | 循环内在逻辑 |
| 5 | catch 里的「剥离残缺 tool 组」 | → `agentLoop.ts`（清理后 rethrow） | 通用正确性 |
| 6 | `maybeCompact` + 阈值常量 | 留在 `useChat.ts`，作为 `deps.compact` 注入 | 阈值是聊天策略 |
| 7 | `turnRef`/`streamSessionRef`/`currentSessionRef` + 守卫 | 留在 `useChat.ts`，通过回调守卫 | 会话/UI 关注点 |
| 8 | `/skill-name` 前缀解析、用户消息创建、`persistMessages`、`autoTitleSession` | 留在 `useChat.ts` | 聊天专属 |
| 9 | catch 里 `setLastError` + 追加错误消息 | 留在 `useChat.ts` | 错误呈现策略 |
| 10 | `sending`/`streamingContent`/`streamingReasoning`/`lastError` | 留在 `useChat.ts` | UI 状态 |

## 3. 目标文件布局

```
src/
  utils/
    message.ts        # 已有：createMessage / parseSkillCommand ...
    agentLoop.ts      # 新增：runAgentLoop + buildSystemMessages + selectTools + AgentLoopError
  hooks/
    useChat.ts        # 改造：变薄，仅编排会话 + 调用 runAgentLoop
    useTasks.tsx      # 新增（后续任务模块）：复用 runAgentLoop 做两阶段循环
```

## 4. API 契约

```ts
// src/utils/agentLoop.ts
import type {
  ChatCompletionInput, ChatCompletionResult, ChatMessage,
  ExecuteToolInput, ExecuteToolResult, Skill, SkillSummary, ToolCall, ToolDef,
} from "../types";
import { createMessage } from "./message";

export interface AgentLoopDeps {
  /** 一轮 LLM 请求（= useDeepSeekConfig.sendChatCompletion 原样传入） */
  complete: (
    input: ChatCompletionInput,
    onChunk?: (text: string) => void,
    onReasoning?: (text: string) => void,
  ) => Promise<ChatCompletionResult>;

  /** 执行工具（= useDeepSeekConfig.executeToolCall 原样传入） */
  executeTool: (input: ExecuteToolInput) => Promise<ExecuteToolResult>;

  /** 拉取 skill 正文（= useSkills.getSkill 原样传入） */
  getSkill: (name: string) => Promise<Skill>;

  /** 可用 skill 列表（= useSkills.skills） */
  availableSkills: SkillSummary[];

  /** 本轮可用的完整工具基集（聊天传 TOOLS；任务传 TOOLS 去 ask_user） */
  tools: ToolDef[];

  /** 已激活 skill，调用方持有并跨轮/跨次调用保留（循环会读写） */
  activeSkills: Map<string, Skill>;

  /** 基础系统提示词，默认 = buildSkillIndexPrompt(available)。任务规划/执行/收尾各传各自引导。 */
  baseSystemPrompt?: string;

  /** 长上下文压缩（聊天注入 maybeCompact；任务可注入或不提供） */
  compact?: (messages: ChatMessage[]) => Promise<ChatMessage[] | null>;

  /** 取消标志，每轮开始前检查（MVP：不中断 in-flight 请求） */
  shouldStop?: () => boolean;

  /** 最大轮数上限（默认不限）。到达后抛 AgentLoopError("达到轮数上限")，任务据此标 failed。 */
  maxRounds?: number;

  // —— 回调（全部可选） ——
  /** 每次 messages 变更后（含压缩后）调用，用于持久化 */
  onPersist?: (messages: ChatMessage[]) => void | Promise<void>;
  /** skill 激活/变更后回调（聊天镜像 activeSkillNames） */
  onSkillsChange?: (active: Skill[]) => void;
  /** 一轮流式开始/结束（聊天用于清空/复位 streaming 状态；异常路径 onRoundEnd 不保证调用） */
  onRoundStart?: () => void;
  onRoundEnd?: () => void;
  /** 流式文本/推理增量（聊天在此套 turn 守卫） */
  onChunk?: (text: string) => void;
  onReasoning?: (text: string) => void;
  /** 一轮产出的完整 tool_calls（任务在步骤边界聚合成 TaskStep.toolCalls） */
  onToolCalls?: (calls: ToolCall[]) => void;
  /** 单个工具执行完成（参数 + 结果），任务用其填充 TaskStep.outputs */
  onToolResult?: (call: ToolCall, result: ExecuteToolResult) => void;
}

export interface AgentLoopResult {
  /** 最终历史（含本次新增的 assistant/tool 消息；错误时由 AgentLoopError 携带） */
  messages: ChatMessage[];
  /** 最终答复文本；被取消或出错时为 null */
  finalContent: string | null;
  /** 是否因 shouldStop 中止 */
  cancelled: boolean;
}

/** 循环内部异常：携带清理后的历史，调用方据此追加自己的错误消息再持久化 */
export class AgentLoopError extends Error {
  constructor(message: string, public messages: ChatMessage[]) {
    super(message);
    this.name = "AgentLoopError";
  }
}

export function buildSkillIndexPrompt(skills: SkillSummary[]): string;
export function buildSystemMessages(available: SkillSummary[], active: Skill[], basePrompt?: string): ChatMessage[];
export function selectTools(active: Skill[], allTools: ToolDef[]): ToolDef[];
export async function runAgentLoop(history: ChatMessage[], deps: AgentLoopDeps): Promise<AgentLoopResult>;
```

## 5. `agentLoop.ts` 完整实现草案

> `AgentLoopDeps`/`AgentLoopResult`/`AgentLoopError` 在代码块中以 `{ /* 见 §4 */ }` 占位，实现时替换为 §4 的完整定义。

```ts
// src/utils/agentLoop.ts
import type {
  ChatCompletionInput, ChatCompletionResult, ChatMessage,
  ExecuteToolInput, ExecuteToolResult, Skill, SkillSummary, ToolCall, ToolDef,
} from "../types";
import { createMessage } from "./message";

export interface AgentLoopDeps { /* 见 §4 */ }
export interface AgentLoopResult { /* 见 §4 */ }
export class AgentLoopError extends Error { /* 见 §4 */ }

/** 常驻基础系统提示词（从 useChat.ts 原样搬移） */
export function buildSkillIndexPrompt(skills: SkillSummary[]): string {
  const lines =
    skills.length > 0
      ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
      : "- （暂无可用技能）";
  return `你是 dswork 助手，帮助用户完成编程、调试、联网研究、概念解释等任务。

以下是可用的技能(skill)列表。当用户的请求与某个技能相关时，调用 load_skill(name) 激活它以获取该领域的详细工作指令；激活后可获得更专业的行为方式。若没有合适技能或不确定，可直接回答。

${lines}`;
}

/** 每轮前重组系统消息（基础引导 + 已激活 skill 正文） */
export function buildSystemMessages(available: SkillSummary[], active: Skill[], basePrompt?: string): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { id: crypto.randomUUID(), role: "system", content: basePrompt ?? buildSkillIndexPrompt(available) },
  ];
  for (const s of active) {
    msgs.push({ id: crypto.randomUUID(), role: "system", content: s.systemPrompt });
  }
  return msgs;
}

/** 工具集并集：无活跃 skill 或任一活跃 skill 未声明 tools → 全量；否则取并集（始终保留 load_skill） */
export function selectTools(active: Skill[], allTools: ToolDef[]): ToolDef[] {
  if (active.length === 0 || active.some((s) => s.tools == null)) return allTools;
  const allowed = new Set<string>(["load_skill"]);
  for (const s of active) s.tools?.forEach((t) => allowed.add(t));
  return allTools.filter((t) => allowed.has(t.function.name));
}

export async function runAgentLoop(
  history: ChatMessage[],
  deps: AgentLoopDeps,
): Promise<AgentLoopResult> {
  let messages = [...history];
  let rounds = 0;

  // 长上下文压缩（与现状一致：进入循环前一次）
  if (deps.compact) {
    const compacted = await deps.compact(messages);
    if (compacted) {
      messages = compacted;
      await deps.onPersist?.(messages);
    }
  }

  try {
    while (true) {
      if (deps.shouldStop?.()) {
        return { messages, finalContent: null, cancelled: true };
      }
      if (deps.maxRounds != null && rounds >= deps.maxRounds) {
        throw new AgentLoopError(`达到轮数上限（${deps.maxRounds}）`, messages);
      }
      rounds += 1;

      const systemMsgs = buildSystemMessages(
        deps.availableSkills,
        [...deps.activeSkills.values()],
        deps.baseSystemPrompt,
      );
      const apiMessages = [...systemMsgs, ...messages];
      const toolsForApi = selectTools([...deps.activeSkills.values()], deps.tools);

      let streamedContent = "";
      let streamedReasoning = "";
      deps.onRoundStart?.();
      const result = await deps.complete(
        { messages: apiMessages, tools: toolsForApi },
        (chunk) => {
          streamedContent += chunk;
          deps.onChunk?.(chunk);
        },
        (reasoning) => {
          streamedReasoning += reasoning;
          deps.onReasoning?.(reasoning);
        },
      );
      deps.onRoundEnd?.();

      if (result.tool_calls && result.tool_calls.length > 0) {
        const assistantMsg = createMessage({
          role: "assistant",
          content: null,
          reasoning: streamedReasoning || streamedContent || undefined,
          tool_calls: result.tool_calls,
        });
        messages = [...messages, assistantMsg];
        await deps.onPersist?.(messages);
        deps.onToolCalls?.(result.tool_calls);

        for (const toolCall of result.tool_calls) {
          const { name, arguments: args } = toolCall.function;
          let toolResult: ExecuteToolResult;

          if (name === "load_skill") {
            let skillName = "";
            try { skillName = (JSON.parse(args || "{}").name ?? "") as string; } catch { skillName = ""; }
            if (skillName && !deps.activeSkills.has(skillName)) {
              try {
                const skill = await deps.getSkill(skillName);
                deps.activeSkills.set(skillName, skill);
                deps.onSkillsChange?.([...deps.activeSkills.values()]);
                toolResult = { output: `技能 "${skillName}" 已激活。`, is_error: false };
              } catch {
                toolResult = { output: `未找到技能 "${skillName}"。`, is_error: true };
              }
            } else if (skillName) {
              toolResult = { output: `技能 "${skillName}" 已处于激活状态。`, is_error: false };
            } else {
              toolResult = { output: "load_skill 需要参数 name。", is_error: true };
            }
          } else {
            try {
              toolResult = await deps.executeTool({ name, arguments: args });
            } catch (err) {
              toolResult = { is_error: true, output: err instanceof Error ? err.message : String(err) };
            }
          }

          const toolMsg = createMessage({
            role: "tool",
            content: toolResult.is_error ? `错误: ${toolResult.output}` : toolResult.output,
            tool_call_id: toolCall.id,
            name,
          });
          messages = [...messages, toolMsg];
          await deps.onPersist?.(messages);
          deps.onToolResult?.(toolCall, toolResult);
        }
      } else {
        const finalMsg = createMessage({
          role: "assistant",
          content: result.content ?? streamedContent,
          reasoning: streamedReasoning || undefined,
        });
        messages = [...messages, finalMsg];
        await deps.onPersist?.(messages);
        return { messages, finalContent: finalMsg.content, cancelled: false };
      }
    }
  } catch (e) {
    // 剥离残缺 tool 组：仅当末尾 assistant(tool_calls) 的工具响应不完整时才移除。
    // （修复原 useChat 的过度删除：请求失败发生在轮次边界时，上一轮完整 tool 组会被误删，丢失上下文。）
    let i = messages.length - 1;
    while (i >= 0 && messages[i].role === "tool") i--;
    if (i >= 0 && messages[i].role === "assistant" && messages[i].tool_calls?.length) {
      const assistant = messages[i];
      const responded = new Set(
        messages
          .slice(i + 1)
          .filter((m) => m.role === "tool")
          .map((m) => m.tool_call_id),
      );
      const complete = assistant.tool_calls!.every((tc) => responded.has(tc.id));
      if (!complete) {
        messages = messages.slice(0, i);
      }
    }
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role === "assistant" && !lastMsg.content && !lastMsg.tool_calls) {
      messages = messages.slice(0, -1);
    }
    throw new AgentLoopError(e instanceof Error ? e.message : String(e), messages);
  }
}
```

## 6. `useChat.ts` 改造后（完整）

```ts
import { useRef, useState } from "react";
import { useMemoizedFn, useUpdateEffect } from "ahooks";
import { useDeepSeekConfig } from "./useDeepSeekConfig";
import { useSessions } from "./useSessions";
import { useSkills } from "./useSkills";
import { createMessage, parseSkillCommand } from "../utils/message";
import { AgentLoopError, runAgentLoop } from "../utils/agentLoop";
import { TOOLS } from "../tools";
import type { ChatMessage, Skill } from "../types";

const COMPACT_MSG_THRESHOLD = 24;
const COMPACT_CHAR_THRESHOLD = 16000;
const KEEP_RECENT = 10;

function estimateMessageChars(messages: ChatMessage[]): number {
  return messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0);
}

export function useChat() {
  const { sendChatCompletion, summarizeMessages, executeToolCall } = useDeepSeekConfig();
  const { messages, currentSessionId, persistMessages, autoTitleSession } = useSessions();
  const { getSkill, skills } = useSkills();

  const [sending, setSending] = useState(false);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [streamingReasoning, setStreamingReasoning] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const activeSkillsRef = useRef<Map<string, Skill>>(new Map());
  const [activeSkillNames, setActiveSkillNames] = useState<string[]>([]);

  const turnRef = useRef(0);
  const streamSessionRef = useRef<string | null>(null);
  const currentSessionRef = useRef(currentSessionId);
  currentSessionRef.current = currentSessionId;

  useUpdateEffect(() => {
    if (streamSessionRef.current !== currentSessionId) {
      setSending(false);
      setStreamingContent(null);
      setStreamingReasoning(null);
    }
    activeSkillsRef.current.clear();
    setActiveSkillNames([]);
  }, [currentSessionId]);

  const maybeCompact = useMemoizedFn(
    async (msgs: ChatMessage[]): Promise<ChatMessage[] | null> => {
      const totalChars = estimateMessageChars(msgs);
      if (msgs.length <= COMPACT_MSG_THRESHOLD && totalChars <= COMPACT_CHAR_THRESHOLD) return null;

      let boundary = Math.max(1, msgs.length - KEEP_RECENT);
      while (boundary < msgs.length - 1 && msgs[boundary]?.role === "tool") boundary++;
      if (boundary < 2) return null;

      const old = msgs.slice(0, boundary);
      const kept = msgs.slice(boundary);
      if (kept[0]?.role === "tool") return null;

      try {
        const summary = await summarizeMessages(old);
        if (!summary.trim()) return null;
        return [createMessage({ role: "system", content: `[对话摘要]\n${summary}` }), ...kept];
      } catch {
        return null;
      }
    },
  );

  const send = useMemoizedFn(async (text: string) => {
    if (!text.trim() || sending) return;

    const sessionId = currentSessionId;
    if (!sessionId) {
      setLastError("当前没有可用的会话，请先新建一个对话");
      return;
    }

    const turn = ++turnRef.current;
    streamSessionRef.current = sessionId;

    const { name: skillName, rest } = parseSkillCommand(text);
    let userText = text;
    if (skillName) {
      try {
        const skill = await getSkill(skillName);
        activeSkillsRef.current.set(skillName, skill);
        setActiveSkillNames([...activeSkillsRef.current.keys()]);
        userText = rest || text;
      } catch {
        // Skill 不存在：不剥离前缀，保留原文发送
      }
    }

    const userMsg = createMessage({ role: "user", content: userText });
    const initialMessages: ChatMessage[] = [...messages, userMsg];
    await persistMessages(sessionId, initialMessages);
    setSending(true);
    setLastError(null);

    const isLatest = () =>
      turn === turnRef.current && streamSessionRef.current === currentSessionRef.current;

    try {
      await runAgentLoop(initialMessages, {
        complete: sendChatCompletion,
        executeTool: executeToolCall,
        getSkill,
        availableSkills: skills,
        tools: TOOLS,
        activeSkills: activeSkillsRef.current,
        compact: maybeCompact,
        // 持久化：与现状一致——后台会话也要落盘，不做 isLatest 守卫
        onPersist: (msgs) => persistMessages(sessionId, msgs),
        onSkillsChange: (active) => setActiveSkillNames(active.map((s) => s.name)),
        onRoundStart: () => { if (isLatest()) { setStreamingContent(""); setStreamingReasoning(""); } },
        onRoundEnd: () => { if (isLatest()) { setStreamingContent(null); setStreamingReasoning(null); } },
        onChunk: (c) => { if (isLatest()) setStreamingContent((p) => (p ?? "") + c); },
        onReasoning: (r) => { if (isLatest()) setStreamingReasoning((p) => (p ?? "") + r); },
      });
      autoTitleSession(sessionId);
    } catch (e) {
      const errorText = e instanceof Error ? e.message : String(e);
      setLastError(errorText);

      // 循环已清理残缺组，这里基于清理后的历史追加用户可见错误消息
      const cleaned = e instanceof AgentLoopError ? e.messages : initialMessages;
      const finalMessages = [
        ...cleaned,
        createMessage({
          role: "assistant",
          content: `请求失败：${errorText || "请检查 API 配置或网络连接"}`,
        }),
      ];
      await persistMessages(sessionId, finalMessages);
    } finally {
      if (turn === turnRef.current) {
        streamSessionRef.current = null;
        setSending(false);
        setStreamingContent(null);
        setStreamingReasoning(null);
      }
    }
  });

  return { send, sending, streamingContent, streamingReasoning, lastError, activeSkillNames };
}
```

### 与现状的关键差异（逐条核对）

1. `while(true)` 主循环整体移入 `runAgentLoop`，`send` 只剩「会话编排 + 回调守卫」。
2. **turn 守卫从循环里剥离**：`onChunk/onReasoning/onRoundStart/onRoundEnd` 统一用 `isLatest()`（含会话判断）。
   原代码 `onRoundStart/onRoundEnd` 只判 `turn === turnRef`，收窄后无可见差异（切会话后 streaming 已被 useUpdateEffect 置空）。
3. **持久化不套 isLatest 守卫**：`persistMessages` 内部已自行守卫 `setMessages`，后端落盘始终执行（与原代码一致）。
4. **错误清理修正（唯一有意的行为变更）**：原 useChat 的「剥离残缺组」在请求失败发生在**轮次边界**时会误删上一轮**完整** tool 组、丢失上下文；抽取时改为「仅剥离不完整组」（见 §5 实现与 §8）。
5. `buildSkillIndexPrompt` 从 useChat 移除（迁入 agentLoop），type import 收敛为 `{ ChatMessage, Skill }`（`ExecuteToolResult`/`SkillSummary`/`ToolDef` 已不在此文件使用）。

## 7. `useTasks` 消费草图（两阶段）

```ts
// src/hooks/useTasks.tsx（任务模块阶段实现，此处仅示意消费方式）
// READ_ONLY_TOOLS = TOOLS 中只读子集（read_file/list_dir/grep/file_search/web_search/web_fetch/read_pdf_or_image）
async function runTask(task: TaskRun, base: AgentLoopDeps, cancel: () => boolean) {
  const taskSkills = new Map<string, Skill>();               // C3：每个任务独立激活态，不与聊天/其它任务串
  const taskDeps: AgentLoopDeps = {
    ...base,
    activeSkills: taskSkills,
    maxRounds: MAX_STEP_ROUNDS,                              // B2：轮数上限
  };

  // 阶段 1：规划 —— 只读工具可探查；探查结果不落任务（只影响规划结论）
  const planResult = await runAgentLoop(
    [{ role: "user", content: PLAN_PROMPT(task.goal) }],
    { ...taskDeps, tools: READ_ONLY_TOOLS, baseSystemPrompt: PLAN_SYSTEM_PROMPT, shouldStop: cancel },
  );
  if (planResult.cancelled) { markTaskCancelled(); return; }
  const steps = parsePlanJson(planResult.finalContent);      // 失败 → 退化为单步模式（整目标一次性执行）

  // 阶段 2：逐步执行，每步一次独立 runAgentLoop
  let ctx = `目标：${task.goal}`;
  for (const step of steps) {
    if (cancel()) { markTaskCancelled(); return; }           // C6：进入下一步前查取消
    markStepRunning(step.id);

    const stepResult = await runAgentLoop(
      [{ role: "user", content: `${ctx}\n\n当前步骤：${step.label}\n${step.plan}` }],
      {
        ...taskDeps,
        tools: FULL_TASK_TOOLS,                               // 执行阶段全量（仍去 ask_user）
        baseSystemPrompt: EXECUTE_SYSTEM_PROMPT,
        shouldStop: cancel,
        onToolCalls: (calls) => appendStepToolCalls(step.id, calls),
        onToolResult: (call, result) => appendStepOutput(step.id, call, result),  // B1
      },
    );
    if (stepResult.cancelled) { markTaskCancelled(); return; }

    // C4：上下文带 label + plan + 工具摘要 + 关键输出，而非仅 finalContent
    ctx += `\n步骤「${step.label}」完成。${truncate(stepResult.finalContent)}`;
    ctx += `\n  工具：${summarizeToolCalls(step.toolCalls)}`;
    ctx += `\n  输出摘要：${summarizeOutputs(step.outputs)}`;
    markStepDone(step.id, stepResult.finalContent);
  }

  // 收尾：生成 result 总结（只读工具）
  const wrap = await runAgentLoop(
    [{ role: "user", content: `${ctx}\n\n请总结以上步骤的执行结果。` }],
    { ...taskDeps, tools: READ_ONLY_TOOLS, baseSystemPrompt: WRAP_SYSTEM_PROMPT, shouldStop: cancel },
  );
  if (wrap.cancelled) { markTaskCancelled(); return; }
  markTaskDone(task.id, wrap.finalContent ?? ctx);
}
```

要点：
- **每步一次 `runAgentLoop`**：步骤的 `toolCalls`/`outputs` 由 `onToolCalls` + `onToolResult` 聚合进 `TaskStep`，循环内存里维护完整 `messages` 供下一步决策（与文档"双份内容"一致）。
- **步骤上下文**：`ctx` 累积已完步骤的 `label + plan + 工具调用摘要 + 关键输出摘要`，而非仅 finalContent（避免关键产物如文件路径/目录树丢失）。
- **规划/执行/收尾分用不同 `baseSystemPrompt` 与工具集**：规划与收尾用只读工具，执行用全量（去 ask_user）。
- **取消**：`shouldStop` + 每步入口 `cancel()` 双查；被取消时 `cancelled=true`，循环停在轮次边界。
- **错误**：catch `AgentLoopError`（含轮数上限）→ `markStepFailed(step.id, errorText)`，任务置 `failed`。
- **轮数上限**：`maxRounds` 每步生效，防后台无限烧 token。
- **重试**：`resumeTask(task, stepIndex)` 跳过阶段 1，`ctx` 由前序 done 步骤的 `label + plan + toolCalls + outputs` 重建；useTasks 内存保留每步完整 `messages`（`Map<stepId, ChatMessage[]>`），未保留则回退截断版 outputs。

## 8. 边界情况与决策点

| 场景 | 处理 |
|---|---|
| 循环被 `shouldStop` 中断 | 停在**轮次边界**，当前 in-flight 请求不中断（MVP）；`messages` 中该轮的工具组已完整（工具全部执行完才回到循环顶部） |
| 一轮多工具 + 取消 | 该轮内所有工具仍会执行完（顶部才检查），可接受；后续可加工具级检查 |
| `activeSkills` 归属 | 调用方持有 `Map` 并注入；聊天在会话切换时 `clear()`，任务为每任务独立 `Map`，循环只读写传入引用 |
| 压缩 | 循环内 `compact` 返回非空即替换并 `onPersist`；聊天注入 `maybeCompact`，任务可选注入 |
| 错误清理 | 循环**仅剥离不完整** tool 组后 `throw AgentLoopError(messages)`（修复原过度删除：轮次边界失败不再误删上一轮完整组）；聊天追加错误消息，任务标记步骤失败 |
| 轮数上限 `maxRounds` | 到达上限抛 `AgentLoopError("达到轮数上限")`；聊天不设（默认不限），任务每步设 `MAX_STEP_ROUNDS` |
| `onRoundStart/End` 异常不配对 | `complete` 抛错时只 start 不 end；调用方复位须放 `finally`，勿依赖 onRoundEnd 一定被调 |
| 严格模式 `noUnusedLocals` | 迁出后清理 `useChat.ts` 中不再使用的 import/类型 |
| React StrictMode 双执行 | `runAgentLoop` 是纯编排、副作用全走注入回调；与现状相同的双重 `send` 风险由 `sending` 守卫承担，不新增风险 |

## 9. 迁移步骤（可回滚、带验证门）

1. **新增 `src/utils/agentLoop.ts`**（§5 完整实现），纯函数、无 React 依赖。
2. **改造 `useChat.ts`**（§6），保留原文件为参考（git 可回滚）。
3. **验证门 A（回归）**：
   - `tsc --noEmit` + `pnpm build` 通过；
   - 手动：正常问答、多轮工具调用、`/skill` 前缀、长上下文压缩、切换会话中途防串台、API 错误提示——与改造前逐字节一致。
4. **验证门 B（新消费者冒烟）**：写一个临时 `runAgentLoop` 单测/脚本（不含 UI），喂一个含 `read_file` 工具的目标，断言 `messages` 结构与 `finalContent`。
5. 确认无误后，任务模块再接入（`useTasks` 按 §7）。

> 建议第 2 步后先在 dev 里跑一轮真实聊天回归，再继续任务模块，避免把「重构回归」和「新功能」混在一起排查。

## 10. 风险与回退

- **风险**：turn 守卫/持久化时机搬移引入细微差异 → 用验证门 A 的逐字节对比兜底。
- **回退**：`agentLoop.ts` 是新增文件，`useChat.ts` 可整体 revert；两者无后端改动，回退零成本。
- **后续**：若任务模块最终回退到「后端循环」（task-execution-module.md §12），本抽取仍对聊天有益（消除 useChat 单文件 300+ 行膨胀），不构成浪费。
