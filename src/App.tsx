import { useState, useEffect, useMemo, useCallback } from "react";
import { useKeyPress, useUpdateEffect } from "ahooks";
import ChatHeader from "./components/ChatHeader";
import type { SessionCacheStats } from "./components/ChatHeader";
import FirstTimeWizard from "./components/FirstTimeWizard";
import SettingsDrawer from "./components/SettingsDrawer";
import TaskDrawer from "./components/TaskDrawer";
import SessionList from "./components/SessionList";
import Message from "./components/message";
import ToolGroup from "./components/message/ToolGroup";
import AskUserModal from "./components/AskUserModal";
import UpdateModal from "./components/UpdateModal";
import PromptBar from "./components/bui/PromptBar";
import LoadingState from "./components/bui/LoadingState";
import ThinkingState from "./components/bui/ThinkingState";
import { MessageSendContext } from "./components/message/registry";
import { App as AntdApp, Button } from "antd";
import { useDeepSeekConfig } from "./hooks/useDeepSeekConfig";
import { useSessions } from "./hooks/useSessions";
import { useChat } from "./hooks/useChat";
import { useSkills } from "./hooks/useSkills";
import { useScrollToBottom } from "./hooks/useScrollToBottom";
import { UpdaterProvider, useUpdater } from "./hooks/useUpdater";
import { groupMessages, reasoningToRows } from "./utils/message";
import { DEEPSEEK_MODEL_OPTIONS } from "./modelOptions";
import type { ReasoningLevel } from "./types";

function AppContent() {
  const { message } = AntdApp.useApp();
  const { config, loading } = useDeepSeekConfig();
  const { skills } = useSkills();
  const {
    sessions,
    currentSessionId,
    messages,
    createSession,
    deleteSession,
    renameSession,
    switchSession,
  } = useSessions();
  const {
    send,
    sending,
    streamingContent,
    streamingReasoning,
    lastError,
    activeSkillNames,
  } = useChat();
  const {
    containerRef,
    bottomRef,
    hasUnreadMessages,
    scrollToBottom,
    handleMessageScroll,
  } = useScrollToBottom(
    messages,
    streamingContent,
    streamingReasoning,
    currentSessionId,
  );

  const [showWizard, setShowWizard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showUpdates, setShowUpdates] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>("max");
  const updater = useUpdater();

  const currentSessionTitle = useMemo(() => {
    const session = sessions.find((s) => s.id === currentSessionId);
    return session?.title;
  }, [sessions, currentSessionId]);

  // 聚合当前会话全部消息的 usage，得到会话级上下文缓存统计；
  // 无任何 usage 数据（如旧会话）时为 null，头部不渲染 chip。
  const sessionCacheStats = useMemo<SessionCacheStats | null>(() => {
    let hit = 0;
    let miss = 0;
    let completion = 0;
    let count = 0;
    for (const m of messages) {
      const u = m.usage;
      if (!u) continue;
      hit += u.prompt_cache_hit_tokens ?? 0;
      miss += u.prompt_cache_miss_tokens ?? 0;
      completion += u.completion_tokens ?? 0;
      count += 1;
    }
    return hit + miss > 0 ? { hit, miss, completion, count } : null;
  }, [messages]);

  useKeyPress(["meta.b", "ctrl.b"], (e) => {
    e.preventDefault();
    setSidebarCollapsed((v) => !v);
  });

  // Show error from chat hook
  useUpdateEffect(() => {
    if (lastError) {
      message.error(lastError || "发送失败，请稍后重试");
    }
  }, [lastError]);

  // Show wizard on first launch if no config
  useEffect(() => {
    if (!loading && config && config.status === "missing") {
      setShowWizard(true);
    }
  }, [loading, config]);

  const handleSend = useCallback(
    (text: string) => {
      if (!config || config.status === "missing") {
        setShowWizard(true);
        return;
      }
      if (config.status === "invalid") {
        message.warning("API 配置异常，请重新测试连接");
        setShowSettings(true);
        return;
      }
      scrollToBottom();
      send(text, reasoningLevel);
    },
    [config, message, scrollToBottom, send, reasoningLevel],
  );

  const skillCommands = useMemo(
    () =>
      skills.map((s) => ({
        key: s.name,
        name: `/${s.name}`,
        desc: s.description,
      })),
    [skills],
  );

  const promptModels = useMemo(
    () => DEEPSEEK_MODEL_OPTIONS.map((o) => ({ key: o.value, name: o.label })),
    [],
  );

  const grouped = useMemo(() => groupMessages(messages), [messages]);

  return (
    <div className="flex h-screen">
      <div className="flex h-full shrink-0 flex-col border-r border-line bg-surface">
        <SessionList
          collapsed={sidebarCollapsed}
          onCollapse={setSidebarCollapsed}
          sessions={sessions}
          currentSessionId={currentSessionId}
          onNewSession={createSession}
          onSwitchSession={switchSession}
          onDeleteSession={deleteSession}
          onRenameSession={renameSession}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader
          title={currentSessionTitle}
          cacheStats={sessionCacheStats}
          onOpenSettings={() => setShowSettings(true)}
          onOpenTasks={() => setShowTasks(true)}
          onOpenUpdates={() => setShowUpdates(true)}
        />

        <div
          ref={containerRef}
          onScroll={handleMessageScroll}
          className="relative flex-1 overflow-y-auto bg-canvas px-6 py-4"
        >
          <MessageSendContext.Provider value={send}>
            {grouped.map((data) => (
              <div key={data.id} className="chat-message-group" style={{ marginBottom: 12 }}>
                {data.type === "msg" ? (
                  <Message message={data.msg} />
                ) : (
                  <ToolGroup messages={data.msgs} />
                )}
              </div>
            ))}
            {streamingReasoning && (
              <div aria-live="polite" style={{ marginTop: 8 }}>
                <ThinkingState
                  variant="Reasoning"
                  auto={false}
                  working
                  activeLabel="正在思考"
                  rows={reasoningToRows(streamingReasoning)}
                  animate={false}
                />
              </div>
            )}
            {streamingContent && (
              <div aria-live="polite" style={{ marginTop: 8 }}>
                <Message
                  message={{
                    id: "streaming",
                    role: "assistant",
                    content: streamingContent,
                  }}
                />
              </div>
            )}
            {sending && !streamingContent && !streamingReasoning && (
              <div
                role="status"
                aria-label="正在思考…"
                style={{ marginTop: 8 }}
              >
                <LoadingState label="正在思考" variant="Dots" />
              </div>
            )}
          </MessageSendContext.Provider>
          {hasUnreadMessages && (
            <Button
              type="primary"
              size="small"
              onClick={() => scrollToBottom()}
              style={{ position: "absolute", right: 24, bottom: 16, zIndex: 1 }}
            >
              回到最新消息
            </Button>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="bg-canvas px-6 py-4">
          <PromptBar
            auto={false}
            commands={skillCommands}
            models={promptModels}
            model={config?.model}
            reasoningLevel={reasoningLevel}
            onReasoningLevelChange={setReasoningLevel}
            onSend={handleSend}
            sending={sending}
            activeSkills={activeSkillNames}
            placeholder="发送消息… (Enter 发送，Shift+Enter 换行)"
          />
        </div>

        <FirstTimeWizard
          open={showWizard}
          onClose={() => setShowWizard(false)}
          onFinish={() => {}}
        />

        <SettingsDrawer
          open={showSettings}
          onClose={() => setShowSettings(false)}
          onCheckUpdates={() => {
            setShowUpdates(true);
            void updater.checkForUpdates();
          }}
        />

        <TaskDrawer
          open={showTasks}
          onClose={() => setShowTasks(false)}
          sessionId={currentSessionId}
        />

        <UpdateModal
          open={showUpdates}
          onClose={() => setShowUpdates(false)}
        />

        <AskUserModal />
      </div>
    </div>
  );
}

function App() {
  return (
    <UpdaterProvider>
      <AppContent />
    </UpdaterProvider>
  );
}

export default App;
