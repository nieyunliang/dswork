import type { ChatMessage } from "../../types";

interface ToolMessageProps {
  message: ChatMessage;
}

export default function ToolMessage({ message }: ToolMessageProps) {
  const isError = message.content === null || message.name === "error";
  const name = message.name ?? "tool";
  const args = message.arguments;

  return (
    <details className="max-w-[80%] self-start">
      <summary className={`flex cursor-pointer items-center gap-1 select-none ${isError ? "text-red" : "text-ink-3"}`}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
        </svg>
        <span className={`text-[12px] ${isError ? "text-red" : "text-ink-2"}`}>{name}</span>
        {args && (
          <span className="font-mono text-[11px] text-ink-2">
            {args.length > 60 ? args.slice(0, 60) + "…" : args}
          </span>
        )}
      </summary>
      <pre className={`mt-1 ml-4 font-mono text-[12px] whitespace-pre-wrap break-all ${isError ? "text-red" : "text-ink-2"}`}>
        {message.content ?? ""}
      </pre>
    </details>
  );
}
