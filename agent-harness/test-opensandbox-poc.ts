import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createSdkOpenSandboxClient,
  OpenSandboxRunner,
  readOpenSandboxPin,
  runOpenSandboxAssetsPoc,
  runOpenSandboxCancelPoc,
  runOpenSandboxContractFailPoc,
  runOpenSandboxHostPoc,
  runOpenSandboxInfrastructurePoc,
  shouldRunOpenSandboxPoc,
} from "../packages/runtime-sandbox/src/index.ts";

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
const runtimeImage = process.env.OPEN_SANDBOX_POC_RUNTIME_IMAGE?.trim();
let hostSummary = "skipped";
if (runtimeImage) {
  const host = await runOpenSandboxHostPoc(client, { image: runtimeImage, apiKey });
  if (
    !host.fileOk || !host.reservedRejected || !host.symlinkRejected || !host.oversizedRejected
    || !host.pathEscapeRejected || !host.envClean || !host.incrementalOk || !host.ptyOk
    || !host.terminalOk || !host.networkIsolated || !host.hardLimits || !host.reconnected
  ) {
    throw new Error(`OpenSandbox host PoC unexpected result: ${JSON.stringify(host)}`);
  }
  hostSummary = `sandbox=${host.sandboxId} provisionMs=${host.provisionMs} isolated=${host.networkIsolated} limits=${host.hardLimits} clis=${JSON.stringify(host.clis)}`;
}
let assetsSummary = "skipped";
if (runtimeImage) {
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
console.log(`OK: OpenSandbox live PoC ${result.sandboxId} createMs=${result.createMs} contractFailClean=${contract.leftovers} cancelLeftovers=${cancel.leftovers} host=${hostSummary} assets=${assetsSummary}`);
