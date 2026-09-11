import {
  CapabilityPackDraft,
  CapabilityPackManifest,
  DescribeCapabilityPayload,
  ListCapabilitiesPayload,
  PreviewMaterializationPayload,
  SearchCapabilitiesPayload,
  ValidateCompositionPayload,
  type RepairFeedback,
} from "@deepsonar/shared-types";
import {
  contentHashOf,
  expandCatalogSelectors,
  type ExpandedModuleSnapshot,
  type MissingModule,
  type SourceModule,
} from "../../skill-sources.js";
import {
  BUILTIN_CAPABILITY_PACKS,
  availableCatalogIds,
  filterCatalog,
  findCatalogRecord,
  freezeTaskCapabilityPack,
  isKnownCapabilityToken,
  manifestFromRoleConfig,
  manifestFromSkillModule,
  parseCompositionSelectors,
  repairCapabilityNotFound,
  repairFromMissingModule,
  repairPermissionEscalation,
  summarizeCapability,
  type CapabilityCatalogRecord,
  type FrozenCapabilityPack,
} from "./catalog.js";

export interface CapabilityJobEnvelope {
  roleName: string;
  roleDescription?: string;
  platformTools: readonly string[];
  allowEgress: boolean;
  selectors: readonly string[];
  resolvedModules?: readonly ExpandedModuleSnapshot[];
  missingModules?: readonly MissingModule[];
  moduleContentHash?: string;
  frozen?: FrozenCapabilityPack | null;
}

export interface TrustedSkillSourceCatalog {
  id: string;
  trust_status: string;
  enabled: boolean;
  last_commit_sha?: string | null;
  last_content_hash?: string | null;
  catalog: SourceModule[];
}

type CatalogDb = typeof import("../../db.js").sql;

export async function loadTrustedSkillSources(db: CatalogDb): Promise<TrustedSkillSourceCatalog[]> {
  const rows = await db`
    SELECT id, trust_status, enabled, catalog_json, last_commit_sha, last_content_hash
    FROM skill_sources
    WHERE enabled = true AND trust_status = 'trusted'
    ORDER BY created_at ASC`;
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    trust_status: String(row.trust_status),
    enabled: Boolean(row.enabled),
    last_commit_sha: typeof row.last_commit_sha === "string" ? row.last_commit_sha : null,
    last_content_hash: typeof row.last_content_hash === "string" ? row.last_content_hash : null,
    catalog: Array.isArray(row.catalog_json) ? row.catalog_json as SourceModule[] : [],
  }));
}

export function buildCapabilityCatalog(input: {
  sources?: readonly TrustedSkillSourceCatalog[];
  job?: CapabilityJobEnvelope;
}): CapabilityCatalogRecord[] {
  const records: CapabilityCatalogRecord[] = [...BUILTIN_CAPABILITY_PACKS];
  for (const source of input.sources ?? []) {
    if (source.trust_status !== "trusted" || !source.enabled) continue;
    for (const module of source.catalog) {
      records.push(manifestFromSkillModule({
        sourceId: source.id,
        module,
        commitSha: source.last_commit_sha,
        contentHash: source.last_content_hash ?? contentHashOf([module]),
      }));
    }
  }
  if (input.job) {
    records.push(manifestFromRoleConfig({
      roleName: input.job.roleName,
      summary: input.job.roleDescription ?? `${input.job.roleName} RoleConfig projection`,
      platformTools: input.job.platformTools,
      allowEgress: input.job.allowEgress,
      selectors: input.job.selectors,
      moduleContentHash: input.job.moduleContentHash ?? "",
    }));
  }
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.manifest.id}@${record.manifest.digest}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function loadCapabilityCatalog(db: CatalogDb, job?: CapabilityJobEnvelope): Promise<CapabilityCatalogRecord[]> {
  return buildCapabilityCatalog({ sources: await loadTrustedSkillSources(db), job });
}

function page<T>(items: readonly T[], limit = 50, offset = 0): { items: T[]; total: number; limit: number; offset: number; next_offset: number | null } {
  const sliced = items.slice(offset, offset + limit);
  return {
    items: sliced,
    total: items.length,
    limit,
    offset,
    next_offset: offset + sliced.length < items.length ? offset + sliced.length : null,
  };
}

export function listCapabilities(records: readonly CapabilityCatalogRecord[], input: ListCapabilitiesPayload) {
  const matched = filterCatalog(records, { scope: input.scope });
  const paged = page(matched, input.limit ?? 50, input.offset ?? 0);
  return {
    capabilities: paged.items.map(summarizeCapability),
    total: paged.total,
    limit: paged.limit,
    offset: paged.offset,
    next_offset: paged.next_offset,
  };
}

export function searchCapabilities(records: readonly CapabilityCatalogRecord[], input: SearchCapabilitiesPayload) {
  const matched = filterCatalog(records, { scope: input.scope, query: input.query });
  const paged = page(matched, input.limit ?? 20, 0);
  return {
    capabilities: paged.items.map(summarizeCapability),
    total: paged.total,
    limit: paged.limit,
  };
}

export function describeCapability(records: readonly CapabilityCatalogRecord[], input: DescribeCapabilityPayload): {
  capability: CapabilityPackManifest | null;
  repair: RepairFeedback[];
} {
  const record = findCatalogRecord(records, input);
  if (!record) {
    return {
      capability: null,
      repair: [repairCapabilityNotFound(input.id, "id", availableCatalogIds(records))],
    };
  }
  return { capability: record.manifest, repair: [] };
}

export function checkPackPermissions(draft: CapabilityPackDraft, job: CapabilityJobEnvelope): RepairFeedback[] {
  const repair: RepairFeedback[] = [];
  const allowedTools = new Set(job.platformTools);
  const extraTools = draft.permissions.platform_tools.filter((tool) => !allowedTools.has(tool));
  if (extraTools.length > 0) {
    repair.push(repairPermissionEscalation(
      "permissions.platform_tools",
      { kind: "platform_tools_subset", allowed: [...job.platformTools] },
      extraTools,
    ));
  }
  if (draft.permissions.allow_egress && !job.allowEgress) {
    repair.push(repairPermissionEscalation(
      "permissions.allow_egress",
      { kind: "allow_egress", value: false },
      true,
    ));
  }
  return repair;
}

export function checkPackCapabilities(draft: CapabilityPackDraft, records: readonly CapabilityCatalogRecord[]): RepairFeedback[] {
  const available = [...availableCatalogIds(records), ...CAPABILITY_TOKEN_LIST];
  const catalogIds = new Set(availableCatalogIds(records));
  const repair: RepairFeedback[] = [];
  draft.capabilities.forEach((capability, index) => {
    if (isKnownCapabilityToken(capability) || catalogIds.has(capability)) return;
    repair.push(repairCapabilityNotFound(capability, `capabilities[${index}]`, available, "validate_composition"));
  });
  return repair;
}

const CAPABILITY_TOKEN_LIST = [
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
];

export function resolveCompositionSelectors(
  selectors: readonly string[],
  sources: readonly TrustedSkillSourceCatalog[],
): { resolved: ExpandedModuleSnapshot[]; missing: MissingModule[]; repair: RepairFeedback[] } {
  const available = sources.flatMap((source) => source.catalog.map((module) => `${source.id}:${module.id}`));
  const { parsed, repair } = parseCompositionSelectors(selectors);
  const missing: MissingModule[] = [];
  const selected: ExpandedModuleSnapshot[] = [];
  const bySource = new Map<string, typeof parsed>();
  for (const selector of parsed) {
    const list = bySource.get(selector.source_id) ?? [];
    list.push(selector);
    bySource.set(selector.source_id, list);
  }
  for (const [sourceId, sourceSelectors] of bySource) {
    const source = sources.find((item) => item.id === sourceId);
    if (!source) {
      for (const selector of sourceSelectors) {
        missing.push({ selector: selector.raw, source_id: sourceId, reason: "source-not-found" });
      }
      continue;
    }
    if (source.trust_status !== "trusted" || !source.enabled) {
      for (const selector of sourceSelectors) {
        missing.push({ selector: selector.raw, source_id: sourceId, reason: "source-not-trusted" });
      }
      continue;
    }
    const expanded = expandCatalogSelectors(sourceId, source.catalog, sourceSelectors);
    missing.push(...expanded.missing_modules);
    for (const entry of expanded.modules) {
      selected.push({
        source_id: sourceId,
        module_id: entry.module.id,
        kind: entry.module.kind,
        plugin: entry.module.plugin,
        name: entry.module.name,
        description: entry.module.description,
        content_hash: contentHashOf([entry.module]),
      });
    }
  }
  return {
    resolved: selected,
    missing,
    repair: [...repair, ...missing.map((item) => repairFromMissingModule(item, available))],
  };
}

export function validateComposition(
  records: readonly CapabilityCatalogRecord[],
  job: CapabilityJobEnvelope,
  input: ValidateCompositionPayload,
  sources: readonly TrustedSkillSourceCatalog[] = [],
): {
  ok: boolean;
  digest: string | null;
  repair: RepairFeedback[];
  selectors: string[];
} {
  const selectors = input.selectors ?? [];
  const resolved = resolveCompositionSelectors(selectors, sources);
  const repair = [
    ...checkPackCapabilities(input.pack_manifest, records),
    ...checkPackPermissions(input.pack_manifest, job),
    ...resolved.repair,
  ];
  const frozen = freezeTaskCapabilityPack({
    roleName: job.roleName,
    summary: input.pack_manifest.summary,
    platformTools: input.pack_manifest.permissions.platform_tools,
    allowEgress: input.pack_manifest.permissions.allow_egress,
    selectors,
    resolvedModules: resolved.resolved,
    moduleContentHash: job.moduleContentHash ?? "",
  });
  return {
    ok: repair.length === 0,
    digest: frozen.digest,
    repair,
    selectors,
  };
}

export function previewMaterialization(
  records: readonly CapabilityCatalogRecord[],
  job: CapabilityJobEnvelope,
  input: PreviewMaterializationPayload,
  sources: readonly TrustedSkillSourceCatalog[] = [],
): {
  ok: boolean;
  digest: string | null;
  selectors: string[];
  resolved_modules: ExpandedModuleSnapshot[];
  permissions: CapabilityPackDraft["permissions"];
  repair: RepairFeedback[];
} {
  const selectors = input.selectors ?? [];
  const resolved = resolveCompositionSelectors(selectors, sources);
  const repair = [
    ...checkPackCapabilities(input.pack_manifest, records),
    ...checkPackPermissions(input.pack_manifest, job),
    ...resolved.repair,
  ];
  const frozen = freezeTaskCapabilityPack({
    roleName: job.roleName,
    summary: input.pack_manifest.summary,
    platformTools: input.pack_manifest.permissions.platform_tools,
    allowEgress: input.pack_manifest.permissions.allow_egress,
    selectors,
    resolvedModules: resolved.resolved,
    moduleContentHash: job.moduleContentHash ?? "",
  });
  return {
    ok: repair.length === 0,
    digest: frozen.digest,
    selectors: frozen.selectors,
    resolved_modules: resolved.resolved,
    permissions: input.pack_manifest.permissions,
    repair,
  };
}

export function jobEnvelopeFromSnapshot(snapshot: {
  name?: unknown;
  role_description?: unknown;
  platform_tools?: unknown;
  modules?: unknown;
  module_selectors?: unknown;
  expanded_modules?: unknown;
  missing_modules?: unknown;
  module_content_hash?: unknown;
  network_policy?: unknown;
  capability_pack?: unknown;
}): CapabilityJobEnvelope {
  const network = snapshot.network_policy && typeof snapshot.network_policy === "object" && !Array.isArray(snapshot.network_policy)
    ? snapshot.network_policy as { allow_egress?: unknown }
    : {};
  const selectors = Array.isArray(snapshot.module_selectors)
    ? snapshot.module_selectors.filter((item): item is string => typeof item === "string")
    : Array.isArray(snapshot.modules)
      ? snapshot.modules.filter((item): item is string => typeof item === "string")
      : [];
  return {
    roleName: typeof snapshot.name === "string" && snapshot.name ? snapshot.name : "unknown",
    roleDescription: typeof snapshot.role_description === "string" ? snapshot.role_description : undefined,
    platformTools: Array.isArray(snapshot.platform_tools)
      ? snapshot.platform_tools.filter((item): item is string => typeof item === "string")
      : [],
    allowEgress: network.allow_egress === true,
    selectors,
    resolvedModules: Array.isArray(snapshot.expanded_modules) ? snapshot.expanded_modules as ExpandedModuleSnapshot[] : [],
    missingModules: Array.isArray(snapshot.missing_modules) ? snapshot.missing_modules as MissingModule[] : [],
    moduleContentHash: typeof snapshot.module_content_hash === "string" ? snapshot.module_content_hash : "",
    frozen: snapshot.capability_pack && typeof snapshot.capability_pack === "object"
      ? snapshot.capability_pack as FrozenCapabilityPack
      : null,
  };
}

export async function handleCapabilityDiscovery(input: {
  operation: string;
  payload: unknown;
  snapshot: Parameters<typeof jobEnvelopeFromSnapshot>[0];
  db: CatalogDb;
}): Promise<Record<string, unknown>> {
  const job = jobEnvelopeFromSnapshot(input.snapshot);
  const [records, sources] = await Promise.all([
    loadCapabilityCatalog(input.db, job),
    loadTrustedSkillSources(input.db),
  ]);
  if (input.operation === "list_capabilities") {
    const parsed = ListCapabilitiesPayload.parse(input.payload ?? {});
    return { accepted: true, operation: input.operation, ...listCapabilities(records, parsed) };
  }
  if (input.operation === "search_capabilities") {
    const parsed = SearchCapabilitiesPayload.parse(input.payload ?? {});
    return { accepted: true, operation: input.operation, ...searchCapabilities(records, parsed) };
  }
  if (input.operation === "describe_capability") {
    const parsed = DescribeCapabilityPayload.parse(input.payload ?? {});
    const result = describeCapability(records, parsed);
    return { accepted: result.repair.length === 0, operation: input.operation, ...result };
  }
  if (input.operation === "validate_composition") {
    const parsed = ValidateCompositionPayload.parse(input.payload ?? {});
    const result = validateComposition(records, job, parsed, sources);
    return { accepted: result.ok, operation: input.operation, ...result };
  }
  if (input.operation === "preview_materialization") {
    const parsed = PreviewMaterializationPayload.parse(input.payload ?? {});
    const result = previewMaterialization(records, job, parsed, sources);
    return { accepted: result.ok, operation: input.operation, ...result };
  }
  throw new Error(`unknown capability discovery operation: ${input.operation}`);
}
