/**
 * 每 Job 注入的本地 MCP。它不连接 Scheduler，也不使用网络：只读查询返回调度器在启动
 * 本 Job 时动态下发的数据；语义提案由宿主从 Claude stream-json 的 tool_use 块捕获。
 */
export const CONTROL_MCP_NAME = "deepsonar-control";
export const CONTROL_SEMANTIC_EVENT_TYPES = {
  emit_progress: "progress",
  emit_fact: "fact",
  emit_finding: "finding",
  submit_hub_decision: "hub_decision",
  mark_job_done: "done",
  request_human: "human",
} as const;

export const CONTROL_MCP_SERVER = String.raw`import readline from "node:readline";

const allowed = new Set(JSON.parse(process.env.DEEPSONAR_CONTROL_TOOL_NAMES || "[]"));
const availableRoles = JSON.parse(process.env.DEEPSONAR_AVAILABLE_ROLES_JSON || "[]");

const definitions = {
  list_available_roles: {
    description: "返回当前 Hub Job 可派发的数据库角色。只使用返回的 name，不得猜测或使用固定角色清单。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  },
  emit_progress: {
    description: "增量上报当前动作或阶段进展。可在执行中多次调用。",
    inputSchema: { type: "object", properties: { message: { type: "string", minLength: 1, maxLength: 2000 }, percent: { type: "number", minimum: 0, maximum: 100 } }, required: ["message"], additionalProperties: false }
  },
  emit_fact: {
    description: "把一个新的、可验证的增量事实实时写入任务画布。Hub 回弹补证 Job 可附带 verification 结构化证据。可多次调用。",
    inputSchema: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string", minLength: 1, maxLength: 10000 }, verification: { type: "object", properties: { finding_id: { type: "string" }, evidence_kind: { type: "string", enum: ["review", "test"] }, outcome: { type: "string", enum: ["supports", "refutes", "inconclusive"] }, subject_revision: { type: "string", minLength: 1, maxLength: 500 }, environment: { type: "string", maxLength: 1000 }, steps: { type: "array", items: { type: "string" }, maxItems: 50 }, expected: { type: "string", maxLength: 5000 }, actual: { type: "string", maxLength: 5000 }, artifact_refs: { type: "array", items: { type: "object", properties: { uri: { type: "string" }, sha256: { type: "string" } }, required: ["uri"] }, maxItems: 20 }, limitations: { type: "array", items: { type: "string" }, maxItems: 20 } }, required: ["finding_id", "evidence_kind", "outcome", "subject_revision"], additionalProperties: false } }, required: ["title", "description"], additionalProperties: false }
  },
  emit_finding: {
    description: "实时提交一个有证据的安全 Finding；调度器负责去重和决定是否验证。可多次调用。",
    inputSchema: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 500 }, severity: { type: "string", enum: ["low", "medium", "high", "critical"] }, location: { type: "string", maxLength: 1000 }, summary: { type: "string", maxLength: 10000 }, rule_id: { type: "string", maxLength: 200 }, suggest_verify: { type: "boolean" } }, required: ["title", "severity"], additionalProperties: false }
  },
  submit_hub_decision: {
    description: "提交本轮 Hub 的 complete 或 intents 决策，二者必须且只能提供一个。",
    inputSchema: { type: "object", properties: { complete: { type: "object", properties: { from: { type: "array", items: { type: "string" } }, description: { type: "string", minLength: 1, maxLength: 10000 } }, required: ["from", "description"], additionalProperties: false }, intents: { type: "array", items: { type: "object", properties: { from: { type: "array", items: { type: "string" } }, role: { type: "string", minLength: 1, maxLength: 64 }, description: { type: "string", minLength: 1, maxLength: 2000 }, prompt: { type: "string", minLength: 1, maxLength: 20000 } }, required: ["from", "role", "description", "prompt"], additionalProperties: false } } }, additionalProperties: false }
  },
  mark_job_done: {
    description: "提交本 Job 的最终摘要；verify 系统角色还必须提交 verdict（confirmed|rework|needs_human；兼容 false_positive→rework）。每个 Job 最后调用一次。",
    inputSchema: { type: "object", properties: { summary: { type: "string", minLength: 1, maxLength: 10000 }, verdict: { type: "string", enum: ["confirmed", "rework", "needs_human", "false_positive"] }, missing_evidence: { type: "array", items: { type: "string" } } }, required: ["summary"], additionalProperties: false }
  },
  request_human: {
    description: "只有缺少必要授权、凭据或高风险操作必须人工确认时调用。",
    inputSchema: { type: "object", properties: { reason: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["reason"], additionalProperties: false }
  }
};

function reply(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.id == null) return;
  try {
    if (request.method === "initialize") {
      reply({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion || "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "deepsonar-control", version: "1" } } });
    } else if (request.method === "ping") {
      reply({ jsonrpc: "2.0", id: request.id, result: {} });
    } else if (request.method === "tools/list") {
      const tools = [...allowed].filter((name) => definitions[name]).map((name) => ({ name, ...definitions[name] }));
      reply({ jsonrpc: "2.0", id: request.id, result: { tools } });
    } else if (request.method === "tools/call") {
      const name = request.params?.name;
      if (!allowed.has(name) || !definitions[name]) throw new Error("tool not allowed for this Job: " + name);
      if (name === "list_available_roles") {
        reply({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify({ roles: availableRoles }) }] } });
      } else {
        reply({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "accepted event" }] } });
      }
    } else if (request.method === "resources/list") {
      reply({ jsonrpc: "2.0", id: request.id, result: { resources: [] } });
    } else if (request.method === "prompts/list") {
      reply({ jsonrpc: "2.0", id: request.id, result: { prompts: [] } });
    } else {
      reply({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
    }
  } catch (error) {
    reply({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: String(error?.message || error) }], isError: true } });
  }
});
`;
