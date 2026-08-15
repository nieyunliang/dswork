import type { TaskStep } from "../types";

/* ─────────────────────────────────────────────────────────
 * 任务规划纯函数（无 React 依赖，可独立单测）。
 * parsePlan：解析规划 JSON；失败退化为单步模式（整个目标一次性执行）。
 * ───────────────────────────────────────────────────────── */

export const MAX_STEPS = 30;

export function generateStepId(): string {
  return `step-${crypto.randomUUID().slice(0, 8)}`;
}

export function singleStep(goal: string): TaskStep {
  return {
    id: generateStepId(),
    label: goal,
    plan: "",
    status: "pending",
    toolCalls: [],
    outputs: [],
  };
}

export function planPrompt(goal: string): string {
  return `任务目标：${goal}\n\n请先规划完成任务所需的步骤列表。输出一个 JSON 数组（不要输出任何其它内容），数组每个元素为 {"label": "步骤标题（简短）", "plan": "该步骤的详细说明"}。步骤数量控制在 3-8 个。`;
}

/** 解析规划 JSON；失败退化为单步模式（整个目标一次性执行） */
export function parsePlan(content: string | null, goal: string): TaskStep[] {
  if (!content) return [singleStep(goal)];
  const text = content.replace(/```(?:json)?/g, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [singleStep(goal)];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed) || parsed.length === 0) return [singleStep(goal)];
    const steps: TaskStep[] = parsed
      .filter(
        (s): s is { label: unknown; plan?: unknown } =>
          !!s && typeof s === "object" && typeof (s as { label?: unknown }).label === "string",
      )
      .slice(0, MAX_STEPS)
      .map((s) => ({
        id: generateStepId(),
        label: s.label as string,
        plan: typeof s.plan === "string" ? s.plan : "",
        status: "pending" as const,
        toolCalls: [],
        outputs: [],
      }));
    return steps.length > 0 ? steps : [singleStep(goal)];
  } catch {
    return [singleStep(goal)];
  }
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[截断 ${s.length - max} 字符]`;
}
