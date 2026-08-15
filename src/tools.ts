import type { ToolDef } from "./types";

export const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取文件内容（相对路径基于当前会话工作目录解析）",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径（绝对路径或相对于工作目录的路径）" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "写入文件内容（相对路径基于当前会话工作目录解析；不自动创建父目录）",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径（绝对路径或相对于工作目录的路径）" },
          content: { type: "string", description: "文件内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "列出目录内容（相对路径基于当前会话工作目录解析）",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目录路径（绝对路径或相对于工作目录的路径）" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "执行 Shell 命令（在当前会话工作目录下运行）",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 Shell 命令" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_get",
      description: "发送 HTTP GET 请求",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "请求 URL" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "联网搜索互联网信息",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "获取指定 URL 的网页内容",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要获取的网页 URL" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "向用户提问以获得补充信息",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "向用户提出的问题" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_search",
      description: "按文件名模式搜索文件（相对路径基于当前会话工作目录解析）",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "搜索目录路径（绝对路径或相对于工作目录的路径）" },
          pattern: { type: "string", description: "文件名正则表达式" },
        },
        required: ["path", "pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "搜索文件内容（相对路径基于当前会话工作目录解析）",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "搜索目录路径（绝对路径或相对于工作目录的路径）" },
          pattern: { type: "string", description: "搜索内容的正则表达式" },
        },
        required: ["path", "pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description: "截取屏幕截图",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_pdf_or_image",
      description: "读取 PDF 或图片文件内容（相对路径基于当前会话工作目录解析）",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径（绝对路径或相对于工作目录的路径）" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description:
        "加载一个技能(skill)，获取该领域的详细工作指令。参数 name 为技能名（如 code/research/debug/explain）。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名" },
        },
        required: ["name"],
      },
    },
  },
];

/** 任务执行阶段工具集：全量 TOOLS 去除 ask_user（任务在后台时用户未必在看抽屉，oneshot 会卡死循环） */
export const FULL_TASK_TOOLS: ToolDef[] = TOOLS.filter(
  (t) => t.function.name !== "ask_user",
);

/** 任务规划/收尾阶段只读工具子集（探查结果只影响规划结论，不落任务步骤）；保留 load_skill */
const READ_ONLY_NAMES = new Set([
  "read_file",
  "list_dir",
  "grep",
  "file_search",
  "web_search",
  "web_fetch",
  "read_pdf_or_image",
  "load_skill",
]);

export const READ_ONLY_TOOLS: ToolDef[] = TOOLS.filter((t) =>
  READ_ONLY_NAMES.has(t.function.name),
);

