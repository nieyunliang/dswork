import {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useMount, useMemoizedFn } from "ahooks";
import { invoke } from "@tauri-apps/api/core";
import { useDeepSeekConfig } from "./useDeepSeekConfig";
import { useSkills } from "./useSkills";
import { runTaskLoop as runTaskLoopCore, type TaskLoopDeps } from "../utils/taskLoop";
import { FULL_TASK_TOOLS } from "../tools";
import type { ChatMessage, Skill, TaskRun, TaskSummary } from "../types";

/* ─────────────────────────────────────────────────────────
 * useTasks：任务执行模块状态层。
 * 执行编排在共享纯函数 runTaskLoop（src/utils/taskLoop.ts）；
 * 本 hook 只负责注入依赖（IPC/LLM/skill）、React 状态同步与防串台。
 * 同一时刻只跑一个任务（启动新任务会停止正在运行的任务）。
 * ───────────────────────────────────────────────────────── */

interface TasksContextType {
  tasks: TaskSummary[];
  currentTask: TaskRun | null;
  loading: boolean;
  refresh: () => Promise<void>;
  openTask: (id: string) => Promise<void>;
  createTask: (goal: string, sessionId?: string) => Promise<void>;
  cancelTask: (id: string) => Promise<void>;
  retryStep: (taskId: string, stepId: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
}

const TasksContext = createContext<TasksContextType | null>(null);

export function TasksProvider({ children }: { children: ReactNode }) {
  const { sendChatCompletion, executeToolCall } = useDeepSeekConfig();
  const { getSkill, skills } = useSkills();

  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [currentTask, setCurrentTask] = useState<TaskRun | null>(null);
  const [loading, setLoading] = useState(true);

  /** 防串台：每次启动循环 +1；旧循环的 stopSignal 因 seq 不匹配而停止，
      且旧循环的 UI 写入按任务 id 过滤，切任务后不会写错视图。 */
  const runSeqRef = useRef(0);
  /** 当前正在运行的任务 id（同一时刻只跑一个） */
  const activeTaskIdRef = useRef<string | null>(null);
  /** 每个任务独立的 skill 激活态（不与聊天/其它任务串） */
  const taskSkillsRef = useRef<Map<string, Skill>>(new Map());
  /** 每步完整 messages（供重试；未保留如重启后回退截断版 outputs 重建） */
  const stepMsgsRef = useRef<Map<string, ChatMessage[]>>(new Map());

  const refresh = useCallback(async () => {
    const list = await invoke<TaskSummary[]>("list_tasks");
    setTasks(list);
  }, []);

  const openTask = useCallback(async (id: string) => {
    const task = await invoke<TaskRun>("get_task", { id });
    setCurrentTask(task);
  }, []);

  useMount(() => {
    refresh().finally(() => setLoading(false));
  });

  /** 持久化 + 同步 UI（id 过滤，防串台）；不得抛出（循环依赖此约定） */
  const persistTask = useMemoizedFn(async (task: TaskRun) => {
    try {
      await invoke("update_task", { id: task.id, task });
    } catch (e) {
      console.error("[tasks] update_task 失败:", e);
    }
    setTasks((prev) =>
      prev.map((t) => (t.id === task.id ? toSummary(task) : t)),
    );
    setCurrentTask((prev) =>
      prev && prev.id === task.id ? { ...task } : prev,
    );
  });

  const runTaskLoop = useMemoizedFn(async (taskId: string, fromStep?: number) => {
    const seq = ++runSeqRef.current;
    taskSkillsRef.current = new Map();
    stepMsgsRef.current = new Map();
    activeTaskIdRef.current = taskId;

    const taskDeps: TaskLoopDeps = {
      getTask: (id) => invoke<TaskRun>("get_task", { id }),
      persistTask,
      generateTitle: (goal) => invoke<string>("generate_task_title", { goal }),
      complete: sendChatCompletion,
      executeTool: executeToolCall,
      getSkill,
      availableSkills: skills,
      tools: FULL_TASK_TOOLS,
    };

    try {
      await runTaskLoopCore(taskId, taskDeps, {
        fromStep,
        // 被取消/删除（cancelTask/deleteTask bump seq）或被更新的循环取代 → 停止
        stopSignal: () => seq !== runSeqRef.current,
        stepMessages: stepMsgsRef.current,
        activeSkills: taskSkillsRef.current,
      });
    } finally {
      if (activeTaskIdRef.current === taskId) {
        activeTaskIdRef.current = null;
      }
    }
  });

  const createTask = useMemoizedFn(async (goal: string, sessionId?: string) => {
    const task = await invoke<TaskRun>("create_task", {
      goal,
      sessionId: sessionId ?? null,
    });
    setTasks((prev) => [toSummary(task), ...prev]);
    setCurrentTask(task);
    // 启动新循环会自动使旧循环停止（seq 机制）；同一时刻只跑一个任务
    runTaskLoop(task.id);
  });

  const cancelTask = useMemoizedFn(async (id: string) => {
    try {
      await invoke("cancel_task", { id });
    } catch (e) {
      console.error("[tasks] cancel_task 失败:", e);
    }
    // 仅当该任务正是运行中的任务时，令循环在轮次边界停止
    // （不能无条件 bump seq：会误杀其它正在运行的任务循环）
    if (activeTaskIdRef.current === id) {
      runSeqRef.current += 1;
    }
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id && (t.status === "running" || t.status === "pending")
          ? { ...t, status: "cancelled" }
          : t,
      ),
    );
    setCurrentTask((prev) =>
      prev && prev.id === id && (prev.status === "running" || prev.status === "pending")
        ? { ...prev, status: "cancelled" }
        : prev,
    );
  });

  const retryStep = useMemoizedFn(async (taskId: string, stepId: string) => {
    const task = await invoke<TaskRun>("get_task", { id: taskId });
    const idx = task.steps.findIndex((s) => s.id === stepId);
    if (idx < 0) return;
    // 该步及其后重置为 pending，跳过阶段 1 重新执行
    for (let i = idx; i < task.steps.length; i++) {
      task.steps[i].status = "pending";
      task.steps[i].error = undefined;
      task.steps[i].toolCalls = [];
      task.steps[i].outputs = [];
    }
    task.status = "running";
    task.error = undefined;
    task.result = undefined;
    await invoke("update_task", { id: taskId, task });
    setCurrentTask((prev) => (prev?.id === taskId ? { ...task } : prev));
    refresh();
    runTaskLoop(taskId, idx);
  });

  const deleteTask = useMemoizedFn(async (id: string) => {
    // 删除前若在运行，先令其循环停止
    if (activeTaskIdRef.current === id) {
      runSeqRef.current += 1;
      activeTaskIdRef.current = null;
    }
    try {
      await invoke("delete_task", { id });
    } catch (e) {
      console.error("[tasks] delete_task 失败:", e);
    }
    setCurrentTask((prev) => (prev?.id === id ? null : prev));
    refresh();
  });

  return (
    <TasksContext.Provider
      value={{
        tasks,
        currentTask,
        loading,
        refresh,
        openTask,
        createTask,
        cancelTask,
        retryStep,
        deleteTask,
      }}
    >
      {children}
    </TasksContext.Provider>
  );
}

function toSummary(task: TaskRun): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    stepCount: task.steps.length,
    doneCount: task.steps.filter((s) => s.status === "done").length,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function useTasks(): TasksContextType {
  const ctx = useContext(TasksContext);
  if (!ctx) {
    throw new Error("useTasks must be used within a TasksProvider");
  }
  return ctx;
}
