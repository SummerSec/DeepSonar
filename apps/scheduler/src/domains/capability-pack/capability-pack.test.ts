import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_PLATFORM_TOOLS,
  CAPABILITY_PACK_SCHEMA,
  CapabilityPackDraft,
  CapabilityPackManifest,
  DEFAULT_MODEL_REPAIR_ATTEMPT_BUDGET,
  REPAIR_FEEDBACK_CATEGORIES,
  REPAIR_FEEDBACK_SCHEMA_VERSION,
  RepairFeedback,
  buildRepairFeedback,
  describeObservedShape,
} from "@deepsonar/shared-types";
import { contentHashOf, type SourceModule } from "../../skill-sources.js";
import {
  BUILTIN_CAPABILITY_PACKS,
  capabilityPackDigest,
  freezeCapabilityPackManifest,
  freezeTaskCapabilityPack,
  manifestFromRoleConfig,
  manifestFromSkillModule,
  moduleCapabilityId,
  redactedSelectorShape,
  repairFromMissingModule,
  selectorRepairPath,
} from "./catalog.js";
import {
  buildCapabilityCatalog,
  describeCapability,
  listCapabilities,
  previewMaterialization,
  searchCapabilities,
  validateComposition,
  type CapabilityJobEnvelope,
} from "./discovery.js";

const SOURCE = "11111111-1111-4111-8111-111111111111";

function moduleOf(id: string, extras: Partial<SourceModule> = {}): SourceModule {
  return {
    id,
    kind: "skill",
    plugin: extras.plugin ?? "whitebox",
    name: extras.name ?? id,
    description: extras.description ?? "maps repository entry points",
    files: extras.files ?? { "SKILL.md": `# ${id}` },
  };
}

function job(overrides: Partial<CapabilityJobEnvelope> = {}): CapabilityJobEnvelope {
  return {
    roleName: "audit",
    roleDescription: "audit RoleConfig",
    platformTools: ["emit_progress", "emit_finding", "mark_job_done", "list_capabilities"],
    allowEgress: false,
    selectors: [],
    moduleContentHash: "abc",
    ...overrides,
  };
}

function draft(overrides: Partial<CapabilityPackDraft> = {}): CapabilityPackDraft {
  return CapabilityPackDraft.parse({
    schema: CAPABILITY_PACK_SCHEMA,
    id: "task.surface",
    version: "0.1.0",
    scope: "task",
    summary: "compose a surface map from admitted capabilities",
    capabilities: ["repository.surface_map", "emit_fact"],
    inputs: [{ name: "target", schema: "string", required: true }],
    outputs: [{ name: "surface_map", artifact_schema: "fact.surface_map" }],
    permissions: { platform_tools: ["emit_finding"], allow_egress: false },
    budget: { max_attempts: 3, max_tokens: 20_000 },
    failure_policy: { correctable: true, replay: "same_session" },
    evaluator: "capability.task.surface.v1",
    ...overrides,
  });
}

test("capability pack digest is stable and unknown fields are rejected", () => {
  const first = freezeCapabilityPackManifest(draft());
  const second = freezeCapabilityPackManifest(draft());
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.digest, capabilityPackDigest(draft()));
  assert.notEqual(capabilityPackDigest(draft({ summary: "compose a different surface map pack" })), first.digest);
  assert.throws(() => CapabilityPackManifest.parse({ ...first, extra: true }), /unrecognized|invalid/i);
  assert.throws(() => CapabilityPackDraft.parse({ ...draft(), digest: first.digest }), /unrecognized|invalid/i);
});

test("builtin packs wrap existing roles and management skill", () => {
  const ids = BUILTIN_CAPABILITY_PACKS.map((pack) => pack.manifest.id);
  for (const id of [
    "repository.surface_map",
    "repository.analysis",
    "repository.static_audit",
    "repository.runtime_reproduction",
    "repository.change",
    "evidence.independent_review",
    "finding.verify",
    "deepsonar.management",
  ]) {
    assert.ok(ids.includes(id), `missing builtin ${id}`);
  }
  assert.equal(BUILTIN_CAPABILITY_PACKS.find((pack) => pack.role === "explore")?.manifest.id, "repository.surface_map");
  assert.equal(BUILTIN_CAPABILITY_PACKS.find((pack) => pack.skill_name === "deepsonar-management")?.manifest.permissions.platform_tools.length, 0);
  for (const pack of BUILTIN_CAPABILITY_PACKS) {
    assert.equal(pack.manifest.schema, CAPABILITY_PACK_SCHEMA);
    assert.equal(pack.source_kind, "builtin");
  }
});

test("git module and RoleConfig adapters emit read-only manifests", () => {
  const module = manifestFromSkillModule({
    sourceId: SOURCE,
    module: moduleOf("whitebox/authz"),
    commitSha: "abc123",
    contentHash: contentHashOf([moduleOf("whitebox/authz")]),
  });
  assert.equal(module.source_kind, "skill_module");
  assert.equal(module.selector, `${SOURCE}:whitebox/authz`);
  assert.equal(module.manifest.scope, "global");
  assert.match(module.manifest.id, /^module\./);

  const role = manifestFromRoleConfig({
    roleName: "audit",
    summary: "project audit RoleConfig",
    platformTools: ["emit_finding", "mark_job_done"],
    allowEgress: false,
    selectors: [`${SOURCE}:whitebox/authz`],
    moduleContentHash: "hash",
  });
  assert.equal(role.source_kind, "role_config");
  assert.equal(role.manifest.id, "role.audit");
  assert.deepEqual(role.manifest.permissions.platform_tools, ["emit_finding", "mark_job_done"]);
});

test("missing modules become structured RepairFeedback", () => {
  const available = [`${SOURCE}:whitebox/authz`];
  const missing = repairFromMissingModule({
    selector: `${SOURCE}:missing`,
    source_id: SOURCE,
    reason: "module-not-found",
  }, available);
  assert.equal(missing.category, "model_correctable");
  assert.equal(missing.code, "MODULE_NOT_FOUND");
  assert.equal(missing.operation, "validate_composition");
  assert.equal(missing.next_action, "replace_with_available_capability_and_resubmit");
  assert.deepEqual(missing.expected, { kind: "trusted_capability_or_module_selector", available });
  assert.deepEqual(missing.observed_shape, { ...redactedSelectorShape(`${SOURCE}:missing`), reason: "module-not-found" });
  assert.equal(missing.path, selectorRepairPath(`${SOURCE}:missing`));
  assert.equal(missing.remaining_budget.attempts, DEFAULT_MODEL_REPAIR_ATTEMPT_BUDGET);

  const untrusted = repairFromMissingModule({
    selector: `${SOURCE}:whitebox/authz`,
    source_id: SOURCE,
    reason: "source-not-trusted",
  }, available);
  assert.equal(untrusted.category, "permanent_failure");
  assert.equal(untrusted.code, "UNTRUSTED_SOURCE");
  assert.deepEqual(untrusted.remaining_budget, {});

  const conflict = repairFromMissingModule({
    selector: `${SOURCE}:whitebox/authz`,
    source_id: SOURCE,
    reason: "name-conflict",
    kind: "skill",
    name: "authz",
    conflicts_with: [{ source_id: SOURCE, module_id: "other/authz", kind: "skill", name: "authz" }],
  }, available);
  assert.equal(conflict.code, "NAME_CONFLICT");
});

test("list and search return summaries without skill bodies", () => {
  const catalog = buildCapabilityCatalog({
    sources: [{
      id: SOURCE,
      trust_status: "trusted",
      enabled: true,
      last_commit_sha: "abc",
      last_content_hash: "def",
      catalog: [moduleOf("whitebox/authz")],
    }],
    job: job(),
  });
  const listed = listCapabilities(catalog, { scope: "builtin" });
  assert.ok(listed.capabilities.every((item) => item.scope === "builtin"));
  assert.ok(listed.capabilities.some((item) => item.id === "repository.surface_map"));
  assert.equal("files" in listed.capabilities[0]!, false);

  const found = searchCapabilities(catalog, { query: "surface_map" });
  assert.equal(found.capabilities[0]?.id, "repository.surface_map");
  const moduleHit = searchCapabilities(catalog, { query: "authz" });
  assert.ok(moduleHit.capabilities.some((item) => item.id.startsWith("module.")));
});

test("describe returns the full machine contract or RepairFeedback", () => {
  const catalog = buildCapabilityCatalog({});
  const found = describeCapability(catalog, { id: "repository.static_audit" });
  assert.equal(found.capability?.id, "repository.static_audit");
  assert.equal(found.repair.length, 0);
  const missing = describeCapability(catalog, { id: "repository.does-not-exist" });
  assert.equal(missing.capability, null);
  assert.equal(missing.repair[0]?.code, "CAPABILITY_NOT_FOUND");
  const digestMiss = describeCapability(catalog, {
    id: "repository.static_audit",
    digest: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  });
  assert.equal(digestMiss.repair[0]?.code, "CAPABILITY_NOT_FOUND");
});

test("validate and preview freeze selectors and reject permission expansion", () => {
  const sources = [{
    id: SOURCE,
    trust_status: "trusted",
    enabled: true,
    last_commit_sha: "abc",
    catalog: [moduleOf("whitebox/authz")],
  }];
  const catalog = buildCapabilityCatalog({ sources, job: job() });
  const ok = previewMaterialization(
    catalog,
    job(),
    { pack_manifest: draft({ capabilities: ["repository.surface_map"], permissions: { platform_tools: ["emit_finding"], allow_egress: false } }), selectors: [`${SOURCE}:whitebox/authz`] },
    sources,
  );
  assert.equal(ok.ok, true);
  assert.match(ok.digest ?? "", /^sha256:/);
  assert.deepEqual(ok.selectors, [`${SOURCE}:whitebox/authz`]);
  assert.equal(ok.resolved_modules[0]?.module_id, "whitebox/authz");

  const escalate = validateComposition(
    catalog,
    job(),
    { pack_manifest: draft({ permissions: { platform_tools: ["submit_hub_decision"], allow_egress: true } }) },
    sources,
  );
  assert.equal(escalate.ok, false);
  assert.ok(escalate.repair.some((item) => item.code === "PERMISSION_ESCALATION"));
  assert.ok(escalate.repair.every((item) => item.category === "permanent_failure"));

  const missing = validateComposition(
    catalog,
    job(),
    { pack_manifest: draft(), selectors: [`${SOURCE}:missing`] },
    sources,
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.repair[0]?.code, "MODULE_NOT_FOUND");

  const untrusted = validateComposition(
    catalog,
    job(),
    { pack_manifest: draft({ capabilities: ["repository.surface_map"] }), selectors: [`${SOURCE}:whitebox/authz`] },
    [{ ...sources[0]!, trust_status: "quarantined" }],
  );
  assert.equal(untrusted.repair[0]?.code, "UNTRUSTED_SOURCE");
});

test("task pack freeze digest covers selectors and resolved modules", () => {
  const first = freezeTaskCapabilityPack({
    roleName: "audit",
    summary: "audit RoleConfig",
    platformTools: ["emit_finding"],
    selectors: [`${SOURCE}:whitebox/authz`],
    resolvedModules: [{
      source_id: SOURCE,
      module_id: "whitebox/authz",
      kind: "skill",
      plugin: "whitebox",
      name: "authz",
      description: "",
      content_hash: "one",
    }],
    moduleContentHash: "one",
  });
  const drifted = freezeTaskCapabilityPack({
    ...first,
    roleName: "audit",
    summary: "audit RoleConfig",
    platformTools: ["emit_finding"],
    selectors: [`${SOURCE}:whitebox/authz`],
    resolvedModules: [{
      source_id: SOURCE,
      module_id: "whitebox/authz",
      kind: "skill",
      plugin: "whitebox",
      name: "authz",
      description: "",
      content_hash: "two",
    }],
    moduleContentHash: "two",
  });
  assert.notEqual(first.digest, drifted.digest);
  assert.deepEqual(first.selectors, [`${SOURCE}:whitebox/authz`]);
  assert.equal(first.scope, "task");
});

test("frozen Job pack is the discovery upper bound after the live source mutates", () => {
  const original = moduleOf("whitebox/authz");
  const frozen = freezeTaskCapabilityPack({
    roleName: "audit",
    summary: "audit RoleConfig",
    platformTools: ["emit_finding", "mark_job_done", "list_capabilities"],
    selectors: [`${SOURCE}:whitebox/authz`],
    resolvedModules: [{
      source_id: SOURCE,
      module_id: "whitebox/authz",
      kind: "skill",
      plugin: "whitebox",
      name: "authz",
      description: original.description,
      content_hash: contentHashOf([original]),
    }],
    moduleContentHash: contentHashOf([original]),
  });
  const frozenJob = job({
    platformTools: ["emit_finding", "mark_job_done", "list_capabilities"],
    selectors: frozen.selectors,
    moduleContentHash: frozen.module_content_hash,
    frozen,
  });
  const originalSources = [{
    id: SOURCE,
    trust_status: "trusted",
    enabled: true,
    last_commit_sha: "abc",
    catalog: [original],
  }];
  const mutatedSources = [{
    id: SOURCE,
    trust_status: "trusted",
    enabled: true,
    last_commit_sha: "def",
    catalog: [
      moduleOf("whitebox/authz", { files: { "SKILL.md": "# mutated after freeze" } }),
      moduleOf("whitebox/new-gadget"),
    ],
  }];

  const before = buildCapabilityCatalog({ sources: originalSources, job: frozenJob });
  const after = buildCapabilityCatalog({ sources: mutatedSources, job: frozenJob });
  const beforeIds = listCapabilities(before, {}).capabilities.map((item) => item.id).sort();
  const afterIds = listCapabilities(after, {}).capabilities.map((item) => item.id).sort();
  assert.deepEqual(afterIds, beforeIds);
  assert.ok(beforeIds.includes(moduleCapabilityId(SOURCE, "whitebox/authz")));
  assert.equal(afterIds.includes(moduleCapabilityId(SOURCE, "whitebox/new-gadget")), false);
  assert.equal(
    describeCapability(after, { id: moduleCapabilityId(SOURCE, "whitebox/authz") }).capability?.digest,
    describeCapability(before, { id: moduleCapabilityId(SOURCE, "whitebox/authz") }).capability?.digest,
  );

  const preview = previewMaterialization(
    after,
    frozenJob,
    { pack_manifest: draft({ capabilities: ["repository.surface_map"], permissions: { platform_tools: ["emit_finding"], allow_egress: false } }), selectors: frozen.selectors },
    mutatedSources,
  );
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.resolved_modules.map((module) => module.content_hash), frozen.resolved_modules.map((module) => module.content_hash));
  assert.equal(preview.resolved_modules[0]?.content_hash, contentHashOf([original]));
  assert.notEqual(preview.resolved_modules[0]?.content_hash, contentHashOf([mutatedSources[0]!.catalog[0]!]));

  const expanded = validateComposition(
    after,
    frozenJob,
    { pack_manifest: draft({ capabilities: ["repository.surface_map"] }), selectors: [`${SOURCE}:whitebox/new-gadget`] },
    mutatedSources,
  );
  assert.equal(expanded.ok, false);
  assert.ok(expanded.repair.some((item) => item.code === "SELECTOR_NOT_FROZEN" && item.category === "permanent_failure"));
});

test("long missing selectors stay inside RepairFeedback.path and do not leak raw text", () => {
  const longSelector = `${SOURCE}:whitebox/${"n".repeat(900)}`;
  assert.ok(longSelector.length > 240);
  assert.ok(longSelector.length <= 1024);
  const feedback = repairFromMissingModule({
    selector: longSelector,
    source_id: SOURCE,
    reason: "module-not-found",
  }, [longSelector]);
  assert.equal(RepairFeedback.safeParse(feedback).success, true);
  assert.ok((feedback.path?.length ?? 0) <= 240);
  assert.equal(feedback.path, selectorRepairPath(longSelector));
  const serialized = JSON.stringify(feedback);
  assert.equal(serialized.includes(longSelector), false);
  assert.equal(serialized.includes("n".repeat(80)), false);
  assert.deepEqual(feedback.observed_shape, { ...redactedSelectorShape(longSelector), reason: "module-not-found" });
});

type KernelRepairCategory = "model_correctable" | "transient_retryable" | "unknown_external_effect" | "permanent_failure";
type AssertSame<A, B> = [A] extends [B] ? [B] extends [A] ? true : never : never;
const _kernelCategoryParity: AssertSame<typeof REPAIR_FEEDBACK_CATEGORIES[number], KernelRepairCategory> = true;
void _kernelCategoryParity;

test("capability pack repair reuses the #453 kernel RepairFeedback contract", () => {
  assert.deepEqual([...REPAIR_FEEDBACK_CATEGORIES], [
    "model_correctable",
    "transient_retryable",
    "unknown_external_effect",
    "permanent_failure",
  ]);
  assert.equal(REPAIR_FEEDBACK_SCHEMA_VERSION, 1);
  assert.equal(typeof buildRepairFeedback, "function");
  assert.equal(typeof describeObservedShape, "function");

  const kernel = buildRepairFeedback({
    category: "model_correctable",
    code: "invalid_payload",
    operation: "emit_fact",
    message: "字段不符合契约。",
  });
  const parsedKernel = RepairFeedback.safeParse(kernel);
  assert.equal(parsedKernel.success, true);
  assert.equal(parsedKernel.success && parsedKernel.data.v, 1);

  for (const category of ["policy", "transient", "unknown"] as const) {
    assert.equal(RepairFeedback.safeParse({
      ...kernel,
      category,
    }).success, false, category);
  }

  const catalog = buildCapabilityCatalog({});
  const missing = describeCapability(catalog, { id: "repository.does-not-exist" }).repair[0];
  assert.ok(missing);
  const parsedPack = RepairFeedback.safeParse(missing);
  assert.equal(parsedPack.success, true);
  assert.equal(parsedPack.success && parsedPack.data.v, 1);
  assert.equal(parsedPack.success && parsedPack.data.operation, "describe_capability");
  assert.equal(parsedPack.success && "current_state" in parsedPack.data, false);
  assert.equal(parsedPack.success && "repair_budget_remaining" in parsedPack.data, false);
  assert.equal(parsedPack.success && typeof parsedPack.data.remaining_budget, "object");
  assert.ok(REPAIR_FEEDBACK_CATEGORIES.includes(missing.category));
});

test("new discovery tools are part of the default platform tool set", () => {
  for (const tool of [
    "list_capabilities",
    "search_capabilities",
    "describe_capability",
    "validate_composition",
    "preview_materialization",
  ]) {
    assert.ok(ALL_PLATFORM_TOOLS.includes(tool as typeof ALL_PLATFORM_TOOLS[number]));
  }
});
