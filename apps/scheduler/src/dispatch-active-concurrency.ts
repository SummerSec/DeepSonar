/**
 * Shared active-job concurrency aggregation for dispatcher claim and credential
 * observability. Keep one口径: status IN (claimed, provisioning, running), keyed
 * by agent_snapshot credential_id / upstream_model (via snapshotUpstreamModel).
 */
import { credentialConcurrencyPolicy } from "./credentials.js";
import { PLATFORM_DEFAULT_AGENT_CLI } from "./domains/role-runtime-snapshot/index.js";
import { snapshotUpstreamModel } from "./provider-effective-model.js";
import { sql } from "./db.js";

export const ACTIVE_DISPATCH_JOB_STATUSES = ["claimed", "provisioning", "running"] as const;

export type DispatchCounts = {
  project: Map<string, number>;
  provider: Map<string, number>;
  credential: Map<string, number>;
  model: Map<string, number>;
  cli: Map<string, number>;
};

export type ActiveDispatchRow = {
  status?: unknown;
  project_id?: unknown;
  agent_cli?: unknown;
  credential_id?: unknown;
  credential_provider?: unknown;
  model?: unknown;
  upstream_model?: unknown;
  count: unknown;
};

/** Credential list/detail observabilty shape (#707 Phase 2). */
export type ActiveConcurrencyView = {
  in_use: number;
  max_concurrent: number | null;
  model_in_use?: Record<string, number>;
};

export const dispatchModelKey = (credentialId: string, model: string): string =>
  `${credentialId}\u0000${model}`;

export function emptyDispatchCounts(): DispatchCounts {
  return {
    project: new Map(),
    provider: new Map(),
    credential: new Map(),
    model: new Map(),
    cli: new Map(),
  };
}

/** Fold GROUP BY rows into the same Maps claim lock uses. */
export function accumulateDispatchCounts(
  rows: readonly ActiveDispatchRow[],
  into: DispatchCounts = emptyDispatchCounts(),
): DispatchCounts {
  for (const row of rows) {
    const projectId = String(row.project_id ?? "");
    const cli = String(row.agent_cli ?? PLATFORM_DEFAULT_AGENT_CLI);
    const provider = String(row.credential_provider ?? "");
    const credentialId = String(row.credential_id ?? "");
    const model = snapshotUpstreamModel(row) ?? "";
    const n = Number(row.count);
    if (projectId) into.project.set(projectId, (into.project.get(projectId) ?? 0) + n);
    if (provider) into.provider.set(provider, (into.provider.get(provider) ?? 0) + n);
    if (credentialId) into.credential.set(credentialId, (into.credential.get(credentialId) ?? 0) + n);
    if (credentialId && model) {
      const key = dispatchModelKey(credentialId, model);
      into.model.set(key, (into.model.get(key) ?? 0) + n);
    }
    into.cli.set(cli, (into.cli.get(cli) ?? 0) + n);
  }
  return into;
}

/**
 * Active jobs grouped the same way as dispatcher claim aggregation.
 * Optional projectId scopes observability for project-scoped actors.
 */
export async function queryActiveDispatchRows(
  query: typeof sql,
  opts: { projectId?: string | null } = {},
): Promise<ActiveDispatchRow[]> {
  const projectId = opts.projectId ?? null;
  return query`
    SELECT status, project_id,
           agent_snapshot_json->>'agent_cli' AS agent_cli,
           agent_snapshot_json->>'credential_id' AS credential_id,
           agent_snapshot_json->>'credential_provider' AS credential_provider,
           agent_snapshot_json->>'model' AS model,
           agent_snapshot_json->>'upstream_model' AS upstream_model,
           COUNT(*)::int AS count
    FROM jobs
    WHERE status IN ('claimed','provisioning','running')
      AND (${projectId}::uuid IS NULL OR project_id = ${projectId})
    GROUP BY status, project_id,
             agent_snapshot_json->>'agent_cli',
             agent_snapshot_json->>'credential_id',
             agent_snapshot_json->>'credential_provider',
             agent_snapshot_json->>'model',
             agent_snapshot_json->>'upstream_model'`;
}

/** Per-credential occupancy for list/detail; model_in_use omitted when empty. */
export function activeConcurrencyForCredential(
  credentialId: string,
  metadata: unknown,
  counts: Pick<DispatchCounts, "credential" | "model">,
): ActiveConcurrencyView {
  const policy = credentialConcurrencyPolicy(metadata);
  const inUse = counts.credential.get(credentialId) ?? 0;
  const modelInUse: Record<string, number> = {};
  const prefix = `${credentialId}\u0000`;
  for (const [key, value] of counts.model) {
    if (!key.startsWith(prefix) || value <= 0) continue;
    modelInUse[key.slice(prefix.length)] = value;
  }
  const view: ActiveConcurrencyView = {
    in_use: inUse,
    max_concurrent: policy.maxConcurrent,
  };
  if (Object.keys(modelInUse).length > 0) view.model_in_use = modelInUse;
  return view;
}
