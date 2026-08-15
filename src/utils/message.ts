import type { ChatMessage } from "../types";
import type { Row } from "../components/bui/ThinkingState";

export type MsgGroup =
  | { id: string; type: "msg"; msg: ChatMessage }
  | { id: string; type: "tools"; msgs: ChatMessage[] };

export function createMessage(message: Omit<ChatMessage, "id">): ChatMessage {
  return { id: crypto.randomUUID(), ...message };
}

export function groupMessages(messages: ChatMessage[]): MsgGroup[] {
  const result: MsgGroup[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    // 工具相关：tool 结果，或携带 tool_calls 的 assistant 消息。
    // 注意不要求 content 为空——带正文前言（如"我先看一下代码"）的首次工具
    // 调用回合也必须收进工具组：组内的前言气泡/推理由 ToolGroup 渲染，工具
    // 步骤统一进 Steps 轨迹。否则该消息会退化为普通消息，tool_calls 被裸渲染
    // 在组外（详见 ToolGroup buildItems 的孤立结果兜底）。
    const isToolRelated =
      m.role === "tool" ||
      (m.role === "assistant" && !!m.tool_calls?.length);
    if (isToolRelated) {
      const group: ChatMessage[] = [m];
      while (i + 1 < messages.length) {
        const next = messages[i + 1];
        if (
          next.role === "tool" ||
          (next.role === "assistant" && !!next.tool_calls?.length)
        ) {
          group.push(next);
          i++;
        } else break;
      }
      result.push({ id: group[0].id, type: "tools", msgs: group });
    } else {
      result.push({ id: m.id, type: "msg", msg: m });
    }
    i++;
  }
  return result;
}

/** Split reasoning prose into ThinkingState rows (paragraph = one row). */
export function reasoningToRows(reasoning?: string | null): Row[] {
  if (!reasoning) return [];
  return reasoning
    .split(/\n{2,}/)
    .map((p) => ({ primary: p.trim() }))
    .filter((r) => r.primary.length > 0);
}

export function parseSkillCommand(input: string): { name: string | null; rest: string } {
  const match = input.match(/^\/(\w[\w-]*)\s*(.*)$/s);
  if (!match) return { name: null, rest: input };
  return { name: match[1], rest: match[2] };
}
