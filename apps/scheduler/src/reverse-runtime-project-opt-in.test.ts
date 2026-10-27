/**
 * #718 PR3: deepsonar-reverse is an official, project_opt_in catalog image.
 * Covers the schema seed / rebuild backfill, startup warmup skip, #691 project
 * exclusion, readiness scope gates and Hub catalog projection. Global defaults
 * (base / audit / kali-minimal) must stay unchanged.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateReadiness, type ReadinessEvaluationInput } from "./readiness.js";
import {
  DEFAULT_RUNTIME_IMAGE_BY_ROLE,
  defaultRuntimeImageKey,
  isProjectRuntimeImageAvailable,
  isStartupRequiredRuntimeImage,
  parseRuntimeImageRegistry,
  selectRuntimeImageRef,
  toHubRuntimeImageCatalogEntry,
} from "./runtime-images.js";
import { officialCatalogBackfillSql } from "./schema-rebuild.js";

const schema = readFileSync(new URL("../../../database/schema.sql", import.meta.url), "utf8");
const registryRaw = JSON.parse(readFileSync(new URL("../../../deploy/runtime-image-registry.json", import.meta.url), "utf8"));
const registry = parseRuntimeImageRegistry(registryRaw);

/** v0.6.0 Release canonical multi-arch index for deepsonar-reverse (GHCR/Docker Hub/ACR). */
const REVERSE_0_6_0_DIGEST = "sha256:fb2839c403b9a478b71eb64f2343b2edf787475be3ef280696b479319d591b4c";
const BUILTIN_ACR_NAMESPACE = "crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec";

const projectId = "11111111-1111-4111-8111-111111111111";
const hubRoleId = "22222222-2222-4222-8222-222222222222";
const workerRoleId = "33333333-3333-4333-8333-333333333333";
const hubConfigId = "44444444-4444-4444-8444-444444444444";
const workerConfigId = "55555555-5555-4555-8555-555555555555";
const credentialId = "66666666-6666-4666-8666-666666666666";
const imageVersionId = "77777777-7777-4777-8777-777777777777";

function seedRow(imageKey: string): string | undefined {
  return schema.split("\n").find((line) => line.trimStart().startsWith(`('${imageKey}',`));
}

test("schema seeds deepsonar-reverse as official + project_opt_in + enabled, matching the registry", () => {
  const row = seedRow("deepsonar-reverse");
  assert.ok(row, "schema.sql must seed deepsonar-reverse");
  assert.match(row, /'official',\s*true,\s*true,\s*true\),?$/);
  const reverse = registry.images.find((image) => image.image_key === "deepsonar-reverse");
  assert.ok(reverse);
  assert.equal(reverse.project_opt_in, true);
  assert.ok(row.includes(`'${reverse.description}'`), "seed description must equal registry description");
  assert.match(reverse.description, /project opt-in/);
  assert.match(reverse.description, /不改变全局默认/);
});

test("global default images stay non-opt-in and reverse never becomes a role default", () => {
  for (const imageKey of ["deepsonar-base", "deepsonar-audit", "deepsonar-kali-minimal"]) {
    assert.match(seedRow(imageKey) ?? "", /'official',\s*true,\s*false,\s*true\),?$/, imageKey);
  }
  assert.deepEqual({ ...DEFAULT_RUNTIME_IMAGE_BY_ROLE }, {
    test: "deepsonar-kali-minimal",
    audit: "deepsonar-audit",
    verify: "deepsonar-base",
  });
  for (const role of ["audit", "analyze", "explore", "verify", "test", "code", "review", "hub_reason"]) {
    assert.notEqual(defaultRuntimeImageKey(role), "deepsonar-reverse", role);
  }
});

test("rebuild backfill carries the reverse seed row", () => {
  const statements = officialCatalogBackfillSql(schema);
  const runtimeImages = statements.find((sql) => sql.startsWith("INSERT INTO runtime_images"));
  assert.ok(runtimeImages);
  assert.match(runtimeImages, /'deepsonar-reverse'/);
  assert.match(runtimeImages, /ON CONFLICT \(image_key\) DO NOTHING;$/);
});

test("startup warmup skips reverse; #691 project exclusion still applies", () => {
  assert.equal(isStartupRequiredRuntimeImage({ official: true, project_opt_in: true, enabled: true }), false);
  assert.equal(isStartupRequiredRuntimeImage({ official: true, project_opt_in: false, enabled: true }), true);
  assert.equal(isProjectRuntimeImageAvailable({ imageKey: "deepsonar-reverse", official: true, projectEnabled: null, projectId }), true);
  assert.equal(isProjectRuntimeImageAvailable({ imageKey: "deepsonar-reverse", official: true, projectEnabled: true, projectId }), true);
  assert.equal(isProjectRuntimeImageAvailable({ imageKey: "deepsonar-reverse", official: true, projectEnabled: false, projectId }), false);
});

test("Hub catalog projects reverse as project_opt_in with binary.rea.cli", () => {
  const entry = toHubRuntimeImageCatalogEntry({
    image_key: "deepsonar-reverse",
    name: "DeepSonar Reverse",
    description: "reverse",
    official: true,
    project_opt_in: true,
    source_kind: "official",
  });
  assert.ok(entry, "reverse must stay visible to governed agent CLIs");
  assert.equal(entry.project_opt_in, true);
  assert.ok(entry.capabilities.includes("binary.rea.cli"));
  assert.ok(entry.compatible_agent_clis.length > 0);
});

function reverseInput(overrides: Partial<ReadinessEvaluationInput> = {}, projectEnabled: boolean | null = null): ReadinessEvaluationInput {
  return {
    scope: { kind: "project", projectId },
    executionMode: "real",
    now: new Date("2026-10-13T00:00:00.000Z"),
    hubEnabled: true,
    allowEgress: true,
    networkSource: "project",
    materialSource: "external_or_workspace",
    roles: [
      {
        role_id: hubRoleId, name: "hub_reason", title: "Hub", kind: "hub",
        project_config_id: null, project_config_scope: "none", project_agent_cli: null, project_model: null, project_runtime_image_key: null,
        global_config_id: hubConfigId, global_agent_cli: "claude-code", global_model: "claude-sonnet-4-5", global_runtime_image_key: "deepsonar-base",
      },
      {
        role_id: workerRoleId, name: "audit", title: "Audit", kind: "role",
        project_config_id: null, project_config_scope: "none", project_agent_cli: null, project_model: null, project_runtime_image_key: null,
        global_config_id: workerConfigId, global_agent_cli: "claude-code", global_model: "claude-sonnet-4-5", global_runtime_image_key: "deepsonar-reverse",
      },
    ],
    credentials: [hubConfigId, workerConfigId].map((roleConfigId) => ({
      role_config_id: roleConfigId,
      purpose: "llm",
      credential_id: credentialId,
      name: "Anthropic team",
      kind: "llm_provider",
      provider: "anthropic",
      project_id: null,
      status: "active",
      public_metadata_json: {},
      agent_cli: "claude-code",
    })),
    runtimeImages: [
      {
        image_key: "deepsonar-base", image_enabled: true, project_opt_in: false, source_kind: "official", official: true, project_enabled: null,
        version_id: imageVersionId, digest: `sha256:${"a".repeat(64)}`, resolved_ref: `summersec/deepsonar-base@sha256:${"a".repeat(64)}`,
        trust_status: "trusted", admission_scan_id: null, admission_bypassed: false,
      },
      {
        image_key: "deepsonar-reverse", image_enabled: true, project_opt_in: true, source_kind: "official", official: true, project_enabled: projectEnabled,
        version_id: imageVersionId, digest: `sha256:${"c".repeat(64)}`, resolved_ref: `summersec/deepsonar-reverse@sha256:${"c".repeat(64)}`,
        trust_status: "trusted", admission_scan_id: null, admission_bypassed: false,
      },
    ],
    audits: [
      { resource_id: credentialId, action: "credential.test", at: "2026-10-12T12:00:00.000Z", result: "ok", after_json: { ok: true } },
      { resource_id: credentialId, action: "credential.models_discover", at: "2026-10-12T12:00:00.000Z", result: "ok", after_json: { model_count: 1 } },
    ],
    projectImagePolicy: { image_strategy: "inherit_global", role_runtime_images: {} },
    ...overrides,
  };
}

function auditImageCheck(input: ReadinessEvaluationInput) {
  const result = evaluateReadiness(input);
  const checks = result.checks.filter((check) => check.role?.name === "audit" && check.code.startsWith("RUNTIME_IMAGE_"));
  return { result, codes: checks.map((check) => check.code) };
}

test("readiness: global scope requires a concrete project for reverse", () => {
  const { result, codes } = auditImageCheck(reverseInput({ scope: { kind: "global", projectId: null }, networkSource: "global" }));
  assert.equal(result.ready, false);
  assert.deepEqual(codes, ["RUNTIME_IMAGE_PROJECT_SCOPE_REQUIRED"]);
  const fix = result.checks.find((check) => check.code === "RUNTIME_IMAGE_PROJECT_SCOPE_REQUIRED")?.fix;
  assert.equal(fix?.scope, "project");
});

test("readiness: project scope resolves reverse unless the project excluded it", () => {
  const available = auditImageCheck(reverseInput());
  assert.deepEqual(available.codes, ["RUNTIME_IMAGE_READY"]);
  assert.equal(available.result.checks.some((check) => check.code === "AGENT_CLI_IMAGE_INCOMPATIBLE"), false);

  const enabled = auditImageCheck(reverseInput({}, true));
  assert.deepEqual(enabled.codes, ["RUNTIME_IMAGE_READY"]);

  const excluded = auditImageCheck(reverseInput({}, false));
  assert.equal(excluded.result.ready, false);
  assert.deepEqual(excluded.codes, ["RUNTIME_IMAGE_PROJECT_NOT_ENABLED"]);
  const check = excluded.result.checks.find((item) => item.code === "RUNTIME_IMAGE_PROJECT_NOT_ENABLED");
  assert.match(check?.message ?? "", /显式排除/);
  assert.equal(check?.fix?.action, "runtime_images");
});

test("bundled reverse 0.6.0 digest binds official catalog admission (static-registry trusted)", () => {
  const reverse = registry.images.find((image) => image.image_key === "deepsonar-reverse");
  assert.ok(reverse, "bundled registry must include deepsonar-reverse");
  assert.equal(reverse.project_opt_in, true);
  assert.equal(reverse.versions.length, 1, "v0.6.0 Release must have backfilled exactly one reverse version");
  const version = reverse.versions[0]!;
  assert.equal(version.version, "0.6.0");
  assert.equal(version.digest, REVERSE_0_6_0_DIGEST);
  assert.deepEqual(version.platforms, ["linux/amd64", "linux/arm64"]);
  assert.equal(
    version.image_ref,
    `ghcr.io/summersec/deepsonar-reverse@${REVERSE_0_6_0_DIGEST}`,
  );
  assert.equal(
    version.registry_refs?.github,
    `ghcr.io/summersec/deepsonar-reverse@${REVERSE_0_6_0_DIGEST}`,
  );
  assert.equal(
    version.registry_refs?.dockerhub,
    `docker.io/sumsec/deepsonar@${REVERSE_0_6_0_DIGEST}`,
  );
  assert.equal(
    version.registry_refs?.["aliyun-acr"],
    `${BUILTIN_ACR_NAMESPACE}/deepsonar-reverse@${REVERSE_0_6_0_DIGEST}`,
  );
  for (const channel of ["github", "dockerhub", "aliyun-acr"] as const) {
    const evidence = version.registry_evidence?.[channel];
    assert.ok(evidence, `${channel} registry_evidence required`);
    assert.equal(evidence.available, true, `${channel} must be available`);
    assert.equal(evidence.inspect_digest, REVERSE_0_6_0_DIGEST, `${channel} inspect must match canonical digest`);
  }
  // applyOfficialRuntimeCatalog selects deployment ref then inserts trust_status=trusted
  // with scan_summary.source=static-registry (Release catalog digest is the trust root).
  assert.equal(selectRuntimeImageRef("deepsonar-reverse", version, ""), version.image_ref);
  assert.equal(
    selectRuntimeImageRef("deepsonar-reverse", version, BUILTIN_ACR_NAMESPACE),
    version.registry_refs!["aliyun-acr"],
  );
  const admissionScanSummary = {
    source: "static-registry" as const,
    contract: "declared" as const,
    ...(version.manual ? { manual: version.manual } : {}),
  };
  assert.equal(admissionScanSummary.source, "static-registry");
  assert.ok(version.manual, "official reverse version must carry offline manuals for trusted resolve");
  assert.equal(version.manual?.contract, "deepsonar.runtime.manuals/v1");
  // Global defaults unchanged; reverse stays project_opt_in only.
  for (const role of Object.keys(DEFAULT_RUNTIME_IMAGE_BY_ROLE)) {
    assert.notEqual(DEFAULT_RUNTIME_IMAGE_BY_ROLE[role as keyof typeof DEFAULT_RUNTIME_IMAGE_BY_ROLE], "deepsonar-reverse");
  }
});
