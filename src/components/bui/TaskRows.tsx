
import { useState } from "react";
import CodeBlock from "./CodeBlock";

/* ─────────────────────────────────────────────────────────
 * TASK ROWS
 * Data-driven expandable task list: each row shows a status
 * badge (pending / running / done / failed), an optional
 * amount, and expandable detail steps. Two variants:
 * "Capsules" (standalone cards) and "List" (bordered rows).
 * Rows enter staggered; each row expands/collapses on click.
 * ───────────────────────────────────────────────────────── */

export type TaskStatus = "pending" | "running" | "done" | "failed";

/** 富详情：text 单行展示；json 按 pretty-print 的多行等宽块展示；
    code 走 CodeBlock（language 为展示用标签，如 "json"）。 */
export type TaskDetail = {
  label: string;
  kind: "text" | "json" | "code";
  content: string;
  language?: string;
};

export type Task = {
  key: string;
  label: string;
  amount?: string;
  status: TaskStatus;
  details?: TaskDetail[];
};

function SpinnerRing({ active, children }: { active?: boolean; children?: React.ReactNode }) {
  const size = 24, stroke = 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg
        width={size} height={size} className="absolute inset-0"
        style={active ? { animation: "spin 1.1s linear infinite" } : undefined}
      >
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={stroke} />
        {active && (
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none"
            stroke="var(--ink-3)" strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={`${c * 0.28} ${c * 0.72}`}
          />
        )}
      </svg>
      <span className="relative text-[10.5px] font-semibold tabular-nums text-ink">{children}</span>
    </span>
  );
}

function Badge({ tone, children }: { tone: "red" | "green"; children: React.ReactNode }) {
  return (
    <span
      className={`flex size-5.5 shrink-0 items-center justify-center rounded-full text-white
        ${tone === "red" ? "bg-red" : "bg-green"}`}
      style={{ animation: "pop-in 300ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      {children}
    </span>
  );
}

const XIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
);
const CheckIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
);
const RetryIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></svg>
);

function taskBadge(status: TaskStatus, number: number): React.ReactNode {
  switch (status) {
    case "done":
      return <Badge tone="green">{CheckIcon}</Badge>;
    case "failed":
      return <Badge tone="red">{XIcon}</Badge>;
    case "running":
      return <SpinnerRing active>{number}</SpinnerRing>;
    case "pending":
      return <SpinnerRing>{number}</SpinnerRing>;
  }
}

function taskPill(status: TaskStatus, doneLabel: string, failedLabel: string): React.ReactNode {
  switch (status) {
    case "done":
      return (
        <span className="inline-flex h-5.5 items-center gap-1.5 rounded-full bg-green-tint px-2 text-[11.5px] font-medium text-green" style={{ animation: "fade-in 200ms ease-out both" }}>
          {doneLabel}
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex h-5.5 items-center gap-1.5 rounded-full bg-red-tint px-2 text-[11.5px] font-medium text-red" style={{ animation: "fade-in 200ms ease-out both" }}>
          {failedLabel} <span style={{ animation: "spin 1.2s linear infinite" }} className="flex">{RetryIcon}</span>
        </span>
      );
    case "running":
    case "pending":
      return null;
  }
}

interface TaskRowsProps {
  tasks: Task[];
  variant?: "Capsules" | "List";
  /** Optional header line above the list (e.g. "正在运行 3 个工具"). */
  label?: string;
  /** Pass while tasks are still executing to render the header shimmering. */
  working?: boolean;
  /** Pill text for done rows (default "Completed"). */
  doneLabel?: string;
  /** Pill text for failed rows (default "Failed"). */
  failedLabel?: string;
}

export default function TaskRows({
  tasks,
  variant = "Capsules",
  label,
  working = false,
  doneLabel = "Completed",
  failedLabel = "Failed",
}: TaskRowsProps) {
  const [manualOpen, setManualOpen] = useState<Record<string, boolean>>({});

  const rows = tasks.map((task, i) => ({
    ...task,
    badge: taskBadge(task.status, i + 1),
    pill: taskPill(task.status, doneLabel, failedLabel),
  }));

  const list = variant === "List";
  return (
    <div className="flex w-full flex-col">
      {label && (
        <div className="mb-1 flex items-center gap-2 px-0.5">
          {working ? (
            <span
              className="bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
                backgroundSize: "200% 100%",
                animation: "shimmer-text 1.4s linear infinite",
              }}
            >
              {label}
            </span>
          ) : (
            <span
              className="text-[13px] font-medium whitespace-nowrap text-ink-2"
              style={{ animation: "fade-in 350ms ease-out both" }}
            >
              {label}
            </span>
          )}
        </div>
      )}

      <div
        className={`flex w-full max-w-110 flex-col ${
          list ? "gap-0 self-start overflow-hidden rounded-card bg-surface shadow-card" : "min-h-[196px] gap-2"
        }`}
      >
        {rows.map((row, i) => {
          const hasDetails = !!row.details?.length;
          const open = manualOpen[row.key] ?? false;
          return (
            <div
              key={row.key}
              className={`self-stretch overflow-hidden transition-[border-radius] duration-300 ${
                list ? "border-b border-line last:border-0" : "bg-surface shadow-card"
              }`}
              style={{
                borderRadius: list ? 0 : open ? 14 : 22,
                animation: `fade-up 450ms cubic-bezier(0.23,1,0.32,1) ${i * 80}ms both`,
              }}
            >
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setManualOpen((current) => ({ ...current, [row.key]: !open }))}
                className="flex h-11 w-full items-center gap-2.5 px-2.5 text-left transition-colors duration-100 hover:bg-inset"
              >
                <span className="flex size-6 shrink-0 items-center justify-center">
                  {row.badge}
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                  {row.label}
                </span>
                {row.amount && (
                  <span className="text-[12.5px] text-ink-2 tabular-nums">{row.amount}</span>
                )}
                {row.pill}
                {hasDetails && (
                  <span
                    aria-hidden="true"
                    className="-ml-2 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3"
                  >
                    <svg
                      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                      className="transition-transform duration-300"
                      style={{ transform: open ? "rotate(180deg)" : "rotate(0)" }}
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </span>
                )}
              </button>

              {/* dropdown detail — expandable grammar shared with ThinkingState */}
              {hasDetails && (
                <div
                  className="grid transition-[grid-template-rows,opacity] duration-300"
                    style={{
                      gridTemplateRows: open ? "1fr" : "0fr",
                      opacity: open ? 1 : 0,
                      transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
                    }}
                  >
                  <div className="overflow-hidden">
                    <div className="mb-2.5 grid grid-cols-[24px_1fr] gap-2.5 px-2.5">
                      <span aria-hidden className="mx-auto h-full w-px bg-line" />
                      <div className="flex min-w-0 flex-col gap-2">
                        {row.details!.map((d, j) => (
                          <div
                            key={d.label}
                            className="flex min-w-0 flex-col gap-1"
                            style={
                              open
                                ? { animation: `fade-up 300ms cubic-bezier(0.23,1,0.32,1) ${120 + j * 100}ms both` }
                                : undefined
                            }
                          >
                            <span className="shrink-0 text-[12px] text-ink-2">{d.label}</span>
                            {d.kind === "text" ? (
                              <span
                                className="min-w-0 whitespace-pre-wrap font-mono text-[11.5px] leading-[1.6] text-ink-3 tabular-nums"
                                style={{ overflowWrap: "anywhere" }}
                              >
                                {d.content}
                              </span>
                            ) : d.kind === "json" ? (
                              <pre
                                className="overflow-auto whitespace-pre rounded-card bg-inset px-2.5 py-2 font-mono text-[11.5px] leading-[1.7] text-ink-2 tabular-nums"
                                style={{ maxHeight: 256 }}
                              >
                                {d.content}
                              </pre>
                            ) : (
                              <CodeBlock
                                code={d.content}
                                language={d.language ?? "text"}
                                filename={d.label}
                                animate={false}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
