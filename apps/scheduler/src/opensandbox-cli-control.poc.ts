/**
 * Vendor-model proof that Claude Code inside OpenSandbox submits Job Platform API
 * operations itself. Requires OPEN_SANDBOX_POC=1 and ANTHROPIC_API_KEY.
 * Mock Anthropic is not a substitute; skip when the vendor key is absent.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  AGENT_CLI_RUNTIME_ADAPTERS,
  DEEPSONAR_GATEWAY_PROXY_HOST,
  freezeAgentCliRuntime,
  shouldRunOpenSandboxPoc,
} from "@deepsonar/runtime-sandbox";

if (!shouldRunOpenSandboxPoc()) {
  console.log("skip: OpenSandbox CLI control PoC (set OPEN_SANDBOX_POC=1)");
  process.exit(0);
}

const vendorKeys = {
  "claude-code": process.env.ANTHROPIC_API_KEY?.trim(),
  codex: process.env.OPENAI_API_KEY?.trim(),
  "open-code": process.env.OPENAI_API_KEY?.trim(),
  pi: process.env.OPENAI_API_KEY?.trim(),
  dsh: process.env.DEEPSEEK_API_KEY?.trim(),
} as const;
const requestedCli = process.env.OPEN_SANDBOX_POC_CLI?.trim() || "claude-code";
if (!(requestedCli in vendorKeys)) {
  console.error(`OPEN_SANDBOX_POC_CLI must be one of ${Object.keys(vendorKeys).join(", ")}`);
  process.exit(1);
}
const selectedCli = requestedCli as keyof typeof vendorKeys;
const vendorKey = vendorKeys[selectedCli];
if (!vendorKey) {
  console.log("skip: OpenSandbox CLI control PoC needs ANTHROPIC_API_KEY, OPENAI_API_KEY, or DEEPSEEK_API_KEY for vendor-model E2E");
  process.exit(0);
}

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const apiKey = process.env.OPEN_SANDBOX_API_KEY?.trim();
const runtimeImage = process.env.OPEN_SANDBOX_POC_RUNTIME_IMAGE?.trim();
if (!databaseUrl || !apiKey || !runtimeImage) {
  console.error("TEST_DATABASE_URL, OPEN_SANDBOX_API_KEY, and OPEN_SANDBOX_POC_RUNTIME_IMAGE are required");
  process.exit(1);
}

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
adminUrl.search = "";
const admin = postgres(adminUrl.toString(), { max: 1 });
const databaseName = `deepsonar_os_cli_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
const targetUrl = new URL(databaseUrl);
targetUrl.pathname = `/${databaseName}`;
targetUrl.search = "";

const projectId = randomUUID();
const canvasId = randomUUID();
const jobId = randomUUID();
const operations = ["emit_fact", "emit_finding", "mark_job_done"] as const;
const calls: string[] = [];
let closeApp: (() => Promise<unknown>) | null = null;
let endSql: (() => Promise<unknown>) | null = null;
let databaseCreated = false;

const collectText = async (
  process: AsyncIterable<{ type: string; chunk?: string }>,
  timeoutMs: number,
) => {
  const chunks: string[] = [];
  const deadline = Date.now() + timeoutMs;
  const iterator = process[Symbol.asyncIterator]();
  while (Date.now() < deadline) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (next.done) break;
    if (next.value?.type === "stdout" || next.value?.type === "stderr") chunks.push(next.value.chunk ?? "");
    if (calls.length >= operations.length) break;
  }
  return chunks.join("");
};

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  process.env.DATABASE_URL = targetUrl.toString();
  process.env.AGENT_MODE = "real";
  process.env.SANDBOX_PROVIDER = "opensandbox";
  process.env.OPEN_SANDBOX_API_KEY = apiKey;
  process.env.OPEN_SANDBOX_DOMAIN = process.env.OPEN_SANDBOX_DOMAIN?.trim() || "127.0.0.1:8080";
  process.env.DEEPSONAR_API_SANDBOX_URL = `http://${DEEPSONAR_GATEWAY_PROXY_HOST}:3100/control/v1`;
  process.env.DEEPSONAR_GATEWAY_PROXY_UPSTREAM_URL = "http://host.docker.internal:3100/gateway";

  const [
    { default: Fastify },
    dbModule,
    platformApi,
    { runner },
    { preparePlatformCapability },
    { config },
  ] = await Promise.all([
    import("fastify"),
    import("./db.js"),
    import("./domains/platform-api/index.js"),
    import("./runtime.js"),
    import("./executor-real.js"),
    import("./config.js"),
  ]);
  const { sql, migrate } = dbModule;
  const { activateProvisionedJobCapabilityTokens, registerPlatformControlRoutes, registerRuntimeHandler, unregisterRuntimeHandler } = platformApi;
  endSql = () => sql.end({ timeout: 5 });
  await migrate();

  const app = Fastify({ logger: false });
  registerPlatformControlRoutes(app);
  await app.listen({ port: 3100, host: "0.0.0.0" });
  closeApp = () => app.close();

  const snapshot = {
    name: "audit",
    platform_tools: [...operations],
    agent_cli: selectedCli,
    agent_runtime: freezeAgentCliRuntime(AGENT_CLI_RUNTIME_ADAPTERS[selectedCli]),
    sandbox_limits: { cpu: 1, memoryMiB: 1024, pidsLimit: 256, capDropAll: true, noNewPrivileges: true },
    runtime_image: { image_ref: runtimeImage, contract_version: "deepsonar.runtime.contract/v1" },
  };
  await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${canvasId}, 'OpenSandbox CLI control')`;
  await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasId}, ${projectId}, 'OpenSandbox CLI control')`;
  await sql`
    INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, timeout_sec)
    VALUES (${jobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json(JSON.parse(JSON.stringify(snapshot)))}, 3600)`;
  const capability = await preparePlatformCapability(jobId, snapshot as Parameters<typeof preparePlatformCapability>[1]);
  await activateProvisionedJobCapabilityTokens(jobId);
  registerRuntimeHandler(jobId, async (context) => {
    calls.push(context.operationId);
    return { accepted: true, operation_id: context.operationId, event_id: context.eventId };
  }, [...operations]);

  const handle = await runner.provision({
    jobId,
    attemptId: randomUUID(),
    image: runtimeImage,
    network: "egress",
    gatewayUpstreamUrl: config.gateway.proxyUpstreamUrl,
    limits: snapshot.sandbox_limits,
    env: {
      DEEPSONAR_ALLOW_EGRESS: "1",
      ...capability.env,
      ...(selectedCli === "claude-code" ? { ANTHROPIC_API_KEY: vendorKey } : {}),
      ...(selectedCli === "dsh" ? { DEEPSEEK_API_KEY: vendorKey } : {}),
      ...(selectedCli === "codex" || selectedCli === "open-code" || selectedCli === "pi" ? { OPENAI_API_KEY: vendorKey } : {}),
    },
    expectedContract: "deepsonar.runtime.contract/v1",
  });
  try {
    const host = await runner.ensureHost(handle);
    await host.run("mkdir -p /workspace/.deepsonar && printf '%s\\n' '{\"mcpServers\":{}}' > /workspace/.deepsonar/mcp.json", { timeoutMs: 5_000 });
    await host.uploadFile(`#!/bin/sh
set -eu
base=$(printf '%s' "$DEEPSONAR_API_BASE_URL" | sed 's:/*$::')
token=$DEEPSONAR_API_TOKEN
post() {
  python3 - "$base" "$token" "$1" "$2" <<'PY'
import sys, urllib.error, urllib.request, uuid
base, token, op, payload = sys.argv[1:5]
req = urllib.request.Request(
    f"{base}/operations/{op}",
    data=payload.encode(),
    headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "Idempotency-Key": str(uuid.uuid4()),
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=8) as resp:
        print(f"CALL:{op}={resp.status}")
except urllib.error.HTTPError as exc:
    print(f"CALL:{op}={exc.code}")
PY
}
post emit_fact '{"title":"CLI fact","description":"Submitted by Claude Code inside OpenSandbox."}'
post emit_finding '{"title":"CLI finding","summary":"Claude Code invoked Job Platform API from the worker."}'
post mark_job_done '{"summary":"Claude Code vendor-model Platform API proof finished."}'
`, "/workspace/poc-cli-emit.sh");
    await host.run("chmod +x /workspace/poc-cli-emit.sh", { timeoutMs: 5_000 });
    const adapter = AGENT_CLI_RUNTIME_ADAPTERS[selectedCli];
    const prompt = "Run exactly this command and nothing else: sh /workspace/poc-cli-emit.sh";
    const vendorEnv: Record<string, string> = {
      ...(selectedCli === "claude-code" ? { ANTHROPIC_API_KEY: vendorKey } : {}),
      ...(selectedCli === "dsh" ? { DEEPSEEK_API_KEY: vendorKey } : {}),
      ...(selectedCli === "codex" || selectedCli === "open-code" || selectedCli === "pi" ? { OPENAI_API_KEY: vendorKey } : {}),
    };
    const process = await adapter.start({
      host,
      env: vendorEnv,
      cwd: "/workspace",
      input: prompt,
      mcpConfigPath: "/workspace/.deepsonar/mcp.json",
      ...(selectedCli === "dsh"
        ? { dshProvider: { provider: "deepseek", model: "deepseek-chat", config: { providers: { deepseek: { type: "openai" } } } } }
        : {}),
    });
    const payload = selectedCli === "dsh"
      ? adapter.encodeInput(prompt, {
          model: "deepseek-chat",
          modelProvider: "deepseek",
          cwd: "/workspace",
          contextIdentity: {
            context_id: jobId.replaceAll("-", ""),
            context_revision: 0,
            adapter_id: "dsh",
            adapter_version: adapter.version,
            runtime_identity: "poc",
            transform_chain_digest: "0",
          },
        })
      : adapter.encodeInput(prompt);
    if (payload) await process.write(payload).catch(() => {});
    const text = await collectText(process, 120_000);
    await process.closeStdin().catch(() => {});
    await process.kill().catch(() => {});
    const submitted = operations.every((name) => calls.includes(name));
    if (!submitted) {
      throw new Error(`${selectedCli} did not submit Platform API ops: calls=${calls.join(",") || "none"} out=${text.replace(/\n/g, " ").slice(0, 400)}`);
    }
  } finally {
    await runner.destroy(handle).catch(() => {});
  }
  const leftovers = await runner.listResources({ jobId });
  if (leftovers.length > 0) throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
  unregisterRuntimeHandler(jobId);
  console.log(`OK: OpenSandbox CLI vendor control cli=${selectedCli} submitted=true leftover=0 calls=${calls.join(",")}`);
} finally {
  if (closeApp) await closeApp().catch(() => {});
  if (endSql) await endSql().catch(() => {});
  if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
  await admin.end({ timeout: 5 }).catch(() => {});
}
