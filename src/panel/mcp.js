const { OfficialApiError } = require("../official/api");
const { PanelError } = require("./errors");
const { VERSION } = require("../shared/version");

/**
 * MCP（Model Context Protocol）服务端：处理 JSON-RPC 消息，把工具调用交给 src/panel/agent.js。
 * 传输见 http/routes/mcp.js（Streamable HTTP，无状态，只返回 JSON）。工具按令牌的权限列出：
 * 没有某项权限的令牌看不到相应的工具，调用时同样被拒绝。
 */

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26"];
const LATEST_VERSION = SUPPORTED_VERSIONS[0];

const INSTRUCTIONS =
  "WeReadAssistant（微信读书助手）的面板：查看各账号的自动阅读与打卡状态、开始或停止阅读，以及读取本人在微信读书中的划线、想法与每周阅读报告。" +
  "account_id 为面板中的账号 ID；令牌只能访问一个账号时可以不填。时间按面板时区。";

const ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
};

const accountParam = {
  account_id: { type: "string", description: "账号 ID（见 list_accounts）；令牌只能访问一个账号时可以不填" },
};

// name → { scope, description, properties, required, readOnly, run(agent, token, args) }
const TOOLS = {
  list_accounts: {
    scope: "read",
    title: "列出账号",
    description: "列出能访问的账号：今天读了多少分钟、是否已打卡（满 5 分钟）、连续打卡天数、正在进行与最近一次运行、下次定时运行的时间。",
    properties: {},
    readOnly: true,
    run: (agent, token) => agent.listAccounts(token),
  },
  get_account_status: {
    scope: "read",
    title: "账号状态",
    description: "一个账号的详细状态：今天的阅读与打卡、连续打卡天数、正在进行的运行、每日目标、挑战（月卡 / 年卡）进度、待执行的重试与补跑、今天的分段阅读计划。",
    properties: { ...accountParam },
    readOnly: true,
    run: (agent, token, args, accountId) => agent.accountStatus(token, accountId),
  },
  list_recent_runs: {
    scope: "read",
    title: "最近的运行",
    description: "一个账号最近的运行记录（最新的在前）：触发方式、结果、阅读分钟数、书名与错误。",
    properties: { ...accountParam, limit: { type: "integer", minimum: 1, maximum: 50, description: "条数，默认 10" } },
    readOnly: true,
    run: (agent, token, args, accountId) => agent.recentRuns(token, accountId, { limit: args.limit === undefined ? 10 : args.limit }),
  },
  start_reading: {
    scope: "run",
    title: "开始阅读",
    description: "立即为账号开始一次自动阅读（按账号配置的时长）；mode 为 login 时只检查登录状态。需要扫码时会经账号的通知渠道推送登录链接。账号已在运行或排队时失败。",
    properties: { ...accountParam, mode: { type: "string", enum: ["read", "login"], description: "read（默认）阅读；login 仅登录" } },
    readOnly: false,
    run: (agent, token, args, accountId) => agent.startRun(token, accountId, { mode: args.mode === undefined ? "read" : args.mode }),
  },
  stop_run: {
    scope: "run",
    title: "停止运行",
    description: "停止账号当前的运行：排队中的直接取消，进行中的关闭浏览器后结束。",
    properties: { ...accountParam },
    readOnly: false,
    run: (agent, token, args, accountId) => agent.stopRun(token, accountId),
  },
  list_note_books: {
    scope: "notes",
    title: "有笔记的书",
    description: "已同步的笔记概况：有划线或想法的书（bookId、书名、作者、划线数、想法数、阅读进度）与最近一次同步的时间。笔记每天自动同步一次。",
    properties: { ...accountParam },
    readOnly: true,
    run: (agent, token, args, accountId) => agent.notesStatus(token, accountId),
  },
  get_book_notes: {
    scope: "notes",
    title: "一本书的笔记",
    description: "一本书的全部划线与想法，按章节整理为 Markdown（引用为划线原文，其后为想法）。",
    properties: { ...accountParam, book_id: { type: "string", description: "书的 bookId（见 list_note_books 或 search_notes）" } },
    required: ["book_id"],
    readOnly: true,
    run: (agent, token, args, accountId) => agent.notesMarkdown(token, accountId, args.book_id),
  },
  search_notes: {
    scope: "notes",
    title: "搜索笔记",
    description: "在已同步的全部划线与想法中搜索（不区分大小写，最多 100 条），返回书、章节、划线原文与想法。",
    properties: { ...accountParam, query: { type: "string", description: "要找的文字，1–100 个字" } },
    required: ["query"],
    readOnly: true,
    run: (agent, token, args, accountId) => agent.searchNotes(token, accountId, args.query),
  },
  sync_notes: {
    scope: "notes",
    title: "同步笔记",
    description: "立即从微信读书同步一次划线与想法（在后台进行，通常几秒到几十秒；之后再用 list_note_books 查看结果）。需要账号配置了微信读书 API Key。",
    properties: { ...accountParam },
    readOnly: false,
    run: (agent, token, args, accountId) => agent.syncNotes(token, accountId),
  },
  get_weekly_report: {
    scope: "notes",
    title: "上周阅读报告",
    description: "上周在微信读书中的阅读统计（官方数据，包括在手机上的阅读）：时长、天数、日均、与前一周相比、读得最多的书与新增笔记。",
    properties: { ...accountParam },
    readOnly: true,
    run: (agent, token, args, accountId) => agent.weeklyReport(token, accountId),
  },
};

function toolDefinition(name) {
  const tool = TOOLS[name];
  return {
    name,
    title: tool.title,
    description: tool.description,
    inputSchema: { type: "object", properties: tool.properties, ...(tool.required ? { required: tool.required } : {}), additionalProperties: false },
    annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: false },
  };
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// 参数的基本检查：只允许声明过的字段，类型对得上，必填的都有
function checkArgs(name, args) {
  const tool = TOOLS[name];
  if (args === undefined || args === null) {
    args = {};
  }
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new RpcError(ERRORS.invalidParams, "arguments 必须是对象");
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = tool.properties[key];
    if (!spec) {
      throw new RpcError(ERRORS.invalidParams, `未知的参数：${key}`);
    }
    const ok = spec.type === "integer" ? Number.isInteger(value) : typeof value === spec.type;
    if (!ok || (spec.enum && !spec.enum.includes(value))) {
      throw new RpcError(ERRORS.invalidParams, `参数 ${key} 的值不对`);
    }
  }
  for (const key of tool.required || []) {
    if (args[key] === undefined) {
      throw new RpcError(ERRORS.invalidParams, `缺少参数：${key}`);
    }
  }
  return args;
}

function createMcp({ agent, store }) {
  const visibleTools = (token) => Object.keys(TOOLS).filter((name) => token.scopes.includes(TOOLS[name].scope));

  // 没填 account_id 时：令牌只能访问一个账号就用它
  function resolveAccount(token, args) {
    if (args.account_id !== undefined) {
      return args.account_id;
    }
    const ids = store.get().accounts.map((account) => account.id).filter((id) => token.accounts === null || token.accounts.includes(id));
    if (ids.length === 1) {
      return ids[0];
    }
    throw new PanelError(400, "bad_request", ids.length === 0 ? "令牌没有能访问的账号" : `请指定 account_id，可选：${ids.join("、")}`);
  }

  async function callTool(token, params) {
    const name = params && params.name;
    if (typeof name !== "string" || !Object.hasOwn(TOOLS, name) || !visibleTools(token).includes(name)) {
      throw new RpcError(ERRORS.invalidParams, `没有这个工具：${name}`);
    }
    const args = checkArgs(name, params.arguments);
    try {
      const accountId = Object.hasOwn(TOOLS[name].properties, "account_id") ? resolveAccount(token, args) : undefined;
      const result = await TOOLS[name].run(agent, token, args, accountId);
      if (typeof result === "string") {
        return { content: [{ type: "text", text: result }], isError: false };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false };
    } catch (e) {
      // 业务错误（没有权限、账号不存在、已在运行等）作为工具的执行错误返回，模型可以读到原因
      if (e instanceof PanelError || e instanceof OfficialApiError) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
      throw e;
    }
  }

  // 处理一条 JSON-RPC 消息。通知（没有 id）返回 null
  async function handle(message, token) {
    const isObject = message && typeof message === "object" && !Array.isArray(message);
    const id = isObject && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null;
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    const fail = (code, text) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
    if (!isObject || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      // 客户端发来的响应（对服务端请求的回复）没有 method：本服务端不发请求，忽略
      return isObject && message.jsonrpc === "2.0" && message.method === undefined && ("result" in message || "error" in message)
        ? null
        : fail(ERRORS.invalidRequest, "不是有效的 JSON-RPC 请求");
    }
    const notification = !("id" in message);
    try {
      let result;
      switch (message.method) {
        case "initialize": {
          const requested = message.params && message.params.protocolVersion;
          result = {
            protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "weread-assistant", title: "WeReadAssistant", version: VERSION },
            instructions: INSTRUCTIONS,
          };
          break;
        }
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = { tools: visibleTools(token).map(toolDefinition) };
          break;
        case "tools/call":
          result = await callTool(token, message.params);
          break;
        default:
          if (message.method.startsWith("notifications/")) {
            return null;
          }
          throw new RpcError(ERRORS.methodNotFound, `不支持的方法：${message.method}`);
      }
      return notification ? null : reply(result);
    } catch (e) {
      if (notification) {
        return null;
      }
      if (e instanceof RpcError) {
        return fail(e.code, e.message);
      }
      console.error("MCP 请求出错:", e);
      return fail(ERRORS.internal, "内部错误");
    }
  }

  return { handle, toolNames: visibleTools };
}

module.exports = {
  LATEST_VERSION,
  SUPPORTED_VERSIONS,
  TOOLS,
  createMcp,
};
