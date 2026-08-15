# dswork 上下文缓存落地 — 验收标准

> 状态：**待审核**（2025-08-14）
> 依据：deepseek-harness 上下文缓存架构调研（见 `docs/context-cache-architecture.md`，任务 3 产出）。
> 三个任务按顺序实施，每个任务完成后按本节标准逐条验收，全部通过才进入下一个任务。

---

## 任务 1：Rust 后端解析 + 前端展示缓存命中统计

**现状盘点**（已核实）：后端 `api.rs` 已有 `UsageStats` / `RawUsage::normalize()`（兼容 DeepSeek `prompt_cache_hit_tokens` 与 OpenAI `cached_tokens` 两种形状）/ `stream_options.include_usage` / `chat-usage` 事件（先于 `chat-done` 发出）；前端 `useDeepSeekConfig` 已监听 `chat-usage` 并随 `ChatCompletionResult.usage` 返回；`agentLoop.ts` 已把 `usage` 写入 assistant 消息；`CacheStatsBadge`（单条消息徽标）与 `ChatHeader`（会话级聚合 chip）已存在。
**因此任务 1 以「端到端验证 + 补缺」为主。**

### 验收项

| # | 验收标准 | 验证方法 |
|---|---|---|
| 1.1 | 后端请求体携带 `stream_options.include_usage: true`，流式结束时 `chat-usage` 事件先于 `chat-done` 发出，且每条 SSE 只发一次 usage | 代码审查 + e2e 脚本打印事件顺序 |
| 1.2 | 归一化正确：DeepSeek 官方端点返回 `prompt_cache_hit_tokens` 时直接采用；OpenAI 兼容端点只返回 `prompt_tokens_details.cached_tokens` 时正确回退（`miss = prompt - cached`） | 单元级：构造两种 `RawUsage` JSON 断言 `normalize()` 输出（在 e2e 脚本内断言） |
| 1.3 | 单条 assistant 消息渲染缓存徽标：`缓存 {hit} / {miss} · 命中率 {rate}%`；tool 轮 assistant 消息同样携带 usage | 真实 API 一轮工具调用对话后检查 UI；无 headless 时检查 `ChatCompletionResult.usage` 已写入消息 |
| 1.4 | 会话头部 chip 渲染聚合统计：`缓存 {rate}% · {total} tokens`，tooltip 含命中/未命中/输出/请求次数明细 | UI 检查 |
| 1.5 | 无 usage 的旧会话 / 端点未返回 usage 时：徽标与 chip 均不渲染（不显示 0%、不报错） | 清空 usage 字段的会话数据重载检查 |
| 1.6 | usage 随消息持久化，重启应用后历史徽标仍渲染；再次发送请求时请求体不含 usage/reasoning/context 字段 | 重启应用 + 抓请求体 |
| 1.7 | 构建零错误：`pnpm build`（tsc strict + vite）与 `cargo check` | 命令行 |

**任务 1 已知缺口**：`api.rs` 剥离字段时未剥离 `id`——属任务 2 字节稳定范畴，在任务 2 一并处理（不阻塞任务 1 验收，但任务 2 完成后请求体必须纯净）。

---

## 任务 2：append-only 前缀稳定（让缓存真正命中）

**核心改造**：请求体「白名单化」+ 消息组装「纯追加」验证 + 真实 API 缓存命中 e2e。

### 2-A 请求体白名单（字节级前缀稳定的关键）

发送给 DeepSeek 的每条消息**只允许出现** OpenAI/DeepSeek 标准字段：
`role`、`content`、`name`、`tool_calls`、`tool_call_id`。
`id`、`reasoning`、`context`、`usage` 等内部字段一律剥离——确保请求字节只由语义内容决定，
system 消息每轮重建（新 UUID）不再破坏前缀。

### 2-B 消息组装纯追加

- `useChat.send` 的输入 = 持久化历史（append-only）+ 新 user 消息，不重建历史；
- `agentLoop` 每轮仅 `[...messages, assistantMsg]` / `[...messages, toolMsg]` 追加；
- compaction 是**显式 cache-bust**（前缀被摘要替换，下一次请求缓存归零属预期，同 DSH 设计）；
- system 消息内容由纯函数 `buildSkillIndexPrompt(available)` 生成，skills 不变时字节稳定；
  激活 skill 属合法的「header 变化」（该次请求缓存失效一次，预期行为）。

### 2-C 真实 API 缓存命中 e2e

新增 `scripts/cache-e2e/`（复用 `scripts/realtest` 基建与 `~/.dswork/config.json`，
仿 DSH `request-cache.e2e.ts` 断言），无 key 时打印跳过提示。

### 验收项

| # | 验收标准 | 验证方法 |
|---|---|---|
| 2.1 | **请求体纯净**：e2e 脚本捕获实际发送的 body，断言每条消息 JSON key 集合 ⊆ {role, content, name, tool_calls, tool_call_id}，绝无 `id` | e2e 脚本内断言 |
| 2.2 | **字节级前缀扩展**：同一历史构造相邻两次请求，白名单化序列化后，请求 2 的 messages 前 N-1 条与请求 1 完全一致（逐字节），第 N 条为追加 | e2e 脚本内断言（本地即可跑，无需 API） |
| 2.3 | **真实缓存命中**：第一次请求（记录 usage）→ 追加一条 user 消息 → 第二次请求；断言第二次 `prompt_cache_hit_tokens > 0` | `scripts/cache-e2e/run.sh`（需 API key） |
| 2.4 | **工具调用多轮场景**：一轮含工具调用的对话（≥2 次请求），第 2 次起每次 `prompt_cache_hit_tokens > 0`（同 DSH e2e 断言强度） | 同上，场景 B |
| 2.5 | 回归：`pnpm build` 通过；聊天零行为回归（`scripts/uitest` 无头浏览器套件通过，若涉及前端改动） | 命令行 |
| 2.6 | system 短前缀不阻塞验收：e2e 用与真实对话一致的消息组装（system + 历史），断言在真实 token 规模下成立 | e2e 脚本 |

---

## 任务 3：研究结论归档

### 验收项

| # | 验收标准 | 验证方法 |
|---|---|---|
| 3.1 | 新增 `docs/context-cache-architecture.md`：DSH 缓存架构四层（适配层 `dsh-llm-deepseek` / 契约层 `TokenUsage` DISJOINT / 架构层 reconstructable requests / 验证层 e2e）+ 核心代码摘录（`mapUsage`、`request-cache.e2e.ts` 断言）+ 与 dswork 的映射表 | 阅读检查 |
| 3.2 | 文档含 dswork 落地记录：任务 1/2 改了什么、请求体白名单规则、compaction 作为显式 cache-bust 的说明 | 阅读检查 |
| 3.3 | 文档含 e2e 复现方法：命令、依赖（`~/.dswork/config.json`）、断言含义；跑一次真实 e2e 并把实际命中数字记录进文档 | 阅读 + 运行记录 |

---

## 总体验收门槛

1. 三个任务各自验收项全部通过；
2. `pnpm build` 与 `cargo check` 零错误；
3. 真实 API e2e（2.3/2.4）跑通并留存输出（含 `prompt_cache_hit_tokens` 数值）；
4. 未覆盖项（如任务模块 `tasks.rs` 的 usage 透传）明确记录为「未做 / 不做」及原因，不悄悄漏掉。
