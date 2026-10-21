import type { RoleRuntimeSnapshotTransaction } from "../role-runtime-snapshot/ports.js";
import {
  parseProjectAgentAllowlist,
  toHubAgentCliCatalog,
  toHubProviderCatalogEntry,
  type HubAgentCliCatalogEntry,
  type HubProviderCatalogEntry,
  type ProjectAgentAllowlist,
} from "./policy.js";

type SqlLike = RoleRuntimeSnapshotTransaction;

/** Read optional restrictions without turning the visible catalog into stored authorization. */
export async function ensureProjectAgentAllowlist(
  db: SqlLike,
  projectId: string,
): Promise<{ allowlist: ProjectAgentAllowlist; persisted: boolean; config_json: Record<string, unknown> }> {
  const [project] = await db`SELECT config_json FROM projects WHERE id = ${projectId}` as Array<{
    config_json: unknown;
  }>;
  if (!project) throw new Error(`project not found: ${projectId}`);
  const cfg = { ...((project.config_json ?? {}) as Record<string, unknown>) };
  return { allowlist: parseProjectAgentAllowlist(cfg), persisted: false, config_json: cfg };
}

export async function listHubAgentCliCatalog(
  db: SqlLike,
  projectId: string,
): Promise<HubAgentCliCatalogEntry[]> {
  const { allowlist } = await ensureProjectAgentAllowlist(db, projectId);
  return toHubAgentCliCatalog(allowlist);
}

export async function listHubProviderCatalog(
  db: SqlLike,
  projectId: string,
): Promise<HubProviderCatalogEntry[]> {
  const { allowlist } = await ensureProjectAgentAllowlist(db, projectId);
  const rows = await db`
    SELECT id, name, provider, status, agent_cli, public_metadata_json, model_catalog_json,
           model_catalog_fetched_at, health_status, project_id, kind
    FROM credentials
    WHERE kind = 'llm_provider'
      AND status = 'active'
      AND (project_id IS NULL OR project_id = ${projectId})
    ORDER BY name, id` as Array<{
    id: string;
    name: string;
    provider: string;
    status: string;
    agent_cli: string | null;
    public_metadata_json: unknown;
    model_catalog_json: unknown;
    model_catalog_fetched_at: unknown;
    health_status: string | null;
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
  const { allowlist } = await ensureProjectAgentAllowlist(db, projectId);
  return allowlist;
}
