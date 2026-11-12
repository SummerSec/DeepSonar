import {
  PI_EXTENSION_IMAGE_ROOT,
  PI_OBSERVATIONAL_MEMORY_PACKAGE,
  PI_OBSERVATIONAL_MEMORY_VERSION,
  PI_OBSERVATIONAL_MEMORY_WRAPPER_PATH,
} from "@deepsonar/shared-types";

// Binds the image-owned wrapper to the allowance/request-id/settlement contract.
// Kept in sync with agent-harness/pi-observational-memory-governed.ts by regression.
export const PI_MEMORY_GOVERNED_WRAPPER_SHA256 = "097adfc983bc08def0e1ebc6c8140ef6d0516e0716bb7936f5ce1aa1e0c0aab3";
// OM imports this image-owned SDK context policy; bind its bytes as well as the wrapper.
export const PI_MEMORY_CONTEXT_POLICY_SHA256 = "ba29e376234a5271972accdcd5ebaba5c49d0ed1a85b2ec648a86a71e7d95220";

/** Runs inside the selected image before Pi can receive a prompt. */
export const PI_MEMORY_IMAGE_GUARD_SOURCE = `
const fs = require("node:fs");
const { createHash } = require("node:crypto");
try {
  const root = ${JSON.stringify(`${PI_EXTENSION_IMAGE_ROOT}/${PI_OBSERVATIONAL_MEMORY_PACKAGE}`)};
  const pkg = JSON.parse(fs.readFileSync(root + "/package.json", "utf8"));
  if (pkg.name !== ${JSON.stringify(PI_OBSERVATIONAL_MEMORY_PACKAGE)}
    || pkg.version !== ${JSON.stringify(PI_OBSERVATIONAL_MEMORY_VERSION)}
    || pkg.license !== "MIT"
    || !Array.isArray(pkg.pi?.extensions) || !pkg.pi.extensions.includes("./src/index.ts")) {
    throw new Error("package identity mismatch");
  }
  for (const file of [root + "/src/index.ts", ${JSON.stringify(PI_OBSERVATIONAL_MEMORY_WRAPPER_PATH)}]) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) throw new Error("runtime file missing");
  }
  const wrapper = fs.readFileSync(${JSON.stringify(PI_OBSERVATIONAL_MEMORY_WRAPPER_PATH)});
  if (createHash("sha256").update(wrapper).digest("hex") !== ${JSON.stringify(PI_MEMORY_GOVERNED_WRAPPER_SHA256)}) {
    throw new Error("governed wrapper contract mismatch");
  }
  const contextPolicy = fs.readFileSync("/opt/deepsonar/request-budget-source/pi-main-request-budget.ts");
  if (createHash("sha256").update(contextPolicy).digest("hex") !== ${JSON.stringify(PI_MEMORY_CONTEXT_POLICY_SHA256)}) {
    throw new Error("model context policy mismatch");
  }
  process.stdout.write("PI_OM_RUNTIME_IMAGE_READY\\n");
} catch {
  process.stderr.write("PI_OM_RUNTIME_IMAGE_CONTENT_INVALID\\n");
  process.exitCode = 78;
}
`;
