# dswork 上下文缓存架构落地记录

> 状态：**已实现**（2025-08-14）
> 关联验收标准：`docs/context-cache-acceptance.md`（任务 1/2/3 全部通过）。
> 上游设计参考：deepseek-harness 的「可重建请求」架构与 DeepSeek 磁盘上下文缓存。

## 1. 背景：DeepSeek 磁盘上下文缓存（服务端能力）

DeepSeek API 对请求 prompt 做 **64-token 粒度的磁盘前缀缓存**：只要本次请求的 prompt 前缀与
之前某次请求一致（字节级），命中的那部分按**更低的计费价格**计费，且 `usage` 返回
`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（OpenAI 兼容端点则返回
`prompt_tokens_details.cached_tokens`）。

因此客户端能否白嫖缓存，取决于**相邻请求是否共享字节级一致的前缀**——这是 deepseek-harness
「Model-visible ⟺ durably referenced」（请求可重建）架构的推论 #1：
> append-only 的会话日志 + 纯函数投影 → 每个请求是前一个请求的「字节级相同前缀 + 追加扩展」
> （append-extension）→ 前缀缓存命中是涌现的，不是手动管理的。

## 2. deepseek-harness 的缓存链路（四层）

| 层 | 组件 | 职责 |
|---|---|---|
| 服务端能力 | DeepSeek API 磁盘上下文缓存 | 64-token 粒度前缀缓存，命中部分低价计费 |
| 适配层 | `dsh-llm-deepseek`（`translate.ts::mapUsage`） | 解析 `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`，映射为 harness 的 `cacheReadTokens` |
| 契约层 | `dsh-llm`（`TokenUsage`） | 计数互斥约定：`inputTokens` 只含未缓存输入，缓存读取单独报 |
| 架构层 | `dsh-agent-loop`（reconstructable requests） | append-only 事件日志 + 纯函数 `deriveEventMessage` 投影 + `EpochHeader` 全量快照 → 前缀字节级稳定 |
| 验证层 | `request-cache.e2e.ts`（需 `DEEPSEEK_API_KEY`） | 真实 API 断言：第一个请求之后的每个请求 `cacheReadTokens > 0` |

核心代码（harness 侧，验证属实）：

```ts
// dsh-llm-deepseek/src/translate.ts
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),   // 互斥：从总输入中扣除缓存命中
    outputTokens: usage.completion_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}
```

## 3. dswork 落地映射

### 任务 1：后端解析 + 前端展示（本轮验证 + 单测补缺）

| 能力 | dswork 位置 | 状态 |
|---|---|---|
| 请求 `stream_options.include_usage` | `src-tauri/src/api.rs::send_deepseek_chat` | 已有 |
| 流式 usage 归一化（DeepSeek 原生字段 + OpenAI `cached_tokens` 回退） | `api.rs::RawUsage::normalize()` | 已有，补 2 个单测（`normalize_*`） |
| 流式事件按请求独立下发（Tauri Channel `StreamEvent`，`usage` 先于 `done` 同通道有序到达） | `api.rs` → `src/hooks/useDeepSeekConfig.tsx` | 已有（2025-08-14 由全局事件迁移到 Channel：聊天与后台任务并发时不再串台，usage 归属不再错乱） |
| 前端从 Channel 接收 usage 并随结果返回 | `useDeepSeekConfig.tsx::sendChatCompletion` | 已有 |
| usage 写入 assistant 消息（含工具轮） | `src/utils/agentLoop.ts` | 已有 |
| 单条消息缓存徽标（命中/未命中/命中率） | `src/components/bui/CacheStatsBadge.tsx` | 已有 |
| 会话级聚合 chip（含 tooltip 明细） | `src/components/ChatHeader.tsx` + `App.tsx::sessionCacheStats` | 已有 |
| 无 usage 的旧会话不渲染 | 两端 `if (!usage) return null` | 已有 |
| usage 随消息持久化（重启仍显示） | `sessions.rs::StoredSession.messages`（ChatMessage 含 usage） | 已有 |

### 任务 2：请求体白名单化 + append-only 前缀稳定（本轮核心改造）

**问题**：改造前 `api.rs` 只剥离 `reasoning`/`context`/`usage`，**`id`（前端
`crypto.randomUUID()`）留在请求体里**。`agentLoop` 每轮重建 system 消息（新 UUID），
相邻请求字节不一致，前缀缓存被静默破坏。

**改造**：`api.rs` 新增白名单函数，发给 DeepSeek 的消息只允许标准字段：

```rust
/// 请求体白名单：发送给 DeepSeek 的每条消息只允许这些标准字段。
const API_MESSAGE_ALLOWED_FIELDS: [&str; 5] = ["role", "content", "name", "tool_calls", "tool_call_id"];

fn to_api_message(m: &ChatMessage) -> serde_json::Value {
    let mut v = serde_json::to_value(m).unwrap_or_default();
    if let Some(obj) = v.as_object_mut() {
        obj.retain(|k, _| API_MESSAGE_ALLOWED_FIELDS.contains(&k.as_str()));
    }
    v
}
```

**为什么这样就够了**：前端消息流本来就是 append-only——`useChat.send` 输入 =
持久化历史（append-only）+ 新 user 消息；`agentLoop` 每轮仅
`[...messages, assistantMsg]` / `[...messages, toolMsg]` 追加。system 消息内容由纯函数
`buildSkillIndexPrompt(available)` 生成（skills 不变则字节稳定）。白名单化后，请求字节
只由语义内容决定，UUID 等内部字段不再泄漏进请求体 → 相邻请求自动满足字节级前缀扩展。

**显式 cache-bust（预期行为，非缺陷）**：
- **compaction**：`maybeCompact` 把旧历史替换为摘要 → 前缀被替换 → 下一次请求缓存归零；
- **激活 skill**：`load_skill` 后 system 消息追加 → 该次请求缓存失效一次；
这两者与 harness 设计一致（"a header change or compaction appears as a cache-read drop on the next step"）。

### 任务 3 的验证层：`scripts/cache-e2e/`

仿 harness `request-cache.e2e.ts` 的真实 API e2e，三个场景：

| 场景 | 断言 | 依赖 |
|---|---|---|
| A 字节级前缀扩展（本地） | 相邻请求剥离内部字段后前 N-1 条逐字节一致，第 N 条为追加；无内部字段 | 无 |
| B 两轮追问（真实 API） | 第二次请求 `prompt_cache_hit_tokens > 0` | API key |
| C 工具调用多轮（真实 API） | 第 2 步起每次 `prompt_cache_hit_tokens > 0`；工具值进入最终回答 | API key |

运行：`scripts/cache-e2e/run.sh`（复用 `scripts/agent-loop-smoke` 的 tsc 编译产物，
与前端同一份 `agentLoop.ts` / `message.ts` 代码；无 key 时场景 B/C 跳过并提示）。

## 4. 真实运行记录（2025-08-14）

```
=== 场景 A：相邻请求字节级前缀扩展（本地） ===
  通过：请求 2 前 3 条与请求 1 逐条字节一致，第 4 条为追加，无内部字段。

=== 场景 B：真实 API 第二次请求缓存命中 ===
  请求 1: hit=0 miss=347 (0% 命中率)
  请求 2: hit=256 miss=115 (69% 命中率)   ← 第二次请求命中缓存 ✅
  通过：第二次请求命中缓存。

=== 场景 C：真实 API 工具调用多轮缓存命中 ===
  请求 1: hit=0 miss=456 (0% 命中率)
  请求 2: hit=512 miss=45 (92% 命中率)   ← 第 2 步起命中缓存 ✅
  通过：2 次请求，第 2 次起全部命中缓存，工具值进入最终回答。

✅ cache-e2e 全部通过
```

Rust 单测：`cargo test` 6 项全过（新增 5 项：normalize 三种形状 + 白名单两组断言）。
构建：`pnpm build` 与 `cargo check` 零错误。

## 5. 实测命中率审计（2025-08-14 续）：为什么是 90-95% 而不是 99%

> 现象：DSH 每请求命中率 ~99%，dswork 实测聚合只有 91.9%（用户观察的「90-95」区间）。
> 方法：`scripts/cache-audit/audit.mjs` 从 `~/.dswork/sessions.json` 还原每次真实请求
> （白名单 + serde_json BTreeMap 排序序列化，与 `api.rs` 等价），用消息里持久化的
> usage 统计分布，并对相邻请求做字节级前缀对比。真实数据：2 个会话、53 次请求。

### 5.1 实测数字

```
总 tokens: hit=1,843,968  miss=162,147  → 聚合命中率 91.9%（= 前端头部 chip 的数字）
单次请求分布: ≥99%: 30 次 | 95-99%: 6 | 90-95%: 4 | 80-90%: 4 | <80%: 9
中位数 99.3% —— 稳态其实没问题，聚合被少数「断裂」请求拖低。
```

### 5.2 根因拆解（miss tokens 归因）

| 类别 | 次数 | miss tokens | 占比 | 说明 |
|---|---|---|---|---|
| **前缀断裂**（hit 远低于上一请求 prompt） | 4 | 105,879 | **65.3%** | 其中 2 次可解释、2 次不可见 |
| ├ load_skill 激活 | 2 | 40,484 | 25% | 合法 header 变化（system 追加 skill 正文 + `selectTools` 收缩 tools） |
| └ **system 静默回退** | 2 | 65,395 | 40% | 会话切换 / 应用重启清空了内存态 activeSkills → system 退回「无 skill」版本 |
| 正常追加（工具输出全文 + 新消息） | 47 | ~56,268 | ~35% | 单轮追加 15-37KB（`run_shell` 等结果全文进消息） |

关键证据（前缀断裂的命中值 = 回退到早期会话基线的签名）：
- `req#46`：追加仅 2.4KB，hit=2432（期望 ≈73,854）→ 命中值恰为「base + 全量 tools + 最早几条消息」时期的缓存项；
- `req#3`：hit=768（期望 ≈2,432）→ 恰为「无 skill 的 base」前缀长度。
- 消息历史字节对比：**0 次中段改写**——白名单 + append-only 架构在真实数据上成立，断裂全部发生在不可见的 system/tools 部分。

### 5.3 修复（2025-08-14 随本审计落地）

1. **active_skills 按会话持久化**（`sessions.rs::save_session_active_skills` + `useChat` 切换/重启后恢复）：
   会话切换与重启不再清空已激活 skill，system 前缀不再静默回退 → 消除最大一类断裂（40% miss）。
   原「切走即清空」是内存态设计，代价是每次切回都烧一次全量缓存。
2. **每请求前缀指纹日志**（`api.rs::prefix_fingerprint`，FNV-1a 64bit，system 消息 + tools 数组的稳定字节指纹）：
   每次请求 `eprintln!` 一行 `[cache] prefix=… hit=… miss=…`。历史消息的 append-only 可由会话数据审计，
   但 system/tools 在持久化数据里不可见——指纹让下一次断裂可以直接定位（相邻两行指纹不一致 = 前缀被改写）。
3. **审计脚本** `scripts/cache-audit/audit.mjs`：真实数据回放 + 断裂判定（期望命中 = 上一请求 prompt_tokens），
   无 API key 依赖，随时可复跑。

### 5.4 仍然存在（与 DSH 的结构性差距，未改）

- **工具输出全文进消息**：DSH 把大输出存文件、消息里只放短引用（每轮增量 ~1%），dswork 全文嵌入
  （单轮 15-37KB ≈ 3-9k tokens）→ 正常追加类请求的命中率天然只有 80-95%。这是「99% vs 90-95%」的另一半差距。
  已由第二轮 L3 缓解（发送前对超长工具输出做确定性截断，见 §7）；DSH 式「输出落文件 + 短引用」仍是最优解，属产品决策。
- **load_skill 激活**是合法的 header 变化（每次激活烧一次缓存，预期行为，同 DSH「header change」设计）。
- **compaction / 推理等级切换**：compaction 在真实数据中未触发（0 次）；推理等级切换是否影响缓存前缀
  无法从历史数据验证（无每请求参数记录），已由 5.3 的指纹日志覆盖观测。

## 6. 后续可做（未做 / 不做）

- **任务模块（`tasks.rs`）usage 透传**：`TaskRun` 的步骤目前 `usage: None`，任务抽屉不展示
  缓存统计。聊天侧已完整覆盖，任务侧需要 UI 设计（步骤卡片加统计位），本轮**不做**，记录在此。
- **会话级缓存失效可视化**：DSH 以「下一步 cache-read 归零」作为 header 变化/compaction 的
  观测信号，dswork 可在头部 chip 上标记"摘要后缓存重置"，属体验增强，未做。
- **summarize/generate_title 等一次性请求**：本就无前缀可复用，无需处理。

## 7. 第二轮优化：聚合命中率 91.9% → 97%+（L1-L4）

第一轮（§5）结论是「断裂全部发生在不可见的 system/tools 部分 + 正常追加偏大」。本轮把四个杠杆落地：

### L1 tools 恒全量（消除 load_skill 断裂中无谓的一半）

- 原：`selectTools` 按活跃 skill 白名单收缩 tools → 激活/回退时 tools 数组字节变化（tools 序列化在输入前缀前部、对话之前）→ 整个对话历史整段失配。审计里 load_skill 断裂 40,484 miss tokens，一半是 system 追加（合法），一半是 tools 收缩（无谓）。
- 改：`agentLoop.ts::selectTools` 恒返回全量工具集；`buildSystemMessages` 对活跃 skill 按 name 排序（同一集合无论激活顺序产出相同字节）。
- 效果：激活 skill 的断裂只剩「system 追加 skill 正文」一处；tools 字节跨请求稳定后本身进缓存，几乎免费。
- 代价：模型可见工具集变宽（与无 skill 时一致），需行为回归。

### L2 压缩阈值 16k 字符 → ~40k tokens（把周期性全前缀替换推迟到上下文窗口边缘）

- 原：`useChat.ts` 24 条消息 / 16k 字符即压缩（≈8-16k tokens，不足窗口 1/4）。压缩是**全前缀替换**（比 load_skill 更狠的断裂）：烧掉整个历史的缓存 + 永久丢失历史细节。
- 改：`estimateMessageTokens` 按 CJK≈1 token/字、其余≈0.25 token/字符估算，阈值 **~40k tokens + 48 条消息**。
- 依据：缓存命中价 ≈ 全价的 1/10，长历史重发几乎免费——压缩的唯一理由是上下文窗口，不是省钱。
- 附：真实 API 实测（200 OK）DeepSeek 接受 system 消息出现在历史中间，`[对话摘要]` 保持 role=system 不变。

### L3 工具输出确定性截断（缩小每轮新增 miss 量 Δ）

- 原：`read_file`/`run_shell` 输出全文进消息（单轮 15-37KB ≈ 3-9k tokens）→ 单次命中率 ≈ P/(P+Δ)，正常追加类请求只有 80-95%。
- 改：`agentLoop.ts::prepareApiMessages` 在 API 边界对 tool 消息做确定性截断（>10k 字符 → 头 8k + 尾 2k + 固定省略标记），**持久化与 UI 保留全文**。纯函数：同一持久化消息每次请求产出相同字节，append-only 前缀稳定不受影响。
- e2e 新增场景 A2 断言：截断确定性（两次准备逐字节一致）+ 截断后相邻请求前缀仍逐字节一致。

### L4 结构化缓存日志（断裂事件的直接证据）

- `api.rs` 每请求追加一行 `~/.dswork/cache-audit.jsonl`（ts / model / prefix 指纹 / sys_msgs / tools / hit / miss），stderr 保留原格式。
- `scripts/cache-audit/audit.mjs --log` 消费：聚合命中率 + 「前缀指纹变化 = system/tools 被改写」事件清单。
- 与 sessions.json 回放互补：指纹覆盖持久化数据里不可见的 system/tools 部分，断裂不再需要事后猜。

### 回归记录

`cargo test` / `pnpm build` 零错误；`scripts/cache-e2e` 场景 A/A2（本地）+ B/C（真实 API）全过；`audit.mjs --log` 在样例日志上验证聚合与断裂识别。
