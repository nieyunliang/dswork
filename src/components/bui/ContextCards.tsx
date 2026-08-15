
import { useEffect, useState } from "react";
import type { ContextChunk } from "../../types";

/* ─────────────────────────────────────────────────────────
 * CONTEXT CARDS
 * Retrieved chunks enter once, then remain available.
 * ───────────────────────────────────────────────────────── */

/** ContextChunk 定义见 src/types.ts（前后端共享的数据契约）。 */
export type { ContextChunk } from "../../types";

interface ContextCardsProps {
  chunks?: ContextChunk[];
  /** 顶部「All chunks」计数；缺省取 chunks.length */
  total?: number;
  /** 提供后，来源 chip 变为可点击按钮（用于打开源文件/定位原文） */
  onOpenSource?: (chunk: ContextChunk) => void;
}

const DEFAULT_TONE = "bg-accent";

export default function ContextCards({
  chunks = [
    {
      id: "demo-1",
      title: "Vendor onboarding rule",
      chars: "290 characters",
      body: "Cold-chain certification must be verified before a new dairy can be added to the reorder workflow.",
      source: "Dairy Onboarding SOP.pdf",
      badge: "PDF",
      tone: "bg-red",
    },
    {
      id: "demo-2",
      title: "Seasonal demand row",
      chars: "1,250 characters",
      body: "Q4 velocity table: pistachio +18%, vanilla +6%, rocky road -11%; retire flavors below 40 scoops weekly.",
      source: "Sales Velocity Export.csv",
      badge: "CSV",
      tone: "bg-green",
    },
  ],
  total = chunks.length,
  onOpenSource,
}: ContextCardsProps) {
  const [chipsShown, setChipsShown] = useState(false);

  useEffect(() => {
    const chips = setTimeout(() => setChipsShown(true), 700);
    return () => clearTimeout(chips);
  }, []);

  return (
    <div className="flex w-full max-w-95 flex-col gap-2">
      <div
        className="flex items-center gap-2 px-0.5"
        style={{ animation: "fade-in 400ms ease-out both" }}
      >
        <span className="text-[13px] font-semibold text-ink">All chunks</span>
        <span className="inline-flex h-5 items-center rounded-md bg-inset px-1.5 text-[11.5px] font-medium text-ink-2 shadow-hairline tabular-nums">
          {total}
        </span>
      </div>

      {chunks.length === 0 && (
        <div className="flex items-center justify-center rounded-card border border-dashed border-line bg-surface px-4 py-8">
          <span className="text-[12.5px] text-ink-3">
            No context chunks retrieved yet
          </span>
        </div>
      )}

      {chunks.map((chunk, i) => (
        <div
          key={chunk.id ?? `${i}-${chunk.title}`}
          className="overflow-hidden rounded-card bg-surface shadow-card"
          style={{
            animation: `fade-up 400ms cubic-bezier(0.23,1,0.32,1) ${i * 100}ms both`,
          }}
        >
          <div className="primitive-card-bar flex items-center gap-2.5 border-b border-line">
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
              <span className="min-w-0 truncate">{chunk.title}</span>
            </span>
            {chunk.chars && (
              <span className="ml-auto shrink-0 text-[12px] text-ink-3 tabular-nums">{chunk.chars}</span>
            )}
          </div>
          <p className="px-3 pt-2 pb-1 text-[12.5px] leading-relaxed text-ink-2">
            {chunk.body}
          </p>
          <div className="px-3 pb-3">
            {onOpenSource ? (
              <button
                type="button"
                aria-label={`Open source: ${chunk.source}`}
                onClick={() => onOpenSource(chunk)}
                className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full bg-inset px-2
                  text-[12px] font-medium text-ink-2 shadow-btn
                  transition-[opacity,transform,background-color] duration-300 hover:bg-hover"
                style={{
                  opacity: chipsShown ? 1 : 0,
                  transform: chipsShown ? "scale(1)" : "scale(0.95)",
                  transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
                  transitionDelay: `${i * 80}ms`,
                }}
              >
                <span className={`flex size-3.5 items-center justify-center rounded-[4px] ${chunk.tone ?? DEFAULT_TONE} text-[7px] font-bold text-white`}>
                  {chunk.badge}
                </span>
                <span className="min-w-0 truncate" style={{ maxWidth: 200 }}>{chunk.source}</span>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17L17 7M7 7h10v10" /></svg>
              </button>
            ) : (
              <span
                className="inline-flex h-6 items-center gap-1.5 rounded-full bg-inset px-2
                  text-[12px] font-medium text-ink-2 shadow-btn
                  transition-[opacity,transform] duration-300"
                style={{
                  opacity: chipsShown ? 1 : 0,
                  transform: chipsShown ? "scale(1)" : "scale(0.95)",
                  transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
                  transitionDelay: `${i * 80}ms`,
                }}
              >
                <span className={`flex size-3.5 items-center justify-center rounded-[4px] ${chunk.tone ?? DEFAULT_TONE} text-[7px] font-bold text-white`}>
                  {chunk.badge}
                </span>
                <span className="min-w-0 truncate" style={{ maxWidth: 200 }}>{chunk.source}</span>
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
