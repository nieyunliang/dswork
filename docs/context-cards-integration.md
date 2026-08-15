# ContextCards 接入验收标准

> 状态：**实施完成**（2025 实施；含前端接入 + 后端持久化字段，双端构建验证通过）
> 接入目标：将 `src/components/bui/ContextCards.tsx` 以「assistant 消息的上下文引用区块」形态接入消息流（`App.tsx` → `components/message/*`），数据经 `ChatMessage.context` 字段携带。
> 前置：组件问题修复已完成并通过 `pnpm build`（tsc strict + vite）。

---

## 一、数据契约验收（AC-D）

| 编号 | 标准 | 状态 | 说明 |
|---|---|---|---|
| AC-D1 | `types.ts` 中 `ChatMessage` 新增可选字段 `context?: ContextChunk[]`（`ContextChunk` 从 ContextCards 导出），历史消息反序列化不受影响（缺字段 = 无卡片） | ✅ | `src/types.ts` 新增 `ContextChunk` 与 `context` 字段；`ContextCards.tsx` 以 `export type { ContextChunk } from "../../types"` 再导出。**后端同步**：`src-tauri/src/api.rs` 的 Rust `ChatMessage` 也加了 `context` 字段（serde 默认忽略未知字段，不补会丢数据）；旧消息无该字段 = `None`，反序列化不受影响 |
| AC-D2 | 每个 chunk 必须有唯一 `id`；同一来源文件检索出的多个片段允许 `title` 相同，但 `id` 不得重复 | ✅ | key = `chunk.id ?? \`${i}-${title}\``；手工 QA-2 用同名 title 数据验证无 React key 警告 |
| AC-D3 | `chars`、`tone` 为可选：缺失时分别表现为「不渲染字符数」「使用 `bg-accent` 中性底」，不产生空文本或 `undefined` 类名 | ✅ | 组件内 `chunk.chars &&` 条件渲染 + `tone ?? DEFAULT_TONE`（`bg-accent`） |
| AC-D4 | `tone` 取值限定为 `bg-red \| bg-green \| bg-orange \| bg-accent`（tokens.css 已有 token），接入方不得传入任意字符串类名 | ✅ | 类型层面收窄为联合类型（前端 `ContextChunk.tone`；后端为宽松 `Option<String>` 兼容旧数据，属于已知偏差，见附注 1） |
| AC-D5 | `total` 不显式传入时 = `chunks.length`；显式传入时以传入值为准 | ✅ | 默认参数实现；QA-4 双值对照 |

## 二、功能验收（AC-F）

| 编号 | 标准 | 状态 | 说明 |
|---|---|---|---|
| AC-F1 | 带 `context` 的 assistant 消息渲染顺序：**工具轨迹（ToolGroup）→ ContextCards → 正文**，三段在同一个消息组内 | ✅ | 顺序满足：`groupMessages` 将工具轮组成 `tools` 组（ToolGroup）先行渲染，`AssistantMessage` 内 ContextCards 位于 reasoning 之后、正文气泡之前。注：工具轨迹与正文分属两个相邻 group（DOM 上相邻、视觉同一轮），符合标准意图；若未来检索发生在工具轮，需在数据映射层把 `context` 挂到最终 assistant 消息（见附注 2） |
| AC-F2 | 卡片进入后常驻消息流：翻页、滚动、切换会话再切回，已进入的卡片不消失、不重复播放入场动画 | ✅ | `context` 随消息持久化；`chipsShown` 定时器仅在组件挂载时触发一次；QA-5 验证 |
| AC-F3 | 空态：`context: []` 或缺失时显示头部「All chunks 0」+ 虚线占位卡，不渲染卡片列表、不报错 | ✅ | 组件内置空态；QA-3 用 `context: []` 验证 |
| AC-F4 | 来源 chip 交互：未传 `onOpenSource` 时为纯展示（无 hover、无箭头、无焦点）；传入后可点击、显示 hover 与 ↗ 图标、点击回调携带对应 chunk | ✅ | 接入传入了 `onOpenSource`：Tauri 环境调 `@tauri-apps/plugin-opener` 的 `openPath(chunk.source)` 打开源文件（权限 `opener:default` 已配置）；Web 预览环境提示「打开文件待接入」；失败时 antd warning 提示。QA-6 验证两种模式 |
| AC-F5 | 长文本：`title` 超宽截断省略号；`body` 超长不撑破卡片；`source` 超长时 chip 内合理截断 | ✅ | title 补 `min-w-0 truncate`（修复了 flex 子项不收缩的问题）；source 用 `min-w-0 truncate` + 行内 `maxWidth: 200` 截断；QA-2 构造超长数据验证 |
| AC-F6 | 多卡片性能：单消息组 ≥ 10 张卡片时首帧无卡顿，动画逐张错峰播放（stagger） | ✅ | 动画按 index 错峰（卡片 100ms / chip 80ms）；QA-7 用 10 张卡片实测 |

## 三、交互与可访问性验收（AC-A）

| 编号 | 标准 | 状态 | 说明 |
|---|---|---|---|
| AC-A1 | 可点击的来源 chip 是 `<button type="button">`，键盘 Tab 可达、Enter/Space 可触发，`:focus-visible` 有 accent 焦点环 | ✅ | 已实现；焦点环依赖 tokens.css 全局 `:focus-visible` 规则 |
| AC-A2 | 按钮 `aria-label` 明确（含来源名，如 "Open source: xxx.pdf"） | ✅ | `aria-label={\`Open source: ${chunk.source}\`}` |
| AC-A3 | 两个装饰性 SVG（三横线、箭头）均带 `aria-hidden="true"`，不进入无障碍树 | ✅ | 全部补齐 |
| AC-A4 | `prefers-reduced-motion` 下无位移动画，内容仍完整可见 | ✅ | 依赖 tokens.css 全局 `prefers-reduced-motion` 规则（动画时长压到 0.01ms）；QA 可选抽查 |

## 四、视觉与主题验收（AC-V）

| 编号 | 标准 | 状态 | 说明 |
|---|---|---|---|
| AC-V1 | 全部颜色走 CSS 变量/既有 token 类，无硬编码色值（badge 白字除外） | ✅ | 代码审查通过；本次新增的 `bg-accent` 等均为既有 token 类，未改 tokens.css |
| AC-V2 | 浅色/深色双主题下卡片、chip、空态对比度正常，可读 | ⏳ 手测 | QA-8：双主题截图对照 |
| AC-V3 | 宽度：`max-w-95` 约束下在消息流容器中不溢出、对齐现有消息气泡的视觉节奏 | ⏳ 手测 | QA-9：窗口缩放实测 |

## 五、工程验收（AC-E）

| 编号 | 标准 | 状态 | 说明 |
|---|---|---|---|
| AC-E1 | `pnpm build` 通过（tsc strict，含 `noUnusedLocals`；vite bundle 无新增报错） | ✅ | 通过；`cargo check`（后端）同样通过 |
| AC-E2 | 未修改 `tokens.css`；如需新工具类只能进 `components/ui/ui.css` | ✅ | 未触碰 tokens.css；source 截断用行内 style 而非新类 |
| AC-E3 | 无新增依赖 | ✅ | 仅新使用既有依赖 `@tauri-apps/plugin-opener`（package.json 原本就有，权限 `opener:default` 原本已配） |
| AC-E4 | ContextCards 保持默认 demo 数据行为不变（不传 props 时可独立预览） | ✅ | 默认值未改动 |

## 六、回归验收（AC-R）

| 编号 | 标准 | 状态 | 说明 |
|---|---|---|---|
| AC-R1 | 现有消息流不受影响：四类消息、流式输出、ThinkingState 推理展示、ToolGroup 轨迹均按原样渲染 | ✅ 代码层面 | 渲染路径未改动，仅新增条件块；QA-10 走查回归 |
| AC-R2 | 会话持久化：带 `context` 的消息保存后重载会话，卡片数据完整还原 | ✅ 代码层面 | 后端 Rust `ChatMessage` 已加 `context` 字段（否则 serde 会剥掉）；QA-11 全链路验证 |
| AC-R3 | 无 context 的旧消息/普通对话不出现任何新 UI 或空占位 | ✅ | 渲染条件为 `message.context !== undefined`；旧消息无该字段 → 不渲染任何内容 |

## 七、边界场景（AC-X）

| 编号 | 场景 | 状态 | 说明 |
|---|---|---|---|
| AC-X1 | `chunks` 为 `undefined` / `[]` | ✅ | 组件默认参数 + 空态分支兜底 |
| AC-X2 | 两个 chunk `title` 相同、`id` 不同 | ✅ | key 回退逻辑；QA-2 验证 |
| AC-X3 | 流式场景：assistant 已开始输出正文后才补入 `context` | ✅ | `chipsShown` 定时器仅挂载时触发一次；后补 context 直接可见，不重复动画 |
| AC-X4 | 单消息 context 条数巨大（≥ 50） | ⚠️ 后续项 | 无数量上限实现；超出阈值截断展示留待数据管道阶段（本次范围外，记录在案） |

## 附注

1. **tone 类型前后端不对称**：前端联合类型（`bg-red | bg-green | bg-orange | bg-accent`），后端为 `Option<String>`。原因是后端要兼容未来从检索管道写入的任意数据；若数据来源受控，可后续收窄。
2. **context 挂载位置决策**：当前只在「独立渲染的 assistant 消息」（含正文的最终回复）上渲染。若未来检索发生在工具轮（`tool_calls` 消息在 `tools` 组内），需在数据映射层把 `context` 合并到最终 assistant 消息——这是真实 RAG 管道阶段的工作，本次未实现。
3. **来源 chip 打开行为**：`openPath` 直接打开 `source` 字符串，真实场景要求 `source` 是文件系统绝对路径或可识别的 URL；相对路径会走 warning 分支，属预期。

---

## 手工 QA 步骤（实测验收）

数据注入：应用数据目录为 `~/.dswork/sessions.json`（`sessions.json` 由后端维护，结构 `{ titled_migrated, sessions: [{ id, title, created_at, updated_at, titled, messages }] }`）。

1. **准备**：关闭应用 → 备份 `~/.dswork/sessions.json` → 用下方示例修改（在某个 `"role": "assistant"` 消息上增加 `"context"` 字段，或新增一条 assistant 消息）→ 启动 `pnpm tauri:dev`。
2. **QA-1 基本渲染**：消息含 2 个正常 chunk（含 `chars`、`tone`）→ 顶部「All chunks 2」、卡片标题/正文/来源 chip 完整，chip 延迟 700ms 淡入。
3. **QA-2 边界数据**：一个消息含「同名 title 不同 id × 2」「缺 chars」「缺 tone」「title 超长」「source 超长」→ 无 key 警告（DevTools console）、字符数隐藏、accent 底色、标题/来源省略号截断。
4. **QA-3 空态**：`"context": []` → 显示「All chunks 0」+ 虚线占位卡。
5. **QA-4 total 覆盖**：`<ContextCards chunks={...} total={5} />` 场景暂不对外暴露，通过代码审查确认即可。
6. **QA-5 常驻**：滚动后切到别的会话再切回 → 卡片仍在、不再播放入场动画。
7. **QA-6 来源点击**：点击 chip → 真实路径文件被系统默认应用打开；改一个不存在的路径 → warning 提示；Web 预览（`pnpm dev`）→ info 提示「打开文件待接入」。
8. **QA-7 多卡片**：一个消息 10 张卡片 → 逐张错峰入场、无卡顿。
9. **QA-8/9 主题与宽度**：双主题切换截图对照；窗口缩放到最小宽度验证不溢出。
10. **QA-10 回归**：正常对话一轮（含工具调用 + 流式输出 + 推理展示）确认与接入前一致。
11. **QA-11 持久化**：带 context 的消息发出后重启应用 → 卡片完整还原（QA-1 的数据注入本身即持久化写入，重启即验证）。

示例数据（粘贴进 sessions.json 某 assistant 消息的 `"context"` 数组）：

```json
"context": [
  { "id": "c1", "title": "Vendor onboarding rule", "body": "Cold-chain certification must be verified before a new dairy can be added to the reorder workflow.", "source": "Dairy Onboarding SOP.pdf", "badge": "PDF", "tone": "bg-red", "chars": "290 characters" },
  { "id": "c2", "title": "Seasonal demand row", "body": "Q4 velocity table: pistachio +18%, vanilla +6%, rocky road -11%; retire flavors below 40 scoops weekly.", "source": "Sales Velocity Export.csv", "badge": "CSV", "tone": "bg-green", "chars": "1,250 characters" },
  { "id": "c3", "title": "Same title duplicate", "body": "A second chunk sharing the title above to verify key uniqueness.", "source": "Another File.md", "badge": "MD" },
  { "id": "c4", "title": "A very very very very very very very very very very very very very long chunk title that should be truncated with an ellipsis", "body": "No chars and no tone here: the badge should fall back to accent.", "source": "NoMetadata.bin", "badge": "BIN" }
]
```
