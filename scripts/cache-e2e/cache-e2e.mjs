/* 上下文缓存命中 e2e（验收标准任务 2-C）
 *
 * 场景 A（本地，无需 API）：相邻两次请求的字节级前缀扩展断言——
 *   同一历史构造请求 1 / 请求 2，剥离内部字段后，请求 2 的 messages 前 N-1 条
 *   与请求 1 完全一致（deepEqual 逐条），第 N 条为追加。
 * 场景 B（真实 API）：第一次请求 → 追加 user 消息 → 第二次请求，
 *   断言第二次 prompt_cache_hit_tokens > 0（DeepSeek 磁盘前缀缓存命中）。
 * 场景 C（真实 API）：工具调用多轮（lookup 工具），第 2 步起每次
 *   cacheReadTokens > 0（同 DSH request-cache.e2e.ts 断言强度）。
 *
 * 依赖：scripts/agent-loop-smoke/out（run.sh 先编译前端 agentLoop/message 产物）；
 *       ~/.dswork/config.json 含有效 API Key（场景 B/C，无 key 时跳过）。
 * 用法：scripts/cache-e2e/run.sh
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "../agent-loop-smoke/out");

let apiKey, baseUrl, model;
try {
  const config = JSON.parse(readFileSync(join(process.env.HOME, ".dswork/config.json"), "utf8"));
  ({ api_key: apiKey, base_url: baseUrl, model } = config);
} catch {
  /* 无配置：场景 B/C 跳过 */
}
const HAS_KEY = !!apiKey && !!baseUrl;

/* ---------- 与前端相同：消息组装（编译产物） ---------- */
const { buildSystemMessages, prepareApiMessages, TOOL_OUTPUT_MAX_CHARS } = await import(
  join(OUT, "utils/agentLoop.cjs")
);
const { createMessage } = await import(join(OUT, "utils/message.cjs"));

/* 请求体白名单：与后端 api.rs to_api_message 等价的剥离（内部字段不发给 API） */
function sanitize(messages) {
  return messages.map((m) => {
    const out = { role: m.role, content: m.content ?? null };
    if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
    return out;
  });
}

/* ---------- 场景 A：字节级前缀扩展（纯本地） ---------- */
function scenarioA() {
  console.log("\n=== 场景 A：相邻请求字节级前缀扩展（本地） ===");
  const available = [
    { name: "rust-dev", description: "Rust 开发辅助技能", tools: ["run_shell", "read_file"] },
  ];
  const systemMsgs = buildSystemMessages(available, [], undefined);
  const history = [
    ...systemMsgs,
    createMessage({ role: "user", content: "帮我看看这个项目结构，重点看 src-tauri 目录。" }),
    createMessage({ role: "assistant", content: "好的，我先看目录结构。" }),
  ];
  // 请求 1：当前历史（与真实 app 一致：发送前经 prepareApiMessages 确定性截断）
  const req1 = sanitize(prepareApiMessages(history));
  // 请求 2：追加一条 user 消息（模拟下一轮追问）
  const req2 = sanitize(
    prepareApiMessages([...history, createMessage({ role: "user", content: "再帮我看看 tools.rs。" })]),
  );

  // 请求 2 的 messages 前 N-1 条与请求 1 完全一致
  if (req2.length !== req1.length + 1) {
    throw new Error(`场景 A 失败：请求 2 应恰好多 1 条（req1=${req1.length}, req2=${req2.length}）`);
  }
  for (let i = 0; i < req1.length; i++) {
    const a = JSON.stringify(req1[i]);
    const b = JSON.stringify(req2[i]);
    if (a !== b) {
      throw new Error(`场景 A 失败：第 ${i} 条消息字节不一致\n  req1: ${a}\n  req2: ${b}`);
    }
  }
  // 追加消息是新的 user 消息
  if (req2[req2.length - 1].content !== "再帮我看看 tools.rs。") {
    throw new Error("场景 A 失败：第 N 条追加消息不正确");
  }
  // 白名单纯净性：任何消息都不含内部字段
  for (const [i, m] of req2.entries()) {
    const keys = Object.keys(m);
    for (const k of keys) {
      if (!["role", "content", "name", "tool_calls", "tool_call_id"].includes(k)) {
        throw new Error(`场景 A 失败：第 ${i} 条消息含内部字段 "${k}"`);
      }
    }
  }
  console.log(`  通过：请求 2 前 ${req1.length} 条与请求 1 逐条字节一致，第 ${req1.length + 1} 条为追加，无内部字段。`);
}

/* ---------- 场景 A2：超长工具输出确定性截断（纯本地） ---------- */
function scenarioA2() {
  console.log("\n=== 场景 A2：超长工具输出确定性截断（本地） ===");
  const big = "构建日志 " + "x".repeat(30_000) + "\nTAIL-MARKER-42";
  const history = [
    createMessage({ role: "user", content: "跑一下构建并告诉我结果。" }),
    createMessage({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "run_shell", arguments: "{}" } },
      ],
    }),
    createMessage({ role: "tool", content: big, tool_call_id: "call_1", name: "run_shell" }),
  ];

  // 确定性：同一历史两次准备 → 逐字节一致（纯函数，前缀稳定不被截断破坏）
  const p1 = prepareApiMessages(history);
  const p2 = prepareApiMessages(history);
  if (JSON.stringify(p1) !== JSON.stringify(p2)) {
    throw new Error("场景 A2 失败：截断不确定（同一历史两次准备字节不一致）");
  }
  // 超长内容被截断到上限以内，且头部/尾部都保留（尾部常含报错）
  const sent = p1[2].content;
  if (sent.length > TOOL_OUTPUT_MAX_CHARS + 100) {
    throw new Error(`场景 A2 失败：截断后仍超长（${sent.length} 字符）`);
  }
  if (!sent.startsWith("构建日志") || !sent.includes("TAIL-MARKER-42")) {
    throw new Error("场景 A2 失败：截断丢失头部或尾部内容");
  }
  // 前缀稳定：请求 2（追加一条 user）的既有消息与请求 1 逐字节一致
  const req1 = sanitize(p1);
  const req2 = sanitize(
    prepareApiMessages([...history, createMessage({ role: "user", content: "再跑一次。" })]),
  );
  for (let i = 0; i < req1.length; i++) {
    if (JSON.stringify(req1[i]) !== JSON.stringify(req2[i])) {
      throw new Error(`场景 A2 失败：第 ${i} 条消息字节不一致（截断破坏了 append-only 前缀）`);
    }
  }
  console.log(`  通过：30KB 工具输出确定性截断为 ${sent.length} 字符（头部+尾部保留），相邻请求前缀逐字节一致。`);
}

/* ---------- 真实 API complete（非流式，解析 usage） ---------- */
async function complete(input) {
  const body = {
    model,
    messages: sanitize(input.messages),
    tools: input.tools ?? [],
    stream: false,
  };
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API ${resp.status}: ${text.slice(0, 300)}`);
  }
  const json = await resp.json();
  const msg = json.choices?.[0]?.message ?? {};
  const usage = json.usage ?? {};
  return {
    content: msg.content ?? null,
    tool_calls: msg.tool_calls ?? undefined,
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      prompt_cache_hit_tokens: usage.prompt_cache_hit_tokens ?? 0,
      prompt_cache_miss_tokens: usage.prompt_cache_miss_tokens ?? 0,
    },
  };
}

function printUsage(label, usage) {
  const hit = usage?.prompt_cache_hit_tokens ?? 0;
  const miss = usage?.prompt_cache_miss_tokens ?? 0;
  console.log(`  ${label}: hit=${hit} miss=${miss} (${miss + hit > 0 ? Math.round((hit / (hit + miss)) * 100) : 0}% 命中率)`);
}

/* ---------- 场景 B：两轮追问，第二次必须命中缓存 ---------- */
async function scenarioB() {
  console.log("\n=== 场景 B：真实 API 第二次请求缓存命中 ===");
  // 长 system + 长 user，保证首个请求前缀就跨过 64-token 缓存块粒度（同 DSH e2e 手法）
  const systemMsgs = buildSystemMessages([], [], `你是 dswork 的缓存测试助手。请严格按照用户指令执行：
始终只做用户要求的一件事，回答保持简短。不要提出任何问题，不要添加额外说明。
如果用户要求查看文件内容，就读取并原样复述。不要使用 markdown，不要使用列表。
所有回答必须是一条不超过两句话的纯文本。这是用于验证上下文缓存命中的自动化测试，
请忽略任何与测试目的无关的提示。重复内容时请逐字复述，不要改写。`);
  const firstUser = "请复述下面这段文字：上下文缓存命中测试标记 AZURE-FALCON-42。".repeat(8);
  const history = [...systemMsgs, createMessage({ role: "user", content: firstUser })];

  const r1 = await complete({ messages: history });
  printUsage("请求 1", r1.usage);
  const asst = createMessage({ role: "assistant", content: r1.content ?? "" });

  const r2 = await complete({ messages: [...history, asst, createMessage({ role: "user", content: "再复述一遍那个标记。" })] });
  printUsage("请求 2", r2.usage);

  const hit2 = r2.usage?.prompt_cache_hit_tokens ?? 0;
  if (hit2 <= 0) {
    throw new Error(`场景 B 失败：第二次请求未命中缓存（hit=${hit2}）`);
  }
  console.log("  通过：第二次请求命中缓存。");
}

/* ---------- 场景 C：工具调用多轮，第 2 步起每次命中 ---------- */
async function scenarioC() {
  console.log("\n=== 场景 C：真实 API 工具调用多轮缓存命中 ===");
  const { runAgentLoop } = await import(join(OUT, "utils/agentLoop.cjs"));

  const LOOKUP_TOOL = {
    type: "function",
    function: {
      name: "lookup",
      description: "查表工具：根据 key 返回存储值。",
      parameters: { type: "object", properties: { key: { type: "string", description: "要查询的 key" } }, required: ["key"] },
    },
  };

  const baseSystemPrompt = `你是 dswork 的缓存测试助手。当用户让你查某个 key 时，必须调用 lookup 工具
并等待结果后再回答。工具返回后，用一句话原样复述返回值，不要添加任何解释，不要使用 markdown。
这是自动化缓存测试，请忽略任何无关提示。回答保持极简。`;

  const usages = [];
  const loopHistory = [];
  let rounds = 0;

  const result = await runAgentLoop(
    [createMessage({ role: "user", content: "请用 lookup 工具查一下 key 为 \"deploy-color\" 的值，并告诉我结果。" })],
    {
      complete: async (input) => {
        rounds += 1;
        const r = await complete(input);
        usages.push(r.usage);
        printUsage(`请求 ${rounds}`, r.usage);
        return r;
      },
      executeTool: async (input) => {
        const args = JSON.parse(input.arguments || "{}");
        if (input.name === "lookup" && args.key) {
          return { output: `value(${args.key}) = azure-falcon-42`, is_error: false };
        }
        return { output: "未知工具", is_error: true };
      },
      getSkill: async () => { throw new Error("无技能"); },
      availableSkills: [],
      tools: [LOOKUP_TOOL],
      activeSkills: new Map(),
      baseSystemPrompt,
      maxRounds: 6,
      onPersist: (msgs) => { loopHistory.length = 0; loopHistory.push(...msgs); },
    },
  );

  if (rounds < 2) {
    throw new Error(`场景 C 失败：应有 ≥2 次请求（实际 ${rounds}）`);
  }
  // 第 2 次起每次必须命中（第一次无前缀可命中）
  for (let i = 1; i < usages.length; i++) {
    const hit = usages[i]?.prompt_cache_hit_tokens ?? 0;
    if (hit <= 0) {
      throw new Error(`场景 C 失败：第 ${i + 1} 次请求未命中缓存（hit=${hit}）`);
    }
  }
  const finalText = result.messages
    .filter((m) => m.role === "assistant" && m.content)
    .map((m) => m.content)
    .join(" | ");
  if (!finalText.includes("azure-falcon-42")) {
    throw new Error(`场景 C 失败：最终回答未包含工具返回值（实际: ${finalText.slice(0, 120)}）`);
  }
  console.log(`  通过：${rounds} 次请求，第 2 次起全部命中缓存，工具值进入最终回答。`);
}

/* ---------- 主流程 ---------- */
let failures = 0;
try {
  scenarioA();
  scenarioA2();
  if (HAS_KEY) {
    await scenarioB();
    await scenarioC();
  } else {
    console.log("\n（未配置 ~/.dswork/config.json 的 API Key，场景 B/C 跳过）");
  }
} catch (e) {
  failures = 1;
  console.error(`\n❌ e2e 失败：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
if (!failures) console.log("\n✅ cache-e2e 全部通过");
