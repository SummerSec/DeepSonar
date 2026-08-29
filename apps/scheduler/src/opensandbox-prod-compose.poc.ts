/**
 * Live proof that production scheduler+web images can attach to an
 * already-running OpenSandbox. Does not start a second server and does
 * not stop the Phase 2 `deepsonar-opensandbox` container.
 *
 * Postgres+scheduler+silo use host network so they can reach loopback OpenSandbox
 * and each other; this VM's compose bridge drops inter-container TCP.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
const siloPort = process.env.OPEN_SANDBOX_POC_SILO_PORT?.trim() || "19000";
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
  "OPEN_SANDBOX_DOMAIN=127.0.0.1:8080",
  "OPEN_SANDBOX_PROTOCOL=http",
  `OPEN_SANDBOX_POC_MASTER_KEY=${masterKeyFile}`,
  `SCHEDULER_HOST_PORT=${schedulerPort}`,
  `DEEPSONAR_WEB_PORT=${webPort}`,
  `POSTGRES_BIND_PORT=${postgresPort}`,
  `SILO_API_PORT=${siloPort}`,
  "BLOB_S3_ACCESS_KEY_ID=pocsilo",
  "BLOB_S3_SECRET_ACCESS_KEY=pocsilo-secret",
  "BLOB_S3_BUCKET=deepsonar",
  "",
].join("\n"), { mode: 0o600 });

const down = () => run([...composeArgs, "down", "-v", "--remove-orphans"], 180_000);

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
  const siloLive = spawnSync("curl", ["-fsS", `http://127.0.0.1:${siloPort}/minio/health/live`], { encoding: "utf8" });
  if (siloLive.status !== 0) {
    throw new Error(`silo health failed on 127.0.0.1:${siloPort}: ${siloLive.stderr || siloLive.stdout}`);
  }
  const blobStore = run(["-n", "docker", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", `${projectName}-scheduler-1`]);
  if (!/^BLOB_STORE=s3$/m.test(blobStore.stdout) || !blobStore.stdout.includes(`BLOB_S3_ENDPOINT=http://127.0.0.1:${siloPort}`)) {
    throw new Error("scheduler is not using host Silo");
  }
  const listed = run(["-n", "docker", "ps", "--format", "{{.Names}}", "--filter", "name=opensandbox"]);
  const names = listed.stdout.trim().split("\n").filter(Boolean);
  if (!names.includes("deepsonar-opensandbox")) {
    throw new Error("prod-compose lost Phase 2 deepsonar-opensandbox");
  }
  const spawned = names.filter((name) => name.includes(projectName));
  if (spawned.length > 0) {
    throw new Error(`prod-compose started extra OpenSandbox: ${spawned.join(",")}`);
  }
  console.log(
    `OK: OpenSandbox prod-compose scheduler=200 web=200 silo=ready blob=s3 probe=ready leftover_server=1 port=${schedulerPort} webPort=${webPort} siloPort=${siloPort}`,
  );
} finally {
  down();
  rmSync(dir, { recursive: true, force: true });
}
