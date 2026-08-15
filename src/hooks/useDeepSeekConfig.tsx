import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useMount } from "ahooks";
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ChatCompletionInput,
  ChatCompletionResult,
  ChatMessage,
  DeepSeekConfig,
  ExecuteToolInput,
  ExecuteToolResult,
  SaveConfigInput,
  StreamEvent,
  TestConnectionInput,
  TestConnectionResult,
  UsageStats,
} from "../types";
import { DEFAULT_DEEPSEEK_MODEL } from "../modelOptions";

interface DeepSeekConfigContextType {
  config: DeepSeekConfig | null;
  loading: boolean;
  refreshConfig: () => Promise<void>;
  saveConfig: (input: SaveConfigInput) => Promise<void>;
  testConnection: (input?: TestConnectionInput) => Promise<TestConnectionResult>;
  sendChatCompletion: (
    input: ChatCompletionInput,
    onChunk?: (text: string) => void,
    onReasoning?: (text: string) => void,
  ) => Promise<ChatCompletionResult>;
  summarizeMessages: (messages: ChatMessage[]) => Promise<string>;
  executeToolCall: (input: ExecuteToolInput) => Promise<ExecuteToolResult>;
  clearApiKey: () => Promise<void>;
}

const DeepSeekConfigContext = createContext<DeepSeekConfigContextType | null>(
  null,
);

export function DeepSeekConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<DeepSeekConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshConfig = useCallback(async () => {
    try {
      const result = await invoke<DeepSeekConfig>("get_deepseek_config");
      setConfig(result);
    } catch {
      setConfig({
        baseUrl: "https://api.deepseek.com",
        model: DEFAULT_DEEPSEEK_MODEL,
        hasApiKey: false,
        status: "missing",
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useMount(() => {
    refreshConfig();
  });

  const saveConfigFn = useCallback(
    async (input: SaveConfigInput) => {
      await invoke("save_deepseek_config", { input });
      await refreshConfig();
    },
    [refreshConfig],
  );

  const testConnection = useCallback(
    async (input?: TestConnectionInput): Promise<TestConnectionResult> => {
      return await invoke<TestConnectionResult>("test_deepseek_connection", {
        input: input ?? null,
      });
    },
    [],
  );

  const sendChatCompletion = useCallback(
    async (
      input: ChatCompletionInput,
      onChunk?: (text: string) => void,
      onReasoning?: (text: string) => void,
    ): Promise<ChatCompletionResult> => {
      return new Promise<ChatCompletionResult>((resolve, reject) => {
        let settled = false;
        // 上下文缓存统计先于 done 到达（同一 Channel 内有序），此处捕获并随结果返回；
        // 端点未返回 usage 时保持 undefined。
        let usage: UsageStats | undefined;
        const once =
          (fn: (...args: any[]) => void) =>
          (...args: any[]) => {
            if (!settled) {
              settled = true;
              fn(...args);
            }
          };

        // 每个请求绑定独立的 Channel：后端事件只投递到本请求，聊天与后台任务
        // 并发时不会串台，也不存在全局监听器注册竞态/泄漏。
        const onEvent = new Channel<StreamEvent>();
        onEvent.onmessage = (event) => {
          if (settled) return;
          switch (event.type) {
            case "chunk":
              onChunk?.(event.text);
              break;
            case "reasoning":
              onReasoning?.(event.text);
              break;
            case "usage":
              usage = {
                prompt_tokens: event.prompt_tokens,
                completion_tokens: event.completion_tokens,
                total_tokens: event.total_tokens,
                prompt_cache_hit_tokens: event.prompt_cache_hit_tokens,
                prompt_cache_miss_tokens: event.prompt_cache_miss_tokens,
              };
              break;
            case "done":
              once(() =>
                resolve({
                  content: null,
                  tool_calls:
                    event.tool_calls.length > 0 ? event.tool_calls : undefined,
                  usage,
                }),
              )();
              break;
            case "error":
              once(() => reject(event.message))();
              break;
          }
        };

        invoke("send_deepseek_chat", { input, onEvent }).catch(
          once((e) => reject(e)),
        );
      });
    },
    [],
  );

  const executeToolCall = useCallback(
    async (input: ExecuteToolInput): Promise<ExecuteToolResult> => {
      return await invoke<ExecuteToolResult>("execute_tool", { input });
    },
    [],
  );

  const summarizeMessages = useCallback(
    async (messages: ChatMessage[]): Promise<string> => {
      return await invoke<string>("summarize_messages", { messages });
    },
    [],
  );

  const clearApiKey = useCallback(async () => {
    await invoke("clear_deepseek_api_key");
    await refreshConfig();
  }, [refreshConfig]);

  return (
    <DeepSeekConfigContext.Provider
      value={{
        config,
        loading,
        refreshConfig,
        saveConfig: saveConfigFn,
        testConnection,
        sendChatCompletion,
        summarizeMessages,
        executeToolCall,
        clearApiKey,
      }}
    >
      {children}
    </DeepSeekConfigContext.Provider>
  );
}

export function useDeepSeekConfig(): DeepSeekConfigContextType {
  const ctx = useContext(DeepSeekConfigContext);
  if (!ctx) {
    throw new Error(
      "useDeepSeekConfig must be used within a DeepSeekConfigProvider",
    );
  }
  return ctx;
}
