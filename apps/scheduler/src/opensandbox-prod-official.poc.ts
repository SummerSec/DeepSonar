/**
 * Live proof that official production compose files can bring up
 * scheduler+web+silo+OpenSandbox on Docker bridge. This VM's
 * iptables-legacy FORWARD policy is DROP; the smoke sets ACCEPT first.
 * Does not stop the Phase 2 `deepsonar-opensandbox` container.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSdkOpenSandboxClient,
  OPENSANDBOX_POC_CLI_IDS,
  readOpenSandboxPin,
  runOpenSandboxImageContractPoc,
  runOpenSandboxInfrastructurePoc,
  shouldRunOpenSandboxPoc,
} from "@deepsonar/runtime-sandbox";

if (!shouldRunOpenSandboxPoc()) {
  console.log("skip: OpenSandbox official prod PoC (set OPEN_SANDBOX_POC=1)");
  process.exit(0);
}

const apiKey = process.env.OPEN_SANDBOX_API_KEY?.trim();
if (!apiKey) {
  console.error("OPEN_SANDBOX_API_KEY is required");
  process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const deployDir = join(repoRoot, "deploy");
const dir = mkdtempSync(join(tmpdir(), "opensandbox-prod-official-"));
const projectName = `os-prod-official-${process.pid}-${randomUUID().slice(0, 8)}`;
const webPort = process.env.OPEN_SANDBOX_POC_WEB_PORT?.trim() || "18083";
const postgresBind = process.env.OPEN_SANDBOX_POC_POSTGRES_BIND?.trim() || "127.0.0.1:15433";
const siloBind = process.env.OPEN_SANDBOX_POC_SILO_BIND?.trim() || "127.0.0.1:19010";
const osHostPort = process.env.OPEN_SANDBOX_POC_PROD_HOST_PORT?.trim() || "18080";
const osContainer = `deepsonar-opensandbox-official-${process.pid}`;
const envFile = join(dir, ".env");
const masterKeyFile = join(dir, "master.key");
const isolateFile = join(deployDir, "docker-compose.opensandbox.prod-isolated.yml");
const composeArgs = [
  "-n", "docker", "compose",
  "--project-name", projectName,
  "--project-directory", dir,
  "--env-file", envFile,
  "-f", join(deployDir, "docker-compose.prod.yml"),
  "-f", join(deployDir, "docker-compose.real.yml"),
  "-f", join(deployDir, "docker-compose.opensandbox.prod.yml"),
  "-f", isolateFile,
];

function run(args: string[], timeout = 180_000) {
  return spawnSync("sudo", args, { encoding: "utf8", timeout });
}

function existingOpenSandboxRunning(): boolean {
  const inspected = run(["-n", "docker", "inspect", "-f", "{{.State.Running}}", "deepsonar-opensandbox"]);
  return inspected.status === 0 && inspected.stdout.trim() === "true";
}

if (!existingOpenSandboxRunning()) {
  throw new Error("Phase 2 deepsonar-opensandbox must stay running for official prod");
}

const forward = run(["-n", "iptables-legacy", "-P", "FORWARD", "ACCEPT"]);
if (forward.status !== 0) {
  throw new Error(`could not set iptables-legacy FORWARD ACCEPT: ${forward.stderr || forward.stdout}`);
}

mkdirSync(join(dir, "opensandbox"), { recursive: true });
writeFileSync(join(dir, "opensandbox/config.toml"), readFileSync(join(deployDir, "opensandbox/config.toml")));
writeFileSync(masterKeyFile, `${"00".repeat(32)}\n`, { mode: 0o600 });
writeFileSync(envFile, [
  "POSTGRES_PASSWORD=poc-opensandbox-official",
  "DEEPSONAR_IMAGE_TAG=0.1.46",
  "DEEPSONAR_VERSION=0.1.46-os-official",
  `OPEN_SANDBOX_API_KEY=${apiKey}`,
  "OPEN_SANDBOX_DOMAIN=opensandbox:8080",
  `OPEN_SANDBOX_HOST_PORT=${osHostPort}`,
  `OPEN_SANDBOX_CONTAINER_NAME=${osContainer}`,
  `DEEPSONAR_WEB_PORT=${webPort}`,
  `POSTGRES_BIND=${postgresBind}`,
  `SILO_API_BIND=${siloBind}`,
  "SILO_CONSOLE_BIND=127.0.0.1:19011",
  "BLOB_S3_ACCESS_KEY_ID=pocsilo",
  "BLOB_S3_SECRET_ACCESS_KEY=pocsilo-secret",
  "BLOB_S3_BUCKET=deepsonar",
  `OPEN_SANDBOX_POC_GATEWAY_NET=${projectName}-gateway`,
  `OPEN_SANDBOX_POC_ADMISSION_VOL=${projectName}-admission`,
  "",
].join("\n"), { mode: 0o600 });

const down = () => run([...composeArgs, "down", "-v", "--remove-orphans"], 180_000);

try {
  const up = run([...composeArgs, "up", "-d", "opensandbox", "scheduler", "web"], 1_200_000);
  if (up.status !== 0) {
    const logs = run([...composeArgs, "logs", "--tail=80"], 30_000);
    throw new Error(`official prod up failed: ${up.stderr || up.stdout}\n${logs.stdout}\n${logs.stderr}`);
  }
  const attached = run(["-n", "docker", "network", "connect", "bridge", osContainer]);
  const attachedText = `${attached.stderr}\n${attached.stdout}`;
  if (attached.status !== 0 && !/already exists in network|already connected/i.test(attachedText)) {
    throw new Error(`official overlay could not join default bridge: ${attachedText}`);
  }

  type HealthProbe = { ok?: boolean; opensandbox?: { level?: string; ready?: boolean; domain?: string } };
  const deadline = Date.now() + 240_000;
  let webHealth: HealthProbe | null = null;
  while (Date.now() < deadline) {
    const webProbe = spawnSync("curl", ["-fsS", `http://127.0.0.1:${webPort}/api/health`], { encoding: "utf8" });
    if (webProbe.status === 0) {
      webHealth = JSON.parse(webProbe.stdout) as HealthProbe;
      if (webHealth.opensandbox?.level === "ok") break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (webHealth?.opensandbox?.level !== "ok") {
    const logs = run([...composeArgs, "logs", "--tail=80", "scheduler", "web", "silo", "opensandbox"], 30_000);
    throw new Error(`official prod health not ready: web=${JSON.stringify(webHealth)}\n${logs.stdout}`);
  }
  const siloPort = siloBind.split(":").pop() ?? "19010";
  const siloLive = spawnSync("curl", ["-fsS", `http://127.0.0.1:${siloPort}/minio/health/live`], { encoding: "utf8" });
  if (siloLive.status !== 0) {
    throw new Error(`official prod silo health failed on ${siloBind}`);
  }
  const overlay = spawnSync("curl", ["-fsS", `http://127.0.0.1:${osHostPort}/health`], { encoding: "utf8" });
  if (overlay.status !== 0 || !overlay.stdout.includes("healthy")) {
    throw new Error(`official overlay OpenSandbox not healthy on :${osHostPort}`);
  }
  if (!existingOpenSandboxRunning()) {
    throw new Error("official prod stopped Phase 2 deepsonar-opensandbox");
  }
  const listed = run(["-n", "docker", "ps", "-q", "--filter", "name=opensandbox"]);
  const opensandboxCount = listed.stdout.trim().split("\n").filter(Boolean).length;
  if (opensandboxCount < 2) {
    throw new Error(`expected Phase 2 plus overlay OpenSandbox, got ${opensandboxCount}`);
  }
  const overlayClient = createSdkOpenSandboxClient({
    domain: `127.0.0.1:${osHostPort}`,
    apiKey,
    protocol: "http",
    useServerProxy: true,
    pin: readOpenSandboxPin({}),
  });
  const jobId = randomUUID();
  const attemptId = randomUUID();
  const created = await runOpenSandboxInfrastructurePoc(overlayClient, { jobId, attemptId });
  if (!created.listed || created.stdout !== "poc") {
    throw new Error(`official overlay provision unexpected: ${JSON.stringify(created)}`);
  }
  const leftovers = await overlayClient.list({ jobId, attemptId });
  if (leftovers.length > 0) {
    throw new Error(`official overlay leftover: ${leftovers.map((item) => item.resourceId).join(",")}`);
  }
  const runtimeImage = process.env.OPEN_SANDBOX_POC_RUNTIME_IMAGE?.trim();
  let official: { provisionMs: number; clis: Partial<Record<(typeof OPENSANDBOX_POC_CLI_IDS)[number], boolean>> } | null = null;
  if (runtimeImage) {
    official = await runOpenSandboxImageContractPoc(overlayClient, { image: runtimeImage });
    const missing = OPENSANDBOX_POC_CLI_IDS.filter((id) => official.clis[id] !== true);
    if (missing.length > 0) {
      throw new Error(`official overlay runtime CLI missing: ${missing.join(",")}`);
    }
  }
  if (!existingOpenSandboxRunning()) {
    throw new Error("official overlay provision stopped Phase 2 deepsonar-opensandbox");
  }
  console.log(
    `OK: OpenSandbox official prod web=200 silo=ready overlay=healthy leftover_server=1 bridge=true provision=true leftover=0 createMs=${created.createMs}${
      official ? ` official=true officialMs=${official.provisionMs} clis=${OPENSANDBOX_POC_CLI_IDS.join(",")}` : ""
    } port=${webPort} osPort=${osHostPort}`,
  );
} finally {
  down();
  rmSync(dir, { recursive: true, force: true });
}
