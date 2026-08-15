/* 无头浏览器 UI 测试用的 Tauri IPC 模拟层（在页面脚本之前注入）。
 * 实现 @tauri-apps/api 需要的 window.__TAURI_INTERNALS__：
 *   - invoke(cmd, args)：内存版后端（sessions/skills/tasks/LLM 假响应）
 *   - transformCallback/unregisterCallback：回调注册（Channel 投递依赖它）
 *   - 事件：plugin:event|listen / unlisten（仅 ask-user 弹窗仍走全局事件）
 * 流式响应经 Channel 投递：send_deepseek_chat 的 args.onEvent.__TAURI_CHANNEL__
 * 指向 transformCallback 注册的回调，直接以 { type, ... } 事件对象调用。
 * 假 LLM 按最后一条用户消息内容区分阶段：
 *   - 含「请先规划」→ 规划（先一次 read_file 探查，再输出步骤 JSON）
 *   - 含「请总结」  → 收尾总结
 *   - 含「当前步骤：修改文件」→ 第一次抛错（模拟网络错误），重试时成功
 *   - 其它（聊天）  → 模拟回复
 */
(function () {
  if (window.__TAURI_INTERNALS__) return;

  const callbacks = new Map();
  let cbSeq = 0;
  const listeners = new Map(); // event -> Map<eventId, {cb, once}>
  let evSeq = 0;

  const sessions = new Map();
  const tasks = new Map();
  let sessionSeq = 100; // 与 create_session 的 id 生成统一，避免与启动会话撞车

  function emit(event, payload) {
    const handlers = listeners.get(event);
    if (!handlers) return;
    for (const [id, h] of [...handlers]) {
      try {
        h.cb({ event, id, payload });
      } catch (e) {
        (window.__mockLog || (window.__mockLog = [])).push("emit-error: " + event + " " + (e && e.message));
        console.error("[mock] 事件回调异常", e);
      }
      if (h.once) handlers.delete(id);
    }
  }

  /* ---------- 假 LLM ----------
   * 事件经 Channel 投递。真实 Tauri 注入层把 Channel 序列化为 "__CHANNEL__:<id>"，
   * 本 mock 直接替换了 __TAURI_INTERNALS__.invoke，拿到的是原始 Channel 实例
   * （id 由 transformCallback 注册），两种形态都兼容。
   * 投递协议与 tauri 2.11 channel_on 一致：每条消息包装为 { message, index }，
   * 流结束时发 { end: true, index }（前端据此清理回调）。 */
  function createChannelSender(channel) {
    const id =
      typeof channel === "string"
        ? Number(channel.replace("__CHANNEL__:", ""))
        : channel?.__TAURI_CHANNEL__ ?? channel?.id;
    const h = callbacks.get(id);
    let index = 0;
    return {
      send(payload) {
        if (!h) return;
        try {
          h.cb({ message: payload, index: index++ });
        } catch (e) {
          (window.__mockLog || (window.__mockLog = [])).push("channel-error: " + (e && e.message));
          console.error("[mock] Channel 回调异常", e);
        }
      },
      end() {
        if (!h) return;
        try {
          h.cb({ end: true, index });
        } catch (e) {
          /* 结束标记失败无碍 */
        }
      },
    };
  }
  function streamContent(sender, text) {
    const chunks = text.match(/.{1,14}/gs) || [text];
    setTimeout(() => {
      for (const c of chunks) sender.send({ type: "chunk", text: c });
      sender.send({ type: "done", tool_calls: [] });
      sender.end();
    }, 0);
  }
  function streamToolCalls(sender, calls) {
    setTimeout(() => {
      sender.send({ type: "reasoning", text: "思考中…" });
      sender.send({ type: "done", tool_calls: calls });
      sender.end();
    }, 0);
  }

  function llmRespond(messages, sender) {
    const userMsg = [...messages].reverse().find((m) => m.role === "user");
    const content = userMsg?.content ?? "";
    (window.__mockLog || (window.__mockLog = [])).push("llm: " + JSON.stringify(content.slice(0, 60)));
    // 模拟无 API Key：所有 LLM 请求直接报错（验收 E1）
    if (window.__failAllLlm) {
      setTimeout(() => {
        sender.send({ type: "error", message: "未配置 API Key" });
        sender.end();
      }, 0);
      return null;
    }
    // ── 聊天回归专用标记（真实跑通 useChat 的工具循环/错误/慢流式路径） ──
    if (content.includes("__TOOLTEST__")) {
      if (window.__chatToolRound) {
        window.__chatToolRound = false;
        return streamContent(sender, "工具调用完成回复");
      }
      window.__chatToolRound = true;
      return streamToolCalls(sender, [
        { id: "chat-tool-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
      ]);
    }
    if (content.includes("__ERRORTEST__")) {
      setTimeout(() => {
        sender.send({ type: "error", message: "模拟网络错误" });
        sender.end();
      }, 0);
      return null;
    }
    if (content.includes("__SLOWTEST__")) {
      // 分两批发射模拟慢流式（用于「发送中切换会话」回归：跨两个定时器，index 递增保证 FIFO）
      const chunks = "慢速回复内容ABCDEFG".match(/.{1,5}/gs) || [];
      setTimeout(() => chunks.slice(0, 2).forEach((c) => sender.send({ type: "chunk", text: c })), 0);
      setTimeout(() => {
        chunks.slice(2).forEach((c) => sender.send({ type: "chunk", text: c }));
        sender.send({ type: "done", tool_calls: [] });
        sender.end();
      }, 250);
      return null;
    }
    if (content.includes("请先规划")) {
      if (!window.__planToolDone) {
        window.__planToolDone = true;
        window.__mockLog.push("branch: plan-tool");
      return streamToolCalls(sender, [
          { id: "plan-1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
        ]);
      }
      window.__mockLog.push("branch: plan-json");
      return streamContent(
        sender,
        '[{"label":"读取项目结构","plan":"先读取项目结构了解现状"},{"label":"修改文件","plan":"修改目标文件"}]',
      );
    }
    if (content.includes("请总结")) {
      window.__mockLog.push("branch: wrap");
      return streamContent(sender, "任务总结完成：两个步骤均已完成。");
    }
    if (content.includes("当前步骤：修改文件") && window.__failStep) {
      // 由测试显式开启：模拟该步骤一次网络错误（用于失败/重试场景）
      window.__failStep = false;
      window.__mockLog.push("branch: step2-fail");
      setTimeout(() => {
        sender.send({ type: "error", message: "模拟网络错误" });
        sender.end();
      }, 120);
      return null;
    }
    if (content.includes("当前步骤：")) {
      const m = content.match(/当前步骤：([^\n]+)/);
      const label = m ? m[1].trim() : "未知步骤";
      if (window.__stepRound) {
        window.__stepRound = false;
        window.__mockLog.push("branch: step-final " + label);
      return streamContent(sender, `步骤「${label}」已完成`);
      }
      window.__stepRound = true;
      window.__mockLog.push("branch: step-tool " + label);
      return streamToolCalls(sender, [
        { id: "exec-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
      ]);
    }
    window.__mockLog.push("branch: chat-reply");
    window.__chatSeq = (window.__chatSeq || 0) + 1;
    return streamContent(sender, `这是模拟回复（#${window.__chatSeq}）：你好，我是 dswork 助手。`);
  }

  /* ---------- invoke 路由 ---------- */
  async function invoke(cmd, args) {
    switch (cmd) {
      case "get_deepseek_config":
        return { baseUrl: "https://api.deepseek.com", model: "deepseek-chat", hasApiKey: true, status: "saved" };
      case "save_deepseek_config":
      case "clear_deepseek_api_key":
        return null;
      case "test_deepseek_connection":
        return { success: true, message: "连接成功" };
      case "list_all_sessions":
        if (sessions.size === 0) {
          const s = { id: `sess-${++sessionSeq}`, title: "新对话", createdAt: 1, updatedAt: 1, messages: [], titled: false };
          sessions.set(s.id, s);
        }
        return [...sessions.values()].map(({ messages: _m, ...s }) => s);
      case "create_session": {
        const s = { id: `sess-${++sessionSeq}`, title: "新对话", createdAt: 2, updatedAt: 2, messages: [], titled: false };
        sessions.set(s.id, s);
        (window.__mockLog || (window.__mockLog = [])).push("create_session: " + s.id + " total=" + sessions.size);
        return s;
      }
      case "get_session":
        return sessions.get(args.id) ?? { id: args.id, title: "新对话", createdAt: 1, updatedAt: 1, messages: [] };
      case "save_session_messages": {
        const s = sessions.get(args.id);
        if (s) {
          s.messages = args.messages;
          s.updatedAt = Math.floor(Date.now() / 1000);
        }
        (window.__mockLog || (window.__mockLog = [])).push("save_messages " + args.id + " n=" + (args.messages || []).length);
        return null;
      }
      case "delete_session":
        sessions.delete(args.id);
        return null;
      case "rename_session":
        return null;
      case "auto_title_session": {
        const s = sessions.get(args.id);
        if (s) {
          s.title = "模拟会话标题";
          s.titled = true;
        }
        return null;
      }
      case "list_skills":
        return [{ name: "code", description: "编程技能", tools: null }];
      case "get_skill":
        return { name: args.name, description: "编程技能", tools: null, systemPrompt: "你是编程专家，遵循最佳实践。" };
      case "summarize_messages":
        return "[对话摘要]";
      case "execute_tool": {
        const name = args.input?.name;
        if (name === "read_file") return { output: "模拟文件内容\nline1\nline2", is_error: false };
        if (name === "list_dir") return { output: "src/\ndocs/\npackage.json", is_error: false };
        if (name === "grep") return { output: "a.txt: 找到匹配", is_error: false };
        return { output: `模拟结果: ${name}`, is_error: false };
      }
      case "send_deepseek_chat":
        llmRespond(args.input.messages, createChannelSender(args.onEvent));
        return null;
      case "create_task": {
        const id = `task-${tasks.size + 1}`;
        const now = Math.floor(Date.now() / 1000);
        const t = {
          id, title: "新任务", goal: args.goal, status: "pending", steps: [],
          result: undefined, error: undefined, sessionId: args.sessionId ?? null,
          createdAt: now, updatedAt: now,
        };
        tasks.set(id, t);
        window.__planToolDone = false;
        window.__stepRound = false;
        return t;
      }
      case "list_tasks":
        return [...tasks.values()]
          .map((t) => ({
            id: t.id, title: t.title, status: t.status,
            stepCount: t.steps.length,
            doneCount: t.steps.filter((s) => s.status === "done").length,
            createdAt: t.createdAt, updatedAt: t.updatedAt,
          }))
          .sort((a, b) => b.updatedAt - a.updatedAt);
      case "get_task":
        return tasks.get(args.id) ?? null;
      case "update_task":
        tasks.set(args.task.id, args.task);
        return null;
      case "cancel_task": {
        const t = tasks.get(args.id);
        if (t && (t.status === "running" || t.status === "pending")) t.status = "cancelled";
        return null;
      }
      case "delete_task":
        tasks.delete(args.id);
        return null;
      case "generate_task_title":
        return "自动标题";
      case "plugin:event|listen": {
        const h = callbacks.get(args.handler);
        if (!h) return "ev-0";
        const id = `ev-${++evSeq}`;
        if (!listeners.has(args.event)) listeners.set(args.event, new Map());
        listeners.get(args.event).set(id, h);

        return id;
      }
      case "plugin:event|unlisten": {
        const before = listeners.get(args.event)?.size ?? 0;
        listeners.get(args.event)?.delete(args.eventId);
        const after = listeners.get(args.event)?.size ?? 0;

        return null;
      }
      default:
        console.warn("[mock] 未实现的命令:", cmd);
        return null;
    }
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(cb, once = false) {
      const id = ++cbSeq;
      callbacks.set(id, { cb, once });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc: (p) => p,
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
})();
