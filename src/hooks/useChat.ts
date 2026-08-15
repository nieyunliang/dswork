import { useEffect, useRef, useState } from "react";
import { useMemoizedFn, useUpdateEffect } from "ahooks";
import { useDeepSeekConfig } from "./useDeepSeekConfig";
import { useSessions } from "./useSessions";
import { useSkills } from "./useSkills";
import { createMessage, parseSkillCommand } from "../utils/message";
import { AgentLoopError, runAgentLoop } from "../utils/agentLoop";
import { TOOLS } from "../tools";
import type { ChatMessage, ReasoningLevel, Skill } from "../types";

const COMPACT_MSG_THRESHOLD = 48;
// 压缩触发按「估算 tokens」计（约 40k tokens）：把压缩推迟到接近上下文窗口才触发。
// 缓存命中价 ≈ 全价的 1/10，长历史重发几乎免费——压缩的唯一理由是上下文窗口，
// 而不是省钱；过早压缩 = 周期性全前缀替换（每次一次全量 miss）+ 永久丢失历史细节。
// （旧阈值 16k 字符 ≈ 8-16k tokens，不足上下文窗口的 1/4，触发即烧一次全量缓存。）
const COMPACT_EST_TOKENS_THRESHOLD = 40_000;
const KEEP_RECENT = 10;

/** 粗略 token 估算：CJK 字符 ≈ 1 token/字，其余字符 ≈ 0.25 token/字符（英文/代码）。
 *  只用于压缩阈值判定，非精确计费。 */
function estimateMessageTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    const c = m.content ?? "";
    let cjk = 0;
    for (let i = 0; i < c.length; i++) {
      const code = c.charCodeAt(i);
      if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
        cjk++;
      }
    }
    total += cjk + Math.ceil((c.length - cjk) * 0.25);
  }
  return total;
}

export function useChat() {
  const { sendChatCompletion, summarizeMessages, executeToolCall } =
    useDeepSeekConfig();
  const {
    messages,
    currentSessionId,
    activeSkills,
    cwd,
    persistMessages,
    saveActiveSkills,
    autoTitleSession,
  } = useSessions();
  const { getSkill, skills } = useSkills();

  const [sending, setSending] = useState(false);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [streamingReasoning, setStreamingReasoning] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  // 当前会话已激活的 skill：逻辑层用 ref（异步循环内读取安全），UI 层用 state 镜像。
  // 持久化到会话（saveActiveSkills），切换会话 / 重启后恢复——保证 system 前缀
  // 不因内存态丢失而静默回退（回退 = 下一次请求整段缓存 miss，实测 6.4 万 tokens）。
  const activeSkillsRef = useRef<Map<string, Skill>>(new Map());
  const [activeSkillNames, setActiveSkillNames] = useState<string[]>([]);

  // Per-turn identity so a stream from a session the user has since switched
  // away from never bleeds onto the current view, and so the finally block of
  // an older turn can't clobber a newer turn's UI state. `turnRef` is bumped
  // on every send; a callback only drives the UI while it is the latest turn
  // AND its session is still the one on screen.
  const turnRef = useRef(0);
  const streamSessionRef = useRef<string | null>(null);
  const currentSessionRef = useRef(currentSessionId);
  currentSessionRef.current = currentSessionId;
  // 当前会话工作目录的 ref 镜像：send 开始时钉住（与 sessionId 同理，
  // 中途切会话/改目录不影响已钉住回合的工具执行基准）。
  const currentCwdRef = useRef(cwd);
  currentCwdRef.current = cwd;

  // 会话切换 / 首次挂载：恢复该会话持久化的活跃 skill。
  // 原实现是切走即清空（内存态），切回后 system 前缀回退到「无 skill」版本，
  // 与缓存里已积累的「base + skill」前缀逐字节不一致 → 下一次请求整段 miss。
  // 恢复后 system 字节与切走前完全一致，缓存前缀不再断裂。
  // （getSkill 是异步的：用捕获的 sessionId 守卫，快速连续切换时旧 fetch 不覆盖新会话。）
  useEffect(() => {
    const sessionId = currentSessionId;
    if (!sessionId) return;
    const names = activeSkills ?? [];
    (async () => {
      const restored = new Map<string, Skill>();
      for (const name of names) {
        try {
          const skill = await getSkill(name);
          restored.set(name, skill);
        } catch {
          // skill 已被删除：跳过，不阻塞恢复
        }
      }
      if (sessionId === currentSessionRef.current) {
        activeSkillsRef.current = restored;
        setActiveSkillNames([...restored.keys()]);
      }
    })();
  }, [currentSessionId]);

  // 切换会话时中止旧回合的流式 UI，让新会话立即可用。
  // 被放弃的回合本身继续在后台运行，仍持久化到它钉住的会话，只是不再渲染到这里。
  useUpdateEffect(() => {
    if (streamSessionRef.current !== currentSessionId) {
      setSending(false);
      setStreamingContent(null);
      setStreamingReasoning(null);
    }
  }, [currentSessionId]);

  const maybeCompact = useMemoizedFn(
    async (msgs: ChatMessage[]): Promise<ChatMessage[] | null> => {
      const totalTokens = estimateMessageTokens(msgs);
      if (
        msgs.length <= COMPACT_MSG_THRESHOLD &&
        totalTokens <= COMPACT_EST_TOKENS_THRESHOLD
      ) {
        return null;
      }

      let boundary = Math.max(1, msgs.length - KEEP_RECENT);
      while (boundary < msgs.length - 1 && msgs[boundary]?.role === "tool") {
        boundary++;
      }
      if (boundary < 2) return null;

      const old = msgs.slice(0, boundary);
      const kept = msgs.slice(boundary);
      if (kept[0]?.role === "tool") return null;

      try {
        const summary = await summarizeMessages(old);
        if (!summary.trim()) return null;
        const summaryMsg = createMessage({
          role: "system",
          content: `[对话摘要]\n${summary}`,
        });
        return [summaryMsg, ...kept];
      } catch {
        return null;
      }
    },
  );

  const send = useMemoizedFn(async (text: string, reasoningLevel?: ReasoningLevel) => {
    if (!text.trim() || sending) return;

    // Pin the turn to the session that was active when it started, so a
    // mid-turn session switch never writes this turn's messages elsewhere.
    const sessionId = currentSessionId;
    if (!sessionId) {
      setLastError("当前没有可用的会话，请先新建一个对话");
      return;
    }

    const turn = ++turnRef.current;
    streamSessionRef.current = sessionId;
    // 钉住回合的工作目录：中途切会话/改目录不影响已开始回合的工具执行基准
    const turnCwd = currentCwdRef.current;

    // Parse /skill-name prefix（用户手动快捷方式，与模型动态加载走同一激活路径）
    const { name: skillName, rest } = parseSkillCommand(text);
    let userText = text;

    if (skillName) {
      try {
        const skill = await getSkill(skillName);
        activeSkillsRef.current.set(skillName, skill);
        setActiveSkillNames([...activeSkillsRef.current.keys()]);
        // 持久化：切换会话 / 重启后恢复，system 前缀不静默回退
        saveActiveSkills(sessionId, [...activeSkillsRef.current.keys()]);
        userText = rest || text;
      } catch {
        // Skill 不存在：不剥离前缀，保留原文发送
      }
    }

    const userMsg = createMessage({ role: "user", content: userText });
    const initialMessages: ChatMessage[] = [...messages, userMsg];
    await persistMessages(sessionId, initialMessages);
    setSending(true);
    setLastError(null);

    const isLatest = () =>
      turn === turnRef.current &&
      streamSessionRef.current === currentSessionRef.current;

    try {
      await runAgentLoop(initialMessages, {
        complete: sendChatCompletion,
        executeTool: (input) => executeToolCall({ ...input, cwd: turnCwd }),
        getSkill,
        availableSkills: skills,
        tools: TOOLS,
        activeSkills: activeSkillsRef.current,
        reasoningLevel,
        cwd: turnCwd,
        compact: maybeCompact,
        // 持久化：与现状一致——后台会话也要落盘，不做 isLatest 守卫
        onPersist: (msgs) => persistMessages(sessionId, msgs),
        onSkillsChange: (active) => {
          setActiveSkillNames(active.map((s) => s.name));
          // 持久化：切换会话 / 重启后恢复，system 前缀不静默回退
          saveActiveSkills(sessionId, active.map((s) => s.name));
        },
        onRoundStart: () => {
          if (isLatest()) {
            setStreamingContent("");
            setStreamingReasoning("");
          }
        },
        onRoundEnd: () => {
          if (isLatest()) {
            setStreamingContent(null);
            setStreamingReasoning(null);
          }
        },
        onChunk: (c) => {
          if (isLatest()) setStreamingContent((p) => (p ?? "") + c);
        },
        onReasoning: (r) => {
          if (isLatest()) setStreamingReasoning((p) => (p ?? "") + r);
        },
      });
      autoTitleSession(sessionId);
    } catch (e) {
      const errorText = e instanceof Error ? e.message : String(e);
      setLastError(errorText);

      // 循环已清理残缺组，这里基于清理后的历史追加用户可见错误消息
      const cleaned = e instanceof AgentLoopError ? e.messages : initialMessages;
      const finalMessages = [
        ...cleaned,
        createMessage({
          role: "assistant",
          content: `请求失败：${errorText || "请检查 API 配置或网络连接"}`,
        }),
      ];
      await persistMessages(sessionId, finalMessages);
    } finally {
      // Only clear the UI state if this is still the latest turn — otherwise
      // a newer turn (started after a mid-turn session switch) would get its
      // sending/streaming clobbered by this older turn finishing.
      if (turn === turnRef.current) {
        streamSessionRef.current = null;
        setSending(false);
        setStreamingContent(null);
        setStreamingReasoning(null);
      }
    }
  });

  return { send, sending, streamingContent, streamingReasoning, lastError, activeSkillNames };
}
