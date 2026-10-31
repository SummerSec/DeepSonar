/**
 * DB versions vs execution-node local images reconcile (#724).
 *
 * Detect is read-only. Repair reuses the governed pull task path (not manual podman pull).
 * Remote workers without an image-inspect plane are reported as inspect_unsupported —
 * Scheduler host status must never be presented as those nodes' status.
 */
import { config } from "./config.js";
import { sql } from "./db.js";
import { listWorkerNodes } from "./domains/worker-nodes/registry.js";
import { LOCAL_WORKER_ID, type WorkerNodeRecord } from "./domains/worker-nodes/model.js";
import {
  assertRuntimeImageAvailable,
  immutableDigest,
  startRuntimeImagePull,
  type RuntimeImageEnsureDependencies,
  type RuntimeImagePullTask,
} from "./runtime-images.js";
import {
  classifyRuntimeImageReadinessFromState,
  hostManagesRuntimeImageLayers,
  type RuntimeImageReadiness,
} from "./runtime-image-readiness.js";

const PROTECTED_JOB_STATUSES = [
  "pending",
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
  "failed",
  "timeout",
  "orphan",
] as const;

export type RuntimeImageReconcileNeedReason = "latest" | "job_frozen" | "project_pin";

export interface RuntimeImageReconcileNeed {
  image_key: string;
  image_ref: string;
  digest: string;
  version_id: string | null;
  reasons: RuntimeImageReconcileNeedReason[];
}

export interface RuntimeImageReconcileItem {
  image_key: string;
  image_ref: string;
  digest: string;
  version_id: string | null;
  reasons: RuntimeImageReconcileNeedReason[];
  in_database: true;
  local_present: boolean | null;
  digest_match: boolean | null;
  readiness: RuntimeImageReadiness | "unknown";
  error: string | null;
}

export interface RuntimeImageReconcileNodeResult {
  node_id: string;
  node_kind: "local" | "remote";
  inspect: "ok" | "unsupported" | "error";
  inspect_error: string | null;
  items: RuntimeImageReconcileItem[];
  missing: Array<{ image_key: string; image_ref: string; digest: string }>;
}

export interface RuntimeImageReconcileResult {
  checked_at: string;
  needs: RuntimeImageReconcileNeed[];
  nodes: RuntimeImageReconcileNodeResult[];
  repair_task: RuntimeImagePullTask | null;
}

async function loadNeededRuntimeImageRefs(): Promise<RuntimeImageReconcileNeed[]> {
  const [latestRows, jobRows, pinRows] = await Promise.all([
    sql<Array<{
      image_key: string;
      version_id: string;
      image_ref: string | null;
      resolved_ref: string | null;
      digest: string | null;
    }>>`
      SELECT DISTINCT ON (i.image_key)
        i.image_key, v.id AS version_id, v.image_ref, v.resolved_ref, v.digest
      FROM runtime_images i
      JOIN runtime_image_versions v ON v.runtime_image_id = i.id
      WHERE i.enabled = true
        AND v.trust_status = 'trusted'
        AND v.digest IS NOT NULL
      ORDER BY i.image_key, v.promoted_at DESC NULLS LAST, v.created_at DESC`,
    sql<Array<{
      image_key: string | null;
      version_id: string | null;
      image_ref: string | null;
      digest: string | null;
    }>>`
      SELECT
        agent_snapshot_json #>> '{runtime_image,image_key}' AS image_key,
        agent_snapshot_json #>> '{runtime_image,runtime_image_version_id}' AS version_id,
        agent_snapshot_json #>> '{runtime_image,image_ref}' AS image_ref,
        agent_snapshot_json #>> '{runtime_image,image_digest}' AS digest
      FROM jobs
      WHERE status = ANY(${[...PROTECTED_JOB_STATUSES]})
        AND agent_snapshot_json #>> '{runtime_image,image_ref}' IS NOT NULL`,
    sql<Array<{
      image_key: string;
      version_id: string;
      image_ref: string | null;
      resolved_ref: string | null;
      digest: string | null;
    }>>`
      SELECT i.image_key, v.id AS version_id, v.image_ref, v.resolved_ref, v.digest
      FROM project_runtime_images p
      JOIN runtime_images i ON i.id = p.runtime_image_id
      JOIN runtime_image_versions v ON v.id = p.selected_version_id
      WHERE p.selected_version_id IS NOT NULL AND v.digest IS NOT NULL`,
  ]);

  const byDigest = new Map<string, RuntimeImageReconcileNeed>();
  const upsert = (
    imageKey: string,
    imageRef: string,
    digest: string,
    versionId: string | null,
    reason: RuntimeImageReconcileNeedReason,
  ) => {
    const existing = byDigest.get(digest);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (!existing.version_id && versionId) existing.version_id = versionId;
      return;
    }
    byDigest.set(digest, {
      image_key: imageKey,
      image_ref: imageRef,
      digest,
      version_id: versionId,
      reasons: [reason],
    });
  };

  for (const row of latestRows) {
    const ref = (row.resolved_ref || row.image_ref || "").trim();
    const digest = (row.digest || immutableDigest(ref) || "").trim();
    if (!row.image_key || !ref || !digest) continue;
    upsert(row.image_key, ref, digest.startsWith("sha256:") ? digest : `sha256:${digest}`, row.version_id, "latest");
  }
  for (const row of pinRows) {
    const ref = (row.resolved_ref || row.image_ref || "").trim();
    const digest = (row.digest || immutableDigest(ref) || "").trim();
    if (!row.image_key || !ref || !digest) continue;
    upsert(row.image_key, ref, digest.startsWith("sha256:") ? digest : `sha256:${digest}`, row.version_id, "project_pin");
  }
  for (const row of jobRows) {
    const ref = (row.image_ref || "").trim();
    const digestRaw = (row.digest || immutableDigest(ref) || "").trim();
    const imageKey = (row.image_key || "unknown").trim() || "unknown";
    if (!ref || !digestRaw) continue;
    const digest = digestRaw.startsWith("sha256:") ? digestRaw : `sha256:${digestRaw}`;
    upsert(imageKey, ref, digest, row.version_id, "job_frozen");
  }
  return [...byDigest.values()];
}

async function inspectNeedLocal(
  need: RuntimeImageReconcileNeed,
  inspect?: RuntimeImageEnsureDependencies["inspect"],
): Promise<RuntimeImageReconcileItem> {
  const hostManaged = hostManagesRuntimeImageLayers();
  try {
    await assertRuntimeImageAvailable(need.image_ref, inspect);
    const readiness = classifyRuntimeImageReadinessFromState({
      imageKey: need.image_key,
      imageRef: need.image_ref,
      pull: null,
      localAvailable: true,
      hostManaged,
    });
    return {
      image_key: need.image_key,
      image_ref: need.image_ref,
      digest: need.digest,
      version_id: need.version_id,
      reasons: need.reasons,
      in_database: true,
      local_present: true,
      digest_match: true,
      readiness: readiness.readiness,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const readiness = classifyRuntimeImageReadinessFromState({
      imageKey: need.image_key,
      imageRef: need.image_ref,
      pull: null,
      localAvailable: false,
      hostManaged,
    });
    return {
      image_key: need.image_key,
      image_ref: need.image_ref,
      digest: need.digest,
      version_id: need.version_id,
      reasons: need.reasons,
      in_database: true,
      local_present: false,
      digest_match: false,
      readiness: readiness.readiness,
      error: message,
    };
  }
}

export async function reconcileRuntimeImagesOnNodes(input: {
  repair?: boolean;
  inspect?: RuntimeImageEnsureDependencies["inspect"];
  listWorkers?: () => Promise<readonly Pick<WorkerNodeRecord, "id" | "kind">[]> | readonly Pick<WorkerNodeRecord, "id" | "kind">[];
  loadNeeds?: () => Promise<readonly RuntimeImageReconcileNeed[]> | readonly RuntimeImageReconcileNeed[];
} = {}): Promise<RuntimeImageReconcileResult> {
  const needs = [...await Promise.resolve(input.loadNeeds ? input.loadNeeds() : loadNeededRuntimeImageRefs())];
  const localNodeId = config.runtime.workerNodes.localNodeId || LOCAL_WORKER_ID;
  const localItems: RuntimeImageReconcileItem[] = [];
  for (const need of needs) {
    localItems.push(await inspectNeedLocal(need, input.inspect));
  }
  const missing = localItems
    .filter((item) => item.local_present === false)
    .map((item) => ({ image_key: item.image_key, image_ref: item.image_ref, digest: item.digest }));

  const nodes: RuntimeImageReconcileNodeResult[] = [{
    node_id: localNodeId,
    node_kind: "local",
    inspect: "ok",
    inspect_error: null,
    items: localItems,
    missing,
  }];

  // Enumerate the admitted registry, including stale/unavailable nodes. No remote
  // endpoint or credentials are read into an image-inspect request.
  const workers = await (input.listWorkers ?? listWorkerNodes)();
  const remoteIds = new Set(workers.filter((worker) => worker.kind === "remote").map((worker) => worker.id));
  for (const nodeId of remoteIds) {
    if (nodeId === localNodeId) continue;
    nodes.push({
      node_id: nodeId,
      node_kind: "remote",
      inspect: "unsupported",
      inspect_error: "remote worker image inspect plane not available; Scheduler host status is not a substitute",
      items: [],
      missing: [],
    });
  }

  let repairTask: RuntimeImagePullTask | null = null;
  if (input.repair && missing.length > 0) {
    repairTask = await startRuntimeImagePull({
      items: missing.map((item) => ({ image_key: item.image_key, image_ref: item.image_ref })),
    });
  }

  return {
    checked_at: new Date().toISOString(),
    needs,
    nodes,
    repair_task: repairTask,
  };
}
