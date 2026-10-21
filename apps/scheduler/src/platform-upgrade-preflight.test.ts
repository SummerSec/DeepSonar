import { validateNativeProviderStructure } from "./platform-upgrade-preflight-environment.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {createCipheriv} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION } from "./schema-version.js";
import { PREFLIGHT_SCHEMA, type PreflightSnapshot } from "./platform-upgrade-preflight-contract.js";
import { validatePlatformUpgradeSnapshot, validatePlatformUpgradeConfiguration } from "./platform-upgrade-preflight.js";

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
function encryptedFixture(plaintext = "private-credential", key = Buffer.from("a".repeat(64), "hex")) {
  const nonce = Buffer.alloc(12, 3), cipher = createCipheriv("aes-256-gcm", key, nonce);
  return {ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64"), nonce: nonce.toString("base64"), auth_tag: cipher.getAuthTag().toString("base64")};
}

test("offline defaults use the complete credential-first resolver and never mutate stored inputs", async () => {
  const snapshot = fixture(), id = "44444444-4444-4444-8444-444444444444";
  snapshot.environment.DEEPSONAR_MASTER_KEY = "a".repeat(64);
  snapshot.credentials = [{id, kind: "llm_provider", provider: "anthropic", project_id: null, status: "active", agent_cli: "claude-code", public_metadata_json: {}, meta_json: {}, settings_config_json: {env: {ANTHROPIC_MODEL: "model"}}, ...encryptedFixture()}];
  snapshot.projects[0].config_json = {enabled_agent_clis: ["pi"], default_credential_id: id, default_model_ref: "model"};
  assert.ok((await validatePlatformUpgradeConfiguration(snapshot)).blocking_errors.some(error => error.code === "PROVIDER_CREDENTIAL_CLI_MISMATCH"));
  const cliMismatch = runCli(JSON.stringify(snapshot));
  assert.equal(cliMismatch.status, 1);
  assert.ok(JSON.parse(cliMismatch.stdout).blocking_errors.some((error: {code: string}) => error.code === "PROVIDER_CREDENTIAL_CLI_MISMATCH"));
  snapshot.projects[0].config_json = {default_agent_cli: "pi", default_credential_id: id, default_model_ref: "model"};
  const before = JSON.stringify(snapshot);
  assert.equal((await validatePlatformUpgradeConfiguration(snapshot)).ok, true); // preference is not a hard CLI restriction
  assert.equal(JSON.stringify(snapshot), before);
  snapshot.credentials[0].status = "disabled";
  assert.equal((await validatePlatformUpgradeConfiguration(snapshot)).ok, false);
  snapshot.credentials[0].status = "active";
  snapshot.projects[0].config_json = {default_credential_id: id, default_model_ref: "missing-model"};
  assert.ok((await validatePlatformUpgradeConfiguration(snapshot)).blocking_errors.some(error => error.code === "PROVIDER_CREDENTIAL_NO_MATCH"));
  assert.ok((await validatePlatformUpgradeConfiguration(snapshot)).not_checked.includes("historical_job_snapshots"));
});

test("projects without an account or model default retain future Job selection, and default resolution stays scoped", async () => {
  const snapshot = fixture(); snapshot.environment.DEEPSONAR_MASTER_KEY = "a".repeat(64);
  const credential = (id: string, extra = {}) => ({id, kind: "llm_provider", provider: "anthropic", project_id: null, status: "active", agent_cli: "claude-code", public_metadata_json: {}, meta_json: {}, settings_config_json: {env: {ANTHROPIC_MODEL: "model"}}, ...encryptedFixture(), ...extra});
  const first = "44444444-4444-4444-8444-444444444444", second = "55555555-5555-4555-8555-555555555555";
  assert.equal((await validatePlatformUpgradeConfiguration(snapshot)).ok, true);
  snapshot.credentials = [credential(first), credential(second)];
  snapshot.projects[0].config_json = {enabled_credential_ids: [first, second], default_agent_cli: "claude-code"};
  assert.equal((await validatePlatformUpgradeConfiguration(snapshot)).ok, true);
  snapshot.projects[0].config_json = {};
  snapshot.role_configs[0].model = "model";
  assert.ok((await validatePlatformUpgradeConfiguration(snapshot)).blocking_errors.some(error => error.code === "PROVIDER_CREDENTIAL_MULTI_MATCH"));
  snapshot.credentials[1].status = "disabled";
  assert.equal((await validatePlatformUpgradeConfiguration(snapshot)).ok, true);
  snapshot.credentials[1].status = "active";
  const otherProject = "66666666-6666-4666-8666-666666666666";
  snapshot.projects.push({id: otherProject, config_json: {}});
  snapshot.credentials[1].project_id = otherProject;
  // The other project has both accounts, so assert the first project has no ambiguity.
  let result = await validatePlatformUpgradeConfiguration(snapshot);
  assert.equal(result.blocking_errors.some(error => error.location === "projects[0].config_json"), false);
  snapshot.credentials[0].status = "disabled";
  result = await validatePlatformUpgradeConfiguration(snapshot);
  assert.ok(result.blocking_errors.some(error => error.location === "projects[0].config_json" && error.code === "PROVIDER_CREDENTIAL_NO_MATCH"));
});

test("offline GCM authenticates stored credentials without reporting key, plaintext or ciphertext", async () => {
  const snapshot = fixture(); snapshot.environment.DEEPSONAR_MASTER_KEY = "a".repeat(64);
  snapshot.credentials = [{id: "44444444-4444-4444-8444-444444444444", kind: "llm_provider", provider: "anthropic", project_id: null, status: "disabled", agent_cli: "claude-code", public_metadata_json: {}, meta_json: {}, settings_config_json: {}, ...encryptedFixture()}];
  assert.equal((await validatePlatformUpgradeConfiguration(snapshot)).ok, true);
  for (const change of [{auth_tag: Buffer.alloc(16).toString("base64")}, {nonce: ""}, {ciphertext: "broken-private-value"}]) {
    const bad = structuredClone(snapshot); Object.assign(bad.credentials[0], change);
    const result = await validatePlatformUpgradeConfiguration(bad);
    assert.ok(result.blocking_errors.some(error => error.code === "CREDENTIAL_DECRYPTION_FAILED"));
    const output = JSON.stringify(result);
    for (const value of ["private-credential", "broken-private-value", snapshot.environment.DEEPSONAR_MASTER_KEY, String(snapshot.credentials[0].ciphertext)]) assert.equal(output.includes(value), false);
  }
  snapshot.environment.DEEPSONAR_MASTER_KEY = "b".repeat(64);
  assert.ok((await validatePlatformUpgradeConfiguration(snapshot)).blocking_errors.some(error => error.code === "CREDENTIAL_DECRYPTION_FAILED"));
  snapshot.database_schema_version = SCHEMA_VERSION - 1;
  const crossSchema = await validatePlatformUpgradeConfiguration(snapshot);
  assert.ok(crossSchema.blocking_errors.some(error => error.code === "DATABASE_SCHEMA_MISMATCH"));
  assert.ok(crossSchema.blocking_errors.some(error => error.code === "CREDENTIAL_DECRYPTION_FAILED"));
  snapshot.database_schema_version = SCHEMA_VERSION;
  snapshot.environment.DEEPSONAR_MASTER_KEY_FILE = "/run/secrets/master";
  snapshot.host_files = [{key: "DEEPSONAR_MASTER_KEY_FILE", path: "/run/secrets/master", exists: true, regular_file: true, readable: true, read_only: true, mode: 0o600}];
  snapshot.master_key_file_content = "a".repeat(64) + "\n";
  assert.equal((await validatePlatformUpgradeConfiguration(snapshot)).ok, true); // FILE wins over wrong inline key
  const cliSuccess = runCli(JSON.stringify(snapshot));
  assert.equal(cliSuccess.status, 0);
  snapshot.credentials[0].auth_tag = Buffer.alloc(16).toString("base64");
  const cliFailure = runCli(JSON.stringify(snapshot));
  assert.equal(cliFailure.status, 1);
  assert.ok(JSON.parse(cliFailure.stdout).blocking_errors.some((error: {code: string}) => error.code === "CREDENTIAL_DECRYPTION_FAILED"));
  for (const secret of ["private-credential", snapshot.master_key_file_content.trim(), String(snapshot.credentials[0].ciphertext)]) assert.equal((cliSuccess.stdout + cliSuccess.stderr + cliFailure.stdout + cliFailure.stderr).includes(secret), false);
  for (const invalid of [undefined, "", "private-invalid-format"]) {
    snapshot.master_key_file_content = invalid;
    assert.ok((await validatePlatformUpgradeConfiguration(snapshot)).blocking_errors.some(error => error.code === "CREDENTIAL_MASTER_KEY_INVALID"));
  }
});

test("existing credential encrypt/decrypt API preserves hex and base64 key compatibility", () => {
  for (const key of ["a".repeat(64), Buffer.from("a".repeat(64), "hex").toString("base64"), Buffer.from("a".repeat(64), "hex").toString("base64").replace(/=+$/, "")]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "const {encryptSecret,decryptSecret}=await import('./src/credentials.ts'); if(decryptSecret(encryptSecret('private-roundtrip'))!=='private-roundtrip')process.exit(1);"], {cwd: fileURLToPath(new URL("../", import.meta.url)), env: {...process.env, DEEPSONAR_OFFLINE_PREFLIGHT: "1", DEEPSONAR_MASTER_KEY: key, DEEPSONAR_MASTER_KEY_FILE: ""}, encoding: "utf8"});
    assert.equal(child.status, 0, "runtime crypto API roundtrip failed");
    assert.equal((child.stdout + child.stderr).includes("private-roundtrip"), false);
  }
});

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
    // Type-only edges are erased and cannot initialize database modules.
    const runtimeSource = source.replace(/import\s+type\b[\s\S]*?from\s*["'][^"']+["'];?/g, "");
    for (const match of runtimeSource.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+\.js)["']/g)) {
      visit(new URL(match[1].replace(/\.js$/, ".ts"), file));
    }
  }
  visit(new URL("./platform-upgrade-preflight.ts", import.meta.url));
});

test("offline environment semantics reject malformed URLs, enums and key encodings without echoing secrets", () => {
  for (const [key, value] of Object.entries({ DATABASE_URL: "https://secret.invalid", OPEN_SANDBOX_DOMAIN: "host/path", BLOB_STORE: "unexpected", BLOB_S3_FORCE_PATH_STYLE: "typo", DEEPSONAR_MASTER_KEY: "secret-invalid-key", DEEPSONAR_API_SANDBOX_URL: "file:///private" })) {
    const snapshot = fixture(); snapshot.environment[key] = value;
    const report = validatePlatformUpgradeSnapshot(snapshot);
    assert.ok(report.blocking_errors.some(error => error.code === "INVALID_ENVIRONMENT_VALUE"));
    assert.ok(!JSON.stringify(report).includes(value));
  }
});
test("required mounted master key needs matching read-only readable regular-file evidence", () => {
  const snapshot = fixture(); snapshot.environment.DEEPSONAR_MASTER_KEY_FILE = "/run/secrets/master";
  assert.ok(codes(snapshot).includes("REQUIRED_HOST_FILE_UNVERIFIED"));
  const evidence = {key: "DEEPSONAR_MASTER_KEY_FILE", path: "/run/secrets/master", exists: true, regular_file: true, readable: true, read_only: true, mode: 0o600};
  snapshot.host_files = [evidence]; assert.deepEqual(codes(snapshot), []);
  for (const change of [{exists: false}, {regular_file: false}, {readable: false}, {read_only: false}, {mode: 0o666}, {path: "/other"}]) {
    snapshot.host_files = [{...evidence, ...change}];
    assert.ok(codes(snapshot).includes("REQUIRED_HOST_FILE_UNVERIFIED"));
  }
});

test("provider extensions are preserved while known malformed native fields fail", () => {
  const settings = { providers: { vendor: { baseUrl: "https://api.example.test/v1", models: [{id: "model"}], vendorExtension: { future: true } } }, arbitraryNativeExtension: [1, 2] };
  const original = structuredClone(settings);
  assert.equal(validateNativeProviderStructure(settings), true);
  assert.deepEqual(settings, original);
  for (const invalid of [{ env: [] }, {env: {API_KEY: 3}}, {env: {OPENAI_BASE_URL: "file:///secret"}}, {providers: {vendor: null}}, {providers: {vendor: {baseUrl: "bad", models: []}}}, {options: {baseURL: 5}}]) assert.equal(validateNativeProviderStructure(invalid), false);
});

test("credential-first defaults distinguish absent and empty allowlist and permit CLI preferences", () => {
  const snapshot = fixture();
  const id = "44444444-4444-4444-8444-444444444444";
  snapshot.environment.DEEPSONAR_MASTER_KEY = "a".repeat(64);
  snapshot.role_configs[0].agent_cli = null;
  snapshot.credentials = [{ id, kind: "llm_provider", provider: "anthropic", project_id: null, status: "active", agent_cli: "claude-code", public_metadata_json: {}, settings_config_json: { env: { ANTHROPIC_MODEL: "example-model" } }, meta_json: {} }];
  const settings = {default_credential_id: id, default_agent_cli: "pi", default_model_ref: "example-model"};
  snapshot.projects[0].config_json = settings;
  assert.deepEqual(codes(snapshot), []);
  snapshot.projects[0].config_json = {...settings, enabled_credential_ids: []};
  assert.ok(codes(snapshot).includes("DEFAULT_CREDENTIAL_OUTSIDE_ALLOWLIST"));
  snapshot.projects[0].config_json = settings; snapshot.credentials[0].status = "disabled";
  assert.ok(codes(snapshot).includes("PROJECT_CREDENTIAL_UNAVAILABLE"));
});

test("preflight uses canonical Pi route and Claude selector model resolution", () => {
  for (const [agent_cli, settings_config_json, model] of [
    ["pi", { providers: { deepsonar: { models: [{ id: "example-model" }] } } }, "deepsonar/example-model"],
    ["claude-code", { env: { ANTHROPIC_MODEL: "other-model", ANTHROPIC_DEFAULT_SONNET_MODEL: "example-model" } }, "sonnet"],
  ] as const) {
    const snapshot = fixture(); const id = "44444444-4444-4444-8444-444444444444";
    snapshot.environment.DEEPSONAR_MASTER_KEY = "a".repeat(64);
    snapshot.credentials = [{id, kind: "llm_provider", provider: "anthropic", project_id: null, status: "active", agent_cli, public_metadata_json: {}, meta_json: {}, settings_config_json}];
    snapshot.projects[0].config_json = {default_credential_id: id, default_model_ref: model};
    assert.deepEqual(codes(snapshot), []);
  }
});
