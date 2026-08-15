/* 无头浏览器 UI 冒烟测试（验收 U1–U7 与任务全流程的可自动化部分）
 * 依赖：系统 Chrome + Node 24（全局 WebSocket）+ vite dev（http://localhost:1420）
 * 用法：node scripts/uitest/run-uitest.mjs
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9223;
const APP_URL = "http://localhost:1420";

let passed = 0;
const failures = [];
function ok(name) {
  passed++;
  console.log(`  ✅ ${name}`);
}
function fail(name, detail) {
  failures.push(`${name}: ${detail}`);
  console.log(`  ❌ ${name} — ${detail}`);
}

/* ---------- 启动 Chrome ---------- */
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  "--remote-allow-origins=*",
  "--headless=new",
  "--no-first-run",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  `--user-data-dir=/tmp/dswork-uitest-profile-${process.pid}`,
  "--window-size=1400,900",
  "about:blank",
], { stdio: "ignore" });

const pageErrors = [];
let ws;

try {
  // 等待调试端口
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch { /* not ready */ }
    await delay(300);
  }
  if (!target) throw new Error("无法连接 Chrome 调试端口");

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let msgId = 0;
  const pending = new Map();
  function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      pageErrors.push("uncaught: " + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "?"));
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      pageErrors.push("console.error: " + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");

  // 注入 Tauri IPC 模拟层（在页面脚本之前）
  const mockSource = readFileSync(join(__dir, "mock-tauri.js"), "utf8");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__pageErrors = []; window.addEventListener('error', e => window.__pageErrors.push(String(e.message || e.error)));" });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: mockSource });

  // 导航到应用
  await send("Page.navigate", { url: APP_URL });

  async function evaluate(expression) {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error("页面执行异常: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    }
    return r.result.value;
  }

  async function waitFor(expression, desc, timeout = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const v = await evaluate(expression);
        if (v) return v;
      } catch { /* retry */ }
      await delay(250);
    }
    const dump = await evaluate(`JSON.stringify({
      tags: [...document.querySelectorAll('.ant-tag')].map(t=>t.textContent.trim()),
      buttons: [...document.querySelectorAll('button')].map(b=>b.textContent.replace(/\\s+/g,'')).slice(-12),
      failFlag: window.__failStep,
      mockLog: (window.__mockLog || []).slice(-70),
      stepRound: window.__stepRound,
      text: document.body.innerText.slice(0, 300),
      pageErrors: window.__pageErrors || null,
    })`).catch(() => "dump failed");
    throw new Error(`等待超时: ${desc} | dump=${dump}`);
  }

  const bodyText = () => evaluate("document.body.innerText");

  /** 在聊天输入框输入文本并点击发送 */
  async function sendChatText(text) {
    await evaluate(`(() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await delay(120);
    await evaluate(`document.querySelector('button[aria-label="Send"]').click()`);
  }

  /* ---------- 场景 A：聊天 R1（模拟回复） ---------- */
  console.log("== A: 聊天发送（回归代理） ==");
  await waitFor("!!document.querySelector('textarea')", "聊天输入框出现");
  await sendChatText("你好，介绍一下你自己");
  await waitFor(
    `document.body.innerText.includes('这是模拟回复')`,
    "聊天模拟回复出现",
  );
  ok("聊天发送 → 回复渲染（R1 代理）");

  /* ---------- 场景 B：任务全流程（规划→执行→收尾→done） ---------- */
  console.log("== B: 任务全流程 ==");
  await evaluate(`document.querySelector('button[aria-label="任务"]').click()`);
  await waitFor(`!!document.querySelector('input[placeholder*="输入任务目标"]')`, "任务抽屉打开（U1）");
  ok("ChatHeader 任务入口 → 抽屉打开（U1/U2）");

  await evaluate(`(() => {
    const input = document.querySelector('input[placeholder*="输入任务目标"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '重构这个项目');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(120);
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '发起任务');
    btn.click();
  })()`);
  await waitFor(`document.body.innerText.includes('读取项目结构')`, "步骤 1 出现（C1 规划全列）");
  await waitFor(`document.body.innerText.includes('修改文件')`, "步骤 2 出现");
  ok("规划后步骤全列 pending → TaskRows 渲染（C1/U3）");

  await waitFor(
    `document.body.innerText.includes('任务总结完成') && [...document.querySelectorAll('button')].some(b => b.textContent.replace(/\\s+/g, '') === '删除')`,
    "任务 done + 结果总结",
    30000,
  );
  const doneText = await bodyText();
  if (doneText.includes("已完成") && doneText.includes("结果总结")) {
    ok("任务 done + result 总结区（C5/U5）");
  } else {
    fail("任务 done + result", "缺少 已完成/结果总结 标记");
  }
  if (doneText.includes("2/2")) {
    ok("任务列表进度 2/2（U2 列表 + doneCount）");
  } else {
    fail("任务列表进度", `未找到 2/2，实际片段: ${doneText.slice(0, 300)}`);
  }
  if (doneText.includes("自动标题")) {
    ok("自动标题落盘（U6）");
  } else {
    fail("自动标题", "任务列表未显示自动标题");
  }

  /* ---------- 场景 C：取消 ---------- */
  console.log("== C: 取消任务 ==");
  await evaluate(`(() => {
    const input = document.querySelector('input[placeholder*="输入任务目标"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '取消演示任务');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(120);
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '发起任务');
    btn.click();
  })()`);
  await waitFor(
    `[...document.querySelectorAll('button')].some(b => b.textContent.replace(/\\s+/g, '') === '取消')`,
    "取消按钮出现（任务 running）",
  );
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.replace(/\\s+/g, '') === '取消');
    btn.click();
  })()`);
  await waitFor(`document.body.innerText.includes('已取消')`, "任务显示已取消", 20000);
  ok("取消 → 已取消（U4/2.4）");

  /* ---------- 场景 D：失败 → 重试 → done ---------- */
  console.log("== D: 失败重试 ==");
  await evaluate(`window.__failStep = true`);
  await evaluate(`(() => {
    const input = document.querySelector('input[placeholder*="输入任务目标"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '失败重试演示');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(120);
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '发起任务');
    btn.click();
  })()`);
  await waitFor(
    `document.body.innerText.includes('失败') && [...document.querySelectorAll('button')].some(b => b.textContent.trim().includes('重试「修改文件」'))`,
    "失败 pill + 重试按钮（C7/U4）",
    30000,
  );
  ok("步骤失败 → 失败标记 + 重试按钮（C7）");

  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim().includes('重试「修改文件」'));
    btn.click();
  })()`);
  await waitFor(
    `document.body.innerText.includes('任务总结完成')`,
    "重试后任务完成",
    30000,
  );
  ok("重试 → 跳过规划重跑失败步 → done（2.4）");

  /* ---------- 场景 E：删除 ---------- */
  console.log("== E: 删除任务 ==");
  // 注意：删除后抽屉 useEffect 会自动打开列表第一项，空态可能一闪而过，
  // 因此断言「任务列表项数量减少」而非空态。
  const countBefore = await evaluate(`[...document.querySelectorAll('button')].filter(b => b.className.includes('flex w-full flex-col')).length`);
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.replace(/\\s+/g, '') === '删除');
    if (btn) btn.click();
  })()`);
  await waitFor(
    `[...document.querySelectorAll('button')].filter(b => b.className.includes('flex w-full flex-col')).length < ${countBefore}`,
    "任务列表项减少（删除生效）",
  );
  ok("删除任务（B6）");

  // 关闭抽屉，回到聊天区
  await evaluate(`document.querySelector('.ant-drawer-close')?.click()`);
  await delay(300);

  /* ---------- 场景 F：聊天多轮工具调用（R2 代理） ---------- */
  console.log("== F: 聊天多轮工具调用 ==");
  await sendChatText("__TOOLTEST__ 读一下 a.txt");
  await waitFor(
    `document.body.innerText.includes('工具调用完成回复') && document.body.innerText.includes('运行了 1 个工具')`,
    "工具轮 + 最终答复",
    20000,
  );
  ok("聊天工具轮（read_file → 结果 → 最终答复）（R2 代理）");

  /* ---------- 场景 G：/skill 前缀激活（R3 代理） ---------- */
  console.log("== G: /skill 前缀 ==");
  await sendChatText("/code 帮我写一个排序函数");
  await waitFor(
    `document.body.innerText.includes('这是模拟回复') && document.body.innerText.includes('帮我写一个排序函数')`,
    "skill 前缀剥离后发送并回复",
    20000,
  );
  await waitFor(
    `document.body.innerText.includes('Skill(code)')`,
    "活跃 skill chip",
    10000,
  );
  ok("/code 激活 skill → 活跃 chip 出现（R3 代理）");

  /* ---------- 场景 H：长上下文压缩（R4 代理） ---------- */
  console.log("== H: 长上下文压缩 ==");
  for (let n = 1; n <= 13; n++) {
    await sendChatText("继续");
    await waitFor(
      `document.body.innerText.includes('这是模拟回复（#${n}）')`,
      `第 ${n} 条回复`,
      20000,
    );
  }
  await waitFor(
    `document.body.innerText.includes('早期对话已压缩为摘要')`,
    "压缩摘要消息出现",
    20000,
  );
  ok("超过压缩阈值 → 摘要系统消息（R4 代理）");

  /* ---------- 场景 I：发送中切换会话（R5 代理） ---------- */
  console.log("== I: 发送中切换会话 ==");
  await sendChatText("__SLOWTEST__");
  await delay(60); // 已发出、正在流式
  const clickResult = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '新对话');
    window.__diagBtns = btns.map(b => ({ cls: b.className.slice(0, 50), disabled: b.disabled }));
    const btn = btns.find(b => b.className.includes('mb-2')) || btns[0];
    if (btn) btn.click();
    return btns.length;
  })()`);
  if (clickResult === 0) console.log("[I] 未找到 新对话 按钮");
  await delay(800);
  const afterClick = await evaluate(`JSON.stringify({
    header: (document.querySelector('h1, .ant-typography') || {}).textContent,
    newDiaogBtns: [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '新对话').length,
    sessionsText: [...document.querySelectorAll('button')].filter(b => b.className.includes('group')).map(b => b.textContent.trim().slice(0, 20)),
  })`);
  console.log("[I] click 后状态:", afterClick);
  await delay(400);
  const leakedState = await evaluate(`JSON.stringify({
    leaked: document.body.innerText.includes('慢速回复'),
    hasContinue: document.body.innerText.includes('继续'),
    diagBtns: window.__diagBtns,
    text: document.body.innerText.slice(-260),
  })`);
  const leaked = JSON.parse(leakedState).leaked;
  if (!leaked) {
    ok("切会话后旧流式不污染新会话视图（R5 代理）");
  } else {
    fail("切会话防串台", "新会话视图出现了旧会话的流式内容 | " + leakedState.slice(0, 400));
  }
  // 切回旧会话：完整回复已持久化
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('模拟会话标题'));
    if (btn) btn.click();
  })()`);
  await waitFor(`document.body.innerText.includes('慢速回复内容ABCDEFG')`, "旧会话完整回复已持久化", 15000);
  ok("旧会话后台完成并持久化完整回复（R5 代理）");

  /* ---------- 场景 J：API 错误提示（R6 代理） ---------- */
  console.log("== J: API 错误 ==");
  await sendChatText("__ERRORTEST__");
  await waitFor(
    `document.body.innerText.includes('请求失败：模拟网络错误')`,
    "错误消息追加",
    20000,
  );
  ok("API 错误 → 追加可见错误消息（R6 代理）");

  /* ---------- 场景 K：无 API Key 任务优雅失败（E1） ---------- */
  console.log("== K: 无 API Key 任务失败 ==");
  await evaluate(`window.__failAllLlm = true`);
  await evaluate(`document.querySelector('button[aria-label="任务"]').click()`);
  await waitFor(`!!document.querySelector('input[placeholder*="输入任务目标"]')`, "任务抽屉重新打开");
  await evaluate(`(() => {
    const input = document.querySelector('input[placeholder*="输入任务目标"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '无密钥任务');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(120);
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.replace(/\\s+/g, '') === '发起任务');
    btn.click();
  })()`);
  await waitFor(
    `document.body.innerText.includes('未配置 API Key') && document.body.innerText.includes('失败')`,
    "任务失败 + 错误提示",
    20000,
  );
  ok("无 API Key → 任务 failed + 明确错误提示，无半死状态（E1）");
  // 清理：删除失败任务，复位标志
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.replace(/\\s+/g, '') === '删除');
    if (btn) btn.click();
  })()`);
  await evaluate(`window.__failAllLlm = false`);
  await delay(400);

  /* ---------- 汇总 ---------- */
  if (pageErrors.length > 0) {
    fail("页面无未捕获错误/console.error", pageErrors.slice(0, 5).join(" | "));
  } else {
    ok("无未捕获异常与 console.error");
  }
} finally {
  try { ws?.close(); } catch { /* noop */ }
  chrome.kill("SIGTERM");
}

console.log(`\nUI 冒烟结果: ${passed} 项通过, ${failures.length} 项失败`);
if (failures.length > 0) {
  console.log("失败明细:", failures.join("\n  - "));
  process.exit(1);
}
console.log("全部通过 ✅");
