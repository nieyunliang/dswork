import { Children, useCallback, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { App as AntdApp } from "antd";
import { openPath } from "@tauri-apps/plugin-opener";
import { Check, Copy } from "iconoir-react";
import CodeBlock from "../bui/CodeBlock";
import ThinkingState from "../bui/ThinkingState";
import ContextCards from "../bui/ContextCards";
import CacheStatsBadge from "../bui/CacheStatsBadge";
import { reasoningToRows } from "../../utils/message";
import type { ChatMessage, ContextChunk } from "../../types";

interface AssistantMessageProps {
  message: ChatMessage;
  /** 隐藏内联 tool_calls 列表：消息已进入 ToolGroup 时，工具步骤统一由组内的
      Steps 轨迹渲染，不再裸露展示。正常渲染路径（groupMessages）下所有带
      tool_calls 的 assistant 消息都会进组，此列表仅作兜底保留。 */
  hideToolCalls?: boolean;
}

/* Extract { code, language } from a fenced-block <pre> whose child <code>
   carries a language-xxx class (react-markdown + remark-gfm shape). */
function extractCodeBlock(children: React.ReactNode): { code: string; language: string } {
  let code = "";
  let language = "";
  const child = Children.toArray(children)[0] as
    | React.ReactElement<{ children?: React.ReactNode; className?: string }>
    | undefined;
  if (child?.props) {
    code = String(child.props.children ?? "");
    const match = /language-([\w+-]+)/.exec(String(child.props.className ?? ""));
    if (match) language = match[1];
  }
  return { code, language };
}

export default function AssistantMessage({
  message,
  hideToolCalls = false,
}: AssistantMessageProps) {
  const { message: antdMessage } = AntdApp.useApp();
  const [copied, setCopied] = useState(false);

  /* 含代码块时气泡拉满整列宽（代码块需要尽可能宽的可读区域）；
     否则气泡按文本 shrink-to-fit 保持 70% 上限。 */
  const hasFence = /```/.test(message.content ?? "");

  /* 复制整条回复的原文（Markdown 源码）。成功后图标短暂切换为对勾。 */
  const handleCopy = useCallback(async () => {
    if (!message.content) return;
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      antdMessage.warning("复制失败");
    }
  }, [message.content, antdMessage]);

  /* 来源 chip 点击：Tauri 环境用系统默认应用打开 source 路径；
     Web 预览环境无插件，仅提示已接通回调（真实打开行为属后续阶段）。 */
  const handleOpenSource = useCallback(
    async (chunk: ContextChunk) => {
      if (!("__TAURI_INTERNALS__" in window)) {
        antdMessage.info(`来源：${chunk.source}（Web 预览模式，打开文件待接入）`);
        return;
      }
      try {
        await openPath(chunk.source);
      } catch {
        antdMessage.warning(`无法打开来源文件：${chunk.source}`);
      }
    },
    [antdMessage],
  );

  return (
    <div className="flex flex-col items-start gap-1">
      {!hideToolCalls && message.tool_calls?.map((tc) => {
        const args = tc.function.arguments;
        const preview = args.length > 60 ? args.slice(0, 60) + "…" : args;
        return (
          <details key={tc.id} className="max-w-[80%] self-start">
            <summary className="flex cursor-pointer items-center gap-1 text-ink-3 select-none">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
              </svg>
              <span className="text-[12px] text-ink-2">{tc.function.name}</span>
              <span className="font-mono text-[11px] text-ink-3">{preview}</span>
            </summary>
            <pre className="mt-1 ml-4 font-mono text-[12px] text-ink-2 whitespace-pre-wrap break-all">
              {args}
            </pre>
          </details>
        );
      })}
      {message.reasoning?.trim() && (
        <ThinkingState
          variant="Reasoning"
          auto={false}
          working={false}
          activeLabel="正在思考"
          doneLabel="思考过程"
          rows={reasoningToRows(message.reasoning)}
        />
      )}
      {message.context !== undefined && (
        <ContextCards chunks={message.context} onOpenSource={handleOpenSource} />
      )}
      {message.content && (
        <div
          className={`group relative rounded-[10px] bg-surface px-3 py-2 shadow-card ${
            hasFence ? "w-full" : "max-w-[70%]"
          }`}
        >
          {/* 复制整条回复：悬停气泡时在右下角浮现；成功时切换为对勾。
              按钮位于气泡内部右下角，不会溢出气泡外缘。 */}
          <button
            type="button"
            aria-label={copied ? "已复制" : "复制回复"}
            title={copied ? "已复制" : "复制回复"}
            onClick={handleCopy}
            style={{ bottom: 6, right: 6 }}
            className={`absolute z-10 flex size-6 items-center justify-center rounded-full bg-surface shadow-card transition-[opacity,transform] duration-150 group-hover:opacity-100 group-focus-within:opacity-100 active:scale-[0.94] ${
              copied
                ? "text-green opacity-100"
                : "text-ink-3 opacity-0 hover:text-ink"
            }`}
          >
            {copied ? (
              <Check width="13" height="13" strokeWidth="2.2" aria-hidden="true" />
            ) : (
              <Copy width="13" height="13" strokeWidth="2" aria-hidden="true" />
            )}
          </button>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => (
                <p className="my-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{children}</p>
              ),
              pre: ({ children }) => {
                const { code, language } = extractCodeBlock(children);
                return (
                  <CodeBlock
                    code={code}
                    language={language || "text"}
                    filename={language ? `code.${language}` : "code.txt"}
                    animate={false}
                  />
                );
              },
              code: ({ children }) => (
                <code className="rounded-[3px] bg-inset px-1 py-px font-mono text-[12px] text-ink-2">
                  {children}
                </code>
              ),
              table: ({ children }) => (
                <table className="my-1 w-full border-collapse text-[13px]">{children}</table>
              ),
              th: ({ children }) => (
                <th className="border border-line bg-inset px-2 py-1 text-left text-ink-2">
                  {children}
                </th>
              ),
              td: ({ children }) => (
                <td className="border border-line px-2 py-1 text-ink">{children}</td>
              ),
            }}
          >
            {message.content ?? ""}
          </ReactMarkdown>
        </div>
      )}
      {message.usage && <CacheStatsBadge usage={message.usage} />}
    </div>
  );
}
