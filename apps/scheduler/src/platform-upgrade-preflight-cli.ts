/** Target-image offline entry point. No DB/schema initialization or upstream I/O. */
import { PREFLIGHT_RESULT_SCHEMA } from "./platform-upgrade-preflight-contract.js";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
function fail(code: string): void {
  process.stdout.write(JSON.stringify({
    schema: PREFLIGHT_RESULT_SCHEMA, ok: false,
    blocking_errors: [{ code, location: "snapshot", message: "Offline preflight input could not be validated" }],
    coverage: [], not_checked: ["configuration"],
  }) + "\n");
  process.exitCode = 1;
}

try {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) throw new Error("input_limit");
    chunks.push(bytes);
  }
  const snapshot: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  // Bootstrap only from the Compose environment carried in the snapshot. Do not
  // inherit a CI/developer env or allow config.ts to discover a local .env file.
  const env = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>).environment : null;
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((value) => typeof value !== "string")) {
    fail("INVALID_ENVIRONMENT");
  } else {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, env);
    process.env.DEEPSONAR_OFFLINE_PREFLIGHT = "1";
    // Canonical bootstrap parsers may warn about malformed values. Never emit
    // their raw diagnostics because a misconfigured value can itself be secret.
    console.log = console.warn = console.error = () => {};
    // The target container is read-only and has no application .env; production
    // host additionally runs --network=none and supplies no volumes or secrets.
    const { validatePlatformUpgradeConfiguration } = await import("./platform-upgrade-preflight.js");
    const result = await validatePlatformUpgradeConfiguration(snapshot);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.ok ? 0 : 1;
  }
} catch {
  // Never surface parse/validator exception text: it may contain a secret value.
  fail("PREFLIGHT_INPUT_OR_VALIDATOR_ERROR");
}
