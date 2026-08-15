/* 真实会话数据的上下文缓存字节级审计
 *
 * 目标：回答「为什么 DSH 命中率 ~99%，而 dswork 实测只有 90-95%」。
 * 方法：从 ~/.dswork/sessions.json 还原每次真实请求的字节流（白名单 + serde_json
 * BTreeMap 排序序列化，与 api.rs 等价），对相邻请求做前缀稳定性检查，并用每条
 * assistant 消息里持久化的 usage 统计命中率分布，按触发原因分类：
 *   - 会话首个请求（无前缀可命中）
 *   - compaction 后首请求（前缀被摘要替换 → 显式 cache-bust）
 *   - skill 激活后首请求（system 追加 → 合法 header 变化）
 *   - 其余（应 append-only，命中率应接近 100%）
 *
 * 用法：node scripts/cache-audit/audit.mjs
 * 依赖：~/.dswork/sessions.json（真实使用数据，无 API key 需求）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SESSIONS = join(process.env.HOME, ".dswork", "sessions.json");

/* ---------- --log 模式：消费 ~/.dswork/cache-audit.jsonl（api.rs 每请求一行） ----------
 * 与 sessions.json 回放互补：日志记录了 system/tools 前缀指纹（持久化数据里不可见），
 * 相邻请求指纹不一致 = 前缀被静默改写（skill 激活/回退、推理等级、tools 变化），
 * 该次请求缓存必然整段失效——这里是断裂事件的直接证据。
 * 用法：node scripts/cache-audit/audit.mjs --log
 */
if (process.argv.includes("--log")) {
  const LOG = join(process.env.HOME, ".dswork", "cache-audit.jsonl");
  let lines;
  try {
    lines = readFileSync(LOG, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (e) {
    console.error(`无法读取 ${LOG}: ${e.message}（应用每次请求会在 api.rs 追加一行）`);
    process.exit(1);
  }
  if (lines.length === 0) {
    console.log("cache-audit.jsonl 为空");
    process.exit(0);
  }
  const sum = (f) => lines.reduce((a, x) => a + f(x), 0);
  const hit = sum((x) => x.hit);
  const miss = sum((x) => x.miss);
  console.log(`\n=== cache-audit.jsonl（${lines.length} 次请求） ===`);
  console.log(
    `总 tokens: hit=${hit} miss=${miss} → 聚合命中率 ${((100 * hit) / Math.max(1, hit + miss)).toFixed(1)}%`,
  );
  const breaks = [];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    if (prev.prefix !== cur.prefix) breaks.push({ i: i + 1, prev, cur });
  }
  console.log(`前缀指纹变化（system/tools 被改写 → 缓存整段失效）: ${breaks.length} 次`);
  for (const b of breaks) {
    console.log(
      `  #${b.i} ${b.prev.prefix} → ${b.cur.prefix} (sys_msgs ${b.prev.sys_msgs}→${b.cur.sys_msgs}, tools ${b.prev.tools}→${b.cur.tools}) hit=${b.cur.hit} miss=${b.cur.miss}`,
    );
  }
  console.log("\n最近 10 次请求：");
  for (const x of lines.slice(-10)) {
    const rate = x.hit + x.miss > 0 ? Math.round((100 * x.hit) / (x.hit + x.miss)) : 0;
    console.log(
      `  [${new Date(x.ts).toISOString()}] prefix=${x.prefix} prompt=${x.prompt_tokens} hit=${x.hit} miss=${x.miss} (${rate}%)`,
    );
  }
  process.exit(0);
}

/* ---------- 与后端 api.rs to_api_message 等价的线格式 ---------- */
// serde_json 默认 Map = BTreeMap：key 按字母序；content 无 skip_serializing_if → None 时输出 null。
function wireMessage(m) {
  const out = { content: m.content ?? null, role: m.role };
  if (m.name) out.name = m.name;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.tool_calls?.length) out.tool_calls = wireToolCalls(m.tool_calls);
  return JSON.stringify(out); // 按插入序已是字母序：content < name < role < tool_call_id < tool_calls
}

function wireToolCalls(calls) {
  return calls.map((tc) => ({
    function: {
      arguments: tc.function.arguments,
      name: tc.function.name,
    },
    id: tc.id,
    type: tc.type ?? "function",
  }));
}

/* 请求 = system 前缀(本轮不变) + 该 assistant 消息之前的历史。
 * system 与 tools 在相邻请求间不变（除非 load_skill），审计只比较 messages 部分；
 * system 变化会作为「skill 激活」事件单独标记。 */
function buildRequest(messages, upToIndex) {
  return messages.slice(0, upToIndex).map(wireMessage);
}

/* 估算字节长度（UTF-8） */
function byteLen(s) {
  return Buffer.byteLength(s, "utf8");
}

/* 第一条不同的消息下标；全部相同返回 -1 */
function firstDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : a.length;
}

/* ---------- 加载数据 ---------- */
let sessions;
try {
  sessions = JSON.parse(readFileSync(SESSIONS, "utf8")).sessions ?? [];
} catch (e) {
  console.error(`无法读取 ${SESSIONS}: ${e.message}`);
  process.exit(1);
}

const hits = []; // {session, reqIndex, hit, miss, rate, appendedBytes, category, detail, prefixStable}
const sessionsWithUsage = sessions.filter((s) => s.messages.some((m) => m.usage));

for (const session of sessionsWithUsage) {
  const msgs = session.messages;
  const boundaries = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "assistant" && msgs[i].usage) boundaries.push(i);
  }
  if (boundaries.length < 1) continue;

  let sawCompaction = msgs.some((m) => m.role === "system" && m.content?.includes("[对话摘要]"));

  for (let k = 0; k < boundaries.length; k++) {
    const i = boundaries[k];
    const usage = msgs[i].usage;
    const hit = usage.prompt_cache_hit_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens ?? 0;
    const rate = hit + miss > 0 ? hit / (hit + miss) : 0;

    // 分类：只关心「上一次请求 → 本次请求」之间发生的事件
    // （load_skill 激活 / 摘要插入），其余均属 append。
    const prevBoundary = k > 0 ? boundaries[k - 1] : -1;
    const window_ = msgs.slice(prevBoundary + 1, i);
    const loadSkillInWindow = window_.some(
      (m) => m.role === "tool" && m.name === "load_skill",
    );
    const summaryInWindow = window_.some(
      (m) => m.role === "system" && m.content?.includes("[对话摘要]"),
    );

    let category = "append";
    if (k === 0) category = "first-request";
    if (loadSkillInWindow) category = "post-load-skill";
    else if (summaryInWindow) category = "post-compaction";

    // 前缀稳定性：与上一次请求逐条对比（首请求无对比对象）
    let prefixStable = null;
    let detail = "";
    if (k > 0) {
      const prev = buildRequest(msgs, boundaries[k - 1]);
      const cur = buildRequest(msgs, i);
      const d = firstDivergence(prev, cur);
      if (d === -1) {
        prefixStable = true; // 逐字节一致（纯追加）
        detail = `append +${cur.length - prev.length} msg`;
      } else if (d < prev.length) {
        prefixStable = false; // 中段改写 → 前缀断裂
        const before = JSON.parse(prev[d]);
        const after = JSON.parse(cur[d]);
        detail = `第 ${d} 条消息改写: ${before.role}(${byteLen(prev[d])}B) → ${after.role}(${byteLen(cur[d])}B)`;
      } else {
        prefixStable = true; // 旧消息全部一致，仅在尾部追加
        detail = `append +${cur.length - prev.length} msg`;
      }
    }

    // 追加内容字节量（本请求相对上一次请求新增的 messages 字节）
    let appendedBytes = 0;
    if (k > 0) {
      const prev = buildRequest(msgs, boundaries[k - 1]);
      const cur = buildRequest(msgs, i);
      for (let j = prev.length; j < cur.length; j++) appendedBytes += byteLen(cur[j]);
    }

    hits.push({
      session: session.title?.slice(0, 20),
      reqIndex: k,
      hit,
      miss,
      rate,
      category,
      detail,
      appendedBytes,
      prompt: usage.prompt_tokens ?? 0,
    });
  }
}

/* ---------- 汇总 ---------- */
const pct = (r) => `${(r * 100).toFixed(1)}%`;
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);

console.log(`\n=== 审计范围 ===`);
console.log(`会话 ${sessions.length} 个，其中带 usage 的 ${sessionsWithUsage.length} 个，共 ${hits.length} 次请求`);

const rates = hits.map((h) => h.rate);
console.log(`\n=== 命中率分布（DeepSeek 实测 usage） ===`);
console.log(`请求数: ${hits.length}`);
console.log(`平均命中率: ${pct(sum(rates, (r) => r) / hits.length)}`);
console.log(`中位数: ${pct([...rates].sort((a, b) => a - b)[Math.floor(rates.length / 2)])}`);
console.log(`最小: ${pct(Math.min(...rates))}  最大: ${pct(Math.max(...rates))}`);
console.log(`总 tokens: hit=${sum(hits, (h) => h.hit)} miss=${sum(hits, (h) => h.miss)}`);

const buckets = { ">= 99%": 0, "95-99%": 0, "90-95%": 0, "80-90%": 0, "< 80%": 0 };
for (const r of rates) {
  if (r >= 0.99) buckets[">= 99%"]++;
  else if (r >= 0.95) buckets["95-99%"]++;
  else if (r >= 0.9) buckets["90-95%"]++;
  else if (r >= 0.8) buckets["80-90%"]++;
  else buckets["< 80%"]++;
}
for (const [b, n] of Object.entries(buckets)) {
  console.log(`  ${b}: ${n} 次请求`);
}

console.log(`\n=== 按类别拆分 ===`);
const cats = [...new Set(hits.map((h) => h.category))];
for (const c of cats) {
  const arr = hits.filter((h) => h.category === c);
  const r = sum(arr, (h) => h.rate) / arr.length;
  console.log(
    `  ${c.padEnd(22)} n=${String(arr.length).padStart(3)}  平均命中率 ${pct(r)}  平均 miss=${Math.round(
      sum(arr, (h) => h.miss) / arr.length,
    )} tokens`,
  );
}

console.log(`\n=== 前缀稳定性 ===`);
const unstable = hits.filter((h) => h.prefixStable === false);
console.log(`中段改写（前缀断裂）的请求: ${unstable.length} 个`);
for (const h of unstable) {
  console.log(`  [${h.session}] req#${h.reqIndex} ${h.category}: ${h.detail}（命中率 ${pct(h.rate)}）`);
}

const appends = hits.filter((h) => h.prefixStable === true && h.category === "append");
console.log(`append-only 请求: ${appends.length} 个`);
console.log(`  其中平均追加字节/请求: ${Math.round(sum(appends, (h) => h.appendedBytes) / Math.max(1, appends.length))}B`);
console.log(`  其中平均 miss（= DeepSeek 重新计费部分）: ${Math.round(sum(appends, (h) => h.miss) / Math.max(1, appends.length))} tokens`);

// append 类命中率与追加字节的散点（前 15 个）
console.log(`\n=== append 类请求明细（按 miss 降序前 12） ===`);
const sorted = [...hits].sort((a, b) => b.miss - a.miss).slice(0, 12);
for (const h of sorted) {
  console.log(
    `  [${h.session}] req#${h.reqIndex} ${h.category.padEnd(18)} hit=${String(h.hit).padStart(6)} miss=${String(
      h.miss,
    ).padStart(5)} ${pct(h.rate).padStart(7)} 追加=${h.appendedBytes}B  prompt=${h.prompt}`,
  );
}

/* ---------- 结论提示 ---------- */
// 前缀断裂判定：本次请求的 hit 应 ≈ 上一次请求的 prompt_tokens（上次请求的全部
// prompt 都是本次请求前缀的一部分）。hit 显著低于它 = 前缀在两次请求之间被改写。
// （追加内容导致的低命中率不算断裂：追加是语义内容，miss 是正常的重新计费部分。）
const perSession = new Map();
for (const h of hits) {
  if (!perSession.has(h.session)) perSession.set(h.session, []);
  perSession.get(h.session).push(h);
}
let breaks = [];
for (const arr of perSession.values()) {
  let prevPrompt = null;
  for (const h of arr) {
    h.expectedHit = prevPrompt;
    if (prevPrompt !== null && prevPrompt - h.hit > 1024) {
      h.broken = true;
      breaks.push(h);
    }
    prevPrompt = h.prompt;
  }
}

console.log(`\n=== 解读 ===`);
const comp = hits.filter((h) => h.category === "post-compaction");
const skill = hits.filter((h) => h.category === "post-load-skill");
const first = hits.filter((h) => h.category === "first-request");
console.log(`- 首请求 ${first.length} 次，load_skill 激活后 ${skill.length} 次，compaction 后 ${comp.length} 次`);
if (unstable.length === 0) {
  console.log(`- 消息历史未发现非追加的中段改写 → 白名单 + append-only 在真实数据上成立`);
} else {
  console.log(`- ⚠️ 发现 ${unstable.length} 次消息中段改写，需进一步排查`);
}
console.log(`- 前缀断裂（hit 远低于上一请求 prompt）：${breaks.length} 次`);
for (const h of breaks) {
  const explainable = h.category !== "append";
  console.log(
    `    [${h.session}] req#${h.reqIndex} ${pct(h.rate)} hit=${h.hit}（期望≈${h.expectedHit}）miss=${h.miss} 追加=${h.appendedBytes}B ${
      explainable ? `可解释（${h.category}）` : "← 不可见前缀变化（skill 激活/回退、推理等级、重启）"
    }`,
  );
}
const breakMiss = sum(breaks, (h) => h.miss);
const loadSkillMiss = sum(skill, (h) => h.miss);
console.log(`- 断裂合计 miss=${breakMiss} tokens（占总 miss ${pct(breakMiss / Math.max(1, sum(hits, (h) => h.miss)))}），其中 load_skill 激活 ${loadSkillMiss} tokens`);
console.log(`- 其余 miss 来自每次请求的「追加内容」（工具输出全文进消息）：追加越大单次命中率越低`);
