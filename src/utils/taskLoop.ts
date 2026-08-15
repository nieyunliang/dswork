import type {
  ChatMessage,
  ExecuteToolResult,
  Skill,
  SkillSummary,
  TaskRun,
  ToolCall,
  ToolDef,
} from "../types";
import { AgentLoopError, runAgentLoop, type AgentLoopDeps } from "./agentLoop";
import { createMessage } from "./message";
import { planPrompt, parsePlan, truncate } from "./taskPlan";

/* ─────────────────────────────────────────────────────────
 * runTaskLoop：任务执行编排（两阶段循环）。
 * 与 React/会话无关，可独立单测；useTasks 只负责注入依赖与 UI 同步。
 *   阶段 1 规划（只读工具）→ 阶段 2 逐步执行（全量工具，去 ask_user）→ 收尾总结。
 * 取消语义：软取消，停在轮次边界（MVP）；单步超时按失败处理。
 * ───────────────────────────────────────────────────────── */

export const MAX_STEP_ROUNDS = 40;
export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000; // 单步超时：10 分钟
const MAX_OUTPUT_CHARS = 8000; // 单条工具输出截断（持久化/展示）

const PLAN_SYSTEM_PROMPT = `你是 dswork 的任务规划器。你的任务是把用户目标拆解为有序的执行步骤。动手规划前，先使用只读工具（读文件、列目录、搜索、联网）探查现状，必要时可加载相关技能（load_skill）了解专业工作流程，但绝对不要修改任何文件或执行任何写操作。探查结束后，输出一个 JSON 数组作为规划结果（不要输出任何其它内容），数组元素格式：{"label": "步骤标题", "plan": "该步骤做什么、为什么"}。`;

const EXECUTE_SYSTEM_PROMPT = `你是 dswork 的任务执行器。你正在逐步执行一个多步骤任务。请专注于完成当前步骤：可以使用工具读写文件、执行命令、联网等；若与相关领域的技能匹配，可调用 load_skill 激活技能获取专业工作指令。完成当前步骤后，输出一个简短的完成说明（包含关键产物如文件路径）。使用与任务目标相同的语言输出。`;

const WRAP_SYSTEM_PROMPT = `你是 dswork 的任务总结器。根据已完成的步骤，输出一份面向用户的任务总结：完成了什么、关键产物（文件路径/命令）、遗留问题或注意事项。使用与任务目标相同的语言输出。`;

export interface TaskLoopDeps {
  getTask: (id: string) => Promise<TaskRun>;
  /** 持久化（update_task 全量写入 + 调用方 UI 同步）；不得抛出 */
  persistTask: (task: TaskRun) => Promise<void>;
  /** 标题生成（失败保留临时标题，不影响任务） */
  generateTitle?: (goal: string) => Promise<string>;
  complete: AgentLoopDeps["complete"];
  executeTool: AgentLoopDeps["executeTool"];
  getSkill: AgentLoopDeps["getSkill"];
  availableSkills: SkillSummary[];
  /** 执行阶段工具集（调用方传入，通常为 FULL_TASK_TOOLS：全量去 ask_user）；
      规划/收尾阶段自动裁剪为只读子集 + load_skill */
  tools: ToolDef[];
  /** 每步轮数上限（防后台无限烧 token） */
  maxRounds?: number;
  /** 单步超时（默认 10 分钟） */
  stepTimeoutMs?: number;
}

export interface TaskLoopOptions {
  /** 重试入口：跳过阶段 1，从该步重新执行 */
  fromStep?: number;
  /** 外部停止信号（新任务启动/取消/删除等）；true 时循环在轮次边界停止 */
  stopSignal?: () => boolean;
  /** 供重试的每步完整 messages；未保留（如重启后）回退截断版 outputs 重建 */
  stepMessages?: Map<string, ChatMessage[]>;
  /** 任务独立 skill 激活态（调用方持有，不与聊天/其它任务串） */
  activeSkills?: Map<string, Skill>;
}

function summarizeToolCalls(calls: ToolCall[]): string {
  return calls
    .map((c) => `${c.function.name}(${truncate(c.function.arguments, 300)})`)
    .join("; ");
}

function summarizeOutputs(outputs: string[]): string {
  return outputs.map((o) => truncate(o, 500)).join("\n");
}

/** 前序步骤上下文摘要 + 当前步骤指令 */
function buildStepUserMsg(task: TaskRun, stepIndex: number): ChatMessage {
  let ctx = `目标：${task.goal}`;
  for (let i = 0; i < stepIndex; i++) {
    const s = task.steps[i];
    if (s.status !== "done") continue;
    ctx += `\n步骤「${s.label}」完成。`;
    ctx += `\n  工具：${summarizeToolCalls(s.toolCalls)}`;
    ctx += `\n  输出摘要：${summarizeOutputs(s.outputs)}`;
  }
  const step = task.steps[stepIndex];
  return createMessage({
    role: "user",
    content: `${ctx}\n\n当前步骤：${step.label}\n${step.plan || "请执行该步骤。"}`,
  });
}

export async function runTaskLoop(
  taskId: string,
  deps: TaskLoopDeps,
  opts: TaskLoopOptions = {},
): Promise<void> {
  const stepTimeoutMs = deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const maxRounds = deps.maxRounds ?? MAX_STEP_ROUNDS;
  const stopSignal = opts.stopSignal ?? (() => false);
  const stepMessages = opts.stepMessages ?? new Map<string, ChatMessage[]>();
  const activeSkills = opts.activeSkills ?? new Map<string, Skill>();

  // 单步超时：置内部停止标志（软取消，停在轮次边界）
  let timedOutAbort = false;
  const stopped = () => timedOutAbort || stopSignal();

  // 兜底：任何情况下执行阶段都不含 ask_user（后台无人应答，oneshot 会卡死循环）
  const tools = deps.tools.filter((t) => t.function.name !== "ask_user");

  // 规划/收尾阶段只读工具子集（探查结果只影响规划结论，不落任务步骤）；保留 load_skill
  const readOnlyTools = (): ToolDef[] => {
    const names = new Set([
      "read_file",
      "list_dir",
      "grep",
      "file_search",
      "web_search",
      "web_fetch",
      "read_pdf_or_image",
      "load_skill",
    ]);
    return tools.filter((t) => names.has(t.function.name));
  };

  const baseDeps: AgentLoopDeps = {
    complete: deps.complete,
    executeTool: deps.executeTool,
    getSkill: deps.getSkill,
    availableSkills: deps.availableSkills,
    tools,
    activeSkills,
    maxRounds,
    shouldStop: stopped,
  };

  let task: TaskRun;
  try {
    task = await deps.getTask(taskId);
  } catch (e) {
    console.error("[tasks] 加载任务失败:", e);
    return;
  }

  // 任务工作目录：注入工具执行（ExecuteToolInput.cwd）与 system 消息（AgentLoopDeps.cwd）。
  // 任务创建时已从会话继承（无会话默认主目录），持久化在 TaskRun.cwd。
  const executeToolWithCwd: AgentLoopDeps["executeTool"] = (input) =>
    deps.executeTool({ ...input, cwd: task.cwd ?? undefined });
  const taskCwd = task.cwd ?? undefined;
  baseDeps.executeTool = executeToolWithCwd;
  baseDeps.cwd = taskCwd;

  try {
    // ── 阶段 1：规划（跳过 when retry） ──
    if (opts.fromStep == null) {
      task = { ...task, status: "running" };
      await deps.persistTask(task);

      const planResult = await runAgentLoop(
        [createMessage({ role: "user", content: planPrompt(task.goal) })],
        {
          ...baseDeps,
          tools: readOnlyTools(),
          baseSystemPrompt: PLAN_SYSTEM_PROMPT,
        },
      );
      if (stopped()) {
        task = { ...task, status: "cancelled" };
        await deps.persistTask(task);
        return;
      }

      task = {
        ...task,
        steps: parsePlan(planResult.finalContent, task.goal),
        status: "running",
      };

      // 标题生成（复用会话标题生成；失败保留临时标题，不影响任务）
      if (deps.generateTitle) {
        try {
          const title = await deps.generateTitle(task.goal);
          if (title.trim()) task = { ...task, title: title.trim() };
        } catch (e) {
          console.error("[tasks] 标题生成失败:", e);
        }
      }
      await deps.persistTask(task);
    }

    // ── 阶段 2：逐步执行 ──
    for (let i = opts.fromStep ?? 0; i < task.steps.length; i++) {
      if (stopped()) {
        task = { ...task, status: "cancelled" };
        await deps.persistTask(task);
        return;
      }
      const step = task.steps[i];
      step.status = "running";
      step.error = undefined;
      await deps.persistTask(task);

      // 重试时优先用保留的完整 messages 重建上下文；否则用截断版 outputs 摘要
      const history: ChatMessage[] = (() => {
        if (opts.fromStep != null && i >= opts.fromStep) {
          const saved: ChatMessage[] = [];
          let allSaved = true;
          for (let k = 0; k < i; k++) {
            const msgs = stepMessages.get(task.steps[k].id);
            if (msgs) saved.push(...msgs);
            else {
              allSaved = false;
              break;
            }
          }
          if (allSaved && saved.length > 0) {
            return [...saved, buildStepUserMsg(task, i)];
          }
        }
        return [buildStepUserMsg(task, i)];
      })();

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        timedOutAbort = true;
      }, stepTimeoutMs);

      try {
        const stepResult = await runAgentLoop(history, {
          ...baseDeps,
          baseSystemPrompt: EXECUTE_SYSTEM_PROMPT,
          onToolCalls: (calls) => {
            step.toolCalls.push(...calls);
          },
          onToolResult: (call, result: ExecuteToolResult) => {
            step.outputs.push(
              `${call.function.name}: ${truncate(result.output, MAX_OUTPUT_CHARS)}`,
            );
          },
        });
        clearTimeout(timer);

        if (stepResult.cancelled || stopped()) {
          if (timedOut) {
            step.status = "failed";
            step.error = "单步执行超时";
            task = { ...task, status: "failed" };
            await deps.persistTask(task);
          } else {
            // 取消：本轮未完成的步骤回到 pending（已收集数据保留供查看）
            step.status = "pending";
            task = { ...task, status: "cancelled" };
            await deps.persistTask(task);
          }
          return;
        }

        stepMessages.set(step.id, stepResult.messages);
        step.status = "done";
        await deps.persistTask(task);
      } catch (e) {
        clearTimeout(timer);
        const errorText = e instanceof Error ? e.message : String(e);
        step.status = "failed";
        step.error = errorText;
        task = { ...task, status: "failed" };
        await deps.persistTask(task);
        return;
      }
    }

    // ── 收尾：生成 result 总结（只读工具） ──
    let resultText: string | null = null;
    try {
      const wrap = await runAgentLoop(
        [
          createMessage({
            role: "user",
            content: `请总结以上任务「${task.title}」的执行结果：完成了什么、关键产物（文件路径/命令）、遗留问题。`,
          }),
        ],
        {
          ...baseDeps,
          tools: readOnlyTools(),
          baseSystemPrompt: WRAP_SYSTEM_PROMPT,
        },
      );
      if (!wrap.cancelled && !stopped()) resultText = wrap.finalContent;
    } catch (e) {
      console.error("[tasks] 收尾总结失败:", e);
    }
    if (stopped()) {
      task = { ...task, status: "cancelled" };
      await deps.persistTask(task);
      return;
    }
    task = {
      ...task,
      status: "done",
      // 收尾失败不影响任务完成：用已完步骤的完成说明兜底
      result:
        resultText ??
        task.steps
          .filter((s) => s.status === "done")
          .map((s) => s.label)
          .join(" → "),
    };
    await deps.persistTask(task);
  } catch (e) {
    // 规划阶段等回合失败（AgentLoopError，如无 API Key/网络错误）是预期路径，
    // 按 warn 记录；其余异常（代码缺陷类）按 error 记录。
    const errorText = e instanceof Error ? e.message : String(e);
    if (e instanceof AgentLoopError) {
      console.warn("[tasks] 任务回合失败（按预期处理）:", errorText);
    } else {
      console.error("[tasks] 任务循环异常:", errorText);
    }
    task = {
      ...task,
      status: "failed",
      error: errorText,
    };
    await deps.persistTask(task);
  }
}
