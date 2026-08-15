import { useEffect, useState } from "react";
import {
  App as AntdApp,
  Button,
  Divider,
  Drawer,
  Empty,
  Flex,
  Input,
  Tag,
  Typography,
} from "antd";
import TaskRows, { type Task, type TaskStatus } from "./bui/TaskRows";
import { useTasks } from "../hooks/useTasks";
import type { TaskRun, TaskStepStatus, TaskRunStatus } from "../types";

const { Text } = Typography;

const STATUS_TAG: Record<
  TaskRunStatus,
  { color: string; label: string }
> = {
  pending: { color: "default", label: "待运行" },
  running: { color: "processing", label: "运行中" },
  done: { color: "success", label: "已完成" },
  failed: { color: "error", label: "失败" },
  cancelled: { color: "warning", label: "已取消" },
};

const STEP_STATUS: Record<TaskStepStatus, TaskStatus> = {
  pending: "pending",
  running: "running",
  done: "done",
  failed: "failed",
};

function formatTime(secs: number): string {
  const d = new Date(secs * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function taskToRows(task: TaskRun): Task[] {
  const MAX_DISPLAY = 12000;
  return task.steps.map((step) => {
    const details = [];
    if (step.plan) {
      details.push({ label: "规划", kind: "text" as const, content: step.plan });
    }
    if (step.toolCalls.length > 0) {
      details.push({
        label: "参数",
        kind: "json" as const,
        content: JSON.stringify(step.toolCalls, null, 2),
      });
    }
    if (step.outputs.length > 0) {
      const joined = step.outputs.join("\n");
      details.push({
        label: "输出",
        kind: "json" as const,
        content: joined.length > MAX_DISPLAY ? `${joined.slice(0, MAX_DISPLAY)}…` : joined,
      });
    }
    if (step.error) {
      details.push({ label: "错误", kind: "text" as const, content: step.error });
    }
    return {
      key: step.id,
      label: step.label,
      status: STEP_STATUS[step.status],
      details,
    };
  });
}

interface TaskDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 创建任务时关联的聊天会话（可选） */
  sessionId?: string | null;
}

export default function TaskDrawer({ open, onClose, sessionId }: TaskDrawerProps) {
  const { message } = AntdApp.useApp();
  const {
    tasks,
    currentTask,
    createTask,
    cancelTask,
    retryStep,
    deleteTask,
    openTask,
  } = useTasks();
  const [goal, setGoal] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open && tasks.length > 0 && !currentTask) {
      openTask(tasks[0].id).catch((e) =>
        console.error("[tasks] 打开任务失败:", e),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tasks.length, currentTask]);

  async function handleCreate() {
    const trimmed = goal.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      await createTask(trimmed, sessionId ?? undefined);
      setGoal("");
      message.success("任务已创建并开始执行");
    } catch (e) {
      message.error(`创建任务失败: ${e}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleCancel() {
    if (!currentTask) return;
    await cancelTask(currentTask.id);
  }

  async function handleDelete() {
    if (!currentTask) return;
    await deleteTask(currentTask.id);
  }

  const running = currentTask?.status === "running";
  const taskTag = currentTask
    ? STATUS_TAG[currentTask.status]
    : { color: "default", label: "" };

  return (
    <Drawer
      title="任务"
      open={open}
      onClose={onClose}
      size={560}
      destroyOnHidden={false}
    >
      <Flex vertical gap={12} style={{ height: "100%" }}>
        {/* 新建任务 */}
        <Flex gap={8}>
          <Input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onPressEnter={handleCreate}
            placeholder="输入任务目标，例如：重构这个项目"
            aria-label="任务目标"
            variant="filled"
            disabled={creating}
          />
          <Button type="primary" onClick={handleCreate} loading={creating}>
            发起任务
          </Button>
        </Flex>

        <Divider style={{ margin: "4px 0" }} />

        <Flex style={{ flex: 1, minHeight: 0 }}>
          {/* 左侧：任务列表 */}
          <div
            className="w-44 shrink-0 overflow-y-auto border-r border-line pr-2"
            style={{ maxWidth: 190 }}
          >
            {tasks.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="暂无任务"
                style={{ marginTop: 32 }}
              />
            ) : (
              <Flex vertical gap={4}>
                {tasks.map((t) => {
                  const tag = STATUS_TAG[t.status];
                  const selected = currentTask?.id === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => openTask(t.id)}
                      className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 ${
                        selected ? "bg-inset" : "hover:bg-inset"
                      }`}
                    >
                      <span className="w-full truncate text-[13px] font-medium text-ink">
                        {t.title}
                      </span>
                      <span className="flex w-full items-center justify-between gap-1">
                        <Tag color={tag.color} style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: "18px" }}>
                          {tag.label}
                        </Tag>
                        <span className="text-[11px] text-ink-3 tabular-nums">
                          {t.doneCount}/{t.stepCount} · {formatTime(t.updatedAt)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </Flex>
            )}
          </div>

          {/* 右侧：当前任务详情 */}
          <div className="min-w-0 flex-1 overflow-y-auto pl-3">
            {!currentTask ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="选择左侧任务查看详情"
                style={{ marginTop: 32 }}
              />
            ) : (
              <Flex vertical gap={10}>
                <Flex align="center" justify="space-between" gap={8}>
                  <Flex vertical gap={2} style={{ minWidth: 0 }}>
                    <Text strong ellipsis style={{ fontSize: 15 }}>
                      {currentTask.title}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                      {currentTask.goal}
                    </Text>
                  </Flex>
                  <Flex gap={6} align="center" style={{ flexShrink: 0 }}>
                    <Tag color={taskTag.color}>{taskTag.label}</Tag>
                    {running && (
                      <Button size="small" onClick={handleCancel}>
                        取消
                      </Button>
                    )}
                    {currentTask.status !== "running" &&
                      currentTask.status !== "pending" && (
                        <Button size="small" danger onClick={handleDelete}>
                          删除
                        </Button>
                      )}
                  </Flex>
                </Flex>

                {currentTask.error && (
                  <Text type="danger" style={{ fontSize: 12 }}>
                    任务错误：{currentTask.error}
                  </Text>
                )}

                {currentTask.steps.length > 0 ? (
                  <TaskRows
                    variant="List"
                    tasks={taskToRows(currentTask)}
                    working={running}
                    label={running ? "正在执行" : "步骤"}
                    doneLabel="完成"
                    failedLabel="失败"
                  />
                ) : (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="正在规划步骤…"
                  />
                )}

                {currentTask.result && (
                  <>
                    <Divider style={{ margin: "4px 0" }} />
                    <Text strong style={{ fontSize: 13 }}>
                      结果总结
                    </Text>
                    <Text
                      style={{
                        fontSize: 12.5,
                        lineHeight: 1.7,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {currentTask.result}
                    </Text>
                  </>
                )}

                {/* 失败步骤的重试入口 */}
                {currentTask.steps.some((s) => s.status === "failed") &&
                  currentTask.status !== "running" && (
                    <Flex gap={8} wrap>
                      {currentTask.steps
                        .filter((s) => s.status === "failed")
                        .map((s) => (
                          <Button
                            key={s.id}
                            size="small"
                            onClick={() => retryStep(currentTask!.id, s.id)}
                          >
                            重试「{s.label.length > 12 ? `${s.label.slice(0, 12)}…` : s.label}」
                          </Button>
                        ))}
                    </Flex>
                  )}
              </Flex>
            )}
          </div>
        </Flex>
      </Flex>
    </Drawer>
  );
}
