import { normalizeModelCatalog } from "../../credentials.js";
import type { RoleRuntimeSnapshotTransaction } from "../role-runtime-snapshot/ports.js";
import {
  ensureProjectAgentAllowlist,
  type ProjectAgentAllowlist,
} from "../project-agent-allowlist/index.js";
import {
  parseProjectModelPolicy,
  toHubModelCatalogEntries,
  type HubModelCatalogEntry,
  type ProjectModelPolicy,
} from "./policy.js";

type SqlLike = RoleRuntimeSnapshotTransaction;

/** 收集项目 RoleConfig.model 与启用凭据 model_catalog，供可选种子使用。 */
export async function collectProjectModelBindings(
  db: SqlLike,
  projectId: string,
): Promise<{ model_ids: string[] }> {
  const roleRows = await db`
    SELECT rc.model
    FROM role_configs rc
    WHERE rc.project_id = ${projectId}` as Array<{ model: string | null }>;
  const credRows = await db`
    SELECT model_catalog_json
    FROM credentials
    WHERE kind = 'llm_provider'
      AND status = 'active'
      AND (project_id IS NULL OR project_id = ${projectId})` as Array<{ model_catalog_json: unknown }>;

  const model_ids: string[] = [];
  for (const row of roleRows) {
    if (typeof row.model === "string" && row.model.trim()) model_ids.push(row.model.trim());
  }
  for (const row of credRows) {
    model_ids.push(...normalizeModelCatalog(row.model_catalog_json));
  }
  return { model_ids };
}

export async function loadProjectModelPolicy(
  db: SqlLike,
  projectId: string,
): Promise<ProjectModelPolicy> {
  const [project] = await db`SELECT config_json FROM projects WHERE id = ${projectId}` as Array<{
    config_json: unknown;
  }>;
  if (!project) throw new Error(`project not found: ${projectId}`);
  return parseProjectModelPolicy(project.config_json);
}

export async function listHubModelCatalog(
  db: SqlLike,
  projectId: string,
): Promise<HubModelCatalogEntry[]> {
  const { allowlist } = await ensureProjectAgentAllowlist(db, projectId, { persist: true });
  const policy = await loadProjectModelPolicy(db, projectId);
  const rows = await db`
    SELECT id, name, provider, status, model_catalog_json
    FROM credentials
    WHERE kind = 'llm_provider'
      AND status = 'active'
      AND (project_id IS NULL OR project_id = ${projectId})
    ORDER BY name, id` as Array<{
    id: string;
    name: string;
    provider: string;
    status: string;
    model_catalog_json: unknown;
  }>;
  return toHubModelCatalogEntries({
    policy,
    agentAllowlist: allowlist,
    credentials: rows,
  });
}

export type { ProjectAgentAllowlist };
