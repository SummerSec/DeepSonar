import { createHash } from "node:crypto";
import {
  CAPABILITY_PACK_SCHEMA,
  CapabilityPackDraft,
  CapabilityPackManifest,
  CapabilityPackSummary,
  buildRepairFeedback,
  describeObservedShape,
  parseModuleSelector,
  type CapabilityPackScope,
  type RepairFeedback,
} from "@deepsonar/shared-types";
import type { ExpandedModuleSnapshot, MissingModule, SourceModule } from "../../skill-sources.js";

export const CAPABILITY_TOKENS = [
  "read_workspace",
  "emit_progress",
  "emit_fact",
  "emit_finding",
  "submit_hub_decision",
  "mark_job_done",
  "request_human",
  "list_available_roles",
  "list_available_runtime_images",
  "list_capabilities",
  "search_capabilities",
  "describe_capability",
  "validate_composition",
  "preview_materialization",
  "list_shared_assets",
  "publish_shared_asset",
  "ack_human_message",
  "manage_platform",
] as const;

export type CapabilityToken = (typeof CAPABILITY_TOKENS)[number];

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function capabilityPackDigest(draft: CapabilityPackDraft): string {
  return `sha256:${createHash("sha256").update(canonicalJson(draft)).digest("hex")}`;
}

export function freezeCapabilityPackManifest(draft: CapabilityPackDraft): CapabilityPackManifest {
  return CapabilityPackManifest.parse({ ...draft, digest: capabilityPackDigest(draft) });
}

const DEFAULT_BUDGET = { max_attempts: 3, max_tokens: 50_000 } as const;
const CORRECTABLE_POLICY = { correctable: true, replay: "same_session" } as const;

export interface CapabilityCatalogRecord {
  manifest: CapabilityPackManifest;
  source_kind: CapabilityPackSummary["source_kind"];
  selector?: string;
  role?: string;
  skill_name?: string;
}

export interface FrozenCapabilityPack {
  schema: typeof CAPABILITY_PACK_SCHEMA;
  id: string;
  version: string;
  digest: string;
  manifest_digest: string;
  scope: "task";
  selectors: string[];
  resolved_modules: Array<{ source_id: string; module_id: string; content_hash: string }>;
  module_content_hash: string;
  permissions: { platform_tools: string[]; allow_egress?: boolean };
}

function draft(partial: Omit<CapabilityPackDraft, "schema">): CapabilityPackDraft {
  return CapabilityPackDraft.parse({ schema: CAPABILITY_PACK_SCHEMA, ...partial });
}

function builtin(
  id: string,
  summary: string,
  capabilities: string[],
  extras: {
    role?: string;
    skill_name?: string;
    inputs?: CapabilityPackDraft["inputs"];
    outputs?: CapabilityPackDraft["outputs"];
    platform_tools: string[];
    allow_egress?: boolean;
    evaluator: string;
  },
): CapabilityCatalogRecord {
  const manifest = freezeCapabilityPackManifest(draft({
    id,
    version: "1.0.0",
    scope: "builtin",
    summary,
    capabilities,
    inputs: extras.inputs ?? [{ name: "target", schema: "string", required: true }],
    outputs: extras.outputs ?? [{ name: "facts", artifact_schema: "canvas.fact" }],
    permissions: { platform_tools: extras.platform_tools, allow_egress: extras.allow_egress ?? false },
    budget: { ...DEFAULT_BUDGET },
    failure_policy: { ...CORRECTABLE_POLICY },
    evaluator: extras.evaluator,
  }));
  return {
    manifest,
    source_kind: "builtin",
    ...(extras.role ? { role: extras.role } : {}),
    ...(extras.skill_name ? { skill_name: extras.skill_name } : {}),
  };
}

export const BUILTIN_CAPABILITY_PACKS: readonly CapabilityCatalogRecord[] = [
  builtin("repository.surface_map", "建立目标边界、入口和可复核事实", ["read_workspace", "emit_fact"], {
    role: "explore",
    platform_tools: ["emit_progress", "emit_fact", "mark_job_done"],
    evaluator: "capability.surface_map.v1",
    outputs: [{ name: "surface_map", artifact_schema: "fact.surface_map" }],
  }),
  builtin("repository.analysis", "在已有事实上分析因果、范围与风险", ["read_workspace", "emit_fact"], {
    role: "analyze",
    platform_tools: ["emit_progress", "emit_fact", "mark_job_done"],
    evaluator: "capability.analysis.v1",
  }),
  builtin("evidence.independent_review", "独立复核 Finding 主体与证据是否一致", ["read_workspace", "emit_fact"], {
    role: "review",
    platform_tools: ["emit_progress", "emit_fact", "mark_job_done"],
    evaluator: "capability.independent_review.v1",
    inputs: [{ name: "finding_id", schema: "uuid", required: true }],
    outputs: [{ name: "review_fact", artifact_schema: "fact.verification" }],
  }),
  builtin("repository.runtime_reproduction", "用运行时步骤复现并记录 expected/actual", ["read_workspace", "emit_fact"], {
    role: "test",
    platform_tools: ["emit_progress", "emit_fact", "mark_job_done"],
    evaluator: "capability.runtime_reproduction.v1",
    outputs: [{ name: "reproduction", artifact_schema: "fact.verification" }],
  }),
  builtin("repository.change", "按 intent 提出最小代码或配置变更", ["read_workspace", "emit_fact"], {
    role: "code",
    platform_tools: ["emit_progress", "emit_fact", "mark_job_done"],
    evaluator: "capability.change.v1",
  }),
  builtin("repository.static_audit", "从本地材料提出带证据的 Finding", ["read_workspace", "emit_finding"], {
    role: "audit",
    platform_tools: ["emit_progress", "emit_finding", "mark_job_done"],
    evaluator: "capability.static_audit.v1",
    outputs: [{ name: "finding", artifact_schema: "finding.sarif_aligned" }],
  }),
  builtin("finding.verify", "只消费已校验 Fact 的系统验证角色，不重读 maker 结论", ["read_workspace", "mark_job_done"], {
    role: "verify",
    platform_tools: ["emit_progress", "mark_job_done"],
    evaluator: "capability.finding_verify.v1",
    inputs: [{ name: "finding_id", schema: "uuid", required: true }],
    outputs: [{ name: "verdict", artifact_schema: "verify.verdict" }],
  }),
  builtin("deepsonar.management", "通过管理 API 操作项目、任务、RoleConfig 与模块源", ["manage_platform"], {
    skill_name: "deepsonar-management",
    platform_tools: [],
    evaluator: "capability.management.v1",
    inputs: [{ name: "command", schema: "string", required: true }],
    outputs: [{ name: "api_result", artifact_schema: "management.json" }],
  }),
];

const ROLE_PACK_ID: Record<string, string> = Object.fromEntries(
  BUILTIN_CAPABILITY_PACKS.filter((pack) => pack.role).map((pack) => [pack.role!, pack.manifest.id]),
);

export function builtinPackIdForRole(roleName: string): string | undefined {
  return ROLE_PACK_ID[roleName];
}

export function moduleCapabilityId(sourceId: string, moduleId: string): string {
  const slug = moduleId.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
  return `module.${sourceId}.${slug}`.slice(0, 160);
}

export function roleCapabilityId(roleName: string): string {
  const slug = roleName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "role";
  return `role.${slug}`.slice(0, 160);
}

export function manifestFromSkillModule(input: {
  sourceId: string;
  module: SourceModule;
  commitSha?: string | null;
  contentHash: string;
}): CapabilityCatalogRecord {
  const selector = `${input.sourceId}:${input.module.id}`;
  const summary = (input.module.description.trim() || `${input.module.kind} ${input.module.name}`).slice(0, 400);
  const padded = summary.length >= 8 ? summary : `${summary} capability`.slice(0, 400);
  const manifest = freezeCapabilityPackManifest(draft({
    id: moduleCapabilityId(input.sourceId, input.module.id),
    version: (input.commitSha ?? "0.0.0").slice(0, 40),
    scope: "global",
    summary: padded,
    capabilities: ["read_workspace"],
    inputs: [{ name: "workspace", schema: "string", required: false }],
    outputs: [{ name: input.module.kind, artifact_schema: `skill.${input.module.kind}` }],
    permissions: { platform_tools: [], allow_egress: false },
    budget: { ...DEFAULT_BUDGET },
    failure_policy: { ...CORRECTABLE_POLICY },
    evaluator: `capability.module.${input.contentHash.slice(0, 12)}`,
  }));
  return { manifest, source_kind: "skill_module", selector, skill_name: input.module.name };
}

export function manifestFromRoleConfig(input: {
  roleName: string;
  summary: string;
  platformTools: readonly string[];
  allowEgress: boolean;
  selectors: readonly string[];
  moduleContentHash: string;
}): CapabilityCatalogRecord {
  const id = roleCapabilityId(input.roleName);
  const builtin = BUILTIN_CAPABILITY_PACKS.find((pack) => pack.role === input.roleName);
  const summary = (input.summary.trim() || `${input.roleName} RoleConfig projection`).slice(0, 400);
  const padded = summary.length >= 8 ? summary : `${input.roleName} role pack`;
  const manifest = freezeCapabilityPackManifest(draft({
    id,
    version: "1.0.0",
    scope: "project",
    summary: padded,
    capabilities: builtin?.manifest.capabilities ?? ["read_workspace"],
    inputs: builtin?.manifest.inputs ?? [{ name: "target", schema: "string", required: true }],
    outputs: builtin?.manifest.outputs ?? [{ name: "facts", artifact_schema: "canvas.fact" }],
    permissions: { platform_tools: [...input.platformTools], allow_egress: input.allowEgress },
    budget: { ...DEFAULT_BUDGET },
    failure_policy: { ...CORRECTABLE_POLICY },
    evaluator: builtin?.manifest.evaluator ?? `capability.role.${input.roleName}.v1`,
  }));
  return { manifest, source_kind: "role_config", role: input.roleName };
}

export function projectFrozenSkillModules(frozen: FrozenCapabilityPack): CapabilityCatalogRecord[] {
  return frozen.resolved_modules.map((module) => {
    const slash = module.module_id.indexOf("/");
    return manifestFromSkillModule({
      sourceId: module.source_id,
      module: {
        id: module.module_id,
        kind: "skill",
        plugin: slash > 0 ? module.module_id.slice(0, slash) : "frozen",
        name: module.module_id,
        description: "frozen job capability module",
        files: {},
      },
      contentHash: module.content_hash,
    });
  });
}

function frozenModuleMatchesSelector(
  module: FrozenCapabilityPack["resolved_modules"][number],
  selector: ReturnType<typeof parseModuleSelector>,
): boolean {
  if (module.source_id !== selector.source_id) return false;
  if (selector.kind === "source") return true;
  if (selector.kind === "module") return module.module_id === selector.module_id;
  return Boolean(selector.plugin && (module.module_id === selector.plugin || module.module_id.startsWith(`${selector.plugin}/`)));
}

export function resolveFrozenModulesForSelectors(
  frozen: FrozenCapabilityPack,
  selectors: readonly string[],
): FrozenCapabilityPack["resolved_modules"] {
  if (selectors.length === 0) return [];
  const parsed = selectors.flatMap((selector) => {
    try {
      return [parseModuleSelector(selector)];
    } catch {
      return [];
    }
  });
  return frozen.resolved_modules.filter((module) => parsed.some((selector) => frozenModuleMatchesSelector(module, selector)));
}

export function expandedFromFrozen(module: FrozenCapabilityPack["resolved_modules"][number]): ExpandedModuleSnapshot {
  const slash = module.module_id.indexOf("/");
  return {
    source_id: module.source_id,
    module_id: module.module_id,
    kind: "skill",
    plugin: slash > 0 ? module.module_id.slice(0, slash) : "frozen",
    name: module.module_id,
    description: "",
    content_hash: module.content_hash,
  };
}

const REPAIR_PATH_MAX = 240;

export function selectorFingerprint(selector: string): string {
  return createHash("sha256").update(selector).digest("hex").slice(0, 16);
}

export function boundRepairPath(path: string): string {
  if (path.length <= REPAIR_PATH_MAX) return path;
  const digest = selectorFingerprint(path);
  return `path.sha256:${digest}`;
}

export function selectorRepairPath(selector: string): string {
  return boundRepairPath(`selectors.sha256:${selectorFingerprint(selector)}`);
}

export function redactedSelectorShape(selector: string): Record<string, unknown> {
  return {
    ...describeObservedShape(selector),
    sha256: selectorFingerprint(selector),
  };
}

function redactSelectorList(available: readonly string[]): string[] {
  return available.map((item) => (item.length <= 80 ? item : `sha256:${selectorFingerprint(item)}`));
}

export function freezeTaskCapabilityPack(input: {
  roleName: string;
  summary: string;
  platformTools: readonly string[];
  allowEgress?: boolean;
  selectors: readonly string[];
  resolvedModules: readonly ExpandedModuleSnapshot[];
  moduleContentHash: string;
}): FrozenCapabilityPack {
  const record = manifestFromRoleConfig({
    roleName: input.roleName,
    summary: input.summary,
    platformTools: input.platformTools,
    allowEgress: input.allowEgress ?? false,
    selectors: input.selectors,
    moduleContentHash: input.moduleContentHash,
  });
  const resolved_modules = input.resolvedModules.map((module) => ({
    source_id: module.source_id,
    module_id: module.module_id,
    content_hash: module.content_hash,
  }));
  const freezeBody = {
    manifest_digest: record.manifest.digest,
    selectors: [...input.selectors],
    resolved_modules,
    module_content_hash: input.moduleContentHash,
    permissions: { platform_tools: [...input.platformTools], allow_egress: input.allowEgress ?? false },
  };
  return {
    schema: CAPABILITY_PACK_SCHEMA,
    id: record.manifest.id,
    version: record.manifest.version,
    digest: `sha256:${createHash("sha256").update(canonicalJson(freezeBody)).digest("hex")}`,
    manifest_digest: record.manifest.digest,
    scope: "task",
    selectors: freezeBody.selectors,
    resolved_modules,
    module_content_hash: input.moduleContentHash,
    permissions: freezeBody.permissions,
  };
}

export function summarizeCapability(record: CapabilityCatalogRecord): CapabilityPackSummary {
  return {
    id: record.manifest.id,
    version: record.manifest.version,
    digest: record.manifest.digest,
    scope: record.manifest.scope,
    summary: record.manifest.summary,
    source_kind: record.source_kind,
  };
}

function packRepair(input: {
  category: "model_correctable" | "permanent_failure";
  code: string;
  operation: string;
  path: string;
  message: string;
  expected: unknown;
  observed: unknown;
  current_state_ref?: string;
  next_action: string;
}): RepairFeedback {
  return buildRepairFeedback({
    category: input.category,
    code: input.code,
    operation: input.operation,
    path: boundRepairPath(input.path),
    message: input.message,
    expected: input.expected,
    observed_shape: input.observed && typeof input.observed === "object"
      ? input.observed
      : describeObservedShape(input.observed),
    current_state_ref: input.current_state_ref ? boundRepairPath(input.current_state_ref) : undefined,
    next_action: input.next_action,
  });
}

export function repairFromMissingModule(
  missing: MissingModule,
  available: string[],
  operation = "validate_composition",
): RepairFeedback {
  const path = selectorRepairPath(missing.selector);
  const current_state_ref = `skill_sources:${missing.source_id}`;
  const availableSafe = redactSelectorList(available);
  if (missing.reason === "source-not-trusted") {
    return packRepair({
      category: "permanent_failure",
      code: "UNTRUSTED_SOURCE",
      operation,
      path,
      message: "模块来源未信任或未启用，Job 不能自行放宽来源策略。",
      expected: { kind: "trusted_enabled_source", available: availableSafe },
      observed: { ...redactedSelectorShape(missing.selector), reason: missing.reason },
      current_state_ref,
      next_action: "replace_with_trusted_source_or_ask_admin_to_trust",
    });
  }
  if (missing.reason === "name-conflict") {
    return packRepair({
      category: "model_correctable",
      code: "NAME_CONFLICT",
      operation,
      path,
      message: "模块名称与已挂载 skill/command 冲突。",
      expected: { kind: "unique_skill_or_command_name", conflicts_with: missing.conflicts_with ?? [] },
      observed: { ...redactedSelectorShape(missing.selector), reason: missing.reason },
      current_state_ref,
      next_action: "choose_one_conflicting_module_and_resubmit",
    });
  }
  if (missing.reason === "manual-override") {
    return packRepair({
      category: "permanent_failure",
      code: "MANUAL_OVERRIDE",
      operation,
      path,
      message: "目录模块被 RoleConfig 手工 skill/command 覆盖。",
      expected: { kind: "catalog_module_not_shadowed" },
      observed: { ...redactedSelectorShape(missing.selector), reason: missing.reason },
      current_state_ref,
      next_action: "remove_manual_skill_or_command_override_and_resubmit",
    });
  }
  return packRepair({
    category: "model_correctable",
    code: "MODULE_NOT_FOUND",
    operation,
    path,
    message: "找不到对应的已信任模块或 Capability Pack。",
    expected: { kind: "trusted_capability_or_module_selector", available: availableSafe },
    observed: { ...redactedSelectorShape(missing.selector), reason: missing.reason },
    current_state_ref,
    next_action: "replace_with_available_capability_and_resubmit",
  });
}

export function repairCapabilityNotFound(
  id: string,
  path: string,
  available: string[],
  operation = "describe_capability",
): RepairFeedback {
  return packRepair({
    category: "model_correctable",
    code: "CAPABILITY_NOT_FOUND",
    operation,
    path,
    message: "请求的 Capability Pack 或 capability token 不在本 Job 可见目录中。",
    expected: { kind: "catalog_capability_id", available: redactSelectorList(available) },
    observed: id,
    current_state_ref: `capability:${id}`,
    next_action: "replace_with_available_capability_and_resubmit",
  });
}

export function repairPermissionEscalation(
  path: string,
  expected: unknown,
  observed: unknown,
  operation = "validate_composition",
): RepairFeedback {
  return packRepair({
    category: "permanent_failure",
    code: "PERMISSION_ESCALATION",
    operation,
    path,
    message: "组合不能扩大冻结 Job 的 platform_tools 或 allow_egress。",
    expected,
    observed,
    current_state_ref: "job.agent_snapshot.capability_pack",
    next_action: "remove_permissions_that_exceed_the_frozen_job_envelope",
  });
}

export function repairInvalidSelector(
  selector: string,
  message: string,
  available: string[],
  operation = "validate_composition",
): RepairFeedback {
  return packRepair({
    category: "model_correctable",
    code: "INVALID_SELECTOR",
    operation,
    path: "selectors",
    message: "模块 selector 无法解析。",
    expected: { kind: "module_selector", format: "source_uuid:module|plugin:path|source:*", available: redactSelectorList(available) },
    observed: { ...redactedSelectorShape(selector), reason: message },
    current_state_ref: selectorRepairPath(selector),
    next_action: "replace_with_available_capability_and_resubmit",
  });
}

export function repairSelectorNotFrozen(
  selector: string,
  frozenSelectors: readonly string[],
  operation = "validate_composition",
): RepairFeedback {
  return packRepair({
    category: "permanent_failure",
    code: "SELECTOR_NOT_FROZEN",
    operation,
    path: selectorRepairPath(selector),
    message: "组合不能引用冻结 Job Capability Pack 之外的 selector。",
    expected: { kind: "frozen_selectors", allowed: redactSelectorList(frozenSelectors) },
    observed: redactedSelectorShape(selector),
    current_state_ref: "job.agent_snapshot.capability_pack.selectors",
    next_action: "replace_with_frozen_selector_or_keep_the_job_pack",
  });
}

export function parseCompositionSelectors(selectors: readonly string[]): { parsed: ReturnType<typeof parseModuleSelector>[]; repair: RepairFeedback[] } {
  const parsed: ReturnType<typeof parseModuleSelector>[] = [];
  const feedback: RepairFeedback[] = [];
  for (const selector of selectors) {
    try {
      parsed.push(parseModuleSelector(selector));
    } catch (error) {
      feedback.push(repairInvalidSelector(selector, error instanceof Error ? error.message : String(error), []));
    }
  }
  return { parsed, repair: feedback };
}

export function isKnownCapabilityToken(value: string): boolean {
  return (CAPABILITY_TOKENS as readonly string[]).includes(value);
}

export function filterCatalog(
  records: readonly CapabilityCatalogRecord[],
  input: { scope?: CapabilityPackScope; query?: string },
): CapabilityCatalogRecord[] {
  const query = input.query?.trim().toLowerCase();
  return records.filter((record) => {
    if (input.scope && record.manifest.scope !== input.scope) return false;
    if (!query) return true;
    const haystack = [
      record.manifest.id,
      record.manifest.summary,
      record.manifest.capabilities.join(" "),
      record.role ?? "",
      record.selector ?? "",
      record.skill_name ?? "",
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

export function findCatalogRecord(
  records: readonly CapabilityCatalogRecord[],
  input: { id: string; version?: string; digest?: string },
): CapabilityCatalogRecord | undefined {
  return records.find((record) => {
    if (record.manifest.id !== input.id) return false;
    if (input.version && record.manifest.version !== input.version) return false;
    if (input.digest && record.manifest.digest !== input.digest) return false;
    return true;
  });
}

export function availableCatalogIds(records: readonly CapabilityCatalogRecord[]): string[] {
  return records.map((record) => record.manifest.id);
}
