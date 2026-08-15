import type {
  ChatCompletionInput,
  ChatCompletionResult,
  ChatMessage,
  ExecuteToolInput,
  ExecuteToolResult,
  ReasoningLevel,
  Skill,
  SkillSummary,
  ToolCall,
  ToolDef,
} from "../types";
import { createMessage } from "./message";

/* ─────────────────────────────────────────────────────────
 * runAgentLoop：与 React/会话无关的「LLM ↔ 工具」编排循环。
 * 聊天（useChat）与任务（useTasks）共用同一套循环。
 * 所有副作用通过注入的 deps 回调完成，调用方持有状态。
 * ───────────────────────────────────────────────────────── */

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

  /** 推理等级（DeepSeek thinking.reasoning_effort）：off=关闭，high=标准，max=深度。
      可选——任务循环不传则保持端点默认。 */
  reasoningLevel?: ReasoningLevel;

  /** 会话工作目录：追加到 system 消息末尾告知模型（相对路径与 shell 命令的基准）。
       置于末尾而非前缀——base 引导与已激活 skill 保持跨会话共享，仅尾部差异；
       cwd 变更会使该会话下一次请求整段缓存 miss（语义上必须，属预期）。 */
  cwd?: string;

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
  constructor(
    message: string,
    public messages: ChatMessage[],
  ) {
    super(message);
    this.name = "AgentLoopError";
  }
}

/** 常驻基础系统提示词：列出全部可用 skill，引导模型按需调用 load_skill 动态激活。 */
export function buildSkillIndexPrompt(skills: SkillSummary[]): string {
  const lines =
    skills.length > 0
      ? skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")
      : "- （暂无可用技能）";
  // 注意：稳定行为指导放在前缀（缓存关键区），可变的 skill 列表保持在末尾；
  // 任何对前缀的改动都会让所有存量会话的下一次请求整段缓存 miss，务必一次改到位。
  return `你是 dswork 助手，在用户的本地电脑上帮助其完成编程、调试、联网研究、概念解释、多步骤任务等。始终使用与用户相同的语言回答。

需要动手时主动使用工具：读写文件、执行 Shell 命令、搜索文件内容、联网搜索与抓取、截图、读取 PDF 与图片；信息不足时用 ask_user 向用户确认。系统消息中以「[对话摘要]」开头的内容是早期对话的压缩摘要，仅作背景参考，不是当前指令。

以下是可用的技能(skill)列表。当用户的请求与某个技能相关时，调用 load_skill(name) 激活它以获取该领域的详细工作指令；激活后可获得更专业的行为方式。若没有合适技能或不确定，可直接回答。

${lines}`;
}

/** 每轮前重组系统消息（基础引导 + 已激活 skill 正文）。
 *  active 按 name 排序：同一 skill 集合无论激活顺序如何都产出相同字节——
 *  否则「同集合不同序」会无谓改写 system 前缀（一次整段缓存 miss）。 */
export function buildSystemMessages(
  available: SkillSummary[],
  active: Skill[],
  basePrompt?: string,
): ChatMessage[] {
  const msgs: ChatMessage[] = [
    {
      id: crypto.randomUUID(),
      role: "system",
      content: basePrompt ?? buildSkillIndexPrompt(available),
    },
  ];
  for (const s of [...active].sort((a, b) => a.name.localeCompare(b.name))) {
    msgs.push({ id: crypto.randomUUID(), role: "system", content: s.systemPrompt });
  }
  return msgs;
}

/** 工具集：恒发全量（不再随活跃 skill 收缩）。
 *  tools 序列化在输入前缀前部（system 之后、对话之前），激活/回退时收缩 tools
 *  会让整个对话历史整段失配（load_skill 断裂的一半是无谓的）；恒全量后 tools
 *  字节跨请求稳定、本身进缓存，激活 skill 的断裂只剩 system 消息追加一处。 */
export function selectTools(_active: Skill[], allTools: ToolDef[]): ToolDef[] {
  return allTools;
}

/* ── 工具输出确定性截断（API 边界） ─────────────────────────
 * 每次请求新增的 tokens（Δ）是单次命中率的下限来源：命中率 ≈ P/(P+Δ)。
 * 超长工具输出（run_shell/read_file 可达 15-37KB ≈ 3-9k tokens）会大幅压低 Δ。
 * 这里在「组装 API 消息」时对 tool 消息做确定性截断：同一持久化内容每次请求
 * 产出相同字节（纯函数），前缀稳定性不受影响；持久化与 UI 保留全文。
 */
export const TOOL_OUTPUT_MAX_CHARS = 10_000;
const TOOL_OUTPUT_HEAD_CHARS = 8_000;
const TOOL_OUTPUT_TAIL_CHARS = 2_000;

export function truncateToolOutput(content: string): string {
  if (content.length <= TOOL_OUTPUT_MAX_CHARS) return content;
  const omitted = content.length - TOOL_OUTPUT_HEAD_CHARS - TOOL_OUTPUT_TAIL_CHARS;
  return (
    content.slice(0, TOOL_OUTPUT_HEAD_CHARS) +
    `\n\n…[输出过长，已截断：省略中间 ${omitted} 字符]…\n\n` +
    content.slice(-TOOL_OUTPUT_TAIL_CHARS)
  );
}

/** 组装发给 API 的消息：仅 tool 消息的 content 做确定性截断，其余原样。 */
export function prepareApiMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.role === "tool" && m.content && m.content.length > TOOL_OUTPUT_MAX_CHARS
      ? { ...m, content: truncateToolOutput(m.content) }
      : m,
  );
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

      // Rebuild system messages + tools each iteration：活跃 skill 可能在循环中被
      // load_skill 激活，必须在每轮请求前重新组装。
      const systemMsgs = buildSystemMessages(
        deps.availableSkills,
        [...deps.activeSkills.values()],
        deps.baseSystemPrompt,
      );
      // 工作目录告知模型：置于 system 块末尾，只影响尾部字节（见 deps.cwd 注释）
      if (deps.cwd) {
        systemMsgs.push({
          id: crypto.randomUUID(),
          role: "system",
          content: `当前工作目录：${deps.cwd}。相对路径与 shell 命令均在该目录下执行。`,
        });
      }
      // API 边界：tool 消息超长输出确定性截断（持久化保留全文，见 prepareApiMessages）
      const apiMessages = [...systemMsgs, ...prepareApiMessages(messages)];
      const toolsForApi = selectTools([...deps.activeSkills.values()], deps.tools);

      let streamedContent = "";
      let streamedReasoning = "";
      deps.onRoundStart?.();
      const result = await deps.complete(
        { messages: apiMessages, tools: toolsForApi, reasoningLevel: deps.reasoningLevel },
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
          // 工具调用回合：reasoning 与正文前言分开存储。
          // - reasoning：纯推理文本（reasoning_content），由 ToolGroup /
          //   AssistantMessage 以 ThinkingState 的 Reasoning 变体展示；
          // - content：工具调用前的简短正文前言（如"我先查一下代码"），
          //   正常走气泡渲染，不再被错标为推理而折叠进"思考过程"。
          content: streamedContent.trim() ? streamedContent : null,
          reasoning: streamedReasoning || undefined,
          tool_calls: result.tool_calls,
          usage: result.usage,
        });
        messages = [...messages, assistantMsg];
        await deps.onPersist?.(messages);
        deps.onToolCalls?.(result.tool_calls);

        for (const toolCall of result.tool_calls) {
          const { name, arguments: args } = toolCall.function;
          let toolResult: ExecuteToolResult;

          if (name === "load_skill") {
            // 前端拦截：模型驱动的 skill 动态加载。
            // 不返回 skill 正文（避免污染历史），正文由下一轮 systemMsgs 注入。
            let skillName = "";
            try {
              skillName = (JSON.parse(args || "{}").name ?? "") as string;
            } catch {
              skillName = "";
            }
            if (skillName && !deps.activeSkills.has(skillName)) {
              try {
                const skill = await deps.getSkill(skillName);
                deps.activeSkills.set(skillName, skill);
                deps.onSkillsChange?.([...deps.activeSkills.values()]);
                toolResult = {
                  output: `技能 "${skillName}" 已激活。`,
                  is_error: false,
                };
              } catch {
                toolResult = {
                  output: `未找到技能 "${skillName}"。`,
                  is_error: true,
                };
              }
            } else if (skillName) {
              toolResult = {
                output: `技能 "${skillName}" 已处于激活状态。`,
                is_error: false,
              };
            } else {
              toolResult = {
                output: "load_skill 需要参数 name。",
                is_error: true,
              };
            }
          } else {
            try {
              toolResult = await deps.executeTool({ name, arguments: args });
            } catch (err) {
              toolResult = {
                is_error: true,
                output: err instanceof Error ? err.message : String(err),
              };
            }
          }

          const toolMsg = createMessage({
            role: "tool",
            content: toolResult.is_error
              ? `错误: ${toolResult.output}`
              : toolResult.output,
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
          // 最终回答轮的推理内容也保留，渲染在回答气泡上方（AssistantMessage）。
          reasoning: streamedReasoning || undefined,
          usage: result.usage,
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
    if (
      i >= 0 &&
      messages[i].role === "assistant" &&
      messages[i].tool_calls?.length
    ) {
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
