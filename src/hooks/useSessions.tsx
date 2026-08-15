import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";
import { useMount } from "ahooks";
import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage, Session, SessionSummary } from "../types";

interface SessionsContextType {
  sessions: SessionSummary[];
  currentSessionId: string | null;
  messages: ChatMessage[];
  /** 当前会话已激活的 skill 名（持久化，切换/重启后恢复 system 前缀） */
  activeSkills: string[];
  loading: boolean;
  createSession: () => Promise<string>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  persistMessages: (sessionId: string, messages: ChatMessage[]) => Promise<void>;
  /** 持久化会话的活跃 skill 名（useChat 在 skill 激活/变更时调用） */
  saveActiveSkills: (sessionId: string, names: string[]) => Promise<void>;
  autoTitleSession: (sessionId: string) => void;
}

const SessionsContext = createContext<SessionsContextType | null>(null);

export function SessionsProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeSkills, setActiveSkills] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // 视图守卫用 ref 而非闭包值：后台回合（发送中切会话）结束时会用
  // 过期的 currentSessionId 闭包做判断，误把旧会话消息写回当前视图。
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  /* All sessions, newest-first (backend sorts by updated_at desc). The sidebar
     groups them by recency. */
  const refreshList = useCallback(async () => {
    const list = await invoke<SessionSummary[]>("list_all_sessions");
    setSessions(list);
    return list;
  }, []);

  useMount(() => {
    (async () => {
      try {
        const list = await refreshList();
        if (list.length > 0) {
          setCurrentSessionId(list[0].id);
          const full = await invoke<Session>("get_session", { id: list[0].id });
          setMessages(full.messages);
          setActiveSkills(full.activeSkills ?? []);
        } else {
          const created = await invoke<Session>("create_session");
          setCurrentSessionId(created.id);
          setMessages([]);
          refreshList();
        }
      } catch (e) {
        console.error("初始化会话失败", e);
        const created = await invoke<Session>("create_session");
        setCurrentSessionId(created.id);
        setMessages([]);
        refreshList();
      } finally {
        setLoading(false);
      }
    })();
  });

  const createSession = useCallback(async () => {
    const created = await invoke<Session>("create_session");
    setCurrentSessionId(created.id);
    setMessages([]);
    setActiveSkills([]);
    refreshList();
    return created.id;
  }, [refreshList]);

  const deleteSession = useCallback(async (id: string) => {
    await invoke("delete_session", { id });
    const list = await refreshList();
    if (id === currentSessionId) {
      if (list.length > 0) {
        setCurrentSessionId(list[0].id);
        const full = await invoke<Session>("get_session", { id: list[0].id });
        setMessages(full.messages);
        setActiveSkills(full.activeSkills ?? []);
      } else {
        const created = await invoke<Session>("create_session");
        setCurrentSessionId(created.id);
        setMessages([]);
        setActiveSkills([]);
        refreshList();
      }
    }
  }, [currentSessionId, refreshList]);

  const renameSession = useCallback(async (id: string, name: string) => {
    await invoke("rename_session", { id, name });
    refreshList();
  }, [refreshList]);

  const switchSession = useCallback(async (id: string) => {
    setCurrentSessionId(id);
    const full = await invoke<Session>("get_session", { id });
    setMessages(full.messages);
    setActiveSkills(full.activeSkills ?? []);
  }, []);

  const persistMessages = useCallback(
    async (sessionId: string, msgs: ChatMessage[]) => {
      // Only update the view when this session is still the one on screen;
      // otherwise a turn finishing from a background session would clobber
      // the messages currently being viewed. Use the ref guard so a stale
      // closure (captured before a mid-turn session switch) never passes.
      if (sessionId === currentSessionIdRef.current) {
        setMessages(msgs);
      }
      await invoke("save_session_messages", { id: sessionId, messages: msgs });
      if (sessionId === currentSessionIdRef.current) {
        refreshList();
      }
    },
    [refreshList],
  );

  const saveActiveSkills = useCallback(
    async (sessionId: string, names: string[]) => {
      await invoke("save_session_active_skills", {
        id: sessionId,
        activeSkills: names,
      });
    },
    [],
  );

  const autoTitleSession = useCallback(
    (sessionId: string) => {
      invoke("auto_title_session", { id: sessionId })
        .then(() => refreshList())
        .catch((e) => console.error("自动命名会话标题失败:", e));
    },
    [refreshList],
  );

  return (
    <SessionsContext.Provider
      value={{
        sessions,
        currentSessionId,
        messages,
        activeSkills,
        loading,
        createSession,
        deleteSession,
        renameSession,
        switchSession,
        persistMessages,
        saveActiveSkills,
        autoTitleSession,
      }}
    >
      {children}
    </SessionsContext.Provider>
  );
}

export function useSessions(): SessionsContextType {
  const ctx = useContext(SessionsContext);
  if (!ctx) {
    throw new Error("useSessions must be used within a SessionsProvider");
  }
  return ctx;
}
