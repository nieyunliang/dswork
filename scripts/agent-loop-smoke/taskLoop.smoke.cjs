/* runTaskLoop 集成冒烟测试（验收标准 §2.3–2.5 的可自动化部分）
 * 用法: 由 run.sh 编译后执行（node taskLoop.smoke.cjs）
 */
const assert = require("node:assert");
const { runTaskLoop } = require("./out/utils/taskLoop.cjs");

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ✅ ${name}`);
}

function baseTask(goal = "测试目标") {
  return {
    id: "t1",
    title: "新任务",
    goal,
    status: "pending",
    steps: [],
    result: undefined,
    error: undefined,
    sessionId: undefined,
    createdAt: 1,
    updatedAt: 1,
  };
}

const PLAN_JSON =
  '[{"label":"步骤1","plan":"先读取结构"},{"label":"步骤2","plan":"修改文件"}]';

/** 按脚本依次应答 complete；脚本元素可为值或函数(input)=>值 */
function makeComplete(script) {
  let i = 0;
  const seen = []; // {tools, userContent}
  const fn = async (input) => {
    seen.push({
      tools: (input.tools ?? []).map((t) => t.function.name),
      userContent: (input.messages[input.messages.length - 1] || {}).content || "",
    });
    const r = script[i++];
    if (typeof r === "function") return r(input);
    return r;
  };
  fn.seen = seen;
  return fn;
}

const MOCK_TOOLS = [
  "read_file", "write_file", "list_dir", "run_shell", "web_search",
  "web_fetch", "ask_user", "file_search", "grep", "read_pdf_or_image", "load_skill",
].map((name) => ({ type: "function", function: { name, description: "", parameters: {} } }));

function readOnlyTools() {
  return ["read_file", "list_dir", "grep", "file_search", "web_search", "web_fetch", "read_pdf_or_image", "load_skill"].sort();
}

async function main() {
  console.log("== T1: 正常流程（规划→执行→收尾，工具集与上下文正确） ==");
  {
    const complete = makeComplete([
      { content: PLAN_JSON, tool_calls: undefined },                    // 规划
      { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] }, // 步骤1工具轮
      { content: "步骤1完成", tool_calls: undefined },                  // 步骤1收尾
      { content: "步骤2完成", tool_calls: undefined },                  // 步骤2
      { content: "任务总结", tool_calls: undefined },                   // 收尾
    ]);
    const persists = [];
    const task = baseTask();
    await runTaskLoop("t1", {
      getTask: async () => structuredClone(task),
      persistTask: async (t) => persists.push(structuredClone(t)),
      generateTitle: async () => "自动标题",
      complete,
      executeTool: async () => ({ output: "文件内容: hello", is_error: false }),
      getSkill: async () => { throw new Error("no skill"); },
      availableSkills: [],
      tools: MOCK_TOOLS,
    });

    const final = persists[persists.length - 1];
    assert.strictEqual(final.status, "done");
    assert.strictEqual(final.result, "任务总结");
    assert.strictEqual(final.title, "自动标题");
    assert.strictEqual(final.steps.length, 2);
    assert.strictEqual(final.steps[0].status, "done");
    assert.strictEqual(final.steps[0].label, "步骤1");
    assert.strictEqual(final.steps[0].plan, "先读取结构");
    assert.strictEqual(final.steps[0].toolCalls.length, 1);
    assert.match(final.steps[0].outputs[0], /^read_file: 文件内容/);
    assert.strictEqual(final.steps[1].status, "done");
    ok("任务 done + 步骤状态 + result + 标题 + toolCalls/outputs 聚合");

    // 规划阶段只读工具；执行阶段全量（无 ask_user）
    assert.deepStrictEqual([...complete.seen[0].tools].sort(), readOnlyTools());
    const execTools = complete.seen[1].tools;
    assert.ok(execTools.includes("write_file"), "执行阶段应含写工具");
    assert.ok(!execTools.includes("ask_user"), "执行阶段不应含 ask_user");
    ok("工具集切分正确（规划只读 / 执行全量去 ask_user）");

    // C9：步骤2上下文带前序步骤摘要（步骤1 的一次 runAgentLoop 占 seen[1..2]，步骤2 首轮为 seen[3]）
    const step2User = complete.seen[3].userContent;
    assert.match(step2User, /步骤「步骤1」完成/);
    assert.match(step2User, /read_file\(/);
    assert.match(step2User, /当前步骤：步骤2/);
    ok("步骤上下文包含前序摘要（C9）");

    // 持久化序列：running → steps(全 pending) → 每步 running/done → done
    assert.strictEqual(persists[0].status, "running");
    assert.strictEqual(persists[1].steps.length, 2);
    assert.ok(persists.every((p) => p.steps.every((s) => s.status !== "running" || p.status === "running")));
    ok("节流落盘序列（步骤边界）");
  }

  console.log("== T2: 规划 JSON 解析失败 → 单步模式 ==");
  {
    const complete = makeComplete([
      { content: "这不是 JSON，我直接干", tool_calls: undefined },  // 规划退化
      { content: "一次性完成", tool_calls: undefined },             // 单步执行
      { content: "总结", tool_calls: undefined },                   // 收尾
    ]);
    const persists = [];
    await runTaskLoop("t1", {
      getTask: async () => baseTask("重构项目"),
      persistTask: async (t) => persists.push(structuredClone(t)),
      generateTitle: async () => "标题",
      complete,
      executeTool: async () => ({ output: "ok", is_error: false }),
      getSkill: async () => { throw new Error("no skill"); },
      availableSkills: [],
      tools: MOCK_TOOLS,
    });
    const final = persists[persists.length - 1];
    assert.strictEqual(final.status, "done");
    assert.strictEqual(final.steps.length, 1);
    assert.strictEqual(final.steps[0].label, "重构项目");
    assert.strictEqual(final.steps[0].status, "done");
    ok("非法 JSON 退化单步并完成");
  }

  console.log("== T3: 单步失败 → 该步 failed + 任务 failed ==");
  {
    const complete = makeComplete([
      { content: PLAN_JSON, tool_calls: undefined },
      async () => { throw new Error("网络炸了"); },
    ]);
    const persists = [];
    await runTaskLoop("t1", {
      getTask: async () => baseTask(),
      persistTask: async (t) => persists.push(structuredClone(t)),
      complete,
      executeTool: async () => ({ output: "ok", is_error: false }),
      getSkill: async () => { throw new Error("no skill"); },
      availableSkills: [],
      tools: MOCK_TOOLS,
    });
    const final = persists[persists.length - 1];
    assert.strictEqual(final.status, "failed");
    assert.strictEqual(final.steps[0].status, "failed");
    assert.match(final.steps[0].error, /网络炸了/);
    ok("步骤失败 → failed + 错误落盘");
  }

  console.log("== T4: 取消 → cancelled，已完步骤保留、当前步骤回 pending ==");
  {
    let cancelled = false;
    const complete = makeComplete([
      { content: PLAN_JSON, tool_calls: undefined },
      { content: "步骤1完成", tool_calls: undefined },
      () => { cancelled = true; return { content: "步骤2完成", tool_calls: undefined }; },
    ]);
    const persists = [];
    await runTaskLoop("t1", {
      getTask: async () => baseTask(),
      persistTask: async (t) => persists.push(structuredClone(t)),
      complete,
      executeTool: async () => ({ output: "ok", is_error: false }),
      getSkill: async () => { throw new Error("no skill"); },
      availableSkills: [],
      tools: MOCK_TOOLS,
    }, { stopSignal: () => cancelled });
    const final = persists[persists.length - 1];
    assert.strictEqual(final.status, "cancelled");
    assert.strictEqual(final.steps[0].status, "done", "已完步骤保留");
    assert.strictEqual(final.steps[1].status, "pending", "未完成步骤回 pending");
    ok("取消语义（轮次边界 + 状态正确）");
  }

  console.log("== T5: 重试（fromStep）→ 跳过规划、从失败步继续 ==");
  {
    const complete = makeComplete([
      // 重试路径不应出现规划调用（脚本第一个元素是步骤2的应答）
      { content: "步骤2重试完成", tool_calls: undefined },
      { content: "重试总结", tool_calls: undefined },
    ]);
    const persists = [];
    const task = baseTask();
    task.status = "running";
    task.steps = [
      { id: "s1", label: "步骤1", plan: "p1", status: "done", toolCalls: [], outputs: ["read_file: ok"] },
      { id: "s2", label: "步骤2", plan: "p2", status: "pending", toolCalls: [], outputs: [] },
    ];
    const stepMessages = new Map([
      ["s1", [
        { id: "m1", role: "user", content: "目标：测试目标\n\n当前步骤：步骤1\np1" },
        { id: "m2", role: "assistant", content: "步骤1完成" },
      ]],
    ]);
    await runTaskLoop("t1", {
      getTask: async () => structuredClone(task),
      persistTask: async (t) => persists.push(structuredClone(t)),
      generateTitle: async () => "不应调用",
      complete,
      executeTool: async () => ({ output: "ok", is_error: false }),
      getSkill: async () => { throw new Error("no skill"); },
      availableSkills: [],
      tools: MOCK_TOOLS,
    }, { fromStep: 1, stepMessages });

    // 规划阶段被跳过：第一个 complete 输入应直接是步骤2上下文
    assert.match(complete.seen[0].userContent, /当前步骤：步骤2/);
    assert.ok(!complete.seen[0].userContent.includes("请先规划"), "不应出现规划 prompt");
    // 重试历史包含前序步骤的完整 messages
    assert.match(complete.seen[0].userContent, /目标：测试目标/);

    const final = persists[persists.length - 1];
    assert.strictEqual(final.status, "done");
    assert.strictEqual(final.steps[0].status, "done");
    assert.strictEqual(final.steps[1].status, "done");
    ok("重试跳过阶段 1，上下文重建，完成后任务 done");
  }

  console.log("== T6: 单步超时 → 该步 failed（超时原因）+ 任务 failed ==");
  {
    const complete = makeComplete([
      { content: PLAN_JSON, tool_calls: undefined },
      async () => { await new Promise((r) => setTimeout(r, 80)); return { content: "姗姗来迟", tool_calls: undefined }; },
    ]);
    const persists = [];
    await runTaskLoop("t1", {
      getTask: async () => baseTask(),
      persistTask: async (t) => persists.push(structuredClone(t)),
      complete,
      executeTool: async () => ({ output: "ok", is_error: false }),
      getSkill: async () => { throw new Error("no skill"); },
      availableSkills: [],
      tools: MOCK_TOOLS,
      stepTimeoutMs: 20,
    });
    const final = persists[persists.length - 1];
    assert.strictEqual(final.status, "failed");
    assert.strictEqual(final.steps[0].status, "failed");
    assert.match(final.steps[0].error, /超时/);
    ok("单步超时按失败处理");
  }

  console.log("== T7: 轮数上限 → AgentLoopError → 步骤 failed ==");
  {
    const complete = makeComplete([
      { content: PLAN_JSON, tool_calls: undefined },
      { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    ]);
    const persists = [];
    await runTaskLoop("t1", {
      getTask: async () => baseTask(),
      persistTask: async (t) => persists.push(structuredClone(t)),
      complete,
      executeTool: async () => ({ output: "ok", is_error: false }),
      getSkill: async () => { throw new Error("no skill"); },
      availableSkills: [],
      tools: MOCK_TOOLS,
      maxRounds: 2,
    });
    const final = persists[persists.length - 1];
    assert.strictEqual(final.status, "failed");
    assert.strictEqual(final.steps[0].status, "failed");
    assert.match(final.steps[0].error, /轮数上限/);
    ok("轮数上限防失控");
  }

  console.log("== T8: 任务级异常兜底（getTask 失败不抛给调用方之外的路径） ==");
  {
    // getTask 抛错 → 循环应直接返回（不产生错误状态覆盖）
    let threw = false;
    try {
      await runTaskLoop("missing", {
        getTask: async () => { throw new Error("任务不存在"); },
        persistTask: async () => {},
        complete: async () => ({ content: "x", tool_calls: undefined }),
        executeTool: async () => ({ output: "", is_error: false }),
        getSkill: async () => { throw new Error("no skill"); },
        availableSkills: [],
        tools: MOCK_TOOLS,
      });
    } catch {
      threw = true;
    }
    assert.strictEqual(threw, false, "getTask 失败应被循环吞掉并返回");
    ok("getTask 失败安全返回");
  }

  console.log(`\n全部 ${passed} 项 taskLoop 冒烟测试通过 ✅`);
}

main().catch((e) => {
  console.error("❌ taskLoop 冒烟测试失败:", e);
  process.exit(1);
});
