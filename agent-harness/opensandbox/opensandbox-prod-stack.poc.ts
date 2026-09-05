/**
 * Live proof that a real Scheduler with SANDBOX_PROVIDER=opensandbox
 * exposes GET /readiness against a reachable OpenSandbox server.
 * Does not provision a sandbox and does not stop the Phase 2 server.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { shouldRunOpenSandboxPoc } from "@deepsonar/runtime-sandbox/poc";

if (!shouldRunOpenSandboxPoc()) {
  console.log("skip: OpenSandbox prod-stack PoC (set OPEN_SANDBOX_POC=1)");
  process.exit(0);
}

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const apiKey = process.env.OPEN_SANDBOX_API_KEY?.trim();
if (!databaseUrl || !apiKey) {
  console.error("TEST_DATABASE_URL and OPEN_SANDBOX_API_KEY are required");
  process.exit(1);
}

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
adminUrl.search = "";
const admin = postgres(adminUrl.toString(), { max: 1 });
const databaseName = `deepsonar_os_stack_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
const targetUrl = new URL(databaseUrl);
targetUrl.pathname = `/${databaseName}`;
targetUrl.search = "";

let closeApp: (() => Promise<unknown>) | null = null;
let endSql: (() => Promise<unknown>) | null = null;
let databaseCreated = false;
let runner: Awaited<typeof import("../../apps/scheduler/src/runtime.js")>["runner"] | null = null;

try {
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  process.env.DATABASE_URL = targetUrl.toString();
  process.env.AGENT_MODE = "real";
  process.env.SANDBOX_PROVIDER = "opensandbox";
  process.env.OPEN_SANDBOX_API_KEY = apiKey;
  process.env.OPEN_SANDBOX_DOMAIN = process.env.OPEN_SANDBOX_DOMAIN?.trim() || "127.0.0.1:8080";
  process.env.DEEPSONAR_AUTH_REQUIRED = "false";

  const [
    { default: Fastify },
    dbModule,
    { registerSettingsRoutes },
    { registerSystemRoutes },
    runtimeModule,
    { resetOpenSandboxServerStatusForTests },
  ] = await Promise.all([
    import("fastify"),
    import("../../apps/scheduler/src/db.js"),
    import("../../apps/scheduler/src/domains/settings/routes.js"),
    import("../../apps/scheduler/src/domains/system/routes.js"),
    import("../../apps/scheduler/src/runtime.js"),
    import("../../apps/scheduler/src/opensandbox-health.js"),
  ]);
  runner = runtimeModule.runner;
  if (runner.constructor.name !== "OpenSandboxRunner") {
    throw new Error(`expected OpenSandboxRunner, got ${runner.constructor.name}`);
  }
  resetOpenSandboxServerStatusForTests();
  const { sql, migrate } = dbModule;
  endSql = () => sql.end({ timeout: 5 });
  await migrate();

  const app = Fastify({ logger: false });
  registerSettingsRoutes(app);
  registerSystemRoutes(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  closeApp = () => app.close();
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const readiness = await app.inject({ method: "GET", url: "/readiness" });
  const health = await app.inject({ method: "GET", url: "/health" });
  if (readiness.statusCode !== 200) {
    throw new Error(`GET /readiness ${readiness.statusCode}: ${readiness.body}`);
  }
  if (health.statusCode !== 200) {
    throw new Error(`GET /health ${health.statusCode}: ${health.body}`);
  }
  const body = JSON.parse(readiness.payload) as {
    checks?: Array<{ code?: string }>;
  };
  if (!body.checks?.some((check) => check.code === "OPENSANDBOX_SERVER_READY")) {
    throw new Error("GET /readiness missing OPENSANDBOX_SERVER_READY");
  }
  const healthBody = JSON.parse(health.payload) as {
    ok?: boolean;
    opensandbox?: { level?: string; ready?: boolean };
  };
  if (healthBody.ok !== true || healthBody.opensandbox?.level !== "ok" || healthBody.opensandbox.ready !== true) {
    throw new Error(`GET /health opensandbox not ready: ${health.payload}`);
  }
  const leaked = `${readiness.payload}${health.payload}`.includes(apiKey);
  if (leaked) throw new Error("OpenSandbox API key leaked into readiness/health");
  const leftovers = await runner.listResources();
  if (leftovers.length !== 0) {
    throw new Error(`OPENSANDBOX_POC_LEFTOVER: ${leftovers.map((item) => item.resourceId).join(",")}`);
  }
  console.log(`OK: OpenSandbox prod-stack runner=OpenSandboxRunner readiness=200 health=200 probe=ready leftover=0 port=${port}`);
} finally {
  if (closeApp) await closeApp().catch(() => {});
  if (endSql) await endSql().catch(() => {});
  if (databaseCreated) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
  }
  await admin.end({ timeout: 5 }).catch(() => {});
}
