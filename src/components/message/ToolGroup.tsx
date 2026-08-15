import ThinkingState, { type Row } from "../bui/ThinkingState";
import type { ChatMessage, ToolCall } from "../../types";
import AssistantMessage from "./AssistantMessage";

interface Props {
  messages: ChatMessage[];
}

type ToolStatus = "pending" | "success" | "error" | "denied";

type ToolItem = {
  id: string;
  name: string;
  args: string;
  output?: string | null;
  status: ToolStatus;
};

function getStatus(result?: ChatMessage): ToolStatus {
  if (!result) return "pending";
  if (result.content === "用户已拒绝此操作") return "denied";
  return result.content?.startsWith("错误:") ? "error" : "success";
}

function buildItems(messages: ChatMessage[]): ToolItem[] {
  const resultByCallId = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      resultByCallId.set(m.tool_call_id, m);
    }
  }

  const items: ToolItem[] = [];
  const matchedIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls as ToolCall[]) {
        const result = resultByCallId.get(tc.id);
        const a = tc.function.arguments;
        matchedIds.add(tc.id);
        items.push({
          id: tc.id,
          name: tc.function.name,
          args: a,
          output: result?.content,
          status: getStatus(result),
        });
      }
    }
  }

  // 孤立工具结果兜底：正常情况下所有 tool 结果都能与组内 assistant 消息的
  // tool_calls 配对（groupMessages 已把带前言的首个工具回合一并收进组）；
  // 仅当历史数据残缺（旧版本落盘 / 压缩截断）时才可能未配对，补进轨迹保列表完整。
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id && !matchedIds.has(m.tool_call_id)) {
      items.push({
        id: m.id,
        name: m.name ?? "tool",
        args: m.arguments ?? "",
        output: m.content,
        status: getStatus(m),
      });
    }
  }

  return items;
}

/* Map tool names to a short verb shown in the trace. */
function toolVerb(name: string): string {
  switch (name) {
    case "read_file":
    case "read_pdf_or_image":
      return "Read";
    case "write_file":
      return "Edit";
    case "list_dir":
      return "List";
    case "run_shell":
      return "Run";
    case "http_get":
    case "web_fetch":
      return "Fetch";
    case "web_search":
    case "file_search":
      return "Search";
    case "grep":
      return "Grep";
    case "ask_user":
      return "Ask";
    case "screenshot":
      return "Screenshot";
    default:
      return name;
  }
}

/* Pull a readable target (path / command / url / query) out of the JSON args. */
function toolTarget(args: string): string {
  try {
    const parsed = JSON.parse(args || "{}") as Record<string, unknown>;
    for (const key of ["path", "file_path", "dir", "command", "cmd", "url", "query", "pattern"]) {
      const val = parsed[key];
      if (typeof val === "string" && val) return val;
    }
  } catch {
    /* fall through to raw args */
  }
  return args.length > 40 ? args.slice(0, 40) + "…" : args;
}

export default function ToolGroup({ messages }: Props) {
  const items = buildItems(messages);
  // 组内 assistant 消息按消息序渲染：正文前言（content）走气泡，推理文本走
  // Reasoning 变体；工具调用本身不进气泡，统一由下方 Steps 轨迹展示。
  const preambles = messages.filter(
    (m) => m.role === "assistant" && (m.content?.trim() || m.reasoning?.trim()),
  );
  if (items.length === 0 && preambles.length === 0) return null;

  const rows: Row[] = items.map((item) => ({
    id: item.id,
    primary: toolVerb(item.name),
    secondary: toolTarget(item.args),
    mono: true,
    status:
      item.status === "pending"
        ? "pending"
        : item.status === "error" || item.status === "denied"
          ? "error"
          : "done",
  }));
  const working = items.some((item) => item.status === "pending");

  return (
    <div className="flex flex-col gap-2">
      {preambles.map((m) => (
        <AssistantMessage key={m.id} message={m} hideToolCalls />
      ))}
      {items.length > 0 && (
        <ThinkingState
          variant="Steps"
          auto={false}
          working={working}
          activeLabel={`正在运行 ${items.length} 个工具`}
          doneLabel={`运行了 ${items.length} 个工具`}
          rows={rows}
        />
      )}
    </div>
  );
}
