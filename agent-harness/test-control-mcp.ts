/** 本地控制 MCP 协议冒烟：验证动态工具列表与控制工具成功响应。 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  mark_job_done: false, // required: still forced on
});
// All platform tools are selectable for every Agent; only mark_job_done is required.
// Explicit false disables optional tools; mark_job_done stays even if set false.
const expectedRestricted = [
  "list_available_roles",
  "list_shared_assets",
  "publish_shared_asset",
  "emit_fact",
  "emit_finding",
  "submit_hub_decision",
  "mark_job_done",
].join(",");
if (restrictedTools.join(",") !== expectedRestricted) {
  throw new Error(`unexpected restricted platform tools: ${restrictedTools.join(",")}`);
}
const restrictedGuide = platformToolGuide(restrictedTools);
for (const disabled of ["emit_progress", "request_human"]) {
  if (restrictedGuide.includes(`### \`${disabled}\``)) throw new Error(`disabled tool leaked into guide: ${disabled}`);
}
for (const expected of [
  "list_shared_assets",
  "没有单独的下载工具",
  "mount_path",
  "publish_shared_asset",
  "BlobStore",
]) {
  if (!restrictedGuide.includes(expected)) throw new Error(`shared-asset platform guide missing: ${expected}`);
}
// Only mark_job_done is forced; Hub-only tools may be turned off explicitly.
const hubTools = resolvePlatformTools("hub_reason", "hub", { list_available_roles: false });
if (hubTools.includes("list_available_roles")) {
  throw new Error("optional Hub tool list_available_roles should honor explicit false");
}
for (const required of ["submit_hub_decision", "mark_job_done"]) {
  if (!hubTools.some((name) => name === required)) throw new Error(`default-on tool missing: ${required}`);
}
for (const systemRole of ["verify", "report"]) {
  const tools = resolvePlatformTools(systemRole, "system", {});
  // Full tool list is available; request_human is optional (default on) for every Agent.
  if (!tools.includes("request_human")) {
    throw new Error(`${systemRole} should allow selecting request_human by default`);
  }
  if (!tools.includes("mark_job_done")) throw new Error(`${systemRole} missing required mark_job_done`);
  const withoutHuman = resolvePlatformTools(systemRole, "system", { request_human: false });
  if (withoutHuman.includes("request_human")) {
    throw new Error(`${systemRole} must honor explicit request_human=false`);
  }
}

const availableRoles = new Set(["review"]);
const validDescription = "复核已有证据并确认剩余验证边界";
const validPrompt = "复核当前画布引用的全部证据，独立确认结论、缺口与下一步验证动作，并只提交新增事实。";
if (!parseHubDecision(JSON.stringify({ intents: [{ from: [], role: "review", description: validDescription, prompt: validPrompt }] }), availableRoles)) {
  throw new Error("valid dynamic Hub role was rejected");
}
for (const invalid of [
  { intents: [{ from: [], description: validDescription, prompt: validPrompt }] },
  { intents: [{ from: [], role: "explore", description: validDescription, prompt: validPrompt }] },
  { intents: [{ from: [], role: "report", description: validDescription, prompt: validPrompt }] },
]) {
  if (parseHubDecision(JSON.stringify(invalid), availableRoles)) {
    throw new Error(`invalid Hub role accepted: ${JSON.stringify(invalid)}`);
  }
}

const tempDir = mkdtempSync(join(tmpdir(), "deepsonar-control-mcp-"));
const scriptPath = join(tempDir, "control-mcp.mjs");
writeFileSync(scriptPath, CONTROL_MCP_SERVER, "utf8");
const child = spawn(process.execPath, [scriptPath], {
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
  arguments: { title: "实时事实", description: "增量证据已由当前请求与源码交叉确认" },
});
send(8, "tools/call", {
  name: "emit_fact",
  arguments: { title: "实时事实", description: "增量证据已由当前请求与源码交叉确认", unexpected: true },
});
send(9, "tools/call", {
  name: "emit_finding",
  arguments: { title: "认证路径存在重放风险", severity: "high", summary: "成功重置后令牌仍可再次使用；隔离请求已复现，且源码路径确认未执行一次性失效处理。" },
});
send(10, "tools/call", {
  name: "emit_finding",
  arguments: { title: "问题", severity: "urgent" },
});
send(11, "tools/call", {
  name: "submit_hub_decision",
  arguments: { intents: [{ from: [], role: "review", description: validDescription, prompt: validPrompt }] },
});
send(12, "tools/call", {
  name: "submit_hub_decision",
  arguments: { intents: [{ from: ["ghp_super_secret_should_not_echo"], role: "review", description: validDescription, prompt: validPrompt }] },
});
send(13, "tools/call", {
  name: "mark_job_done",
  arguments: { summary: "已完成当前范围内的源码核对与证据整理。" },
});
send(14, "tools/call", {
  name: "mark_job_done",
  arguments: { summary: "已完成当前范围内的源码核对与证据整理。", unexpected: true },
});
send(15, "tools/call", {
  name: "request_human",
  arguments: { reason: "需要人工确认隔离测试账号的授权范围。" },
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
send(26, "tools/call", {
  name: "emit_fact",
  arguments: { payload_file: "../fact.json" },
});
send(27, "tools/call", {
  name: "emit_finding",
  arguments: { title: "认证路径存在重放风险", summary: "成功重置后令牌仍可再次使用；隔离请求已复现，且源码路径确认未执行一次性失效处理。", payload_file: "finding.json" },
});
send(28, "tools/call", {
  name: "emit_finding",
  arguments: { payload_file: "C:\\tmp\\finding.json" },
});
send(29, "tools/call", {
  name: "emit_fact",
  arguments: { payload_file: "/workspace/fact.json" },
});

await new Promise<void>((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error("MCP response timeout")), 5_000);
  const timer = setInterval(() => {
    if (replies.trim().split("\n").length >= 29) {
      clearTimeout(deadline);
      clearInterval(timer);
      resolve();
    }
  }, 25);
});
child.kill();
if (child.exitCode === null) await once(child, "exit").catch(() => {});
rmSync(tempDir, { recursive: true, force: true });

const rpcReplies = replies.trim().split("\n").map((line) => JSON.parse(line));
const toolsReply = rpcReplies.find((reply) => reply.id === 2);
const descriptionCautions: Record<string, string> = {
  list_available_roles: "不得猜测、缩写或使用已禁用及 system 角色",
  emit_progress: "不得代替最终结论或 Finding",
  emit_fact: "遇到 isError 或截断时，写入完整 JSON 后用 payload_file 重试",
  emit_finding: "suggest_verify 只是建议，不能当作派发决定",
  submit_hub_decision: "仅在 isError 或校验失败后重试，成功后不得再次调用",
  mark_job_done: "仅主协调 Agent 在所有子代理结束后调用，子代理不得调用",
  request_human: "不得再调用 mark_job_done",
  list_shared_assets: "不得修改共享挂载，也不得通过 HTTP、curl 或 S3 另行获取",
  publish_shared_asset: "不得从 .deepsonar/shared 发布或覆盖不可变资产",
};
for (const [name, caution] of Object.entries(descriptionCautions)) {
  const advertised = toolsReply?.result?.tools?.find((tool: { name?: string }) => tool.name === name);
  if (!advertised || typeof advertised.description !== "string" || !advertised.description.includes(caution)) {
    throw new Error(`MCP tools/list description missing caution for ${name}: ${caution}`);
  }
}
for (const [name, schema] of Object.entries(ControlToolInputSchemasJson)) {
  // Claude Code / Anthropic skip tools whose inputSchema lacks type:object
  // or uses top-level anyOf/oneOf (MCP log: "top-level anyOf, which the Anthropic API does not accept").
  const s = schema as { type?: unknown; anyOf?: unknown; oneOf?: unknown };
  if (s.type !== "object") {
    throw new Error(`MCP inputSchema for ${name} must have type: object (got ${JSON.stringify(s.type)})`);
  }
  if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    throw new Error(`MCP inputSchema for ${name} must not use top-level anyOf/oneOf`);
  }
  const advertised = toolsReply?.result?.tools?.find((tool) => tool.name === name)?.inputSchema;
  const expected = structuredClone(schema) as Record<string, any>;
  if (name === "submit_hub_decision") {
    expected.properties.intents.items.properties.role.enum = ["review"];
  }
  if (JSON.stringify(advertised) !== JSON.stringify(expected)) {
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
assertError(26, "invalid_payload");
assertError(27, "invalid_payload");
assertError(28, "invalid_payload");
assertError(29, "invalid_payload");
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
