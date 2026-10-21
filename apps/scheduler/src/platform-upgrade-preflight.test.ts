import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION } from "./schema-version.js";
import { PREFLIGHT_SCHEMA, type PreflightSnapshot } from "./platform-upgrade-preflight-contract.js";
import { validatePlatformUpgradeSnapshot } from "./platform-upgrade-preflight.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const roleId = "22222222-2222-4222-8222-222222222222";
const configId = "33333333-3333-4333-8333-333333333333";
function fixture(): PreflightSnapshot {
  return {
    schema: PREFLIGHT_SCHEMA, database_schema_version: SCHEMA_VERSION, target_schema_version: SCHEMA_VERSION,
    environment: { AGENT_MODE: "fake" },
    global_settings: [{ id: "global", rules_json: {}, runtime_registry_channel: "github" }],
    projects: [{ id: projectId, config_json: { skill_source_allowlist_configured: true } }],
    agent_roles: [{ id: roleId, name: "audit", kind: "role", project_id: null }],
    role_configs: [{ id: configId, role_id: roleId, project_id: null, agent_cli: "claude-code" }],
    role_config_files: [], runtime_images: [], runtime_image_versions: [], credentials: [],
  };
}
function codes(snapshot: PreflightSnapshot): string[] {
  return validatePlatformUpgradeSnapshot(snapshot).blocking_errors.map((error) => error.code);
}

test("current project marker and canonical role defaults pass without a database", () => {
  assert.deepEqual(codes(fixture()), []);
});
test("target and database schemas are independently checked against target code", () => {
  const snapshot = fixture(); snapshot.database_schema_version = SCHEMA_VERSION - 1;
  snapshot.target_schema_version = SCHEMA_VERSION + 1;
  assert.deepEqual(codes(snapshot), ["DATABASE_SCHEMA_MISMATCH", "TARGET_SCHEMA_MISMATCH"]);
});
test("unknown and removed structured fields are never stripped into a successful preflight", () => {
  for (const value of [{ enabled_agent_clis: ["codex"] }, { role_runtime_images: {} }, { unexpected: true }, { roles: { enabled: ["audit"] } }]) {
    const snapshot = fixture(); snapshot.projects[0].config_json = value;
    assert.ok(codes(snapshot).includes("INVALID_PROJECT_CONFIG"));
  }
  const snapshot = fixture(); snapshot.role_configs[0].pi_extensions = [];
  assert.ok(codes(snapshot).includes("UNKNOWN_OR_REMOVED_FIELD"));
});
test("canonical role validators reject protected env, malformed module selectors, knobs and config-file secrets", () => {
  for (const fields of [
    { env_vars_json: { HOME: "/tmp" } }, { modules_json: ["not-a-selector"] },
    { runtime_knobs_json: { stall_sec: 3 } }, { sandbox_limits_json: { privileged: true } },
    { context_window_tokens: 4 },
  ]) {
    const snapshot = fixture(); Object.assign(snapshot.role_configs[0], fields);
    assert.ok(codes(snapshot).includes("INVALID_ROLE_CONFIG_VALUES"));
  }
  const snapshot = fixture();
  snapshot.role_config_files = [{ role_config_id: configId, path: ".claude/settings.json", content: '{"key":"sk-123456789012345678901234"}' }];
  assert.ok(codes(snapshot).includes("INVALID_ROLE_CONFIG_VALUES"));
});
test("project sandbox resources cannot raise the platform ceiling", () => {
  const snapshot = fixture(); Object.assign(snapshot.role_configs[0], { project_id: projectId, sandbox_limits_json: { cpu: 64 } });
  assert.ok(codes(snapshot).includes("INVALID_ROLE_CONFIG_VALUES"));
});
test("canonical global rules reject invalid concurrency and removed aliases", () => {
  const snapshot = fixture(); snapshot.global_settings[0].rules_json = { maxGlobalJobs: 0, autoVerifySeverities: ["critical"] };
  assert.ok(codes(snapshot).includes("INVALID_GLOBAL_RULES"));
  assert.ok(codes(snapshot).includes("UNKNOWN_OR_REMOVED_RULE"));
});
test("missing role and project references block instead of dropping configuration", () => {
  const snapshot = fixture(); snapshot.role_configs[0].role_id = "missing";
  assert.ok(codes(snapshot).includes("ROLE_NOT_FOUND"));
  snapshot.role_config_files = [{ role_config_id: "missing", path: "x", content: "" }];
  assert.ok(codes(snapshot).includes("ROLE_CONFIG_NOT_FOUND"));
});
test("credential CLI and provider settings use current validators without decrypting secrets", () => {
  const snapshot = fixture(); snapshot.credentials = [{ id: "credential", kind: "llm_provider", provider: "openai", project_id: null, status: "active", agent_cli: "claude-code", public_metadata_json: {}, settings_config_json: {}, meta_json: {} }];
  assert.ok(codes(snapshot).includes("CREDENTIAL_CLI_INCOMPATIBLE"));
  snapshot.credentials[0].agent_cli = "pi";
  snapshot.credentials[0].settings_config_json = { reasoning: "not-supported" };
  assert.ok(codes(snapshot).includes("INVALID_PROVIDER_SETTINGS"));
});
test("input values and attacker-controlled keys never appear in errors", () => {
  const snapshot = fixture(); const secret = "secret-marker-that-must-not-leak";
  snapshot.role_configs[0].env_vars_json = { [secret]: secret };
  snapshot.projects[0].config_json = { [secret]: secret };
  assert.equal(JSON.stringify(validatePlatformUpgradeSnapshot(snapshot)).includes(secret), false);
});

const cli = fileURLToPath(new URL("./platform-upgrade-preflight-cli.ts", import.meta.url));
const scheduler = fileURLToPath(new URL("..", import.meta.url));
function runCli(input: string, cwd = scheduler) {
  // Resolve tsx from the Scheduler workspace, even when testing .env isolation.
  const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
  return spawnSync(process.execPath, ["--import", loader, cli], { cwd, input, encoding: "utf8", timeout: 30_000 });
}
test("CLI is JSON-only, nonzero on invalid config, and suppresses raw bootstrap warnings", () => {
  const snapshot = fixture(); snapshot.environment.DEEPSONAR_HUB_MAX_ROUNDS = "secret-invalid-number";
  const run = runCli(JSON.stringify(snapshot));
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stderr, "");
  assert.equal(run.stdout.includes("secret-invalid-number"), false);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, false);
  assert.ok(result.blocking_errors.some((error: { code: string }) => error.code === "INVALID_BOOTSTRAP_VALUE"));
});
test("CLI ignores .env and inherited secrets; malformed JSON returns sanitized blocking JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-preflight-"));
  try {
    writeFileSync(join(dir, ".env"), "AGENT_MODE=unsupported\nDEEPSONAR_HUB_MAX_ROUNDS=secret\n");
    const good = runCli(JSON.stringify(fixture()), dir);
    assert.equal(good.status, 0, good.stderr + good.stdout);
    assert.equal(JSON.parse(good.stdout).ok, true);
    assert.equal(readFileSync(join(dir, ".env"), "utf8").includes("AGENT_MODE=unsupported"), true);
    const bad = runCli('{"secret":"never-echo-this"');
    assert.equal(bad.status, 1);
    assert.equal(bad.stderr, "");
    assert.equal(bad.stdout.includes("never-echo-this"), false);
    assert.equal(JSON.parse(bad.stdout).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("offline validator leaves the entire input snapshot unchanged", () => {
  const snapshot = fixture();
  snapshot.credentials = [{ id: "credential", kind: "llm_provider", provider: "anthropic", project_id: null, status: "active", agent_cli: "claude-code", public_metadata_json: {}, settings_config_json: { env: { ANTHROPIC_MODEL: "example-model" } }, meta_json: {} }];
  const before = structuredClone(snapshot);
  validatePlatformUpgradeSnapshot(snapshot);
  assert.deepEqual(snapshot, before);
});
test("offline local dependency graph never imports DB, routes, core or schema initialization", () => {
  const seen = new Set<string>();
  function visit(file: URL) {
    if (seen.has(file.href)) return;
    seen.add(file.href);
    assert.doesNotMatch(file.pathname, /\/(?:db|core|schema-rebuild|schema-rebuild-cli)\.ts$|\/routes\.ts$/);
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\binitSchema\s*\(/);
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+\.js)["']/g)) {
      visit(new URL(match[1].replace(/\.js$/, ".ts"), file));
    }
  }
  visit(new URL("./platform-upgrade-preflight.ts", import.meta.url));
});
