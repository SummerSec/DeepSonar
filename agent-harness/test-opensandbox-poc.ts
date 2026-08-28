import {
  createSdkOpenSandboxClient,
  readOpenSandboxPin,
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
console.log(`OK: OpenSandbox live PoC ${result.sandboxId}`);
