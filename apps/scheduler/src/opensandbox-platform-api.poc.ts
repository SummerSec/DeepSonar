/**
 * Live proof that OpenSandbox workers can only submit semantics via Job Platform API.
 * Requires OPEN_SANDBOX_POC=1, a reachable OpenSandbox server, and TEST_DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  createSdkOpenSandboxClient,
  OpenSandboxRunner,
  readOpenSandboxPin,
  shouldRunOpenSandboxPoc,
} from "../../../packages/runtime-sandbox/src/index.ts";

if (!shouldRunOpenSandboxPoc()) {
  console.log("skip: OpenSandbox Platform API PoC (set OPEN_SANDBOX_POC=1)");
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
const databaseName = `deepsonar_os_api_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
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

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  process.env.DATABASE_URL = targetUrl.toString();
  process.env.AGENT_MODE = "fake";

  const [{ default: Fastify }, dbModule, platformApi] = await Promise.all([
    import("fastify"),
    import("./db.ts"),
    import("./domains/platform-api/index.ts"),
  ]);
  const { sql, migrate } = dbModule;
  const {
    activateProvisionedJobCapabilityTokens,
    mintJobCapabilityToken,
    registerPlatformControlRoutes,
    registerRuntimeHandler,
    unregisterRuntimeHandler,
  } = platformApi;
  endSql = () => sql.end({ timeout: 5 });
  await migrate();

  const app = Fastify({ logger: false });
  registerPlatformControlRoutes(app);
  await app.listen({ port: 3100, host: "0.0.0.0" });
  closeApp = () => app.close();

  const snapshot = { name: "audit", platform_tools: [...operations] };
  await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${canvasId}, 'OpenSandbox Platform API')`;
  await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasId}, ${projectId}, 'OpenSandbox Platform API')`;
  await sql`
    INSERT INTO jobs (
      id, project_id, canvas_id, type, status, agent_snapshot_json,
      started_at, timeout_sec, lease_expires_at
    ) VALUES (
      ${jobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json(snapshot)},
      now(), 3600, now() + interval '1 hour'
    )`;
  const grant = await mintJobCapabilityToken(jobId);
  await activateProvisionedJobCapabilityTokens(jobId);
  registerRuntimeHandler(jobId, async (context) => {
    calls.push(context.operationId);
    return { accepted: true, operation_id: context.operationId, event_id: context.eventId };
  }, [...operations]);

  const pin = readOpenSandboxPin({});
  const client = createSdkOpenSandboxClient({
    domain: process.env.OPEN_SANDBOX_DOMAIN?.trim() || "127.0.0.1:8080",
    apiKey,
    protocol: process.env.OPEN_SANDBOX_PROTOCOL === "https" ? "https" : "http",
    useServerProxy: true,
    pin,
  });
  const runner = new OpenSandboxRunner(client);
  const limits = { cpu: 1, memoryMiB: 512, pidsLimit: 128, capDropAll: true, noNewPrivileges: true };
  const invokePy = `
import json, socket, urllib.error, urllib.request
gw = "127.0.0.1"
with open("/proc/net/route") as fh:
    for line in fh:
        fields = line.split()
        if len(fields) > 2 and fields[1] == "00000000":
            gw = socket.inet_ntoa(int(fields[2], 16).to_bytes(4, "little"))
            break
req = urllib.request.Request(
    f"http://{gw}:3100/control/v1/jobs/${jobId}/operations/emit_fact",
    data=json.dumps({"title":"OpenSandbox fact","description":"Submitted from inside an OpenSandbox worker via Job Platform API."}).encode(),
    headers={"Authorization":"Bearer ${grant.token}","Idempotency-Key":"${randomUUID()}","Content-Type":"application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=5) as resp:
        print("CODE:" + str(resp.status))
        print(resp.read().decode())
except urllib.error.HTTPError as exc:
    print("CODE:" + str(exc.code))
    print(exc.read().decode())
except Exception as exc:
    print("CODE:0")
    print(type(exc).__name__)
`.trim();
  const invoke = `python3 -c ${JSON.stringify(invokePy)}`;

  const isolated = await runner.provision({
    jobId: randomUUID(),
    attemptId: randomUUID(),
    image: runtimeImage,
    network: "none",
    limits,
    expectedContract: "deepsonar.runtime.contract/v1",
  });
  let isolatedBlocked = false;
  try {
    const host = await runner.ensureHost(isolated);
    const probe = await host.run(invoke, { timeoutMs: 8_000 });
    isolatedBlocked = probe.exitCode !== 0 || !/CODE:200/.test(`${probe.stdout}${probe.stderr}`);
  } finally {
    await runner.destroy(isolated).catch(() => {});
  }

  const allowed = await runner.provision({
    jobId: randomUUID(),
    attemptId: randomUUID(),
    image: runtimeImage,
    network: "egress",
    limits,
    expectedContract: "deepsonar.runtime.contract/v1",
  });
  let submitted = false;
  try {
    const host = await runner.ensureHost(allowed);
    const result = await host.run(invoke, { timeoutMs: 12_000 });
    submitted = result.exitCode === 0 && /CODE:200/.test(result.stdout);
    if (!submitted) throw new Error(`OpenSandbox Platform API invoke failed: ${JSON.stringify(result)}`);
  } finally {
    await runner.destroy(allowed).catch(() => {});
  }

  const leftovers = await runner.listResources();
  if (leftovers.length > 0) {
    throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
  }
  if (!isolatedBlocked) throw new Error("network=none was able to submit Platform API events");
  if (!calls.includes("emit_fact")) throw new Error("emit_fact handler was not invoked");
  unregisterRuntimeHandler(jobId);
  console.log(`OK: OpenSandbox Platform API isolated=${isolatedBlocked} submitted=${submitted} calls=${calls.join(",")}`);
} finally {
  if (closeApp) await closeApp().catch(() => {});
  if (endSql) await endSql().catch(() => {});
  if (databaseCreated) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
  }
  await admin.end({ timeout: 5 }).catch(() => {});
}
