/* runAgentLoop 冒烟测试（验收标准 §1.3 / §1.4）
 * 用法: ./run.sh（先编译 agentLoop.ts 到 out/，再跑本脚本）
 */
const assert = require("node:assert");
const {
  runAgentLoop,
  AgentLoopError,
  buildSkillIndexPrompt,
} = require("./out/utils/agentLoop.cjs");

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ✅ ${name}`);
}

async function main() {
  console.log("== 测试 1: 成功路径（工具轮 → 最终答复） ==");
  {
    let round = 0;
    const deps = {
      complete: async (input, onChunk) => {
        round++;
        if (round === 1) {
          onChunk?.("思考中…");
          return {
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.txt"}' },
              },
            ],
          };
        }
        return { content: "这是最终答复", tool_calls: undefined };
      },
      executeTool: async () => ({ output: "文件内容: hello", is_error: false }),
      getSkill: async () => { throw new Error("no skill"); },
      availableSkills: [],
      tools: [{ type: "function", function: { name: "read_file", description: "", parameters: {} } }],
      activeSkills: new Map(),
      onChunk: () => {},
    };
    const result = await runAgentLoop(
      [{ id: "u1", role: "user", content: "读文件 a.txt" }],
      deps,
    );
    assert.strictEqual(result.cancelled, false, "不应取消");
    assert.strictEqual(result.finalContent, "这是最终答复");
    // 结构: user, assistant(tool_calls), tool, assistant(content)
    const roles = result.messages.map((m) => m.role);
    assert.deepStrictEqual(roles, ["user", "assistant", "tool", "assistant"]);
    assert.strictEqual(result.messages[1].tool_calls[0].id, "call-1");
    assert.strictEqual(result.messages[2].tool_call_id, "call-1", "tool 消息应配对 assistant 的 tool_call_id");
    assert.strictEqual(result.messages[3].content, "这是最终答复");
    ok("结构断言通过");
  }

  console.log("== 测试 2: 场景A — 工具组残缺（onPersist 中途抛错）→ 剥离残缺组 ==");
  {
    let persistCalls = 0;
    const deps = {
      complete: async () => ({
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      }),
      executeTool: async () => ({ output: "ok", is_error: false }),
      getSkill: async () => { throw new Error("no skill"); },
      availableSkills: [],
      tools: [],
      activeSkills: new Map(),
      // assistant 消息落盘后、第 2 个工具结果落盘前抛错 → 该轮工具组不完整
      onPersist: async () => {
        persistCalls++;
        if (persistCalls === 2) throw new Error("持久化失败");
      },
    };
    let err = null;
    try {
      await runAgentLoop([{ id: "u1", role: "user", content: "go" }], deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof AgentLoopError, "应抛 AgentLoopError");
    // 残缺组（assistant + 部分 tool 消息）应被剥离 → 只剩 user
    assert.deepStrictEqual(err.messages.map((m) => m.role), ["user"], "残缺 tool 组应被剥离");
    ok("残缺组剥离通过");
  }

  console.log("== 测试 3: 场景B — 轮次边界失败（上一轮工具组完整）→ 保留完整组 ==");
  {
    let round = 0;
    const deps = {
      complete: async () => {
        round++;
        if (round === 1) {
          return {
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
            ],
          };
        }
        throw new Error("网络中断");
      },
      executeTool: async () => ({ output: "ok", is_error: false }),
      getSkill: async () => { throw new Error("no skill"); },
      availableSkills: [],
      tools: [],
      activeSkills: new Map(),
    };
    let err = null;
    try {
      await runAgentLoop([{ id: "u1", role: "user", content: "go" }], deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof AgentLoopError);
    // 上一轮完整工具组（assistant(tool_calls) + tool）必须保留
    assert.deepStrictEqual(
      err.messages.map((m) => m.role),
      ["user", "assistant", "tool"],
      "完整工具组不得被误删",
    );
    ok("轮次边界保留完整组通过（原缺陷已修复）");
  }

  console.log("== 测试 4: 取消（shouldStop） ==");
  {
    const deps = {
      complete: async () => { throw new Error("不应调用"); },
      executeTool: async () => ({ output: "", is_error: false }),
      getSkill: async () => { throw new Error("no skill"); },
      availableSkills: [],
      tools: [],
      activeSkills: new Map(),
      shouldStop: () => true,
    };
    const result = await runAgentLoop([{ id: "u1", role: "user", content: "go" }], deps);
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(result.finalContent, null);
    ok("取消语义通过");
  }

  console.log("== 测试 5: 轮数上限 ==");
  {
    const deps = {
      complete: async () => ({
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }],
      }),
      executeTool: async () => ({ output: "ok", is_error: false }),
      getSkill: async () => { throw new Error("no skill"); },
      availableSkills: [],
      tools: [],
      activeSkills: new Map(),
      maxRounds: 2,
    };
    let err = null;
    try {
      await runAgentLoop([{ id: "u1", role: "user", content: "go" }], deps);
    } catch (e) {
      err = e;
    }
    assert(err instanceof AgentLoopError);
    assert.match(err.message, /轮数上限/);
    ok("轮数上限通过");
  }

  console.log("== 测试 6: buildSkillIndexPrompt 空技能 ==");
  {
    const p = buildSkillIndexPrompt([]);
    assert.match(p, /暂无可用技能/);
    ok("空技能提示词通过");
  }

  console.log("== 测试 7: parsePlan（规划 JSON 解析与单步退化） ==");
  {
    const { parsePlan } = require("./out/utils/taskPlan.cjs");
    // 正常：围栏内 JSON 数组
    const steps = parsePlan('```json\n[{"label":"读取结构","plan":"先看目录"},{"label":"改文件","plan":"修改 A"}] \n```', "目标");
    assert.strictEqual(steps.length, 2);
    assert.strictEqual(steps[0].label, "读取结构");
    assert.strictEqual(steps[0].plan, "先看目录");
    assert.strictEqual(steps[0].status, "pending");
    assert.deepStrictEqual(steps[0].toolCalls, []);
    ok("正常规划解析通过");

    // 非法 JSON → 退化单步
    const fallback = parsePlan("我不是 JSON", "目标");
    assert.strictEqual(fallback.length, 1);
    assert.strictEqual(fallback[0].label, "目标");
    assert.strictEqual(fallback[0].status, "pending");
    ok("非法 JSON 退化单步通过");

    // null / 空内容 → 退化单步
    assert.strictEqual(parsePlan(null, "目标").length, 1);
    assert.strictEqual(parsePlan("", "目标").length, 1);
    ok("空内容退化单步通过");

    // 数组为空 / 无 label 元素 → 退化单步
    assert.strictEqual(parsePlan("[]", "目标").length, 1);
    assert.strictEqual(parsePlan('[{"plan":"没有label"}]', "目标").length, 1);
    ok("空数组/缺 label 退化单步通过");

    // 超过 MAX_STEPS 截断
    const many = JSON.stringify(
      Array.from({ length: 50 }, (_, i) => ({ label: `s${i}`, plan: "" })),
    );
    assert.strictEqual(parsePlan(many, "目标").length, 30);
    ok("步骤数上限截断通过");
  }

  console.log(`\n全部 ${passed} 项冒烟测试通过 ✅`);
}

main().catch((e) => {
  console.error("❌ 冒烟测试失败:", e);
  process.exit(1);
});
