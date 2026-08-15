/* 真实 API 端到端任务测试（验收剩余项：真实模型规划/执行/收尾）
 * 复用与前端完全相同的 taskLoop/agentLoop/taskPlan 代码（编译产物），
 * 注入：真实 DeepSeek API（complete）+ 真实文件工具（限制在 scratch 目录）+ 内存任务存储。
 * 用法：先编译（见 run.sh），再 node run-real-task.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const __dir = dirname(fileURLToPath(import.meta.url));

/* ---------- 读取配置（密钥不打印） ---------- */
const config = JSON.parse(readFileSync(join(homedir(), ".dswork/config.json"), "utf8"));
const { base_url: baseUrl, model, api_key: apiKey } = config;
if (!apiKey) {
  console.error("未找到 API Key");
  process.exit(1);
}

const SCRATCH = `/tmp/dswork-realtask-${Date.now()}`;
mkdirSync(SCRATCH, { recursive: true });
writeFileSync(join(SCRATCH, "a.txt"), "这是真实测试文件。\nline2\nREAL-TEST-MARKER\n", "utf8");
writeFileSync(join(SCRATCH, "b.txt"), "", "utf8");
console.log("scratch 目录:", SCRATCH);

/* ---------- complete：真实 DeepSeek API（非流式） ---------- */
function sanitize(messages) {
  // 与后端 api.rs 剥离逻辑等价：只保留 API 需要的字段
  return messages.map((m) => {
    const out = { role: m.role, content: m.content ?? null };
    if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
    return out;
  });
}

async function complete(input, _onChunk, _onReasoning) {
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
    throw new Error(`API ${resp.status}: ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  const msg = json.choices?.[0]?.message ?? {};
  return { content: msg.content ?? null, tool_calls: msg.tool_calls ?? undefined };
}

/* ---------- 真实文件工具（路径限制在 scratch 内） ---------- */
function guard(p) {
  const r = resolve(p);
  if (!r.startsWith(resolve(SCRATCH))) {
    throw new Error(`路径越界: ${p}`);
  }
  return r;
}

async function executeTool(input) {
  const name = input.name;
  let args = {};
  try {
    args = JSON.parse(input.arguments || "{}");
  } catch {
    return { output: "参数解析失败", is_error: true };
  }
  try {
    switch (name) {
      case "read_file": {
        const p = guard(args.path);
        if (!existsSync(p)) return { output: `文件不存在: ${p}`, is_error: true };
        return { output: readFileSync(p, "utf8"), is_error: false };
      }
      case "write_file": {
        const p = guard(args.path);
        writeFileSync(p, String(args.content ?? ""), "utf8");
        return { output: `已写入 ${p}（${String(args.content ?? "").length} 字符）`, is_error: false };
      }
      case "list_dir": {
        const p = guard(args.path);
        const names = readdirSync(p, { withFileTypes: true }).map((e) =>
          e.isDirectory() ? `${e.name}/` : e.name,
        );
        return { output: names.join("\n") || "(空目录)", is_error: false };
      }
      case "grep": {
        const p = guard(args.path);
        const pattern = new RegExp(args.pattern);
        const hits = [];
        const walk = (d) => {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) walk(join(d, e.name));
            else {
              const f = join(d, e.name);
              const content = readFileSync(f, "utf8");
              if (pattern.test(content)) hits.push(`${f}: 匹配`);
            }
          }
        };
        walk(p);
        return { output: hits.join("\n") || "(无匹配)", is_error: false };
      }
      case "file_search": {
        const p = guard(args.path);
        const re = new RegExp(args.pattern);
        const found = readdirSync(p).filter((n) => re.test(n));
        return { output: found.join("\n") || "(无匹配)", is_error: false };
      }
      default:
        return { output: `测试环境未实现工具: ${name}`, is_error: true };
    }
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), is_error: true };
  }
}

/* ---------- 真实工具集（真实定义，去 shell/skill/网络，仅本地文件操作） ---------- */
const { TOOLS } = await import(join(__dir, "../agent-loop-smoke/out/tools.cjs"));
const LOCAL_TOOL_NAMES = new Set(["read_file", "write_file", "list_dir", "grep", "file_search"]);
const REAL_TOOLS = TOOLS.filter((t) => LOCAL_TOOL_NAMES.has(t.function.name));

/* ---------- 跑任务 ---------- */
const { runTaskLoop } = await import(join(__dir, "../agent-loop-smoke/out/utils/taskLoop.cjs"));

const task = {
  id: "real-1",
  title: "新任务",
  goal: `读取 ${SCRATCH}/a.txt 的内容，把内容写入 ${SCRATCH}/b.txt 并在末尾追加一行 REAL-TEST-OK，然后用 grep 在 ${SCRATCH} 目录搜索 REAL-TEST-OK 确认写入成功，最后总结结果。`,
  status: "pending",
  steps: [],
  createdAt: 1,
  updatedAt: 1,
};

const persists = [];
console.log("目标:", task.goal);
console.log("开始执行（真实 API + 真实文件工具）…\n");

const t0 = Date.now();
await runTaskLoop("real-1", {
  getTask: async () => structuredClone(task),
  persistTask: async (t) => persists.push(structuredClone(t)),
  generateTitle: async (goal) => {
    const r = await complete({ messages: [{ role: "user", content: `为以下任务生成 10 字内标题：${goal}` }] });
    return r.content ?? "真实任务";
  },
  complete,
  executeTool,
  getSkill: async () => { throw new Error("无技能"); },
  availableSkills: [],
  tools: REAL_TOOLS,
  maxRounds: 12,
  stepTimeoutMs: 8 * 60 * 1000,
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const final = persists[persists.length - 1];
console.log(`\n耗时 ${elapsed}s，状态: ${final.status}`);
console.log("标题:", final.title);
console.log("步骤:");
for (const s of final.steps) {
  console.log(`  [${s.status}] ${s.label}`);
  for (const tc of s.toolCalls) console.log(`    工具: ${tc.function.name} ${tc.function.arguments.slice(0, 120)}`);
}
if (final.result) console.log("结果:", final.result.slice(0, 400));

/* ---------- 断言 ---------- */
let failed = false;
const assert = (cond, name) => {
  console.log(cond ? `  ✅ ${name}` : `  ❌ ${name}`);
  if (!cond) failed = true;
};

assert(final.status === "done", "任务 done");
assert(final.steps.filter((s) => s.status === "done").length >= 2, "至少 2 个步骤完成");
assert(Boolean(final.result), "result 总结非空");
const bContent = existsSync(join(SCRATCH, "b.txt")) ? readFileSync(join(SCRATCH, "b.txt"), "utf8") : "";
assert(bContent.includes("REAL-TEST-OK"), "b.txt 包含 REAL-TEST-OK（真实写文件生效）");
assert(bContent.includes("这是真实测试文件"), "b.txt 包含 a.txt 内容（读取→写入链路生效）");
assert(final.steps.some((s) => s.toolCalls.some((tc) => tc.function.name === "grep")), "使用了 grep 工具");

console.log(failed ? "\n真实 API 任务测试失败 ❌" : "\n真实 API 任务测试全部通过 ✅");
process.exit(failed ? 1 : 0);
