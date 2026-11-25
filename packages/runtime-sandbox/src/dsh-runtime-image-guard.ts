import { createHash } from "node:crypto";
import { DSH_REQUEST_BUDGET_PLUGIN, DSH_REQUEST_BUDGET_SOURCE, DSH_REQUEST_BUDGET_VENDOR_SHA256 } from "./dsh-request-budget.js";
import { DSH_PRIVATE_CREDENTIALS_SOURCE } from "./private-credential-reader.js";

// Scheduler-owned pin for the installer output at the canonical image path.
// The real-install regression must match this pin when the installer changes.
export const DSH_REQUEST_BUDGET_ARTIFACT_SHA256 = "7d3586ba3428c444f9524d8456fce3e6ba681d4dd55f9939cd453f01f3e61fed";

/** Check the installed contract before Cordis can swallow a plugin-load error. */
export const DSH_REQUEST_BUDGET_IMAGE_GUARD_SOURCE = `
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const hash = value => createHash("sha256").update(value).digest("hex");
try {
  const root = ${JSON.stringify(DSH_REQUEST_BUDGET_PLUGIN.slice(0, -"/lib/deepsonar-index.js".length))};
  const pkg = JSON.parse(fs.readFileSync(root + "/package.json", "utf8"));
  const manifest = JSON.parse(fs.readFileSync(root + "/lib/deepsonar-request-budget.manifest.json", "utf8"));
  if (pkg.name !== "@deepseek-ai/dsh-llm-pi-ai" || pkg.version !== "0.2.2-rc.1"
    || manifest.version !== 1 || manifest.vendorVersion !== pkg.version
    || manifest.sdkVersion !== "1.5.2"
    || manifest.vendorSha256 !== ${JSON.stringify(DSH_REQUEST_BUDGET_VENDOR_SHA256)}
    || manifest.artifactSha256 !== ${JSON.stringify(DSH_REQUEST_BUDGET_ARTIFACT_SHA256)}
    || manifest.helperSha256 !== ${JSON.stringify(createHash("sha256").update(DSH_REQUEST_BUDGET_SOURCE).digest("hex"))}) {
    throw new Error("request budget contract mismatch");
  }
  for (const [file, expected] of [["index.js", manifest.vendorSha256],
    ["deepsonar-index.js", manifest.artifactSha256], ["deepsonar-request-budget.mjs", manifest.helperSha256]]) {
    if (hash(fs.readFileSync(root + "/lib/" + file)) !== expected) throw new Error("request budget artifact mismatch");
  }
  const sdk = JSON.parse(fs.readFileSync("/opt/deepsonar/dsh/node_modules/@earendil-works/pi-ai/package.json", "utf8"));
  if (sdk.name !== "@earendil-works/pi-ai" || sdk.version !== manifest.sdkVersion) throw new Error("SDK mismatch");
  if (hash(fs.readFileSync("/opt/deepsonar/dsh/node_modules/@deepseek-ai/dsh-credentials/deepsonar-job-credentials.mjs"))
    !== ${JSON.stringify(createHash("sha256").update(DSH_PRIVATE_CREDENTIALS_SOURCE).digest("hex"))}) throw new Error("credential plugin mismatch");
  process.stdout.write("DSH_REQUEST_BUDGET_IMAGE_READY\\n");
} catch {
  process.stderr.write("DSH_REQUEST_BUDGET_IMAGE_CONTENT_INVALID\\n");
  process.exitCode = 78;
}
`;
