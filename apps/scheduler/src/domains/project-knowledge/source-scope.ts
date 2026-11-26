import type { KnowledgeDb } from "./types.js";

/** 版本 sources_json 里的一条来源引用（fact/evidence/task 都可能是真实形状）。 */
export type SourceRef = { kind?: unknown; ref?: unknown; content_hash?: unknown };

/** 一条来源的归属与是否属于治理资料。 */
export type SourceOwner = {
  kind: string;
  ref: string;
  content_hash: string | null;
  project_id: string | null;
  job_id: string | null;
  governance: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function sourceRefs(value: unknown): SourceRef[] {
  return Array.isArray(value) ? value.filter((item): item is SourceRef => typeof item === "object" && item !== null) : [];
}

/**
 * 定位每条来源的归属：evidence → artifacts(job_id, project_id)；fact → canvas_nodes(canvas_id) → canvases(project_id)；
 * task → jobs(job_id, project_id)。治理资料 = 归属 Job 挂了 project_knowledge_job_assignments。
 * 这里只做「定位」，读权限仍沿用该来源原有的授权（冻结清单 + audience）。
 */
export type ResolvedSources = { owners: SourceOwner[]; unresolved: number };

async function locateEvidence(db: KnowledgeDb, ref: string) {
  const [row] = await db`SELECT a.project_id, a.job_id FROM artifact_evidence e
    JOIN artifacts a ON a.id=e.artifact_id WHERE e.id=${ref}`;
  return row ? { projectId: String(row.project_id), jobId: String(row.job_id) } : null;
}

async function locateFact(db: KnowledgeDb, ref: string) {
  // Fact 也可能挂在某个 Job 上（canvas_nodes.job_id），治理来源要按它判定。
  const [row] = await db`SELECT c.project_id, cn.job_id FROM canvas_nodes cn
    JOIN canvases c ON c.id=cn.canvas_id WHERE cn.id=${ref}`;
  return row ? { projectId: String(row.project_id), jobId: row.job_id ? String(row.job_id) : null } : null;
}

async function locateTask(db: KnowledgeDb, ref: string) {
  const [row] = await db`SELECT project_id, id FROM jobs WHERE id=${ref}`;
  return row ? { projectId: String(row.project_id), jobId: String(row.id) } : null;
}

async function isGovernanceJob(db: KnowledgeDb, jobId: string, projectId: string) {
  const [assigned] = await db`SELECT 1 FROM project_knowledge_job_assignments
    WHERE job_id=${jobId} AND project_id=${projectId} LIMIT 1`;
  return Boolean(assigned);
}

async function resolveOne(db: KnowledgeDb, source: SourceRef): Promise<{ owner: SourceOwner | null; unresolved: boolean }> {
  const kind = typeof source.kind === "string" ? source.kind : "";
  if (kind !== "fact" && kind !== "evidence" && kind !== "task") return { owner: null, unresolved: false };
  // `task` 这种来源没有 ref 字段，标识就是 job_id（沉淀入库时追加的当前任务出处）。
  const rawRef = kind === "task" ? (source as Record<string, unknown>).job_id : source.ref;
  const ref = typeof rawRef === "string" && UUID.test(rawRef) ? rawRef.toLowerCase() : null;
  if (!ref) return { owner: null, unresolved: true };
  const located = kind === "evidence" ? await locateEvidence(db, ref)
    : kind === "fact" ? await locateFact(db, ref) : await locateTask(db, ref);
  if (!located) return { owner: null, unresolved: true };
  const contentHash = typeof source.content_hash === "string" ? source.content_hash : null;
  const governance = located.jobId ? await isGovernanceJob(db, located.jobId, located.projectId) : false;
  return { owner: { kind, ref, content_hash: contentHash, project_id: located.projectId, job_id: located.jobId, governance },
    unresolved: false };
}

export async function resolveSourceOwners(db: KnowledgeDb, sources: unknown): Promise<ResolvedSources> {
  const owners: SourceOwner[] = [];
  let unresolved = 0;
  for (const source of sourceRefs(sources)) {
    const resolved = await resolveOne(db, source);
    if (resolved.owner) owners.push(resolved.owner);
    if (resolved.unresolved) unresolved += 1;
  }
  return { owners, unresolved };
}

/**
 * 复用它自己原有的授权规则：来源必须在该读者 Job 的冻结清单里（input_ref 与 content_hash 逐字相等），
 * 且读者当前阶段在该来源的 audience 内。同一批次但不在受众里的任务不放行。
 */
export async function actorMayReadGovernanceSources(db: KnowledgeDb,
  actor: { jobId?: string | null; projectId: string; humanAuthority?: boolean },
  owners: readonly SourceOwner[]): Promise<boolean> {
  const restricted = owners.filter((owner) => owner.governance);
  if (!restricted.length) return true;
  // 项目管理者/运维在管理 API 上的读操作沿用其既有权限，不再要求治理 Job 的冻结清单。
  if (actor.humanAuthority) return true;
  if (!actor.jobId) return false;
  const assignments = await db`SELECT stage, input_manifest_json FROM project_knowledge_job_assignments
    WHERE job_id=${actor.jobId} AND project_id=${actor.projectId}`;
  const allowed = new Set<string>();
  for (const row of assignments) {
    const stage = String(row.stage);
    const manifest = Array.isArray(row.input_manifest_json) ? row.input_manifest_json : [];
    for (const entry of manifest) {
      if (typeof entry !== "object" || entry === null) continue;
      const value = entry as Record<string, unknown>;
      if (typeof value.input_ref !== "string" || typeof value.content_hash !== "string") continue;
      const audience = Array.isArray(value.audience) ? value.audience.map(String) : [];
      if (!audience.includes(stage)) continue;
      allowed.add(`${value.input_ref}\u0000${value.content_hash}`);
    }
  }
  // 清单里的 input_ref 是 `kind:UUID`（inputs.ts 写入格式），不另造裸 UUID 比对。
  return restricted.every((owner) => allowed.has(`${owner.kind}:${owner.ref}\u0000${owner.content_hash ?? ""}`));
}
