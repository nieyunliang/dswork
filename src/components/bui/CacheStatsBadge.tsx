import type { UsageStats } from "../../types";

/** 紧凑数字格式化：1_234 → "1.2k"，2_345_678 → "2.3M" */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface CacheStatsBadgeProps {
  usage?: UsageStats;
}

/** 单次请求的上下文缓存统计徽标：命中 / 未命中 tokens 与命中率。
    无 usage（旧会话或端点未返回）或总 prompt tokens 为 0 时不渲染。 */
export default function CacheStatsBadge({ usage }: CacheStatsBadgeProps) {
  if (!usage) return null;
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? 0;
  const promptTotal = hit + miss;
  if (promptTotal <= 0) return null;
  const hitRate = Math.round((hit / promptTotal) * 100);

  return (
    <span
      className="inline-flex select-none items-center gap-1 rounded-full bg-field px-2 py-0.5 text-[11px] leading-none text-ink-3 tabular-nums"
      title={`缓存命中 ${hit.toLocaleString()} / 未命中 ${miss.toLocaleString()} tokens`}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
      </svg>
      缓存 {formatTokens(hit)} / {formatTokens(miss)} · 命中率 {hitRate}%
    </span>
  );
}
