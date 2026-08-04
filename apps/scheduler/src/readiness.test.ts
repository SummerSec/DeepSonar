import assert from "node:assert/strict";
import test from "node:test";
import { evaluateReadiness, type ReadinessEvaluationInput } from "./readiness.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const hubRoleId = "22222222-2222-4222-8222-222222222222";
const workerRoleId = "33333333-3333-4333-8333-333333333333";
const hubConfigId = "44444444-4444-4444-8444-444444444444";
const workerConfigId = "55555555-5555-4555-8555-555555555555";
const credentialId = "66666666-6666-4666-8666-666666666666";
const imageVersionId = "77777777-7777-4777-8777-777777777777";
const scanId = "88888888-8888-4888-8888-888888888888";

function baseInput(overrides: Partial<ReadinessEvaluationInput> = {}): ReadinessEvaluationInput {
  return {
    scope: { kind: "project", projectId },
    executionMode: "real",
    now: new Date("2026-08-04T00:00:00.000Z"),
    hubEnabled: true,
    allowEgress: true,
    networkSource: "project",
    materialSource: "external_or_workspace",
    roles: [
      {
        role_id: hubRoleId,
        name: "hub_reason",
        title: "Hub",
        kind: "hub",
        project_config_id: null,
        project_config_scope: "none",
        project_agent_cli: null,
        project_model: null,
        project_runtime_image_key: null,
        global_config_id: hubConfigId,
        global_agent_cli: "claude-code",
        global_model: "claude-sonnet-4-5",
        global_runtime_image_key: "deepsonar-base",
      },
      {
        role_id: workerRoleId,
        name: "audit",
        title: "Audit",
        kind: "role",
        project_config_id: workerConfigId,
        project_config_scope: "project",
        project_agent_cli: "claude-code",
        project_model: "claude-sonnet-4-5",
        project_runtime_image_key: "deepsonar-audit",
        global_config_id: null,
        global_agent_cli: null,
        global_model: null,
        global_runtime_image_key: null,
      },
    ],
    credentials: [
      {
        role_config_id: hubConfigId,
        purpose: "llm",
        credential_id: credentialId,
        name: "Anthropic team",
        kind: "llm_provider",
        provider: "anthropic",
        project_id: null,
        status: "active",
        public_metadata_json: { allowed_model_ids: ["claude-sonnet-4-5"] },
      },
      {
        role_config_id: workerConfigId,
        purpose: "llm",
        credential_id: credentialId,
        name: "Anthropic team",
        kind: "llm_provider",
        provider: "anthropic",
        project_id: projectId,
        status: "active",
        public_metadata_json: { allowed_model_ids: ["claude-sonnet-4-5"] },
      },
    ],
    runtimeImages: [
      {
        image_key: "deepsonar-base",
        image_enabled: true,
        project_opt_in: false,
        source_kind: "official",
        official: true,
        project_enabled: null,
        version_id: imageVersionId,
        digest: `sha256:${"a".repeat(64)}`,
        resolved_ref: `summersec/deepsonar-base@sha256:${"a".repeat(64)}`,
        trust_status: "trusted",
        admission_scan_id: null,
        admission_bypassed: false,
      },
      {
        image_key: "deepsonar-audit",
        image_enabled: true,
        project_opt_in: true,
        source_kind: "third_party",
        official: false,
        project_enabled: true,
        version_id: imageVersionId,
        digest: `sha256:${"b".repeat(64)}`,
        resolved_ref: `summersec/deepsonar-audit@sha256:${"b".repeat(64)}`,
        trust_status: "trusted",
        admission_scan_id: scanId,
        admission_bypassed: false,
      },
    ],
    audits: [
      { resource_id: credentialId, action: "credential.test", at: "2026-08-03T12:00:00.000Z", result: "ok", after_json: { ok: true } },
      { resource_id: credentialId, action: "credential.models_discover", at: "2026-08-03T12:00:00.000Z", result: "ok", after_json: { model_count: 1 } },
    ],
    ...overrides,
  };
}

test("real preflight accepts governed role, credential, evidence and image projections", () => {
  const result = evaluateReadiness(baseInput());
  assert.equal(result.ready, true);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.network_policy.allow_egress, true);
  assert.equal(result.network_policy.source, "project");
  const credentialChecks = result.checks.filter((check) => check.credential);
  assert.ok(credentialChecks.length > 0);
  assert.equal(JSON.stringify(result).includes("ciphertext"), false);
  assert.equal(JSON.stringify(result).includes("ANTHROPIC_API_KEY"), false);
});

test("real preflight fails closed for CLI/provider/model and untrusted image mismatches", () => {
  const input = baseInput({
    roles: baseInput().roles.map((role) => role.name === "audit"
      ? { ...role, project_agent_cli: "claude-code", project_model: "claude-opus-4-1" }
      : role),
    credentials: baseInput().credentials?.map((credential) => ({ ...credential, provider: "openai" })) ,
    runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-audit"
      ? { ...image, trust_status: "quarantined", admission_scan_id: null }
      : image),
  });
  const result = evaluateReadiness(input);
  assert.equal(result.ready, false);
  assert.ok(result.checks.some((check) => check.code === "CREDENTIAL_CLI_INCOMPATIBLE"));
  assert.ok(result.checks.some((check) => check.code === "MODEL_NOT_ALLOWED"));
  assert.ok(result.checks.some((check) => check.code === "RUNTIME_IMAGE_NOT_TRUSTED"));
});

test("fake preflight remains actionable without pretending online evidence exists", () => {
  const result = evaluateReadiness(baseInput({
    executionMode: "fake",
    credentials: [],
    runtimeImages: [],
    materialSource: "unspecified",
  }));
  assert.equal(result.ready, true);
  assert.ok(result.checks.some((check) => check.code === "CREDENTIAL_MISSING_FAKE" && check.severity === "warning"));
  assert.ok(result.checks.some((check) => check.code === "RUNTIME_IMAGE_SKIPPED_FAKE"));
  assert.ok(result.checks.some((check) => check.code === "MATERIAL_SOURCE_UNSPECIFIED"));
});

test("material source stays unspecified until the task declares it", () => {
  const result = evaluateReadiness(baseInput({ materialSource: undefined }));
  assert.equal(result.network_policy.material_source, "unspecified");
  assert.ok(result.checks.some((check) => check.code === "MATERIAL_SOURCE_UNSPECIFIED" && check.severity === "warning"));
});

test("fake preflight does not block on failed live credential evidence", () => {
  const result = evaluateReadiness(baseInput({
    executionMode: "fake",
    audits: [
      { resource_id: credentialId, action: "credential.test", at: "2026-08-03T12:00:00.000Z", result: "error", after_json: { ok: false } },
      { resource_id: credentialId, action: "credential.models_discover", at: "2026-08-03T12:00:00.000Z", result: "error", after_json: null },
    ],
  }));
  assert.equal(result.ready, true);
  assert.ok(result.checks.some((check) => check.code === "CREDENTIAL_TEST_FAILED_FAKE" && check.severity === "warning"));
  assert.ok(result.checks.some((check) => check.code === "MODEL_DISCOVERY_FAILED" && check.severity === "warning"));
});

test("task network override is explicit and does not mutate project scope", () => {
  const result = evaluateReadiness(baseInput({ allowEgress: false, networkSource: "task_override", materialSource: "workspace_or_offline" }));
  assert.equal(result.network_policy.allow_egress, false);
  assert.equal(result.network_policy.source, "task_override");
  assert.equal(result.network_policy.material_source, "workspace_or_offline");
  assert.equal(result.scope.project_id, projectId);
});

test("credential scope follows global and project RoleConfig boundaries", () => {
  const credentials = baseInput().credentials ?? [];
  const result = evaluateReadiness(baseInput({
    credentials: credentials.map((credential) => credential.role_config_id === hubConfigId
      ? { ...credential, project_id: projectId }
      : { ...credential, project_id: null }),
  }));
  assert.equal(result.ready, false);
  const scopeMismatches = result.checks.filter((check) => check.code === "CREDENTIAL_SCOPE_MISMATCH");
  assert.ok(scopeMismatches.some((check) => check.role?.name === "hub_reason"));
  assert.equal(scopeMismatches.some((check) => check.role?.name === "audit"), false);
});

test("runtime image project opt-in and manual digest admission follow resolver semantics", () => {
  const explicitDisabled = evaluateReadiness(baseInput({
    runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-base"
      ? { ...image, project_opt_in: false, project_enabled: false }
      : image),
  }));
  assert.equal(explicitDisabled.ready, false);
  assert.ok(explicitDisabled.checks.some((check) => check.code === "RUNTIME_IMAGE_PROJECT_NOT_ENABLED"));

  const officialOptInMissing = evaluateReadiness(baseInput({
    runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-base"
      ? { ...image, project_opt_in: true, project_enabled: null }
      : image),
  }));
  assert.equal(officialOptInMissing.ready, false);
  assert.ok(officialOptInMissing.checks.some((check) => check.code === "RUNTIME_IMAGE_PROJECT_NOT_ENABLED"));

  const officialOptInEnabled = evaluateReadiness(baseInput({
    runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-base"
      ? { ...image, project_opt_in: true, project_enabled: true }
      : image),
  }));
  assert.equal(officialOptInEnabled.ready, true);

  const thirdPartyNotEnabled = evaluateReadiness(baseInput({
    runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-audit"
      ? { ...image, project_enabled: null }
      : image),
  }));
  assert.equal(thirdPartyNotEnabled.ready, false);
  assert.ok(thirdPartyNotEnabled.checks.some((check) => check.code === "RUNTIME_IMAGE_PROJECT_NOT_ENABLED"));

  const manualDigest = evaluateReadiness(baseInput({
    runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-audit"
      ? { ...image, project_enabled: true, admission_scan_id: null, admission_bypassed: true }
      : image),
  }));
  assert.equal(manualDigest.ready, true);
  assert.ok(manualDigest.checks.some((check) => check.code === "RUNTIME_IMAGE_ADMISSION_BYPASSED" && check.severity === "warning"));
});

test("global real readiness leaves project-scoped runtime images unresolved", () => {
  const base = baseInput();
  const result = evaluateReadiness({
    ...base,
    scope: { kind: "global", projectId: null },
    networkSource: "global",
    roles: base.roles.map((role) => role.name === "audit"
      ? {
          ...role,
          project_config_id: null,
          project_config_scope: "none",
          global_config_id: workerConfigId,
          global_agent_cli: "claude-code",
          global_model: "claude-sonnet-4-5",
          global_runtime_image_key: "deepsonar-audit",
        }
      : role),
    credentials: base.credentials?.map((credential) => ({ ...credential, project_id: null })),
    runtimeImages: base.runtimeImages?.map((image) => image.image_key === "deepsonar-base"
      ? { ...image, project_opt_in: true, project_enabled: null }
      : { ...image, project_enabled: null }),
  });
  assert.equal(result.ready, false);
  assert.ok(result.checks.some((check) => check.code === "RUNTIME_IMAGE_PROJECT_SCOPE_REQUIRED"));
  assert.equal(result.checks.some((check) => check.code === "RUNTIME_IMAGE_READY"), false);
});

test("trusted runtime fallback wins over untrusted preferred-platform candidate", () => {
  const images = baseInput().runtimeImages ?? [];
  const trusted = images.find((image) => image.image_key === "deepsonar-audit")!;
  const untrustedPreferred = {
    ...trusted,
    trust_status: "quarantined",
    admission_scan_id: null,
    platforms_json: ["linux/amd64"],
  };
  const trustedFallback = { ...trusted, platforms_json: ["linux/arm64"] };
  const result = evaluateReadiness(baseInput({
    runtimeImages: [
      ...images.filter((image) => image.image_key !== "deepsonar-audit"),
      untrustedPreferred,
      trustedFallback,
    ],
  }));
  assert.equal(result.ready, true);
  assert.ok(result.checks.some((check) => check.code === "RUNTIME_IMAGE_READY" && check.role?.name === "audit"));
  assert.equal(result.checks.some((check) => check.code === "RUNTIME_IMAGE_NOT_TRUSTED" && check.role?.name === "audit"), false);
});

test("archived projects fail preflight before task creation", () => {
  const result = evaluateReadiness(baseInput({ projectStatus: "archived" }));
  assert.equal(result.ready, false);
  assert.ok(result.checks.some((check) => check.code === "PROJECT_ARCHIVED"));
});

test("stale audit evidence is surfaced as a warning, not an online claim", () => {
  const result = evaluateReadiness(baseInput({
    audits: [
      { resource_id: credentialId, action: "credential.test", at: "2026-07-01T00:00:00.000Z", result: "ok", after_json: { ok: true } },
      { resource_id: credentialId, action: "credential.models_discover", at: "2026-07-01T00:00:00.000Z", result: "ok", after_json: { model_count: 1 } },
    ],
  }));
  assert.equal(result.ready, true);
  const stale = result.checks.find((check) => check.code === "CREDENTIAL_TEST_EVIDENCE_STALE");
  assert.ok(stale);
  assert.equal(stale?.evidence?.status, "stale");
  const staleModels = result.checks.find((check) => check.code === "MODEL_DISCOVERY_EVIDENCE_STALE");
  assert.ok(staleModels);
  assert.equal(staleModels?.evidence?.status, "stale");
  assert.equal(result.checks.some((check) => check.code === "MODEL_DISCOVERY_READY"), false);
});
