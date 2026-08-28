import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSdkOpenSandboxClient,
  listOfficialOpenSandboxRuntimeImages,
  OpenSandboxRunner,
  OPENSANDBOX_SERVER_IMAGE,
  readOpenSandboxPin,
  runOpenSandboxArchPoc,
  runOpenSandboxAssetsPoc,
  runOpenSandboxCancelPoc,
  runOpenSandboxCliLaunchPoc,
  runOpenSandboxRecoveryPoc,
  runOpenSandboxContractFailPoc,
  runOpenSandboxHostPoc,
  runOpenSandboxImageContractPoc,
  runOpenSandboxInfrastructurePoc,
  runOpenSandboxOfficialImagesPoc,
  runOpenSandboxRestrictedPoc,
  shouldRunOpenSandboxPoc,
} from "../packages/runtime-sandbox/src/index.ts";
import { parseAgentSession } from "../apps/web/src/session-viewer/parseAgentSession.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!shouldRunOpenSandboxPoc()) {
  console.log("skip: OpenSandbox live PoC (set OPEN_SANDBOX_POC=1 with a reachable server)");
  process.exit(0);
}

const domain = process.env.OPEN_SANDBOX_DOMAIN?.trim() || "127.0.0.1:8080";
const apiKey = process.env.OPEN_SANDBOX_API_KEY?.trim();
if (!apiKey) {
  console.error("OPEN_SANDBOX_API_KEY is required when OPEN_SANDBOX_POC=1");
  process.exit(1);
}

const pin = readOpenSandboxPin({
  sdk: process.env.OPEN_SANDBOX_SDK_VERSION || undefined,
  serverImage: process.env.OPENSANDBOX_SERVER_IMAGE || undefined,
  execdImage: process.env.OPENSANDBOX_EXECD_IMAGE || undefined,
  egressImage: process.env.OPENSANDBOX_EGRESS_IMAGE || undefined,
});
const client = createSdkOpenSandboxClient({
  domain,
  apiKey,
  protocol: process.env.OPEN_SANDBOX_PROTOCOL === "https" ? "https" : "http",
  useServerProxy: true,
  pin,
});
const caseName = (() => {
  const idx = process.argv.indexOf("--case");
  return idx >= 0 ? (process.argv[idx + 1] ?? "") : "all";
})();
if (caseName !== "all" && caseName !== "arch" && caseName !== "images" && caseName !== "prod-config") {
  throw new Error("OpenSandbox PoC --case must be all, arch, images, or prod-config");
}

async function runArchCase(): Promise<string> {
  const requestedArch = process.env.OPEN_SANDBOX_POC_ARCH?.trim();
  if (requestedArch !== "amd64" && requestedArch !== "arm64") {
    throw new Error("OPEN_SANDBOX_POC_ARCH must be amd64 or arm64");
  }
  const archImage = process.env.OPEN_SANDBOX_POC_ARCH_IMAGE?.trim() || process.env.OPEN_SANDBOX_POC_IMAGE;
  const arch = await runOpenSandboxArchPoc(client, {
    jobId: "00000000-0000-4000-8000-000000000164",
    attemptId: "00000000-0000-4000-8000-000000000264",
    image: archImage,
    arch: requestedArch,
  });
  return `arch=${arch.arch} leftovers=${arch.leftovers}`;
}

if (caseName === "arch") {
  const archSummary = await runArchCase();
  console.log(`OK: OpenSandbox arch PoC ${archSummary}`);
  process.exit(0);
}

function officialImagesFromRegistry(): ReturnType<typeof listOfficialOpenSandboxRuntimeImages> {
  const registry = JSON.parse(readFileSync(join(repoRoot, "deploy/runtime-image-registry.json"), "utf8"));
  const listed = listOfficialOpenSandboxRuntimeImages(registry);
  const filter = (process.env.OPEN_SANDBOX_POC_IMAGE_KEYS ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  return filter.length > 0 ? listed.filter((item) => filter.includes(item.key)) : listed;
}

async function runImagesCase(): Promise<string> {
  const results = await runOpenSandboxOfficialImagesPoc(client, officialImagesFromRegistry());
  return results.map((item) => `${item.key} provisionMs=${item.provisionMs} leftovers=${item.leftovers}`).join(" ");
}

function runProdConfigCase(): string {
  const dir = mkdtempSync(join(tmpdir(), "opensandbox-prod-"));
  const envFile = join(dir, ".env");
  writeFileSync(envFile, [
    "POSTGRES_PASSWORD=poc-opensandbox",
    "BLOB_S3_ACCESS_KEY_ID=poc",
    "BLOB_S3_SECRET_ACCESS_KEY=poc-secret",
    "DEEPSONAR_IMAGE_TAG=0.1.45",
    "OPEN_SANDBOX_API_KEY=poc-opensandbox",
    "",
  ].join("\n"));
  try {
    const rendered = spawnSync("sudo", [
      "-n", "docker", "compose",
      "--project-directory", dir,
      "--env-file", envFile,
      "-f", join(repoRoot, "deploy/docker-compose.prod.yml"),
      "-f", join(repoRoot, "deploy/docker-compose.real.yml"),
      "-f", join(repoRoot, "deploy/docker-compose.opensandbox.prod.yml"),
      "config",
    ], { encoding: "utf8" });
    if (rendered.status !== 0) {
      throw new Error(`OpenSandbox prod compose config failed: ${rendered.stderr || rendered.stdout}`);
    }
    if (!rendered.stdout.includes("SANDBOX_PROVIDER: opensandbox") || !rendered.stdout.includes("AGENT_MODE: real")) {
      throw new Error("OpenSandbox prod compose missing scheduler SANDBOX_PROVIDER or AGENT_MODE=real");
    }
    if (!rendered.stdout.includes(OPENSANDBOX_SERVER_IMAGE)) {
      throw new Error("OpenSandbox prod compose missing pinned server digest");
    }
    if (/network_mode:\s*host|:latest\b/.test(rendered.stdout)) {
      throw new Error("OpenSandbox prod compose resolved host-network or latest");
    }
    return "merged=true provider=opensandbox pinned=true";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (caseName === "images") {
  const imagesSummary = await runImagesCase();
  console.log(`OK: OpenSandbox official images PoC ${imagesSummary}`);
  process.exit(0);
}

if (caseName === "prod-config") {
  const prodSummary = runProdConfigCase();
  console.log(`OK: OpenSandbox production overlay ${prodSummary}`);
  process.exit(0);
}

const result = await runOpenSandboxInfrastructurePoc(client, {
  jobId: "00000000-0000-4000-8000-000000000162",
  attemptId: "00000000-0000-4000-8000-000000000262",
  image: process.env.OPEN_SANDBOX_POC_IMAGE,
});
if (!result.listed || result.stdout !== "poc") {
  throw new Error(`OpenSandbox PoC unexpected result: ${JSON.stringify(result)}`);
}
const contract = await runOpenSandboxContractFailPoc(new OpenSandboxRunner(client), {
  jobId: "00000000-0000-4000-8000-000000000163",
  attemptId: "00000000-0000-4000-8000-000000000263",
  image: process.env.OPEN_SANDBOX_POC_IMAGE,
});
if (!contract.rejected || contract.leftovers !== 0) {
  throw new Error(`OpenSandbox contract PoC unexpected result: ${JSON.stringify(contract)}`);
}
const cancel = await runOpenSandboxCancelPoc(new OpenSandboxRunner(client), {
  image: process.env.OPEN_SANDBOX_POC_IMAGE,
});
if (!cancel.cancelled || cancel.leftovers !== 0) {
  throw new Error(`OpenSandbox cancel PoC unexpected result: ${JSON.stringify(cancel)}`);
}
const requestedArch = process.env.OPEN_SANDBOX_POC_ARCH?.trim();
let archSummary = "skipped";
if (requestedArch === "amd64" || requestedArch === "arm64") {
  archSummary = await runArchCase();
} else if (requestedArch) {
  throw new Error("OPEN_SANDBOX_POC_ARCH must be amd64 or arm64");
}
const runtimeImage = process.env.OPEN_SANDBOX_POC_RUNTIME_IMAGE?.trim();
const skipHost = process.env.OPEN_SANDBOX_POC_SKIP_HOST === "1";
const skipCli = process.env.OPEN_SANDBOX_POC_SKIP_CLI === "1";
let hostSummary = "skipped";
if (runtimeImage && !skipHost) {
  const host = await runOpenSandboxHostPoc(client, { image: runtimeImage, apiKey });
  if (
    !host.fileOk || !host.reservedRejected || !host.symlinkRejected || !host.oversizedRejected
    || !host.pathEscapeRejected || !host.envClean || !host.incrementalOk || !host.ptyOk
    || !host.terminalOk || !host.tabOk || !host.interruptOk || !host.closedOnDestroy
    || !host.networkIsolated || !host.hardLimits || !host.reconnected
  ) {
    throw new Error(`OpenSandbox host PoC unexpected result: ${JSON.stringify(host)}`);
  }
  hostSummary = `sandbox=${host.sandboxId} provisionMs=${host.provisionMs} isolated=${host.networkIsolated} limits=${host.hardLimits} tab=${host.tabOk} interrupt=${host.interruptOk} closed=${host.closedOnDestroy} clis=${JSON.stringify(host.clis)}`;
}
let assetsSummary = "skipped";
if (runtimeImage && !skipHost) {
  const jobId = randomUUID();
  const volumeName = `deepsonar-assets-${jobId}`;
  const created = spawnSync("sudo", [
    "docker", "volume", "create",
    "--label", "deepsonar.shared_assets.managed=true",
    "--label", `deepsonar.shared_assets.job=${jobId}`,
    volumeName,
  ], { encoding: "utf8" });
  if (created.status === 0) {
    try {
      const seeded = spawnSync("sudo", [
        "docker", "run", "--rm", "-v", `${volumeName}:/data`,
        "docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23",
        "sh", "-c", "echo seed > /data/poc-seed.txt",
      ], { encoding: "utf8" });
      if (seeded.status !== 0) throw new Error(seeded.stderr || "seed volume failed");
      const assets = await runOpenSandboxAssetsPoc(client, { image: runtimeImage, volumeName, jobId });
      if (!assets.mounted || !assets.readonly || !assets.seedOk) {
        throw new Error(`OpenSandbox assets PoC unexpected result: ${JSON.stringify(assets)}`);
      }
      assetsSummary = `mounted=${assets.mounted} readonly=${assets.readonly} seedOk=${assets.seedOk}`;
    } finally {
      spawnSync("sudo", ["docker", "volume", "rm", "-f", volumeName], { encoding: "utf8" });
    }
  }
}
let restrictedSummary = "skipped";
if (runtimeImage && !skipHost) {
  const restricted = await runOpenSandboxRestrictedPoc(client, { image: runtimeImage });
  if (!restricted.isolated) {
    throw new Error(`OpenSandbox restricted PoC unexpected result: ${JSON.stringify(restricted)}`);
  }
  restrictedSummary = `isolated=${restricted.isolated}`;
}
let recoverySummary = "skipped";
if (runtimeImage) {
  const recovery = await runOpenSandboxRecoveryPoc(client, { image: runtimeImage, expectedContract: "deepsonar.runtime.contract/v1" });
  if (!recovery.alive || !recovery.reconnected || !recovery.aliveAfterReconnect || !recovery.deadAfterDestroy || recovery.leftovers !== 0) {
    throw new Error(`OpenSandbox recovery PoC unexpected result: ${JSON.stringify(recovery)}`);
  }
  recoverySummary = `alive=${recovery.alive} reconnect=${recovery.reconnected} dead=${recovery.deadAfterDestroy} leftovers=${recovery.leftovers}`;
}
let cliSummary = "skipped";
if (runtimeImage && !skipCli) {
  const launched = await runOpenSandboxCliLaunchPoc(client, { image: runtimeImage });
  const failed = Object.entries(launched).filter(([, item]) => !item.started || item.notFound || !item.stdinClosed || !item.inputWritten || !item.steered);
  if (failed.length > 0) {
    throw new Error(`OpenSandbox CLI launch PoC unexpected result: ${JSON.stringify(launched)}`);
  }
  const viewer: Record<string, {
    sessionId?: string;
    archived: boolean;
    resumed: boolean;
    items: number;
    format?: string;
    lines?: number;
    parsed?: number;
    skipped?: number;
    bytes?: number;
    preview?: string;
  }> = {};
  for (const [id, item] of Object.entries(launched)) {
    const artifact = item.artifacts[0];
    const parsed = artifact ? parseAgentSession(artifact.content, { cli: id }) : undefined;
    viewer[id] = {
      sessionId: item.sessionId,
      archived: item.archived,
      resumed: item.resumed,
      items: parsed?.items.length ?? 0,
      format: parsed?.format,
      lines: parsed?.totals.lines,
      parsed: parsed?.totals.parsed,
      skipped: parsed?.totals.skipped,
      bytes: artifact ? Buffer.byteLength(artifact.content) : 0,
      preview: artifact?.content.replace(/\s+/g, " ").slice(0, 180),
    };
  }
  cliSummary = JSON.stringify({ launch: Object.fromEntries(Object.entries(launched).map(([id, item]) => [id, {
    started: item.started,
    steered: item.steered,
    sessionId: item.sessionId,
    archived: item.archived,
    archiveCount: item.archiveCount,
    archiveError: item.archiveError,
    resumed: item.resumed,
  }])), viewer });
}
const extraImages = (process.env.OPEN_SANDBOX_POC_EXTRA_IMAGES ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const extraSummaries: string[] = [];
for (const image of extraImages) {
  const extra = await runOpenSandboxImageContractPoc(client, { image });
  extraSummaries.push(`${image.slice(-12)} provisionMs=${extra.provisionMs} clis=${JSON.stringify(extra.clis)}`);
}
console.log(`OK: OpenSandbox live PoC ${result.sandboxId} createMs=${result.createMs} contractFailClean=${contract.leftovers} cancelLeftovers=${cancel.leftovers} arch=${archSummary} host=${hostSummary} assets=${assetsSummary} restricted=${restrictedSummary} recovery=${recoverySummary} cli=${cliSummary} extra=${extraSummaries.join(";") || "skipped"}`);
