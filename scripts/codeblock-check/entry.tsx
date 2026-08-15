/* CodeBlock 使用体检页：真实组件 + 真实 tokens.css/App.css，供无头 Chrome 截图与测量。
 * 用法：pnpm dev 后打开 /scripts/codeblock-check/entry.html（?dark=1 切暗色）。
 */
import { createRoot } from "react-dom/client";
import { App as AntdApp } from "antd";
import CodeBlock from "../../src/components/bui/CodeBlock";
import TaskRows from "../../src/components/bui/TaskRows";
import AssistantMessage from "../../src/components/message/AssistantMessage";
import type { ChatMessage } from "../../src/types";
import "../../src/components/bui/tokens.css";
import "../../src/App.css";

if (new URLSearchParams(location.search).get("dark") === "1") {
  document.documentElement.classList.add("dark");
}

const LONG_LINE = `const payload = { endpoint: "https://api.example.com/v1/stream?token=abcdef1234567890&format=json&retries=3&timeout=30000", body: { flavor: "pistachio", gallons: 42 }, headers: { "X-Request-Id": "req_01HZ..." } };`;

const LONG_CODE = `export async function churnBatch() {
  const flavor = await getFlavor("pistachio");
  const base = await dairy.fetch({ flavor });
  await freezer.store(base, { temp: "-14C" });
  return base.gallons;
}`;

const msg = (id: string, content: string): ChatMessage => ({
  id,
  role: "assistant",
  content,
  tool_calls: [],
  reasoning: "",
  context: undefined,
});

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section data-case={id} style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-3, #888)", margin: "0 0 8px" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Demo() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 20,
        padding: 24,
        maxWidth: 960,
        margin: "0 auto",
        fontFamily: "var(--font-inter, sans-serif)",
      }}
    >
      <Section id="demo" title="1) CodeBlock 默认（流式 demo）">
        <CodeBlock />
      </Section>
      <Section id="short" title="2) CodeBlock 短代码 animate=false（chat 实际用法）">
        <CodeBlock code={`const x = 1;`} language="ts" filename="short.ts" animate={false} />
      </Section>
      <Section id="long" title="3) CodeBlock 超长行 animate=false">
        <CodeBlock code={LONG_LINE} language="ts" filename="long.ts" animate={false} />
      </Section>
      <Section id="msg-ts" title="4) AssistantMessage：带语言 fence 的代码">
        <AssistantMessage message={msg("m-ts", "看这段代码：\n\n```ts\nconst a: number = 1;\nconsole.log(a);\n```\n\n就这些。")} />
      </Section>
      <Section id="msg-plain" title="5) AssistantMessage：无语言 fence（纯文本块）">
        <AssistantMessage message={msg("m-plain", "输出：\n\n```\nhello world\n```\n\n完毕。")} />
      </Section>
      <Section id="msg-longline" title="6) AssistantMessage：超长行代码">
        <AssistantMessage message={msg("m-long", "结果：\n\n```ts\n" + LONG_LINE + "\n```\n\n结束。")} />
      </Section>
      <Section id="msg-multi" title="7) AssistantMessage：多代码块 + 行内 code">
        <AssistantMessage message={msg("m-multi", "第一段：\n\n```json\n{\"a\": 1}\n```\n\n内联 `code` 与第二段：\n\n```py\nprint(1)\n```")} />
      </Section>
      <Section id="taskrows" title="8) TaskRows List 变体 + code 详情">
        <TaskRows
          variant="List"
          tasks={[
            {
              key: "t1",
              label: "写入 churn.ts",
              status: "done",
              details: [{ label: "churn.ts", kind: "code", content: LONG_CODE, language: "ts" }],
            },
          ]}
        />
      </Section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <AntdApp>
    <Demo />
  </AntdApp>,
);
