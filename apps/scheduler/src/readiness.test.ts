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
        public_metadata_json: {},
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
        public_metadata_json: {},
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
    projectImagePolicy: { image_strategy: "project_managed", role_runtime_images: { audit: "deepsonar-audit" } },
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

test("DSH readiness notes the upstream system-message client fingerprint", () => {
  const result = evaluateReadiness(baseInput({
    roles: baseInput().roles.map((role) => role.name === "hub_reason"
      ? { ...role, global_agent_cli: "dsh" }
      : role),
  }));
  assert.equal(result.ready, true);
  const note = result.checks.find((check) => check.code === "DSH_UPSTREAM_CLIENT_FINGERPRINT");
  assert.equal(note?.severity, "warning");
  assert.equal(note?.state, "attention");
  assert.match(note?.message ?? "", /pi 兼容帧/);
  assert.match(note?.message ?? "", /unauthorized client/);
  assert.equal(result.checks.some((check) => check.code === "DSH_UPSTREAM_CLIENT_FINGERPRINT" && check.role?.name === "audit"), false);
});

test("readiness exposes HOST_DISK_PRESSURE and blocks only at error threshold", () => {
  const warning = evaluateReadiness(baseInput({
    hostDisk: {
      level: "warning",
      path: "/host-disk",
      usedPercent: 86,
      warningPercent: 85,
      errorPercent: 90,
      checkedAt: "2026-08-04T00:00:00.000Z",
      error: null,
    },
  }));
  assert.equal(warning.ready, true);
  assert.ok(warning.checks.some((check) =>
    check.code === "HOST_DISK_PRESSURE" && check.severity === "warning"));

  const error = evaluateReadiness(baseInput({
    hostDisk: {
      level: "error",
      path: "/host-disk",
      usedPercent: 92,
      warningPercent: 85,
      errorPercent: 90,
      checkedAt: "2026-08-04T00:00:00.000Z",
      error: null,
    },
  }));
  assert.equal(error.ready, false);
  assert.ok(error.checks.some((check) =>
    check.code === "HOST_DISK_PRESSURE" && check.severity === "error"));
});
test("OpenSandbox server probe fails readiness when unreachable or unconfigured", () => {
  const ready = evaluateReadiness(baseInput({
    openSandboxServer: {
      level: "ok",
      domain: "127.0.0.1:8080",
      checkedAt: "2026-08-04T00:00:00.000Z",
      error: null,
    },
  }));
  assert.equal(ready.ready, true);
  assert.ok(ready.checks.some((check) => check.code === "OPENSANDBOX_SERVER_READY"));

  const unconfigured = evaluateReadiness(baseInput({
    openSandboxServer: {
      level: "unconfigured",
      domain: "127.0.0.1:8080",
      checkedAt: "2026-08-04T00:00:00.000Z",
      error: "OPEN_SANDBOX_API_KEY missing",
    },
  }));
  assert.equal(unconfigured.ready, false);
  assert.ok(unconfigured.checks.some((check) =>
    check.code === "OPENSANDBOX_SERVER_UNCONFIGURED" && check.severity === "error"));

  const unavailable = evaluateReadiness(baseInput({
    openSandboxServer: {
      level: "error",
      domain: "127.0.0.1:8080",
      checkedAt: "2026-08-04T00:00:00.000Z",
      error: "opensandbox health timed out",
    },
  }));
  assert.equal(unavailable.ready, false);
  assert.ok(unavailable.checks.some((check) =>
    check.code === "OPENSANDBOX_SERVER_UNAVAILABLE" && check.message.includes("opensandbox health timed out")));
  assert.equal(JSON.stringify(unavailable).includes("OPEN_SANDBOX_API_KEY="), false);
});

test("readiness follows strategy and ignores legacy project image column", () => {
  const inherited = evaluateReadiness(baseInput({
    projectImagePolicy: { image_strategy: "inherit_global", role_runtime_images: { audit: "deepsonar-chrome-audit" } },
    roles: baseInput().roles.map((role) => role.name === "audit"
      ? { ...role, project_runtime_image_key: "deepsonar-chrome-audit", global_runtime_image_key: "openharmony" }
      : role),
    runtimeImages: [
      ...(baseInput().runtimeImages ?? []).filter((image) => image.image_key === "deepsonar-base"),
      { ...baseInput().runtimeImages![0], image_key: "openharmony", official: true, project_opt_in: false, project_enabled: null },
    ],
  }));
  const inheritedAudit = inherited.checks.find((check) => check.role?.name === "audit" && check.runtime_image);
  assert.equal(inheritedAudit?.role?.runtime_image_key, "openharmony");
  assert.equal(inheritedAudit?.runtime_image?.image_key, "openharmony");

  const managed = evaluateReadiness(baseInput({
    projectImagePolicy: { image_strategy: "project_managed", role_runtime_images: { audit: "deepsonar-audit" } },
    roles: baseInput().roles.map((role) => role.name === "audit"
      ? { ...role, project_runtime_image_key: "deepsonar-chrome-audit", global_runtime_image_key: "openharmony" }
      : role),
  }));
  const managedAudit = managed.checks.find((check) => check.role?.name === "audit" && check.runtime_image);
  assert.equal(managedAudit?.role?.runtime_image_key, "deepsonar-audit");
  assert.equal(managedAudit?.runtime_image?.image_key, "deepsonar-audit");
});


test("real preflight resolves a model from Credential settings when RoleConfig model is null", () => {
  const input = baseInput({
    roles: baseInput().roles.map((role) => ({
      ...role,
      project_model: null,
      global_model: null,
    })),
    credentials: baseInput().credentials?.map((credential) => ({
      ...credential,
      agent_cli: "claude-code",
      settings_config_json: { env: { ANTHROPIC_MODEL: "claude-sonnet-4-5" } },
    })),
  });
  const result = evaluateReadiness(input);
  assert.equal(result.ready, true);
  assert.equal(result.checks.some((check) => check.code === "CREDENTIAL_CLI_INCOMPATIBLE"), false);
});

test("stale project pin is distinct from a missing trusted image", () => {
  const stalePinId = "99999999-9999-4999-8999-999999999999";
  const latestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const result = evaluateReadiness(baseInput({
    runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-base"
      ? {
          ...image,
          version_id: null,
          digest: null,
          resolved_ref: null,
          trust_status: null,
          selected_version_id: stalePinId,
          selected_version: "0.1.29",
          latest_version_id: latestId,
          latest_version: "0.1.39",
        }
      : image),
  }));
  assert.equal(result.ready, false);
  const check = result.checks.find((item) => item.code === "RUNTIME_IMAGE_PIN_STALE" && item.role?.name === "hub_reason");
  assert.ok(check);
  assert.match(check?.message ?? "", /0\.1\.29/);
  assert.match(check?.message ?? "", /0\.1\.39/);
  assert.equal(check?.runtime_image?.pin_stale, true);
  assert.equal(check?.runtime_image?.selected_version, "0.1.29");
  assert.equal(check?.runtime_image?.latest_version, "0.1.39");
  assert.equal(check?.fix?.action, "runtime_images");
  assert.equal(result.checks.some((item) => item.code === "RUNTIME_IMAGE_UNAVAILABLE" && item.role?.name === "hub_reason"), false);
});

test("executable explicit pin stays ready even when marketplace latest is newer", () => {
  const pinId = "99999999-9999-4999-8999-999999999999";
  const latestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const digest = `sha256:${"a".repeat(64)}`;
  const result = evaluateReadiness(baseInput({
    runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-base"
      ? {
          ...image,
          version_id: pinId,
          digest,
          resolved_ref: `ghcr.io/summersec/deepsonar-base@${digest}`,
          trust_status: "trusted",
          selected_version_id: pinId,
          selected_version: "0.1.38",
          latest_version_id: latestId,
          latest_version: "0.1.39",
        }
      : image),
  }));
  assert.equal(result.ready, true);
  assert.equal(result.checks.some((check) => check.code === "RUNTIME_IMAGE_PIN_STALE"), false);
  const ready = result.checks.find((check) => check.code === "RUNTIME_IMAGE_READY" && check.role?.name === "hub_reason");
  assert.equal(ready?.runtime_image?.pin_stale, false);
  assert.equal(ready?.runtime_image?.selected_version, "0.1.38");
  assert.equal(ready?.runtime_image?.latest_version, "0.1.39");
});

test("follow-latest pin still reports missing trusted when marketplace has none", () => {
  const result = evaluateReadiness(baseInput({
    runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-base"
      ? {
          ...image,
          version_id: null,
          digest: null,
          resolved_ref: null,
          trust_status: null,
          selected_version_id: null,
          latest_version_id: null,
        }
      : image),
  }));
  assert.equal(result.ready, false);
  assert.ok(result.checks.some((check) => check.code === "RUNTIME_IMAGE_UNAVAILABLE" && check.role?.name === "hub_reason"));
  assert.equal(result.checks.some((check) => check.code === "RUNTIME_IMAGE_PIN_STALE"), false);
});

test("readiness repair metadata covers disabled runtime images", () => {
  const result = evaluateReadiness(baseInput({
    runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-audit"
      ? { ...image, image_enabled: false }
      : image),
  }));
  const check = result.checks.find((item) => item.code === "RUNTIME_IMAGE_DISABLED" && item.role?.name === "audit");
  assert.equal(check?.fix?.action, "runtime_images");
  assert.equal(check?.fix?.scope, "project");
});

test("real preflight accepts a bare immutable digest from the runtime resolver", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const result = evaluateReadiness(baseInput({
    runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-base"
      ? { ...image, resolved_ref: digest }
      : image),
  }));
  assert.equal(result.ready, true);
  assert.equal(result.checks.some((check) => check.code === "RUNTIME_IMAGE_DIGEST_INVALID"), false);
});

test("real preflight treats compatible credential CLI drift as attention, not fail", () => {
  const result = evaluateReadiness(baseInput({
    roles: baseInput().roles.map((role) => role.name === "audit"
      ? { ...role, project_agent_cli: "pi" }
      : role),
    credentials: baseInput().credentials?.map((credential) => ({
      ...credential,
      agent_cli: "claude-code",
      settings_config_json: { env: { ANTHROPIC_MODEL: "grok-4.6" } },
    })),
  }));
  assert.equal(result.ready, true);
  assert.equal(result.checks.some((check) => check.code === "CREDENTIAL_CLI_INCOMPATIBLE"), false);
  const hint = result.checks.find((check) => check.code === "CREDENTIAL_CLI_HINT_DRIFT" && check.role?.name === "audit");
  assert.ok(hint);
  assert.equal(hint?.state, "attention");
});

test("real preflight fails closed for CLI/provider and untrusted image mismatches", () => {
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
  assert.ok(result.checks.some((check) => check.code === "RUNTIME_IMAGE_NOT_TRUSTED"));
});

test("catalog ready but local inspect miss fails readiness with RUNTIME_IMAGE_NOT_LOCAL", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  const result = evaluateReadiness(baseInput({
    localImagePresence: {
      [`sha256:${"a".repeat(64)}`]: true,
      [digest]: false,
    },
  }));
  assert.equal(result.ready, false);
  const check = result.checks.find((item) => item.code === "RUNTIME_IMAGE_NOT_LOCAL" && item.role?.name === "audit");
  assert.ok(check);
  assert.equal(check?.runtime_image?.digest, digest);
  assert.equal(check?.runtime_image?.image_key, "deepsonar-audit");
  assert.equal(check?.fix?.action, "runtime_images");
  assert.equal(result.checks.some((item) => item.code === "RUNTIME_IMAGE_READY" && item.role?.name === "hub_reason"), true);
});

test("catalog ready and local inspect hit keeps RUNTIME_IMAGE_READY", () => {
  const result = evaluateReadiness(baseInput({
    localImagePresence: {
      [`sha256:${"a".repeat(64)}`]: true,
      [`sha256:${"b".repeat(64)}`]: true,
    },
  }));
  assert.equal(result.ready, true);
  assert.equal(result.checks.some((check) => check.code === "RUNTIME_IMAGE_NOT_LOCAL"), false);
  assert.ok(result.checks.some((check) => check.code === "RUNTIME_IMAGE_READY" && check.role?.name === "audit"));
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

test("all actionable readiness checks carry stable repair metadata by scope", () => {
  const projectVariants = [
    baseInput({ hubEnabled: false }),
    baseInput({ roles: baseInput().roles.filter((role) => role.kind !== "hub") }),
    baseInput({ roles: baseInput().roles.filter((role) => role.kind !== "role") }),
    baseInput({ credentials: [] }),
    baseInput({ credentials: [...(baseInput().credentials ?? []), { ...(baseInput().credentials ?? [])[0]!, role_config_id: workerConfigId, purpose: "llm" }] }),
    baseInput({ credentials: baseInput().credentials?.map((credential) => credential.role_config_id === workerConfigId ? { ...credential, project_id: "99999999-9999-4999-8999-999999999999" } : credential) }),
    baseInput({ credentials: baseInput().credentials?.map((credential) => credential.role_config_id === workerConfigId ? { ...credential, provider: "unknown-provider" } : credential) }),
    baseInput({ credentials: baseInput().credentials?.map((credential) => credential.role_config_id === workerConfigId ? { ...credential, provider: "openai" } : credential) }),
    baseInput({ credentials: baseInput().credentials?.map((credential) => credential.role_config_id === workerConfigId ? { ...credential, status: "disabled" } : credential) }),
    baseInput({ credentials: baseInput().credentials?.map((credential) => credential.role_config_id === workerConfigId ? { ...credential, kind: "git" } : credential) }),
    baseInput({ audits: baseInput().audits?.map((audit) => audit.action === "credential.test" ? { ...audit, result: "error" } : audit) }),
    baseInput({ audits: baseInput().audits?.map((audit) => audit.action === "credential.models_discover" ? { ...audit, result: "error" } : audit) }),
    baseInput({ audits: baseInput().audits?.filter((audit) => audit.action !== "credential.models_discover") }),
    baseInput({ audits: baseInput().audits?.map((audit) => ({ ...audit, at: "2026-07-01T00:00:00.000Z" })) }),
    baseInput({ executionMode: "fake", audits: baseInput().audits?.map((audit) => audit.action === "credential.test" ? { ...audit, result: "error" } : audit) }),
    baseInput({ executionMode: "fake", credentials: [] }),
    baseInput({ runtimeImages: [] }),
    baseInput({
      runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-base"
        ? {
            ...image,
            version_id: null,
            digest: null,
            resolved_ref: null,
            trust_status: null,
            selected_version_id: "99999999-9999-4999-8999-999999999999",
            selected_version: "0.1.29",
            latest_version_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            latest_version: "0.1.39",
          }
        : image),
    }),
    baseInput({ runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-audit" ? { ...image, image_enabled: false } : image) }),
    baseInput({ runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-audit" ? { ...image, project_enabled: null } : image) }),
    baseInput({ runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-audit" ? { ...image, trust_status: "quarantined", admission_scan_id: null } : image) }),
    baseInput({ runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-audit" ? { ...image, digest: `sha256:${"c".repeat(64)}` } : image) }),
    baseInput({ runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-audit" ? { ...image, admission_scan_id: null, admission_bypassed: false } : image) }),
    baseInput({ runtimeImages: baseInput().runtimeImages?.map((image) => image.image_key === "deepsonar-audit" ? { ...image, admission_scan_id: null, admission_bypassed: true } : image) }),
    baseInput({ allowEgress: false, materialSource: "external_or_workspace" }),
    baseInput({ materialSource: "unspecified" }),
    baseInput({ projectStatus: "archived" }),
    baseInput({
      localImagePresence: {
        [`sha256:${"a".repeat(64)}`]: false,
        [`sha256:${"b".repeat(64)}`]: false,
      },
    }),
  ];
  const globalVariant = baseInput({
    scope: { kind: "global", projectId: null },
    networkSource: "global",
    roles: baseInput().roles.map((role) => ({
      ...role,
      project_config_id: null,
      project_config_scope: "none" as const,
      project_agent_cli: null,
      project_model: null,
      project_runtime_image_key: null,
      global_config_id: role.name === "hub_reason" ? hubConfigId : workerConfigId,
      global_agent_cli: "claude-code",
      global_model: "claude-sonnet-4-5",
      global_runtime_image_key: role.name === "hub_reason" ? "deepsonar-base" : "deepsonar-audit",
    })),
    credentials: baseInput().credentials?.map((credential) => ({ ...credential, role_config_id: credential.role_config_id === workerConfigId ? workerConfigId : hubConfigId, project_id: null })),
    runtimeImages: baseInput().runtimeImages?.map((image) => ({ ...image, project_enabled: null })),
  });

  const results = [
    ...projectVariants.map((input) => ({ input, result: evaluateReadiness(input) })),
    { input: globalVariant, result: evaluateReadiness(globalVariant) },
  ];
  const expectedActions: Record<string, "credentials" | "role_config" | "rules" | "runtime_images"> = {
    HUB_DISABLED: "rules",
    HUB_ROLE_UNAVAILABLE: "role_config",
    WORKER_ROLE_UNAVAILABLE: "role_config",
    CREDENTIAL_BINDING_AMBIGUOUS: "role_config",
    CREDENTIAL_MISSING: "role_config",
    CREDENTIAL_MISSING_FAKE: "role_config",
    CREDENTIAL_SCOPE_MISMATCH: "role_config",
    CREDENTIAL_PROVIDER_UNKNOWN: "credentials",
    CREDENTIAL_CLI_INCOMPATIBLE: "role_config",
    CREDENTIAL_NOT_ACTIVE: "credentials",
    CREDENTIAL_KIND_INCOMPATIBLE: "role_config",
    CREDENTIAL_TEST_FAILED: "credentials",
    CREDENTIAL_TEST_FAILED_FAKE: "credentials",
    CREDENTIAL_TEST_EVIDENCE_STALE: "credentials",
    MODEL_DISCOVERY_FAILED: "credentials",
    MODEL_DISCOVERY_EVIDENCE_MISSING: "credentials",
    MODEL_DISCOVERY_EVIDENCE_STALE: "credentials",
    RUNTIME_IMAGE_UNAVAILABLE: "runtime_images",
    RUNTIME_IMAGE_PIN_STALE: "runtime_images",
    RUNTIME_IMAGE_DISABLED: "runtime_images",
    RUNTIME_IMAGE_PROJECT_NOT_ENABLED: "runtime_images",
    RUNTIME_IMAGE_PROJECT_SCOPE_REQUIRED: "runtime_images",
    RUNTIME_IMAGE_NOT_TRUSTED: "runtime_images",
    RUNTIME_IMAGE_DIGEST_INVALID: "runtime_images",
    RUNTIME_IMAGE_ADMISSION_INCOMPLETE: "runtime_images",
    RUNTIME_IMAGE_ADMISSION_BYPASSED: "runtime_images",
    RUNTIME_IMAGE_NOT_LOCAL: "runtime_images",
    NETWORK_POLICY_MATERIAL_CONFLICT: "rules",
    MATERIAL_SOURCE_UNSPECIFIED: "rules",
    PROJECT_ARCHIVED: "rules",
  };
  const actionableCodes = new Set<string>();
  for (const { input, result } of results) {
    for (const check of result.checks.filter((item) => item.state !== "pass")) {
      if (!check.fix) continue;
      actionableCodes.add(check.code);
      assert.ok(check.fix.action, `${check.code} must expose action`);
      assert.equal(check.fix.action, expectedActions[check.code], `${check.code} repair action`);
      assert.ok(check.fix.scope, `${check.code} must expose scope`);
      assert.equal(typeof check.fix.project_id === "string" || check.fix.project_id === null, true, `${check.code} project_id shape`);
      if (check.fix.scope === "project" && input.scope.projectId) assert.equal(check.fix.project_id, input.scope.projectId);
    }
  }
  const globalScopeResult = results.at(-1)!.result;
  const projectScopeFix = globalScopeResult.checks.find((check) => check.code === "RUNTIME_IMAGE_PROJECT_SCOPE_REQUIRED")?.fix;
  assert.equal(projectScopeFix?.scope, "project");
  assert.equal(projectScopeFix?.project_id, null);
  assert.equal(projectScopeFix?.href, "/projects");
  for (const code of [
    "HUB_DISABLED",
    "HUB_ROLE_UNAVAILABLE",
    "WORKER_ROLE_UNAVAILABLE",
    "CREDENTIAL_BINDING_AMBIGUOUS",
    "CREDENTIAL_MISSING",
    "CREDENTIAL_MISSING_FAKE",
    "CREDENTIAL_SCOPE_MISMATCH",
    "CREDENTIAL_PROVIDER_UNKNOWN",
    "CREDENTIAL_CLI_INCOMPATIBLE",
    "CREDENTIAL_NOT_ACTIVE",
    "CREDENTIAL_KIND_INCOMPATIBLE",
    "CREDENTIAL_TEST_FAILED",
    "CREDENTIAL_TEST_FAILED_FAKE",
    "CREDENTIAL_TEST_EVIDENCE_STALE",
    "MODEL_DISCOVERY_FAILED",
    "MODEL_DISCOVERY_EVIDENCE_MISSING",
    "MODEL_DISCOVERY_EVIDENCE_STALE",
    "RUNTIME_IMAGE_UNAVAILABLE",
    "RUNTIME_IMAGE_PIN_STALE",
    "RUNTIME_IMAGE_DISABLED",
    "RUNTIME_IMAGE_PROJECT_NOT_ENABLED",
    "RUNTIME_IMAGE_NOT_TRUSTED",
    "RUNTIME_IMAGE_DIGEST_INVALID",
    "RUNTIME_IMAGE_ADMISSION_INCOMPLETE",
    "RUNTIME_IMAGE_ADMISSION_BYPASSED",
    "RUNTIME_IMAGE_NOT_LOCAL",
    "RUNTIME_IMAGE_PROJECT_SCOPE_REQUIRED",
    "NETWORK_POLICY_MATERIAL_CONFLICT",
    "MATERIAL_SOURCE_UNSPECIFIED",
    "PROJECT_ARCHIVED",
  ]) {
    assert.equal(actionableCodes.has(code), true, `${code} should be covered by repair metadata checks`);
  }
});
