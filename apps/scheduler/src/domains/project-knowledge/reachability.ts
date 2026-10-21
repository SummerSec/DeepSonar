import type { KnowledgeDb } from "./types.js";

/** Offline audit only. Historic Job snapshots and revoked versions remain roots. */
export async function planKnowledgeBlobReachability(db: KnowledgeDb) {
  const roots = new Map<string, Set<string>>();
  let unresolved = 0;
  const add = (value: unknown, reason: string) => {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) { unresolved++; return; }
    const reasons = roots.get(value) ?? new Set<string>();
    reasons.add(reason); roots.set(value, reasons);
  };
  const manifests = (value: unknown, reason: string) => {
    if (!Array.isArray(value)) { unresolved++; return; }
    for (const entry of value) add((entry as { blob_hash?: unknown })?.blob_hash, reason);
  };
  for (const row of await db`SELECT content_sha256 FROM shared_asset_versions`) add(row.content_sha256, "shared_asset_version");
  for (const row of await db`SELECT content_sha256 FROM project_knowledge_versions`) add(row.content_sha256, "knowledge_version");
  for (const row of await db`SELECT catalog_snapshot_hash FROM skill_sources WHERE catalog_snapshot_hash IS NOT NULL`) add(row.catalog_snapshot_hash, "skill_source");
  for (const row of await db`SELECT input_manifest_json FROM project_knowledge_work`) manifests(row.input_manifest_json, "work");
  for (const row of await db`SELECT input_manifest_json FROM project_knowledge_job_assignments`) manifests(row.input_manifest_json, "assignment");
  for (const row of await db`SELECT agent_snapshot_json FROM jobs`) {
    const snapshot = row.agent_snapshot_json as {
      job_skill_catalog?: { sources?: Array<{ manifest_hash?: string | null }> };
      project_knowledge_catalog?: { entries?: Array<{ hash?: string }> };
    } | null;
    for (const source of snapshot?.job_skill_catalog?.sources ?? []) if (source.manifest_hash) add(source.manifest_hash, "historic_job_skill_catalog");
    for (const entry of snapshot?.project_knowledge_catalog?.entries ?? []) add(entry.hash, "historic_job_knowledge");
  }
  const indexed = await db`SELECT content_sha256 FROM shared_asset_blobs ORDER BY content_sha256`;
  return {
    deletion_enabled: false as const,
    unresolved_roots: unresolved,
    reachable: [...roots].sort(([a], [b]) => a.localeCompare(b)).map(([hash, reasons]) => ({ hash, reasons: [...reasons].sort() })),
    retained_unreferenced: indexed.map((row) => String(row.content_sha256)).filter((hash) => !roots.has(hash)),
  };
}
