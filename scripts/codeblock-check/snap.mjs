/* CodeBlock 体检：无头 Chrome 加载体检页，测量布局并输出截图。
 * 依赖：系统 Chrome + vite dev（http://localhost:1420）
 * 用法：node scripts/codeblock-check/snap.mjs [输出目录]
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(__dir, "shots");
mkdirSync(OUT, { recursive: true });

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEBUG_PORT = 9224;
const ENTRY = "http://localhost:1420/scripts/codeblock-check/entry.html";

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  "--remote-allow-origins=*",
  "--headless=new",
  "--no-first-run",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--force-color-profile=srgb",
  `--user-data-dir=/tmp/dswork-codeblock-profile-${process.pid}`,
  "--window-size=1400,1000",
  "about:blank",
], { stdio: "ignore" });

let ws;
try {
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
    }
  };

  await send("Page.enable");
  await send("Runtime.enable");

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

  async function waitFor(expression, desc, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (await evaluate(expression)) return;
      } catch { /* retry */ }
      await delay(250);
    }
    throw new Error("等待超时: " + desc);
  }

  async function measure() {
    return evaluate(`(() => {
      const sec = (id) => document.querySelector('section[data-case="' + id + '"]');
      const pre = (id) => { const s = sec(id); return s ? s.querySelector('pre') : null; };
      const card = (id) => { const s = sec(id); return s ? s.querySelector('div.overflow-hidden') : null; };
      const bubble = (id) => {
        const s = sec(id); if (!s) return null;
        return [...s.querySelectorAll('div')].find(d => d.className && String(d.className).includes('max-w-[70%]'));
      };
      const barSpans = (id) => {
        const s = sec(id); if (!s) return [];
        const bar = s.querySelector('.primitive-card-bar');
        return bar ? [...bar.querySelectorAll('span')] : [];
      };
      const r = (el) => el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null;
      const out = { viewport: window.innerWidth, bodyScrollW: document.documentElement.scrollWidth };
      for (const id of ['demo','short','long','msg-ts','msg-plain','msg-longline','msg-multi','taskrows']) {
        const p = pre(id), b = bubble(id), spans = barSpans(id);
        out[id] = {
          card: r(card(id)),
          pre: p ? { clientW: p.clientWidth, scrollW: p.scrollWidth, overflowX: getComputedStyle(p).overflowX, h: p.clientHeight } : null,
          bubble: b ? { ...r(b), maxWidth: getComputedStyle(b).maxWidth } : null,
          header: spans.length ? { filename: spans[0]?.textContent ?? null, lang: spans[spans.length - 1]?.textContent ?? null } : null,
        };
      }
      // ── 补充探测 ──
      const barOf = (id) => { const s = sec(id); return s ? s.querySelector('.primitive-card-bar') : null; };
      for (const id of ['msg-ts','msg-multi','msg-plain']) {
        const bar = barOf(id);
        if (bar) out[id + '-header-fit'] = { barClientW: bar.clientWidth, barScrollW: bar.scrollWidth };
      }
      const sPre = pre('short');
      const sLine = sPre ? sPre.querySelector('.whitespace-pre') : null;
      if (sPre && sLine) {
        out['short-space'] = {
          preH: sPre.clientHeight,
          contentBottom: Math.round(sLine.getBoundingClientRect().bottom) - Math.round(sPre.getBoundingClientRect().top),
        };
      }
      const lPre = pre('long');
      if (lPre) {
        const chain = [];
        let el = lPre;
        while (el && el !== document.body) {
          const cs = getComputedStyle(el);
          chain.push({ tag: el.tagName, overflowX: cs.overflowX, cls: String(el.className).slice(0, 50) });
          el = el.parentElement;
        }
        out['long-chain'] = chain;
      }
      const inline = sec('msg-multi') ? sec('msg-multi').querySelector('code:not([class*="language"])') : null;
      if (inline) {
        const cs = getComputedStyle(inline);
        out['inline-code'] = { paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, bg: cs.backgroundColor };
      }
      const tPre = pre('taskrows');
      if (tPre) {
        const rowEl = sec('taskrows').querySelector('button');
        out['taskrows-pre'] = {
          cls: tPre.className,
          lineCount: tPre.querySelectorAll('.whitespace-pre').length,
          fontSize: getComputedStyle(tPre).fontSize,
          lineHeight: getComputedStyle(tPre).lineHeight,
          paddingTop: getComputedStyle(tPre).paddingTop,
          paddingBottom: getComputedStyle(tPre).paddingBottom,
          rowExpanded: rowEl ? rowEl.getAttribute('aria-expanded') : null,
          preRectH: Math.round(tPre.getBoundingClientRect().height),
        };
      }
      return out;
    })()`);
  }

  async function shot(name) {
    const lm = await send("Page.getLayoutMetrics");
    const h = Math.ceil(lm.cssContentSize.height);
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1400, height: h, scale: 1 },
    });
    const buf = Buffer.from(shot.data, "base64");
    writeFileSync(join(OUT, name), buf);
    console.log("截图:", join(OUT, name), `(${buf.length} bytes, ${h}px 高)`);
  }

  // ── 亮色 ──
  await send("Page.navigate", { url: ENTRY });
  await waitFor(`document.querySelectorAll('section[data-case]').length === 8`, "8 个场景渲染");
  await delay(2600); // 等 demo 流式动画走到几行 + antd 样式注入
  const light = await measure();
  console.log("LIGHT:", JSON.stringify(light, null, 2));
  await shot("codeblock-light.png");

  // ── 暗色 ──
  await send("Page.navigate", { url: ENTRY + "?dark=1" });
  await waitFor(`document.querySelectorAll('section[data-case]').length === 8`, "8 个场景渲染(dark)");
  await delay(2600);
  const dark = await measure();
  console.log("DARK:", JSON.stringify(dark, null, 2));
  await shot("codeblock-dark.png");

  writeFileSync(join(OUT, "measures.json"), JSON.stringify({ light, dark }, null, 2));
  console.log("测量数据已写入:", join(OUT, "measures.json"));
} finally {
  try { ws?.close(); } catch { /* noop */ }
  chrome.kill("SIGTERM");
}
