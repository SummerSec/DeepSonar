/**
 * Vendor-model proof that real CLIs inside OpenSandbox talk to Model Gateway
 * and submit Job Platform API operations themselves. Long-lived vendor keys stay
 * in Scheduler credentials; the sandbox only receives a job gateway token.
 * Mock LLM is not a substitute. Default: run every CLI that has a vendor key.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import postgres from "postgres";
import {
  AGENT_CLI_RUNTIME_ADAPTERS,
  CLI_SESSION_ADAPTERS,
  DEEPSONAR_GATEWAY_PROXY_HOST,
  applyRuntimeOutputText,
  freezeAgentCliRuntime,
  shouldRunOpenSandboxPoc,
  type AdapterRuntimeState,
} from "@deepsonar/runtime-sandbox";
import { parseAgentSession } from "../../web/src/session-viewer/parseAgentSession.ts";

if (!shouldRunOpenSandboxPoc()) {
  console.log("skip: OpenSandbox CLI control PoC (set OPEN_SANDBOX_POC=1)");
  process.exit(0);
}

process.env.DEEPSONAR_MASTER_KEY ??= "00".repeat(32);

const vendorPlans = {
  "claude-code": { secret: process.env.ANTHROPIC_API_KEY?.trim(), provider: "anthropic", model: "claude-sonnet-4-5" },
  codex: { secret: process.env.OPENAI_API_KEY?.trim(), provider: "openai", model: "gpt-5" },
  "open-code": { secret: process.env.OPENAI_API_KEY?.trim(), provider: "openai", model: "gpt-5" },
  pi: { secret: process.env.OPENAI_API_KEY?.trim(), provider: "openai", model: "gpt-5" },
  dsh: { secret: process.env.DEEPSEEK_API_KEY?.trim(), provider: "openai", model: "deepseek-chat", baseUrl: "https://api.deepseek.com" },
} as const;
type VendorCli = keyof typeof vendorPlans;
const vendorCliIds = Object.keys(vendorPlans) as VendorCli[];
const requestedCli = process.env.OPEN_SANDBOX_POC_CLI?.trim();
if (requestedCli && !(requestedCli in vendorPlans)) {
  console.error(`OPEN_SANDBOX_POC_CLI must be one of ${vendorCliIds.join(", ")}`);
  process.exit(1);
}
const selectedClis = (requestedCli ? [requestedCli as VendorCli] : vendorCliIds)
  .filter((cli) => Boolean(vendorPlans[cli].secret));
if (requestedCli && selectedClis.length === 0) {
  console.error(`OPEN_SANDBOX_POC_CLI=${requestedCli} needs its vendor key for vendor-model E2E`);
  process.exit(1);
}
if (selectedClis.length === 0) {
  console.log("skip: OpenSandbox CLI control PoC needs ANTHROPIC_API_KEY, OPENAI_API_KEY, or DEEPSEEK_API_KEY for vendor-model E2E");
  process.exit(0);
}
if (!requestedCli && selectedClis.length !== vendorCliIds.length) {
  const missing = [
    !vendorPlans["claude-code"].secret ? "ANTHROPIC_API_KEY" : "",
    !vendorPlans.codex.secret ? "OPENAI_API_KEY" : "",
    !vendorPlans.dsh.secret ? "DEEPSEEK_API_KEY" : "",
  ].filter(Boolean);
  console.error(`vendor CLI E2E requires all five CLIs; missing ${missing.join(",")}`);
  process.exit(1);
}

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const apiKey = process.env.OPEN_SANDBOX_API_KEY?.trim();
const runtimeImage = process.env.OPEN_SANDBOX_POC_RUNTIME_IMAGE?.trim();
if (!databaseUrl || !apiKey || !runtimeImage) {
  console.error("TEST_DATABASE_URL, OPEN_SANDBOX_API_KEY, and OPEN_SANDBOX_POC_RUNTIME_IMAGE are required");
  process.exit(1);
}

const execFileP = promisify(execFile);
try {
  await execFileP("docker", ["info"], { timeout: 10_000 });
} catch {
  throw new Error("vendor CLI E2E needs host docker access for Gateway bind");
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
const operations = ["emit_fact", "emit_finding", "submit_hub_decision", "mark_job_done"] as const;
let closeApp: (() => Promise<unknown>) | null = null;
let endSql: (() => Promise<unknown>) | null = null;
let databaseCreated = false;

const collectText = async (
  process: AsyncIterable<{ type: string; chunk?: string }>,
  timeoutMs: number,
  submitted: () => boolean,
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
    if (submitted()) break;
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
    { encryptSecret, fingerprintOf, last4Of, PROVIDER_ENV_MAP },
    { mintJobToken, registerGateway },
    { materializeProviderSettings, qualifyPiModelRef, routeMaterializedProviderFilesThroughGateway },
    { buildDshPiAiRuntimeProjection, defaultDshPiAiSettings },
  ] = await Promise.all([
    import("fastify"),
    import("./db.js"),
    import("./domains/platform-api/index.js"),
    import("./runtime.js"),
    import("./executor-real.js"),
    import("./config.js"),
    import("./credentials.js"),
    import("./gateway.js"),
    import("./provider-settings.js"),
    import("./dsh-pi-ai-settings.js"),
  ]);
  const { sql, migrate } = dbModule;
  const { activateProvisionedJobCapabilityTokens, registerPlatformControlRoutes, registerRuntimeHandler, unregisterRuntimeHandler } = platformApi;
  endSql = () => sql.end({ timeout: 5 });
  await migrate();

  const app = Fastify({ logger: false });
  registerPlatformControlRoutes(app);
  registerGateway(app);
  try {
    await app.listen({ port: 3100, host: "0.0.0.0" });
  } catch (error) {
    throw new Error(`vendor CLI PoC needs 0.0.0.0:3100 for deepsonar-gateway-proxy: ${error instanceof Error ? error.message : String(error)}`);
  }
  closeApp = () => app.close();

  await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${canvasId}, 'OpenSandbox CLI control')`;
  await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasId}, ${projectId}, 'OpenSandbox CLI control')`;

  const ran: VendorCli[] = [];
  for (const selectedCli of selectedClis) {
    const plan = vendorPlans[selectedCli];
    const vendorSecret = plan.secret;
    if (!vendorSecret) throw new Error(`missing vendor secret for ${selectedCli}`);
    const jobId = randomUUID();
    const attemptId = randomUUID();
    const credentialId = randomUUID();
    const calls: string[] = [];
    const encrypted = encryptSecret(vendorSecret);
    const mapping = PROVIDER_ENV_MAP[plan.provider];
    if (!mapping) throw new Error(`unsupported vendor provider ${plan.provider}`);
    const settingsConfig = selectedCli === "dsh"
      ? defaultDshPiAiSettings({
        route: "deepseek",
        protocol: "openai-completions",
        baseURL: "https://api.deepseek.com",
        model: plan.model,
      })
      : {};
    await sql`
      INSERT INTO credentials (
        id, name, kind, provider, ciphertext, nonce, auth_tag, fingerprint, last4, status,
        agent_cli, public_metadata_json, settings_config_json
      ) VALUES (
        ${credentialId}, ${`OpenSandbox ${selectedCli} vendor`}, 'llm_provider', ${plan.provider},
        ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.auth_tag},
        ${fingerprintOf(vendorSecret)}, ${last4Of(vendorSecret)}, 'active', ${selectedCli},
        ${sql.json(JSON.parse(JSON.stringify("baseUrl" in plan ? { base_url: plan.baseUrl } : {})))},
        ${sql.json(JSON.parse(JSON.stringify(settingsConfig)))}
      )`;

    const snapshot = {
      name: "audit",
      platform_tools: [...operations],
      agent_cli: selectedCli,
      agent_runtime: freezeAgentCliRuntime(AGENT_CLI_RUNTIME_ADAPTERS[selectedCli]),
      credential_id: credentialId,
      credential_provider: plan.provider,
      model: plan.model,
      sandbox_limits: { cpu: 1, memoryMiB: 1024, pidsLimit: 256, capDropAll: true, noNewPrivileges: true },
      runtime_image: { image_ref: runtimeImage, contract_version: "deepsonar.runtime.contract/v1" },
      config_files: [] as Array<{ path: string; content: string; content_sha256: string }>,
      settings_config_json: settingsConfig,
    };
    await sql`
      INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, timeout_sec, started_at, lease_expires_at)
      VALUES (${jobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json(JSON.parse(JSON.stringify(snapshot)))}, 3600, now(), now() + interval '1 hour')`;
    await sql`
      INSERT INTO job_attempts (id, job_id, attempt_no, status, phase, started_at)
      VALUES (${attemptId}, ${jobId}, 1, 'active', 'agent.ready', now())`;

    const capability = await preparePlatformCapability(jobId, snapshot as Parameters<typeof preparePlatformCapability>[1]);
    await activateProvisionedJobCapabilityTokens(jobId);
    registerRuntimeHandler(jobId, async (context) => {
      calls.push(context.operationId);
      return { accepted: true, operation_id: context.operationId, event_id: context.eventId };
    }, [...operations]);

    const token = await mintJobToken({
      jobId,
      projectId,
      credentialId,
      allowedModels: [plan.model],
      ttlSec: 3600,
    });
    const runtimeHome = "/workspace/.deepsonar-home";
    const gatewayEnv: Record<string, string> = {
      DEEPSONAR_ALLOW_EGRESS: "1",
      DEEPSONAR_GATEWAY_TOKEN: token.plaintext,
      ...capability.env,
      HOME: runtimeHome,
    };
    if (selectedCli === "dsh") {
      for (const key of mapping.secretKeys) delete gatewayEnv[key];
      if (mapping.baseUrlKey) delete gatewayEnv[mapping.baseUrlKey];
    } else {
      for (const key of mapping.secretKeys) gatewayEnv[key] = token.plaintext;
      if (mapping.baseUrlKey) gatewayEnv[mapping.baseUrlKey] = config.gateway.sandboxUrl;
    }
    if (Object.values(gatewayEnv).includes(vendorSecret) || gatewayEnv.DEEPSEEK_API_KEY) {
      throw new Error("vendor key leaked into OpenSandbox worker env");
    }

    let runtimeConfigFiles = selectedCli === "pi"
      ? materializeProviderSettings({
        agentCli: "pi",
        settingsConfig: { provider: plan.provider, baseUrl: "https://gateway.invalid", api: "openai-responses", models: [{ id: plan.model }] },
        overrides: { model: plan.model },
      })
      : [];
    if (runtimeConfigFiles.length > 0) {
      runtimeConfigFiles = routeMaterializedProviderFilesThroughGateway({
        agentCli: selectedCli,
        files: runtimeConfigFiles,
        gatewayBaseUrl: config.gateway.sandboxUrl,
        jobToken: token.plaintext,
      });
    }

    const handle = await runner.provision({
      jobId,
      attemptId,
      image: runtimeImage,
      network: "egress",
      gatewayUpstreamUrl: config.gateway.proxyUpstreamUrl,
      limits: snapshot.sandbox_limits,
      env: gatewayEnv,
      expectedContract: "deepsonar.runtime.contract/v1",
    });
    try {
      const host = await runner.ensureHost(handle);
      await host.run("mkdir -p /workspace/.deepsonar && printf '%s\\n' '{\"mcpServers\":{}}' > /workspace/.deepsonar/mcp.json", { timeoutMs: 5_000 });
      for (const file of runtimeConfigFiles) {
        const target = selectedCli === "pi" && file.path.startsWith(".pi/")
          ? `/workspace/.deepsonar-home/${file.path}`
          : `/workspace/${file.path}`;
        await host.uploadFile(file.content, target);
      }
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
post emit_fact '{"title":"CLI fact","description":"Submitted by a vendor CLI inside OpenSandbox via Job Platform API."}'
post emit_finding '{"title":"CLI finding","summary":"Vendor CLI invoked Job Platform API from the worker."}'
post submit_hub_decision '{"complete":{"from":[],"description":"Vendor CLI submitted a hub complete decision."}}'
post mark_job_done '{"summary":"Vendor-model Platform API proof finished."}'
`, "/workspace/poc-cli-emit.sh");
      await host.run("chmod +x /workspace/poc-cli-emit.sh", { timeoutMs: 5_000 });
      const adapter = AGENT_CLI_RUNTIME_ADAPTERS[selectedCli];
      const prompt = "Run exactly this command and nothing else: sh /workspace/poc-cli-emit.sh";
      await host.run(`mkdir -p ${runtimeHome}`, { timeoutMs: 5_000 });
      const dshProvider = selectedCli === "dsh"
        ? buildDshPiAiRuntimeProjection({
          settingsConfig,
          credentialProvider: plan.provider,
          gatewayBaseUrl: config.gateway.sandboxUrl,
          model: plan.model,
        })
        : undefined;
      const state: AdapterRuntimeState = {
        model: plan.model,
        modelProvider: selectedCli === "dsh" ? "deepseek" : plan.provider,
        cwd: "/workspace",
        contextIdentity: {
          context_id: jobId.replaceAll("-", ""),
          context_revision: 0,
          adapter_id: selectedCli,
          adapter_version: adapter.version,
          runtime_identity: "poc",
          transform_chain_digest: "0",
        },
      };
      const startContext = {
        host,
        env: gatewayEnv,
        cwd: "/workspace",
        input: prompt,
        model: selectedCli === "pi"
          ? qualifyPiModelRef(plan.model, runtimeConfigFiles) ?? plan.model
          : plan.model,
        mcpConfigPath: "/workspace/.deepsonar/mcp.json",
        contextIdentity: state.contextIdentity,
        ...(dshProvider ? { dshProvider } : {}),
      };
      await adapter.materialize?.(startContext);
      const started = await adapter.start(startContext);
      const payload = adapter.encodeInput(prompt, state);
      if (payload) await started.write(payload).catch(() => {});
      let steered = !adapter.capabilities.incrementalMessages;
      const steerPayload = adapter.encodeSteer?.("Continue and finish the script.", state)
        ?? (adapter.capabilities.incrementalMessages ? adapter.encodeInput("Continue and finish the script.", state) : "");
      if (steerPayload) {
        steered = true;
        await started.write(steerPayload).catch(() => { steered = false; });
      }
      if (adapter.encodeFollowUp) {
        await started.write(adapter.encodeFollowUp("follow-up: confirm the script finished.", state)).catch(() => { steered = false; });
      }
      if (!adapter.capabilities.incrementalMessages) await started.closeStdin().catch(() => {});
      const text = await collectText(started, 180_000, () => operations.every((name) => calls.includes(name)));
      if (adapter.capabilities.incrementalMessages) await started.closeStdin().catch(() => {});
      applyRuntimeOutputText(adapter, text, state);
      if (!operations.every((name) => calls.includes(name))) {
        throw new Error(`${selectedCli} did not submit Platform API ops: calls=${calls.join(",") || "none"} out=${text.replace(/\n/g, " ").slice(0, 400)}`);
      }
      if (!steered) throw new Error(`${selectedCli} steer/follow-up was not written`);
      if (!state.sessionId) throw new Error(`${selectedCli} did not expose a session id for archive`);
      const bundle = await CLI_SESSION_ADAPTERS[selectedCli].exportSession({
        run: (command) => host.run(command, { timeoutMs: 15_000, env: { HOME: runtimeHome } }),
        readText: async (filePath) => {
          const result = await host.run(`cat -- ${JSON.stringify(filePath)}`, { timeoutMs: 15_000, env: { HOME: runtimeHome } });
          return result.exitCode === 0 ? result.stdout : null;
        },
      }, state.sessionId, state.sessionFile);
      if (bundle.artifacts.length === 0) {
        throw new Error(`${selectedCli} session archive empty: ${bundle.captureError ?? "no artifacts"}`);
      }
      const artifact = bundle.artifacts.find((item) => item.kind === "main")
        ?? bundle.artifacts.find((item) => item.kind === "vendor_export")
        ?? bundle.artifacts[0]!;
      const parsed = parseAgentSession(artifact.content, { cli: selectedCli });
      if (parsed.items.length === 0 || parsed.totals.parsed === 0) {
        throw new Error(`${selectedCli} session viewer parsed empty: format=${parsed.format} bytes=${Buffer.byteLength(artifact.content)}`);
      }
      await started.kill().catch(() => {});
      const resumeProcess = await adapter.resume({
        ...startContext,
        sessionId: state.sessionId,
        sessionFile: state.sessionFile,
      });
      const resumePayload = adapter.encodeInput("resume-ping", state);
      if (resumePayload) await resumeProcess.write(resumePayload).catch(() => {});
      if (resumePayload || !adapter.capabilities.incrementalMessages) {
        await resumeProcess.closeStdin().catch(() => {});
      }
      await collectText(resumeProcess, 15_000, () => false);
      await resumeProcess.kill().catch(() => {});
    } finally {
      await runner.destroy(handle).catch(() => {});
    }
    const leftovers = await runner.listResources({ jobId });
    if (leftovers.length > 0) throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
    unregisterRuntimeHandler(jobId);
    ran.push(selectedCli);
  }
  const skipped = vendorCliIds.filter((cli) => !ran.includes(cli));
  if (!requestedCli && skipped.length > 0) {
    throw new Error(`vendor CLI E2E incomplete: skipped=${skipped.join(",")}`);
  }
  console.log(
    `OK: OpenSandbox CLI vendor control clis=${ran.join(",")} skipped=${skipped.join(",") || "none"} gateway=true submitted=true steered=true archived=true viewed=true resumed=true leftover=0`,
  );
} finally {
  if (closeApp) await closeApp().catch(() => {});
  if (endSql) await endSql().catch(() => {});
  if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
  await admin.end({ timeout: 5 }).catch(() => {});
}
