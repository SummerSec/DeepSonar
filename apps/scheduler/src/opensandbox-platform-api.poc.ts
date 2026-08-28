/**
 * Live proof that OpenSandbox workers submit semantics only via Job Platform API.
 * Real jobs use restricted (allow_egress=false) or egress — never none.
 * Requires OPEN_SANDBOX_POC=1, a reachable OpenSandbox server, and TEST_DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  bindGatewayProxyToOpenSandboxNetwork,
  createSdkOpenSandboxClient,
  DEEPSONAR_GATEWAY_PROXY_HOST,
  OpenSandboxRunner,
  readOpenSandboxPin,
  shouldRunOpenSandboxPoc,
} from "@deepsonar/runtime-sandbox";

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
    import("./db.js"),
    import("./domains/platform-api/index.js"),
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
  const runner = new OpenSandboxRunner(client, { bind: bindGatewayProxyToOpenSandboxNetwork });
  const limits = { cpu: 1, memoryMiB: 512, pidsLimit: 128, capDropAll: true, noNewPrivileges: true };
  const invokePy = `
import json, os, socket, urllib.error, urllib.request, uuid

def gw():
    with open("/proc/net/route") as fh:
        for line in fh:
            fields = line.split()
            if len(fields) > 2 and fields[1] == "00000000":
                return socket.inet_ntoa(int(fields[2], 16).to_bytes(4, "little"))
    return ""

def leaked():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        s.connect(("192.0.2.1", 80))
        return True
    except OSError:
        return False
    finally:
        s.close()

OPS = [
    ("emit_fact", {"title": "OpenSandbox fact", "description": "Submitted from inside an OpenSandbox worker via Job Platform API."}),
    ("emit_finding", {"title": "OpenSandbox finding from restricted worker", "summary": "This finding proves Job Platform API ingest from an OpenSandbox restricted sandbox."}),
    ("mark_job_done", {"summary": "OpenSandbox Platform API live proof finished from the worker."}),
]

def post(operation, payload, token):
    base = os.environ["DEEPSONAR_API_BASE_URL"].rstrip("/")
    req = urllib.request.Request(
        f"{base}/operations/{operation}",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": "Bearer " + token,
            "Idempotency-Key": str(uuid.uuid4()),
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except Exception:
        return 0

print("GW:" + gw())
print("LEAK:" + ("1" if leaked() else "0"))
if os.environ.get("DEEPSONAR_POC_MODE") == "submit":
    token = os.environ["DEEPSONAR_API_TOKEN"]
    for name, payload in OPS:
        print(f"CALL:{name}=" + str(post(name, payload, token)))
    print("UNAUTH:" + str(post("emit_fact", OPS[0][1], "invalid-token")))
`.trim();

  const summarize = (label: string, result: { exitCode: number; stdout: string; stderr: string }) =>
    `${label} exit=${result.exitCode} stdout=${result.stdout.slice(0, 240)} stderr=${result.stderr.slice(0, 240)}`;

  const runInvoke = async (
    network: "none" | "restricted",
    env: Record<string, string>,
    gatewayUpstreamUrl?: string,
  ) => {
    const handle = await runner.provision({
      jobId: randomUUID(),
      attemptId: randomUUID(),
      image: runtimeImage,
      network,
      gatewayUpstreamUrl,
      limits,
      expectedContract: "deepsonar.runtime.contract/v1",
    });
    try {
      const host = await runner.ensureHost(handle);
      await host.uploadFile(invokePy, "/workspace/poc-emit-fact.py");
      return await host.run("python3 /workspace/poc-emit-fact.py", {
        timeoutMs: network === "none" ? 8_000 : 12_000,
        env,
      });
    } finally {
      await runner.destroy(handle).catch(() => {});
    }
  };

  const isolated = await runInvoke("none", { DEEPSONAR_POC_MODE: "isolated" });
  const isolatedBlocked = isolated.exitCode === 0 && /LEAK:0/.test(isolated.stdout);
  if (!isolatedBlocked) {
    throw new Error(`network=none leaked TEST-NET or failed: ${summarize("none", isolated)}`);
  }

  const allowed = await runInvoke("restricted", {
    DEEPSONAR_POC_MODE: "submit",
    DEEPSONAR_API_BASE_URL: `http://${DEEPSONAR_GATEWAY_PROXY_HOST}:3100/control/v1/jobs/${jobId}`,
    DEEPSONAR_API_TOKEN: grant.token,
    DEEPSONAR_JOB_ID: jobId,
  }, "http://host.docker.internal:3100/gateway");
  const submitted = operations.every((name) => allowed.exitCode === 0 && allowed.stdout.includes(`CALL:${name}=200`));
  const rejectedUnauth = allowed.exitCode === 0 && /UNAUTH:401/.test(allowed.stdout);
  const restrictedIsolated = /LEAK:0/.test(allowed.stdout);
  if (!submitted || !rejectedUnauth || !restrictedIsolated) {
    throw new Error(`restricted Platform API invoke failed: ${summarize("restricted", allowed)}`);
  }

  const leftovers = await runner.listResources();
  if (leftovers.length > 0) {
    throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
  }
  if (!operations.every((name) => calls.includes(name))) {
    throw new Error(`Platform API handlers missing: expected ${operations.join(",")} got ${calls.join(",")}`);
  }
  unregisterRuntimeHandler(jobId);
  console.log(`OK: OpenSandbox Platform API isolated=${isolatedBlocked} submitted=${submitted} unauth=401 restrictedIsolated=${restrictedIsolated} calls=${calls.join(",")}`);
} finally {
  if (closeApp) await closeApp().catch(() => {});
  if (endSql) await endSql().catch(() => {});
  if (databaseCreated) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
  }
  await admin.end({ timeout: 5 }).catch(() => {});
}
