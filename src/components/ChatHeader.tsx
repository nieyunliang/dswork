import { useState } from "react";
import { CheckSquare, Computer, Download, Folder, HalfMoon, Settings, SunLight } from "iconoir-react";
import { Button, Flex, Tooltip, Typography } from "antd";
import { useTheme } from "../hooks/useTheme";
import { useUpdater } from "../hooks/useUpdater";
import type { ThemeMode } from "../hooks/useTheme";
import { formatTokens } from "./bui/CacheStatsBadge";
import CwdModal from "./CwdModal";

const { Text } = Typography;

/** 当前会话累计的上下文缓存统计（由 App 从 messages 聚合而来） */
export interface SessionCacheStats {
  /** 累计命中缓存的 prompt tokens */
  hit: number;
  /** 累计未命中缓存的 prompt tokens */
  miss: number;
  /** 累计输出 tokens */
  completion: number;
  /** 携带 usage 的请求次数 */
  count: number;
}

interface ChatHeaderProps {
  title?: string;
  /** 会话级缓存统计汇总；无数据（如旧会话）时为 null，不渲染 chip */
  cacheStats?: SessionCacheStats | null;
  /** 当前会话工作目录（点击 chip 可修改） */
  cwd?: string;
  /** 修改会话工作目录（后端校验；失败时抛出，由弹窗提示） */
  onChangeCwd?: (cwd: string) => Promise<void>;
  onOpenSettings: () => void;
  onOpenTasks: () => void;
  /** 打开更新弹窗（badge 或按钮触发） */
  onOpenUpdates: () => void;
}

const iconProps = {
  width: 15,
  height: 15,
  strokeWidth: 1.8,
  "aria-hidden": true,
} as const;

const modeIcon: Record<ThemeMode, React.ReactNode> = {
  system: <Computer {...iconProps} />,
  light: <SunLight {...iconProps} />,
  dark: <HalfMoon {...iconProps} />,
};

const modeLabel: Record<ThemeMode, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

export default function ChatHeader({
  title,
  cacheStats,
  cwd,
  onChangeCwd,
  onOpenSettings,
  onOpenTasks,
  onOpenUpdates,
}: ChatHeaderProps) {
  const { mode, cycleMode } = useTheme();
  const { status: updaterStatus, updateInfo } = useUpdater();
  const [showCwdModal, setShowCwdModal] = useState(false);

  const statsNode = (() => {
    if (!cacheStats) return null;
    const promptTotal = cacheStats.hit + cacheStats.miss;
    if (promptTotal <= 0) return null;
    const hitRate = Math.round((cacheStats.hit / promptTotal) * 100);
    return (
      <Tooltip
        title={
          <div className="text-[12px] leading-relaxed">
            <div>
              缓存命中 <span className="tabular-nums">{cacheStats.hit.toLocaleString()}</span> tokens
            </div>
            <div>
              缓存未命中 <span className="tabular-nums">{cacheStats.miss.toLocaleString()}</span> tokens
            </div>
            <div>
              输出 <span className="tabular-nums">{cacheStats.completion.toLocaleString()}</span> tokens
            </div>
            <div>
              请求 <span className="tabular-nums">{cacheStats.count}</span> 次
            </div>
            <div>
              命中率 <span className="tabular-nums">{hitRate}%</span>
            </div>
          </div>
        }
      >
        <span className="inline-flex select-none items-center gap-1 rounded-full bg-field px-2 py-0.5 text-[11px] leading-none text-ink-3 tabular-nums">
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
          缓存 {hitRate}% · {formatTokens(promptTotal)} tokens
        </span>
      </Tooltip>
    );
  })();

  return (
    <div
      className="flex min-h-12 items-center justify-between border-b border-line bg-surface px-6 py-2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Text strong ellipsis style={{ fontSize: 16, minWidth: 0, flexShrink: 1 }}>
          {title ?? "dswork"}
        </Text>
        {cwd && (
          <Tooltip title={`工作目录：${cwd}（点击修改）`}>
            <Button
              type="text"
              size="small"
              icon={<Folder width={12} height={12} strokeWidth={2} aria-hidden="true" />}
              aria-label={`设置工作目录，当前 ${cwd}`}
              onClick={() => setShowCwdModal(true)}
              style={{ maxWidth: 280, paddingInline: 8 }}
            >
              <span
                className="block overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-ink-3"
                dir="ltr"
              >
                {cwd}
              </span>
            </Button>
          </Tooltip>
        )}
      </div>

      <Flex gap={12} align="center">
        {statsNode}
        {updaterStatus === "available" && updateInfo && (
          <Tooltip title={`发现新版本 v${updateInfo.version}，点击查看`}>
            <Button
              type="primary"
              size="small"
              icon={<Download width={13} height={13} strokeWidth={2} aria-hidden="true" />}
              onClick={onOpenUpdates}
            >
              v{updateInfo.version} 可更新
            </Button>
          </Tooltip>
        )}
        <Tooltip title="任务">
          <Button
            type="text"
            icon={<CheckSquare {...iconProps} />}
            aria-label="任务"
            onClick={onOpenTasks}
          />
        </Tooltip>
        <Tooltip title={modeLabel[mode]}>
          <Button
            type="text"
            icon={modeIcon[mode]}
            aria-label={`切换主题，当前${modeLabel[mode]}`}
            onClick={cycleMode}
          />
        </Tooltip>
        <Button
          type="text"
          icon={<Settings {...iconProps} />}
          aria-label="设置"
          onClick={onOpenSettings}
        />
      </Flex>

      <CwdModal
        open={showCwdModal}
        cwd={cwd ?? ""}
        onClose={() => setShowCwdModal(false)}
        onSave={onChangeCwd ?? (async () => {})}
      />
    </div>
  );
}
