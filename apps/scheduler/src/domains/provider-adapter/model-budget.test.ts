import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ModelDescriptor, ModelLimitSource, ModelTokenBudget, freezeModelDescriptor } from "@deepsonar/shared-types";

process.env.AGENT_MODE = "fake";
const { listCredentialModelsPreview } = await import("../../credential-test.js");
const { normalizeModelCatalog } = await import("../../credentials.js");
const { materializeProviderSettings, projectProviderRuntimeSnapshot, providerModelBudget } = await import("../../provider-settings.js");
const { descriptorsFromModelDiscovery } = await import("./model-discovery.js");
const { resolveModelDescriptorCatalog } = await import("./descriptors.js");
const { freezeProviderModelSnapshot } = await import("./freeze.js");
const { resolveAgentSnapshotForJob, SnapshotUnresolvableError } = await import("../role-runtime-snapshot/application.js");
const modelId = "workbuddy-ai/hy4free";
const revision = "2026-11-06T12:00:00.000Z";
const catalog = () => descriptorsFromModelDiscovery({ provider: "openai", catalogRevision: revision,
  rows: [{ id: modelId, context_length: 1_000_000, context_window: 1_000_000, max_output_tokens: 64_000 }] });
const settings = (model: Record<string, unknown> = {}) => ({ providers: {
  magpie: { api: "openai-completions", baseUrl: "http://127.0.0.1/v1", models: [{ id: modelId, ...model }, { id: "unselected" }] },
} });
function project(config = settings(), roleContextWindowTokens?: number | null, contextSource?: "job" | "role_config") {
  return projectProviderRuntimeSnapshot({ agentCli: "pi", roleModel: modelId, settingsConfig: config,
    credentialProvider: "openai", catalogJson: catalog(), roleContextWindowTokens, contextSource });
}
function native(snapshot: ReturnType<typeof project>) {
  return JSON.parse(snapshot.config_files[0]!.content).providers.magpie.models as Array<Record<string, unknown>>;
}

test("#958 /models retains bounded declarations through the credential string projection and Pi file", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ data: [{ id: modelId, context_length: 1_000_000,
      context_window: 1_000_000, max_output_tokens: 64_000, api_key: "must-not-survive", arbitrary: "must-not-survive" }] })) as typeof fetch;
    const found = await listCredentialModelsPreview({ provider: "openai", kind: "llm_provider",
      public_metadata_json: { base_url: "http://127.0.0.1/v1" } }, "fixture-secret");
    assert.deepEqual(found.models, [modelId]);
    assert.deepEqual(normalizeModelCatalog(found.model_descriptors), [modelId]);
    const descriptor = ModelDescriptor.parse(found.model_descriptors[0]);
    assert.equal(descriptor.context_window, 1_000_000);
    assert.equal(descriptor.max_output_tokens, 64_000);
    assert.equal(descriptor.limit_source?.trust, "provider_declared");
    assert.equal(descriptor.limit_source?.endpoint, "models_endpoint");
    assert.equal(JSON.stringify(descriptor).includes("127.0.0.1"), false);
    assert.equal(JSON.stringify(descriptor).includes("must-not-survive"), false);
    const frozen = projectProviderRuntimeSnapshot({ agentCli: "pi", roleModel: modelId, settingsConfig: settings(),
      credentialProvider: "openai", catalogJson: found.model_descriptors });
    assert.equal(frozen.model, modelId);
    assert.equal(frozen.pi_provider, "magpie");
    assert.equal(frozen.context_window_tokens, 1_000_000);
    assert.deepEqual(frozen.model_budget.context_window_tokens, { configured: null, declared: 1_000_000, effective: 1_000_000, source: "provider_declared" });
    assert.equal(frozen.model_budget.max_output_tokens.effective, 64_000);
    assert.equal(frozen.model_budget.catalog_revision, found.fetched_at);
    assert.equal(native(frozen)[0]?.contextWindow, 1_000_000);
    assert.equal(native(frozen)[0]?.maxTokens, 64_000);
    assert.deepEqual(native(frozen)[1], { id: "unselected" });
    const provider = freezeProviderModelSnapshot({ provider: "openai", cliModelId: frozen.model,
      upstreamModelId: frozen.upstream_model, catalogJson: found.model_descriptors, modelBudget: frozen.model_budget });
    assert.equal(provider?.model_descriptor?.model_id, modelId);
    assert.equal(provider?.model_descriptor?.max_output_tokens, 64_000);
    assert.deepEqual(provider?.model_descriptor?.limit_source, descriptor.limit_source);
    assert.deepEqual(freezeModelDescriptor(descriptor).limit_source, descriptor.limit_source);
  } finally { globalThis.fetch = previousFetch; }
});

test("#958 preserves Job > Role > credential generic > selected native > declared > unknown CLI priority per field", () => {
  const config = { ...settings({ contextWindow: 500_000, maxTokens: 8_000 }), context_window_tokens: 400_000 };
  const configured = JSON.stringify(config);
  const scenarios = [
    { config, override: 200_000, source: "job" as const, expected: 200_000, provenance: "job" },
    { config, override: 300_000, source: "role_config" as const, expected: 300_000, provenance: "role_config" },
    { config, override: null, source: undefined, expected: 400_000, provenance: "credential_settings" },
    { config: settings({ contextWindow: 500_000, maxTokens: 8_000 }), override: undefined, source: undefined, expected: 500_000, provenance: "credential_settings" },
  ];
  for (const scenario of scenarios) {
    const snapshot = project(scenario.config, scenario.override, scenario.source);
    const budget = ModelTokenBudget.parse(snapshot.model_budget);
    assert.equal(budget.context_window_tokens.effective, scenario.expected);
    assert.equal(budget.context_window_tokens.configured, scenario.expected);
    assert.equal(budget.context_window_tokens.declared, 1_000_000);
    assert.equal(budget.context_window_tokens.source, scenario.provenance);
    assert.equal(budget.max_output_tokens.effective, 8_000);
    assert.equal(budget.max_output_tokens.declared, 64_000);
    assert.equal(native(snapshot)[0]?.contextWindow, scenario.expected);
    assert.equal(native(snapshot)[0]?.maxTokens, 8_000);
  }
  assert.equal(JSON.stringify(config), configured, "freezing never modifies credential settings");
  const first = project();
  const originalFrozen = JSON.stringify(first);
  const changed = catalog(); changed[0]!.context_window = 900_000;
  projectProviderRuntimeSnapshot({ agentCli: "pi", roleModel: modelId, settingsConfig: settings(), credentialProvider: "openai", catalogJson: changed });
  assert.equal(JSON.stringify(first), originalFrozen, "refresh cannot rewrite a previously frozen snapshot");
});

test("#958 missing, malformed and conflicting declaration fields remain explicitly unknown", () => {
  const cases: Array<Record<string, unknown>> = [
    {}, { context_window: null, max_output_tokens: null }, { context_window: 0, max_output_tokens: -1 }, { context_window: "1000000", max_output_tokens: "64000" },
    { context_window: 1_000_000, context_length: 128_000, max_output_tokens: 1.5 },
    { context_window: 10_000_001, max_output_tokens: 10_000_001 }, { context_window: Infinity, max_output_tokens: NaN },
  ];
  for (const [index, declaration] of cases.entries()) {
    const rows = descriptorsFromModelDiscovery({ provider: "openai", catalogRevision: revision, rows: [{ id: modelId, ...declaration }] });
    assert.equal(rows[0]?.context_window, null);
    assert.equal(rows[0]?.max_output_tokens, null);
    assert.equal(rows[0]?.limit_source?.context_window.status, index === 0 ? "missing" : "invalid");
    const projected = projectProviderRuntimeSnapshot({ agentCli: "pi", roleModel: modelId, settingsConfig: settings(), credentialProvider: "openai", catalogJson: rows });
    assert.equal(projected.context_window_tokens, null);
    assert.deepEqual(projected.model_budget.context_window_tokens, { configured: null, declared: null, effective: null, source: "cli_default" });
    assert.equal(projected.model_budget.max_output_tokens.effective, null);
    assert.equal("contextWindow" in native(projected)[0]!, false);
    assert.equal("maxTokens" in native(projected)[0]!, false);
  }
  const partial = descriptorsFromModelDiscovery({ provider: "openai", catalogRevision: revision, rows: [{ id: modelId, context_length: 1_000_000 }] });
  const budget = providerModelBudget({ agentCli: "pi", model: modelId, settingsConfig: settings(), credentialProvider: "openai", catalogJson: partial });
  assert.equal(budget.context_window_tokens.effective, 1_000_000);
  assert.equal(budget.max_output_tokens.effective, null);
  const duplicated = descriptorsFromModelDiscovery({ provider: "openai", catalogRevision: revision,
    rows: [{ id: modelId, context_window: 1_000_000 }, { id: modelId, context_window: 128_000 }] });
  assert.equal(duplicated[0]?.context_window, null);
  assert.equal(duplicated[0]?.limit_source?.context_window.status, "invalid");
  const mixedDuplicates = descriptorsFromModelDiscovery({ provider: "openai", catalogRevision: revision,
    rows: [modelId, { id: modelId, context_window: 1_000_000 }] });
  assert.equal(mixedDuplicates[0]?.limit_source?.context_window.status, "invalid");
  assert.equal(mixedDuplicates[0]?.limit_source?.context_window.field, "context_window");
  const bounded = descriptorsFromModelDiscovery({ provider: "openai", catalogRevision: revision,
    rows: Array.from({ length: 220 }, (_, index) => ({ id: `model-${index}` })) });
  assert.equal(bounded.length, 200);
});

test("#958 explicit invalid limits fail closed even under higher-priority overrides, and absent discovery stays unknown", () => {
  for (const value of [0, -1, 1.5, "64000", null, Infinity, 10_000_001]) {
    assert.throws(() => project(settings({ maxTokens: value }), 200_000), /model\.maxTokens|native model/);
    assert.throws(() => project(settings({ contextWindow: value }), 200_000), /model\.contextWindow|native model/);
    if (value !== null) assert.throws(() => materializeProviderSettings({ agentCli: "pi", settingsConfig: settings(),
      overrides: { max_output_tokens: value as number } }), /model\.maxTokens/);
  }
  const old = resolveModelDescriptorCatalog({ provider: "openai", catalogJson: [modelId], contextWindow: 200_000 });
  assert.deepEqual(normalizeModelCatalog(old), [modelId]);
  assert.throws(() => resolveModelDescriptorCatalog({ provider: "openai", catalogJson: [modelId, ...catalog()] }), /object/);
  const budget = providerModelBudget({ agentCli: "pi", model: modelId, settingsConfig: settings(), credentialProvider: "openai", catalogJson: old });
  assert.equal(budget.context_window_tokens.effective, null, "unmarked string-catalog projections are not provider declarations");
  assert.equal(budget.max_output_tokens.effective, null);
  const frozen = projectProviderRuntimeSnapshot({ agentCli: "pi", roleModel: modelId, settingsConfig: settings({ maxTokens: 4096, contextWindow: 128_000 }) });
  const provider = freezeProviderModelSnapshot({ provider: "openai", cliModelId: modelId, upstreamModelId: modelId, modelBudget: frozen.model_budget });
  assert.equal(provider?.passthrough, false);
  assert.equal(provider?.model_descriptor?.max_output_tokens, 4096);
});

test("#958 freezes only the authenticated selected Pi route, preserving a full slash-containing catalog id", () => {
  const config = { providers: {
    primary: { api: "openai-completions", models: [{ id: "model-a", contextWindow: 64_000, maxTokens: 2048 }] },
    secondary: { api: "openai-completions", models: [{ id: "model-a", contextWindow: 128_000, maxTokens: 8192 }] },
  } };
  const projected = projectProviderRuntimeSnapshot({ agentCli: "pi", roleModel: "secondary/model-a", settingsConfig: config });
  assert.equal(projected.pi_provider, "secondary");
  assert.equal(projected.model, "model-a");
  assert.equal(projected.model_budget.context_window_tokens.effective, 128_000);
  assert.equal(projected.model_budget.max_output_tokens.effective, 8192);
  assert.throws(() => providerModelBudget({ agentCli: "pi", model: "model-a", settingsConfig: config }), /多个已认证/);
});

const credentialId = "edc9a7b5-51bf-40e8-aef2-e96e91aa4750";
function snapshotFixture(input: {
  config?: unknown;
  discovery?: unknown;
  roleContext?: number;
  projectContext?: number;
  credentialProject?: string | null;
  roleModel?: string;
  fallbacks?: string[];
} = {}) {
  const queries: string[] = [];
  const credential = { id: credentialId, name: "fixture", provider: "openai", status: "active", agent_cli: "pi",
    project_id: input.credentialProject ?? null, public_metadata_json: {}, meta_json: {}, health_status: "ok",
    settings_config_json: input.config ?? settings(), model_catalog_json: input.discovery ?? catalog(), model_catalog_fetched_at: revision };
  const db = Object.assign(async (parts: TemplateStringsArray) => {
    const query = parts.join("?"); queries.push(query);
    if (query.includes("FROM agent_roles")) return [{ id: "role-audit", name: "audit", description: "audit", kind: "role", ui_color: "#f59e0b" }];
    if (query.includes("FROM projects")) return [{ config_json: { enabled_agent_clis: ["pi"], default_agent_cli: "pi", default_credential_id: credentialId,
      fallback_model_refs: input.fallbacks ?? [] } }];
    if (query.includes("FROM role_configs") && query.includes("project_id IS NULL")) {
      return [{ id: "global-audit", project_id: null, agent_cli: "pi", version: 1, model: input.roleModel ?? modelId, modules_json: [], context_window_tokens: input.roleContext ?? null }];
    }
    if (query.includes("FROM role_configs")) return input.projectContext === undefined ? []
      : [{ id: "project-audit", project_id: "project-1", agent_cli: null, version: 1, model: null, modules_json: [], context_window_tokens: input.projectContext }];
    if (query.includes("FROM credentials")) return [credential];
    return [];
  }, { json: (value: unknown) => value });
  return { db, credential, queries };
}

test("#958 complete Job creation freezes declarations and final Pi budgets without rewriting configuration or historical Jobs", async () => {
  const fixture = snapshotFixture({ roleContext: 400_000, projectContext: 300_000 });
  const configured = JSON.stringify(fixture.credential);
  const job = await resolveAgentSnapshotForJob(fixture.db, "project-1", "audit", {
    modelRef: modelId, runtimeProfile: { context_window_tokens: 200_000 },
  });
  assert.equal(job.credential_id, credentialId);
  assert.equal(job.credential_provider, "openai");
  assert.equal(job.pi_provider, "magpie");
  assert.equal(job.model, modelId);
  assert.equal(job.context_window_tokens, 200_000);
  assert.equal(job.runtime_profile.context_window_tokens, 200_000);
  const budget = ModelTokenBudget.parse(job.model_budget);
  assert.deepEqual(budget.context_window_tokens, { configured: 200_000, declared: 1_000_000, effective: 200_000, source: "job" });
  assert.equal(budget.max_output_tokens.effective, 64_000);
  assert.equal(job.provider_model?.model_descriptor?.context_window, 1_000_000, "original declaration remains separate from client override");
  assert.equal(job.provider_model?.model_descriptor?.max_output_tokens, 64_000);
  assert.equal(job.provider_model?.model_descriptor?.limit_source?.trust, "provider_declared");
  const modelsFile = job.config_files.find((file) => file.path === ".pi/agent/models.json")!;
  const models = JSON.parse(modelsFile.content).providers.magpie.models;
  assert.equal(models[0].contextWindow, 200_000);
  assert.equal(models[0].maxTokens, 64_000);
  assert.equal(JSON.stringify(fixture.credential), configured);
  assert.equal(fixture.queries.some((query) => /UPDATE\s+jobs|INSERT\s+INTO\s+jobs|UPDATE\s+credentials/i.test(query)), false);
  const historical = JSON.parse(JSON.stringify(job)); delete historical.model_budget;
  const oldBytes = JSON.stringify(historical), frozenBytes = JSON.stringify(job);
  const projectJob = await resolveAgentSnapshotForJob(fixture.db, "project-1", "audit", { modelRef: modelId });
  assert.equal(projectJob.model_budget?.context_window_tokens.effective, 300_000);
  assert.equal(projectJob.model_budget?.context_window_tokens.source, "role_config");
  fixture.credential.model_catalog_json = descriptorsFromModelDiscovery({ provider: "openai", catalogRevision: "next",
    rows: [{ id: modelId, context_window: 900_000, max_output_tokens: 32_000 }] });
  const later = await resolveAgentSnapshotForJob(fixture.db, "project-1", "audit", { modelRef: modelId });
  assert.equal(later.model_budget?.max_output_tokens.effective, 32_000);
  assert.equal(JSON.stringify(job), frozenBytes);
  assert.equal(JSON.stringify(historical), oldBytes);
  assert.equal("model_budget" in historical, false);
});

test("#958 declarations cannot expand configured model admission or credential project scope", async () => {
  const fixture = snapshotFixture({ discovery: descriptorsFromModelDiscovery({ provider: "openai", catalogRevision: revision,
    rows: [{ id: modelId, context_window: 1_000_000 }, { id: "discovered-only", context_window: 1_000_000 }] }) });
  await assert.rejects(resolveAgentSnapshotForJob(fixture.db, "project-1", "audit", { modelRef: "discovered-only" }), (error: unknown) => {
    assert.ok(error instanceof SnapshotUnresolvableError);
    assert.equal(error.repair?.code, "provider_credential_no_match");
    return true;
  });
  const foreign = snapshotFixture({ credentialProject: "another-project" });
  await assert.rejects(resolveAgentSnapshotForJob(foreign.db, "project-1", "audit", { modelRef: modelId }), SnapshotUnresolvableError);
  const mismatch = catalog(); mismatch[0]!.provider = "anthropic";
  await assert.rejects(resolveAgentSnapshotForJob(snapshotFixture({ discovery: mismatch }).db, "project-1", "audit", { modelRef: modelId }), /model descriptor provider mismatch/);
});

test("#958 full snapshot preselection does not resolve an unselected or explicitly routed duplicate model on the wrong Pi route", async () => {
  const config = { providers: {
    first: { api: "openai-completions", models: [{ id: "shared", contextWindow: 64_000, maxTokens: 2048 }, { id: modelId }] },
    second: { api: "openai-completions", models: [{ id: "shared", contextWindow: 128_000, maxTokens: 8192 }] },
  } };
  const ordinary = await resolveAgentSnapshotForJob(snapshotFixture({ config, fallbacks: ["shared"] }).db, "project-1", "audit", { modelRef: modelId });
  assert.equal(ordinary.pi_provider, "first");
  assert.equal(ordinary.model_budget?.max_output_tokens.effective, 64_000);
  const routed = await resolveAgentSnapshotForJob(snapshotFixture({ config }).db, "project-1", "audit", {
    modelRef: "second/shared", modelRequirements: { min_context_window: 100_000 },
  });
  assert.equal(routed.pi_provider, "second");
  assert.equal(routed.model, "shared");
  assert.equal(routed.model_budget?.context_window_tokens.effective, 128_000);
  assert.equal(routed.model_budget?.max_output_tokens.effective, 8192);
  await assert.rejects(resolveAgentSnapshotForJob(snapshotFixture({ config }).db, "project-1", "audit", { modelRef: "shared" }), SnapshotUnresolvableError);
  const fallback = await resolveAgentSnapshotForJob(snapshotFixture({ config, roleModel: "first/shared", fallbacks: ["second/shared"] }).db,
    "project-1", "audit", { modelRequirements: { min_context_window: 100_000 } });
  assert.equal(fallback.pi_provider, "second");
  assert.equal(fallback.model_budget?.context_window_tokens.effective, 128_000);
  assert.equal(fallback.model_budget?.max_output_tokens.effective, 8192);
  await assert.rejects(resolveAgentSnapshotForJob(snapshotFixture({ config, roleModel: "first/shared", fallbacks: ["second/shared"] }).db,
    "project-1", "audit", { modelRequirements: { min_context_window: 200_000 } }), SnapshotUnresolvableError);
});

test("#958 shared budget schemas reject impossible provenance, illegal numbers and unknown fields without supplying defaults", () => {
  const valid = project().model_budget;
  assert.equal(ModelTokenBudget.safeParse(undefined).success, false);
  assert.equal(ModelTokenBudget.safeParse({ ...valid, other: true }).success, false);
  for (const value of [0, -1, 1.5, "1000000", Infinity, 10_000_001]) {
    assert.equal(ModelTokenBudget.safeParse({ ...valid, context_window_tokens: { ...valid.context_window_tokens, effective: value } }).success, false);
  }
  assert.equal(ModelTokenBudget.safeParse({ ...valid, context_window_tokens: { ...valid.context_window_tokens, source: "cli_default" } }).success, false);
  assert.equal(ModelTokenBudget.safeParse({ ...valid, max_output_tokens: { configured: null, declared: null, effective: 64_000, source: "provider_declared" } }).success, false);
  assert.equal(ModelLimitSource.safeParse({ ...catalog()[0]!.limit_source, source_url: "http://127.0.0.1/private?key=fixture" }).success, false);
  assert.equal(ModelLimitSource.safeParse({ ...catalog()[0]!.limit_source, trust: "upstream_verified" }).success, false);
  const parsed = ModelTokenBudget.parse(valid);
  assert.deepEqual(parsed, valid);
  assert.notEqual(parsed, valid);
  assert.equal(ModelLimitSource.safeParse({ ...catalog()[0]!.limit_source,
    context_window: { field: "maxTokens", status: "declared" } }).success, false);
  assert.equal(ModelLimitSource.safeParse({ ...catalog()[0]!.limit_source,
    context_window: { field: null, status: "invalid" } }).success, false);
});

test("#958 manual Pi models files receive the identical effective budget on the selected entry only", () => {
  const makeFile = (path: string, content: string) => ({ path, content,
    content_sha256: createHash("sha256").update(content).digest("hex") });
  for (const entry of [{ id: modelId }, { id: modelId, contextWindow: 100_000, maxTokens: 4096 }]) {
    const providers = { magpie: { api: "openai-completions", models: [entry, { id: "other-model", contextWindow: 80_000 }] },
      other: { api: "openai-completions", models: [{ id: modelId, contextWindow: 64_000, maxTokens: 2048 }] } };
    const sidecar = makeFile(".pi/agent/settings.json", "{\"unchanged\":true}\n");
    const files = [makeFile(".pi/agent/models.json", JSON.stringify({ providers })), sidecar];
    const original = JSON.stringify(files);
    const snapshot = projectProviderRuntimeSnapshot({ agentCli: "pi", roleModel: `magpie/${modelId}`, roleContextWindowTokens: 200_000,
      contextSource: "job", settingsConfig: {}, manualConfigFiles: files, credentialProvider: "openai", catalogJson: catalog() });
    const document = JSON.parse(snapshot.config_files[0]!.content);
    assert.equal(snapshot.pi_provider, "magpie");
    assert.equal(snapshot.model_budget.context_window_tokens.effective, 200_000);
    assert.equal(document.providers.magpie.models[0].contextWindow, 200_000);
    assert.equal(document.providers.magpie.models[0].maxTokens, snapshot.model_budget.max_output_tokens.effective);
    assert.deepEqual(document.providers.magpie.models[1], providers.magpie.models[1]);
    assert.deepEqual(document.providers.other, providers.other);
    assert.equal(snapshot.config_files[1], sidecar);
    assert.equal(snapshot.config_files[0]?.content_sha256, createHash("sha256").update(snapshot.config_files[0]!.content).digest("hex"));
    assert.equal(JSON.stringify(files), original);
  }
  const manual = [makeFile(".pi/agent/models.json", JSON.stringify(settings()))];
  const fromDefault = projectProviderRuntimeSnapshot({ agentCli: "pi", settingsConfig: {}, defaultModel: `magpie/${modelId}`,
    manualConfigFiles: manual, credentialProvider: "openai", catalogJson: catalog() });
  assert.equal(fromDefault.model_budget.context_window_tokens.effective, 1_000_000);
  assert.equal(fromDefault.model_budget.max_output_tokens.effective, 64_000);
  assert.equal(native(fromDefault)[0]?.contextWindow, 1_000_000);
  assert.equal(native(fromDefault)[0]?.maxTokens, 64_000);
  const unknown = projectProviderRuntimeSnapshot({ agentCli: "pi", settingsConfig: {}, roleModel: `magpie/${modelId}`, manualConfigFiles: manual });
  assert.equal(unknown.model_budget.context_window_tokens.effective, null);
  assert.equal(unknown.config_files[0], manual[0], "unknown CLI defaults do not rewrite the manual file");
});
