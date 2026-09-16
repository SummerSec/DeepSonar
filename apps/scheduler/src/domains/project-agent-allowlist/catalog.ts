import type { RoleRuntimeSnapshotTransaction } from "../role-runtime-snapshot/ports.js";
import {
  parseProjectAgentAllowlist,
  seedProjectAgentAllowlist,
  toHubAgentCliCatalog,
  toHubProviderCatalogEntry,
  type HubAgentCliCatalogEntry,
  type HubProviderCatalogEntry,
  type ProjectAgentAllowlist,
} from "./policy.js";

type SqlLike = RoleRuntimeSnapshotTransaction;

/** 收集项目 RoleConfig 当前绑定的 CLI / Credential，供迁移种子使用。 */
export async function collectProjectIdentityBindings(
  db: SqlLike,
  projectId: string,
): Promise<{ agent_clis: string[]; credential_ids: string[] }> {
  const rows = await db`
    SELECT rc.agent_cli, c.id AS credential_id
    FROM role_configs rc
    LEFT JOIN role_credentials rcb ON rcb.role_config_id = rc.id AND rcb.purpose = 'llm'
    LEFT JOIN credentials c ON c.id = rcb.credential_id
    WHERE rc.project_id = ${projectId}` as Array<{ agent_cli: string | null; credential_id: string | null }>;
  const agent_clis: string[] = [];
  const credential_ids: string[] = [];
  for (const row of rows) {
    if (typeof row.agent_cli === "string" && row.agent_cli.trim()) agent_clis.push(row.agent_cli.trim());
    if (typeof row.credential_id === "string") credential_ids.push(row.credential_id);
  }
  return { agent_clis, credential_ids };
}

function jsonParam(db: SqlLike, value: unknown): unknown {
  return typeof db.json === "function" ? db.json(value) : value;
}

/**
 * 确保项目白名单已种子化。返回解析后的 allowlist；若写回了种子则 persisted=true。
 */
export async function ensureProjectAgentAllowlist(
  db: SqlLike,
  projectId: string,
  options?: { persist?: boolean },
): Promise<{ allowlist: ProjectAgentAllowlist; persisted: boolean; config_json: Record<string, unknown> }> {
  const [project] = await db`SELECT config_json FROM projects WHERE id = ${projectId}` as Array<{
    config_json: unknown;
  }>;
  if (!project) throw new Error(`project not found: ${projectId}`);
  const cfg = { ...((project.config_json ?? {}) as Record<string, unknown>) };
  const before = parseProjectAgentAllowlist(cfg);
  if (before.configured) {
    return { allowlist: before, persisted: false, config_json: cfg };
  }
  const seed = await collectProjectIdentityBindings(db, projectId);
  const { changed, allowlist } = seedProjectAgentAllowlist(cfg, seed);
  if (changed && options?.persist !== false) {
    await db`UPDATE projects SET config_json = ${jsonParam(db, cfg) as never} WHERE id = ${projectId}`;
    return { allowlist, persisted: true, config_json: cfg };
  }
  return { allowlist, persisted: false, config_json: cfg };
}

export async function listHubAgentCliCatalog(
  db: SqlLike,
  projectId: string,
): Promise<HubAgentCliCatalogEntry[]> {
  const { allowlist } = await ensureProjectAgentAllowlist(db, projectId, { persist: true });
  return toHubAgentCliCatalog(allowlist);
}

export async function listHubProviderCatalog(
  db: SqlLike,
  projectId: string,
): Promise<HubProviderCatalogEntry[]> {
  const { allowlist } = await ensureProjectAgentAllowlist(db, projectId, { persist: true });
  const rows = await db`
    SELECT id, name, provider, status, public_metadata_json, project_id, kind
    FROM credentials
    WHERE kind = 'llm_provider'
      AND status = 'active'
      AND (project_id IS NULL OR project_id = ${projectId})
    ORDER BY name, id` as Array<{
    id: string;
    name: string;
    provider: string;
    status: string;
    public_metadata_json: unknown;
    project_id: string | null;
    kind: string;
  }>;
  const entries: HubProviderCatalogEntry[] = [];
  for (const row of rows) {
    const entry = toHubProviderCatalogEntry(row, allowlist);
    if (entry) entries.push(entry);
  }
  return entries;
}

export async function loadProjectAgentAllowlist(
  db: SqlLike,
  projectId: string,
): Promise<ProjectAgentAllowlist> {
  const { allowlist } = await ensureProjectAgentAllowlist(db, projectId, { persist: false });
  return allowlist;
}
