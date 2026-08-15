import type { ChatMessage } from "../../types";

interface SystemMessageProps {
  message: ChatMessage;
}

export default function SystemMessage({ message }: SystemMessageProps) {
  const content = message.content ?? "";

  return (
    <details
      className="my-1 mx-auto max-w-[80%] self-stretch rounded-[8px] border border-dashed border-line-strong bg-inset px-3 py-1.5"
    >
      <summary className="flex cursor-pointer items-center justify-center gap-1.5 select-none">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
        <span className="text-[12px] text-ink-2">早期对话已压缩为摘要，点击展开查看</span>
      </summary>
      <pre className="mt-1 text-[12px] text-ink-2 whitespace-pre-wrap break-all">
        {content}
      </pre>
    </details>
  );
}
