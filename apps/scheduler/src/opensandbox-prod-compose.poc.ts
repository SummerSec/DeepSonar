/**
 * Live proof that production compose can run scheduler+web against an
 * already-running OpenSandbox. Does not start a second server and does
 * not stop the Phase 2 `deepsonar-opensandbox` container.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

const deployDir = join(dirname(fileURLToPath(import.meta.url)), "../../../deploy");
const projectName = `os-prod-compose-${process.pid}-${randomUUID().slice(0, 8)}`;
const schedulerPort = process.env.OPEN_SANDBOX_POC_SCHEDULER_PORT?.trim() || "13100";
const webPort = process.env.OPEN_SANDBOX_POC_WEB_PORT?.trim() || "18082";
const postgresPort = process.env.OPEN_SANDBOX_POC_POSTGRES_PORT?.trim() || "15432";
const gatewayNet = `${projectName}-gateway`;
const envFile = join(deployDir, ".env");
const masterKeyFile = join(deployDir, "master.key");
const envExisted = existsSync(envFile);
const masterExisted = existsSync(masterKeyFile);
const envBackup = envExisted ? readFileSync(envFile) : null;
const masterBackup = masterExisted ? readFileSync(masterKeyFile) : null;
const composeArgs = [
  "-n", "docker", "compose",
  "--project-name", projectName,
  "--project-directory", deployDir,
  "--env-file", envFile,
  "-f", join(deployDir, "docker-compose.prod.yml"),
  "-f", join(deployDir, "docker-compose.real.yml"),
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
  "BLOB_S3_ACCESS_KEY_ID=poc",
  "BLOB_S3_SECRET_ACCESS_KEY=poc-secret",
  "DEEPSONAR_IMAGE_TAG=0.1.45",
  "DEEPSONAR_VERSION=0.1.45-os-compose",
  "DEEPSONAR_MASTER_KEY_FILE=/run/secrets/deepsonar_master_key",
  "DEEPSONAR_ADMIN_TOKEN=poc-admin-token",
  "DEEPSONAR_AUTH_REQUIRED=true",
  `OPEN_SANDBOX_API_KEY=${apiKey}`,
  "OPEN_SANDBOX_DOMAIN=host.docker.internal:8080",
  "OPEN_SANDBOX_PROTOCOL=http",
  `SCHEDULER_HOST_PORT=${schedulerPort}`,
  `DEEPSONAR_WEB_PORT=${webPort}`,
  `POSTGRES_BIND=127.0.0.1:${postgresPort}`,
  "SILO_API_BIND=127.0.0.1:19000",
  "SILO_CONSOLE_BIND=127.0.0.1:19001",
  `OPEN_SANDBOX_POC_GATEWAY_NET=${gatewayNet}`,
  "",
].join("\n"), { mode: 0o600 });

const down = () => run([...composeArgs, "down", "-v", "--remove-orphans"], 180_000);

try {
  const build = run([
    ...composeArgs,
    "up", "-d", "--build",
    "postgres", "silo", "silo-init", "scheduler", "web",
  ], 1_200_000);
  if (build.status !== 0) {
    throw new Error(`prod-compose up failed: ${build.stderr || build.stdout}`);
  }

  const deadline = Date.now() + 240_000;
  let schedulerHealth: { opensandbox?: { level?: string; ready?: boolean; domain?: string }; ok?: boolean } | null = null;
  let webHealth: { opensandbox?: { level?: string; ready?: boolean } } | null = null;
  while (Date.now() < deadline) {
    const schedulerProbe = spawnSync("curl", ["-fsS", `http://127.0.0.1:${schedulerPort}/health`], { encoding: "utf8" });
    const webProbe = spawnSync("curl", ["-fsS", `http://127.0.0.1:${webPort}/api/health`], { encoding: "utf8" });
    if (schedulerProbe.status === 0 && webProbe.status === 0) {
      schedulerHealth = JSON.parse(schedulerProbe.stdout) as typeof schedulerHealth;
      webHealth = JSON.parse(webProbe.stdout) as typeof webHealth;
      if (schedulerHealth?.opensandbox?.level === "ok" && webHealth?.opensandbox?.level === "ok") break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (schedulerHealth?.opensandbox?.level !== "ok" || webHealth?.opensandbox?.level !== "ok") {
    throw new Error(`prod-compose health not ready: scheduler=${JSON.stringify(schedulerHealth)} web=${JSON.stringify(webHealth)}`);
  }
  if (schedulerHealth.opensandbox?.domain && !schedulerHealth.opensandbox.domain.includes("8080")) {
    throw new Error(`unexpected OpenSandbox domain ${schedulerHealth.opensandbox.domain}`);
  }
  const leaked = JSON.stringify({ schedulerHealth, webHealth }).includes(apiKey);
  if (leaked) throw new Error("OpenSandbox API key leaked into compose health");
  if (!existingOpenSandboxRunning()) {
    throw new Error("prod-compose stopped Phase 2 deepsonar-opensandbox");
  }
  const second = run(["-n", "docker", "ps", "-q", "--filter", "name=opensandbox"]);
  const opensandboxCount = second.stdout.trim().split("\n").filter(Boolean).length;
  if (opensandboxCount !== 1) {
    throw new Error(`expected exactly one OpenSandbox container, got ${opensandboxCount}`);
  }
  console.log(
    `OK: OpenSandbox prod-compose scheduler=200 web=200 probe=ready leftover_server=1 port=${schedulerPort} webPort=${webPort}`,
  );
} finally {
  down();
  if (envBackup) writeFileSync(envFile, envBackup, { mode: 0o600 });
  else if (!envExisted && existsSync(envFile)) unlinkSync(envFile);
  if (masterBackup) writeFileSync(masterKeyFile, masterBackup, { mode: 0o600 });
  else if (!masterExisted && existsSync(masterKeyFile)) unlinkSync(masterKeyFile);
}
