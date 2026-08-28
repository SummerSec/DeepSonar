/**
 * Live proof that production scheduler+web images can attach to an
 * already-running OpenSandbox. Does not start a second server and does
 * not stop the Phase 2 `deepsonar-opensandbox` container.
 *
 * Phase 2 server is host-network + 127.0.0.1:8080. Compose extra_hosts
 * maps host.docker.internal to docker0, so this PoC proxies that
 * gateway address onto loopback without touching the live server.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, connect, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldRunOpenSandboxPoc } from "@deepsonar/runtime-sandbox";

if (!shouldRunOpenSandboxPoc()) {
  console.log("skip: OpenSandbox prod-compose PoC (set OPEN_SANDBOX_POC=1)");
  process.exit(0);
}

const apiKey = process.env.OPEN_SANDBOX_API_KEY?.trim();
if (!apiKey) {
  console.error("OPEN_SANDBOX_API_KEY is required");
  process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const deployDir = join(repoRoot, "deploy");
const dir = mkdtempSync(join(tmpdir(), "opensandbox-prod-compose-"));
const projectName = `os-prod-compose-${process.pid}-${randomUUID().slice(0, 8)}`;
const schedulerPort = process.env.OPEN_SANDBOX_POC_SCHEDULER_PORT?.trim() || "13100";
const webPort = process.env.OPEN_SANDBOX_POC_WEB_PORT?.trim() || "18082";
const postgresPort = process.env.OPEN_SANDBOX_POC_POSTGRES_PORT?.trim() || "15432";
const envFile = join(dir, ".env");
const masterKeyFile = join(dir, "master.key");
const composeArgs = [
  "-n", "docker", "compose",
  "--project-name", projectName,
  "--project-directory", deployDir,
  "--env-file", envFile,
  "-f", join(deployDir, "docker-compose.opensandbox.host.yml"),
];

function run(args: string[], timeout = 120_000) {
  return spawnSync("sudo", args, { encoding: "utf8", timeout });
}

function existingOpenSandboxRunning(): boolean {
  const inspected = run(["-n", "docker", "inspect", "-f", "{{.State.Running}}", "deepsonar-opensandbox"]);
  return inspected.status === 0 && inspected.stdout.trim() === "true";
}

function hostGatewayIp(): string {
  const docker0 = networkInterfaces().docker0?.find((entry) => entry.family === "IPv4" && !entry.internal);
  if (!docker0?.address) throw new Error("docker0 IPv4 is required to proxy host.docker.internal:8080");
  return docker0.address;
}

function startHostGatewayProxy(listenIp: string): Promise<Server> {
  const server = createServer((client) => {
    const upstream = connect({ host: "127.0.0.1", port: 8080 });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(8080, listenIp, () => resolve(server));
  });
}

if (!existingOpenSandboxRunning()) {
  throw new Error("Phase 2 deepsonar-opensandbox must stay running for prod-compose");
}

writeFileSync(masterKeyFile, `${"00".repeat(32)}\n`, { mode: 0o600 });
writeFileSync(envFile, [
  "POSTGRES_PASSWORD=poc-opensandbox-compose",
  "DEEPSONAR_IMAGE_TAG=0.1.45",
  "DEEPSONAR_VERSION=0.1.45-os-compose",
  "DEEPSONAR_ADMIN_TOKEN=poc-admin-token",
  `OPEN_SANDBOX_API_KEY=${apiKey}`,
  "OPEN_SANDBOX_DOMAIN=host.docker.internal:8080",
  "OPEN_SANDBOX_PROTOCOL=http",
  `OPEN_SANDBOX_POC_MASTER_KEY=${masterKeyFile}`,
  `SCHEDULER_HOST_PORT=${schedulerPort}`,
  `DEEPSONAR_WEB_PORT=${webPort}`,
  `POSTGRES_BIND_PORT=${postgresPort}`,
  "",
].join("\n"), { mode: 0o600 });

const down = () => run([...composeArgs, "down", "-v", "--remove-orphans"], 180_000);
const gatewayIp = hostGatewayIp();
const proxy = await startHostGatewayProxy(gatewayIp);

try {
  const build = run([...composeArgs, "up", "-d", "--build"], 1_200_000);
  if (build.status !== 0) {
    const logs = run([...composeArgs, "logs", "--tail=80"], 30_000);
    throw new Error(`prod-compose up failed: ${build.stderr || build.stdout}\n${logs.stdout}\n${logs.stderr}`);
  }

  type HealthProbe = { ok?: boolean; opensandbox?: { level?: string; ready?: boolean; domain?: string } };
  const deadline = Date.now() + 240_000;
  let schedulerHealth: HealthProbe | null = null;
  let webHealth: HealthProbe | null = null;
  while (Date.now() < deadline) {
    const schedulerProbe = spawnSync("curl", ["-fsS", `http://127.0.0.1:${schedulerPort}/health`], { encoding: "utf8" });
    const webProbe = spawnSync("curl", ["-fsS", `http://127.0.0.1:${webPort}/api/health`], { encoding: "utf8" });
    if (schedulerProbe.status === 0 && webProbe.status === 0) {
      schedulerHealth = JSON.parse(schedulerProbe.stdout) as HealthProbe;
      webHealth = JSON.parse(webProbe.stdout) as HealthProbe;
      if (schedulerHealth.opensandbox?.level === "ok" && webHealth.opensandbox?.level === "ok") break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (schedulerHealth?.opensandbox?.level !== "ok" || webHealth?.opensandbox?.level !== "ok") {
    const logs = run([...composeArgs, "logs", "--tail=80", "scheduler", "web"], 30_000);
    throw new Error(`prod-compose health not ready: scheduler=${JSON.stringify(schedulerHealth)} web=${JSON.stringify(webHealth)}\n${logs.stdout}`);
  }
  if (schedulerHealth.opensandbox?.domain && !schedulerHealth.opensandbox.domain.includes("8080")) {
    throw new Error(`unexpected OpenSandbox domain ${schedulerHealth.opensandbox.domain}`);
  }
  if (JSON.stringify({ schedulerHealth, webHealth }).includes(apiKey)) {
    throw new Error("OpenSandbox API key leaked into compose health");
  }
  if (!existingOpenSandboxRunning()) {
    throw new Error("prod-compose stopped Phase 2 deepsonar-opensandbox");
  }
  const listed = run(["-n", "docker", "ps", "-q", "--filter", "name=opensandbox"]);
  const opensandboxCount = listed.stdout.trim().split("\n").filter(Boolean).length;
  if (opensandboxCount !== 1) {
    throw new Error(`expected exactly one OpenSandbox container, got ${opensandboxCount}`);
  }
  console.log(
    `OK: OpenSandbox prod-compose scheduler=200 web=200 probe=ready leftover_server=1 port=${schedulerPort} webPort=${webPort}`,
  );
} finally {
  down();
  proxy.close();
  rmSync(dir, { recursive: true, force: true });
}
