import {
  PI_EXTENSION_IMAGE_ROOT,
  PI_OBSERVATIONAL_MEMORY_PACKAGE,
  PI_OBSERVATIONAL_MEMORY_VERSION,
  PI_OBSERVATIONAL_MEMORY_WRAPPER_PATH,
} from "@deepsonar/shared-types";

/** Runs inside the selected image before Pi can receive a prompt. */
export const PI_MEMORY_IMAGE_GUARD_SOURCE = `
const fs = require("node:fs");
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
  process.stdout.write("PI_OM_RUNTIME_IMAGE_READY\\n");
} catch {
  process.stderr.write("PI_OM_RUNTIME_IMAGE_CONTENT_INVALID\\n");
  process.exitCode = 78;
}
`;
