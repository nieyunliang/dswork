import { useCallback, useEffect, useMemo, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * CODE BLOCK
 * Agent-written code streams line by line; copy is live.
 * Demo content is the default; pass `code` to render real
 * snippets (e.g. from markdown fenced blocks).
 * ───────────────────────────────────────────────────────── */

const LINE_MS = 240;
const HOLD_MS = 3200;

type Tok = { t: string; c?: "kw" | "str" | "num" | "fn" | "dim" };

const DEMO_CODE = `export async function churnBatch() {
  const flavor = await getFlavor("pistachio");
  const base = await dairy.fetch({ flavor });
  await freezer.store(base, { temp: "-14C" });
  return base.gallons;
}`;

const COLORS: Record<string, string> = {
  kw: "var(--accent-ink)",
  str: "var(--green)",
  num: "var(--orange)",
  fn: "var(--ink)",
  dim: "var(--ink-3)",
};

export default function CodeBlock({
  code = DEMO_CODE,
  language = "TypeScript",
  filename = "churn.ts",
  animate = true,
}: {
  code?: string;
  language?: string;
  filename?: string;
  animate?: boolean;
}) {
  const lines = useMemo<Tok[][]>(
    () => code.split("\n").map((line) => [{ t: line }]),
    [code],
  );
  const [count, setCount] = useState(animate ? 0 : lines.length);
  const [copied, setCopied] = useState(false);
  const done = count >= lines.length;

  useEffect(() => {
    if (!animate) return;
    const t = setTimeout(
      () => setCount((c) => (c >= lines.length ? 0 : c + 1)),
      count === 0 ? 400 : done ? HOLD_MS : LINE_MS,
    );
    return () => clearTimeout(t);
  }, [count, done, animate, lines.length]);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  return (
    <div className="w-full overflow-hidden rounded-card bg-surface shadow-card">
      {/* header */}
      <div className="primitive-card-bar flex items-center justify-between border-b border-line">
        <span className="flex items-baseline gap-2">
          <span className="font-mono text-[12px] font-medium text-ink">{filename}</span>
          <span className="text-[11.5px] text-ink-3">{language}</span>
        </span>
        <button
          aria-label="Copy code"
          onClick={copy}
          className={`flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px]
            font-medium transition-colors duration-100 hover:bg-hover
            ${copied ? "text-green" : "text-ink-3 hover:text-ink"}`}
        >
          {copied ? (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {/* code */}
      <pre
        className={`overflow-auto bg-inset px-3 py-2.5 font-mono text-[11.5px] leading-[1.7] ${
          animate ? "min-h-[137px]" : ""
        }`}
        style={{ maxHeight: 420 }}
      >
        {lines.slice(0, count).map((line, i) => (
          <div
            key={i}
            className="flex"
            style={{ animation: "fade-up 250ms cubic-bezier(0.23,1,0.32,1) both" }}
          >
            <span className="w-5 shrink-0 text-right text-[10.5px] leading-[1.86] text-ink-3/60 select-none">
              {i + 1}
            </span>
            <span className="pl-2.5 whitespace-pre">
              {line.map((tok, j) => (
                <span key={j} style={{ color: tok.c ? COLORS[tok.c] : "var(--ink-2)" }}>
                  {tok.t}
                </span>
              ))}
              {i === count - 1 && !done && (
                <span className="ml-0.5 inline-block h-3 w-[3px] translate-y-0.5 rounded-full bg-accent" />
              )}
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
}
