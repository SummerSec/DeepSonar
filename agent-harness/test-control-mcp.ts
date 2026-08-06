/** 本地控制 MCP 协议冒烟：验证动态工具列表与控制工具成功响应。 */
import { spawn } from "node:child_process";
import { CONTROL_MCP_SERVER } from "../apps/scheduler/src/control-mcp.js";
import { parseHubDecision, parseHubDecisionPayload } from "../apps/scheduler/src/graph.js";
import { ControlInputError } from "../apps/scheduler/src/control-input.js";
import { platformToolGuide } from "../apps/scheduler/src/platform-tools.js";
import { ControlToolInputSchemasJson, resolvePlatformTools } from "../packages/shared-types/src/index.js";

const workerGuide = platformToolGuide(["emit_progress", "emit_fact", "mark_job_done", "request_human"]);
for (const expected of [
  "emit_progress",
  "已定位认证入口",
  "emit_fact",
  "单 Job 最多 100 条",
  "mark_job_done",
  "request_human",
  "schema_validated / pending_scheduler_validation",
  "不要同时调用",
]) {
  if (!workerGuide.includes(expected)) throw new Error(`platform tool guide missing: ${expected}`);
}

const restrictedTools = resolvePlatformTools("explore", "role", {
  emit_progress: false,
  request_human: false,
  mark_job_done: false,
});
if (restrictedTools.join(",") !== "list_shared_assets,emit_fact,mark_job_done,publish_shared_asset") {
  throw new Error(`unexpected restricted platform tools: ${restrictedTools.join(",")}`);
}
const restrictedGuide = platformToolGuide(restrictedTools);
for (const disabled of ["emit_progress", "request_human"]) {
  if (restrictedGuide.includes(disabled)) throw new Error(`disabled tool leaked into guide: ${disabled}`);
}
const hubTools = resolvePlatformTools("hub_reason", "hub", { list_available_roles: false });
for (const required of ["list_available_roles", "submit_hub_decision", "mark_job_done"]) {
  if (!hubTools.some((name) => name === required)) throw new Error(`required Hub tool was disabled: ${required}`);
}
for (const systemRole of ["verify", "report"]) {
  const tools = resolvePlatformTools(systemRole, "system", {});
  if (tools.includes("request_human")) {
    throw new Error(`${systemRole} must converge through mark_job_done instead of request_human`);
  }
  if (!tools.includes("mark_job_done")) throw new Error(`${systemRole} missing required mark_job_done`);
}

const availableRoles = new Set(["review"]);
if (!parseHubDecision(JSON.stringify({ intents: [{ from: [], role: "review", description: "复核", prompt: "执行复核" }] }), availableRoles)) {
  throw new Error("valid dynamic Hub role was rejected");
}
for (const invalid of [
  { intents: [{ from: [], description: "缺角色", prompt: "执行" }] },
  { intents: [{ from: [], role: "explore", description: "固定默认", prompt: "执行" }] },
  { intents: [{ from: [], role: "report", description: "系统角色", prompt: "执行" }] },
]) {
  if (parseHubDecision(JSON.stringify(invalid), availableRoles)) {
    throw new Error(`invalid Hub role accepted: ${JSON.stringify(invalid)}`);
  }
}

const child = spawn(process.execPath, ["--input-type=module", "-e", CONTROL_MCP_SERVER], {
  env: {
    ...process.env,
    DEEPSONAR_CONTROL_TOOL_NAMES: JSON.stringify([
      "list_available_roles",
      "list_shared_assets",
      "publish_shared_asset",
      "emit_progress",
      "emit_fact",
      "emit_finding",
      "submit_hub_decision",
      "mark_job_done",
      "request_human",
    ]),
    DEEPSONAR_AVAILABLE_ROLES_JSON: JSON.stringify([
      { name: "review", title: "复核", description: "独立复核证据" },
    ]),
  },
  stdio: ["pipe", "pipe", "inherit"],
});

let replies = "";
child.stdout.on("data", (chunk) => {
  replies += chunk.toString();
});
const send = (id: number, method: string, params: Record<string, unknown> = {}) => {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
};

send(1, "initialize", { protocolVersion: "2024-11-05" });
send(2, "tools/list");
send(3, "tools/call", {
  name: "list_available_roles",
});
send(4, "tools/call", {
  name: "list_available_roles",
  arguments: { extra: true },
});
send(5, "tools/call", {
  name: "emit_progress",
  arguments: { message: "进行中", percent: 25 },
});
send(6, "tools/call", {
  name: "emit_progress",
  arguments: { message: "   ", percent: 25 },
});
send(7, "tools/call", {
  name: "emit_fact",
  arguments: { title: "实时事实", description: "增量证据" },
});
send(8, "tools/call", {
  name: "emit_fact",
  arguments: { title: "实时事实", description: "增量证据", unexpected: true },
});
send(9, "tools/call", {
  name: "emit_finding",
  arguments: { title: "问题", severity: "high", summary: "证据" },
});
send(10, "tools/call", {
  name: "emit_finding",
  arguments: { title: "问题", severity: "urgent" },
});
send(11, "tools/call", {
  name: "submit_hub_decision",
  arguments: { intents: [{ from: [], role: "review", description: "复核", prompt: "执行复核" }] },
});
send(12, "tools/call", {
  name: "submit_hub_decision",
  arguments: { intents: [{ from: ["ghp_super_secret_should_not_echo"], role: "review", description: "复核", prompt: "执行复核" }] },
});
send(13, "tools/call", {
  name: "mark_job_done",
  arguments: { summary: "完成" },
});
send(14, "tools/call", {
  name: "mark_job_done",
  arguments: { summary: "完成", unexpected: true },
});
send(15, "tools/call", {
  name: "request_human",
  arguments: { reason: "需要人工确认" },
});
send(16, "tools/call", {
  name: "request_human",
  arguments: { reason: "  " },
});
send(17, "tools/call", {
  name: "ghp_unknown_secret_should_not_echo",
  arguments: {},
});
for (const [id, name] of [
  [18, "__proto__"],
  [19, "constructor"],
  [20, "toString"],
] as const) {
  send(id, "tools/call", { name, arguments: {} });
}
send(21, "tools/call", {
  name: "submit_hub_decision",
  arguments: {
    complete: { from: [], description: "完成" },
    intents: [{ from: [], role: "review", description: "复核", prompt: "执行复核" }],
  },
});
send(22, "tools/call", {
  name: "list_shared_assets",
  arguments: {},
});
send(23, "tools/call", {
  name: "list_shared_assets",
  arguments: { scope: "unknown" },
});
send(24, "tools/call", {
  name: "publish_shared_asset",
  arguments: { scope: "project", source_path: "/workspace/output/result.json", key: "output/result.json", content_type: "application/json" },
});
send(25, "tools/call", {
  name: "publish_shared_asset",
  arguments: { scope: "project", source_path: "/workspace/.deepsonar/shared/catalog.json", key: "catalog.json", content_type: "application/json" },
});

await new Promise<void>((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error("MCP response timeout")), 5_000);
  const timer = setInterval(() => {
    if (replies.trim().split("\n").length >= 25) {
      clearTimeout(deadline);
      clearInterval(timer);
      resolve();
    }
  }, 25);
});
child.kill();

const rpcReplies = replies.trim().split("\n").map((line) => JSON.parse(line));
const toolsReply = rpcReplies.find((reply) => reply.id === 2);
for (const [name, schema] of Object.entries(ControlToolInputSchemasJson)) {
  const advertised = toolsReply?.result?.tools?.find((tool) => tool.name === name)?.inputSchema;
  if (JSON.stringify(advertised) !== JSON.stringify(schema)) {
    throw new Error(`MCP schema drift for ${name}`);
  }
}
const roleReply = rpcReplies.find((reply) => reply.id === 3);
const rolePayload = JSON.parse(roleReply?.result?.content?.[0]?.text ?? "null");
if (rolePayload?.roles?.[0]?.name !== "review") {
  throw new Error(`unexpected available roles response: ${JSON.stringify(rolePayload)}`);
}
const statusOf = (id: number) => {
  const reply = rpcReplies.find((item) => item.id === id);
  const text = reply?.result?.content?.[0]?.text;
  try { return JSON.parse(text ?? "null"); } catch { return null; }
};
for (const id of [5, 7, 9, 11, 13, 15, 24]) {
  const status = statusOf(id);
  if (status?.status !== "schema_validated" || status.phase !== "pending_scheduler_validation") {
    throw new Error(`unexpected valid control tool response ${id}: ${JSON.stringify(rpcReplies.find((item) => item.id === id))}`);
  }
}
const assertError = (id: number, code: string) => {
  const reply = rpcReplies.find((item) => item.id === id);
  if (reply?.result?.isError !== true || reply.result.error_code !== code) {
    throw new Error(`expected ${code} for MCP request ${id}: ${JSON.stringify(reply)}`);
  }
};
assertError(4, "unknown_field");
assertError(6, "invalid_progress");
assertError(8, "unknown_field");
assertError(10, "invalid_payload");
assertError(12, "invalid_node_ref");
const invalidRefText = rpcReplies.find((reply) => reply.id === 12)?.result?.content?.[0]?.text ?? "";
if (invalidRefText.includes("ghp_super_secret_should_not_echo")) {
  throw new Error("MCP invalid_node_ref echoed an untrusted reference");
}
assertError(14, "unknown_field");
assertError(16, "invalid_human");
assertError(17, "unknown_tool");
const unknownToolText = rpcReplies.find((reply) => reply.id === 17)?.result?.content?.[0]?.text ?? "";
if (unknownToolText.includes("ghp_unknown_secret_should_not_echo")) {
  throw new Error("MCP unknown_tool echoed an untrusted tool name");
}
for (const [id, name] of [[18, "__proto__"], [19, "constructor"], [20, "toString"]] as const) {
  assertError(id, "unknown_tool");
  const text = rpcReplies.find((reply) => reply.id === id)?.result?.content?.[0]?.text ?? "";
  if (text.includes(name)) throw new Error(`MCP unknown_tool echoed prototype key ${name}`);
}
assertError(21, "invalid_payload");
const catalogStatus = statusOf(22);
if (catalogStatus?.version !== 1 || catalogStatus?.readonly !== true || !Array.isArray(catalogStatus.assets)) {
  throw new Error(`unexpected shared asset catalog response: ${JSON.stringify(catalogStatus)}`);
}
assertError(23, "invalid_payload");
assertError(25, "invalid_payload");
let hostHubErrorCode = "";
try {
  parseHubDecisionPayload({
    complete: { from: [], description: "完成" },
    intents: [{ from: [], role: "review", description: "复核", prompt: "执行复核" }],
  }, new Set(["root"]));
} catch (error) {
  hostHubErrorCode = error instanceof ControlInputError ? error.code : "";
}
if (hostHubErrorCode !== "invalid_payload") {
  throw new Error(`host Hub both-branch contract drifted: ${hostHubErrorCode}`);
}
if (rpcReplies.some((reply) => /accepted\s+event/i.test(String(reply?.result?.content?.[0]?.text ?? "")))) {
  throw new Error("legacy MCP success response leaked from control MCP");
}
console.log(JSON.stringify({ replies: rpcReplies.length, semanticEvents: 0, guide: "complete" }));
