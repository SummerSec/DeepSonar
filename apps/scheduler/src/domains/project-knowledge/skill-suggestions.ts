import type { SuggestProjectSkillsPayload, RecordSkillChoicePayload } from "@deepsonar/shared-types";
import type { KnowledgeActor } from "./inputs.js";
import { canonical, reject, sha256, type KnowledgeDb } from "./types.js";
import { projectSkillSelector, type FrozenKnowledgeCatalog, type KnowledgeCatalogEntry } from "./catalog-snapshot.js";
import { readKnowledgeVersionContent } from "./blobs.js";
import { assessSkillApplicability, SKILL_SUGGESTION_POLICY, type SuggestionEnvironment } from "./skill-suggestion-rules.js";

export interface PreparedSuggestions { catalogHash: string; candidates: Array<{ entry: KnowledgeCatalogEntry; raw: string | undefined }>; truncated: boolean }
/** Empty catalogs still validate the Job; foreign entries never enter the database predicate. */
async function currentSuggestionScope(db: KnowledgeDb, actor: KnowledgeActor, entries: KnowledgeCatalogEntry[]) {
  const local = entries.filter(e => e.owner_project_id === actor.projectId && e.kind === "skill");
  const ids = local.map(e => e.version_id);
  const rows = await db`SELECT j.started_at,j.timeout_sec,j.agent_snapshot_json,
      v.id,v.item_id,v.version,v.content_sha256
    FROM jobs j JOIN LATERAL (SELECT id,status,cancel_requested FROM job_attempts
      WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) a ON true
    LEFT JOIN (project_knowledge_versions v JOIN project_knowledge_items i
      ON i.id=v.item_id AND i.project_id=v.project_id AND i.kind='skill' AND i.status<>'revoked')
      ON v.project_id=j.project_id AND v.id IN ${db(ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])} AND v.revoked_at IS NULL
    WHERE j.id=${actor.jobId} AND j.project_id=${actor.projectId} AND j.status='running'
      AND j.lease_expires_at>now() AND a.id=${actor.attemptId} AND a.status='active' AND NOT a.cancel_requested`;
  const job = rows[0];
  if (!job) return reject("KNOWLEDGE_JOB_INACTIVE", "Job or Attempt is no longer active");
  if (canonical(job.agent_snapshot_json) !== canonical(actor.snapshot))
    return reject("KNOWLEDGE_SNAPSHOT_INVALID", "Job snapshot changed");
  const visible = local.filter(e => rows.some(r => r.id === e.version_id && r.item_id === e.item_id
    && Number(r.version) === e.version && r.content_sha256 === e.hash));
  return { job, visible };
}

export async function prepareSkillSuggestions(db: KnowledgeDb, actor: KnowledgeActor): Promise<PreparedSuggestions> {
  const catalog = actor.snapshot.project_knowledge_catalog as FrozenKnowledgeCatalog | undefined;
  if (!catalog || !Array.isArray(catalog.entries) || catalog.hash !== sha256(canonical(catalog.entries)))
    return reject("KNOWLEDGE_SNAPSHOT_INVALID", "Project knowledge snapshot is missing or invalid");
  const { visible } = await currentSuggestionScope(db, actor, catalog.entries);
  visible.sort((a, b) => projectSkillSelector(a).localeCompare(projectSkillSelector(b)) || a.hash.localeCompare(b.hash));
  if (visible.length > 20) return reject("KNOWLEDGE_SUGGESTION_CATALOG_LIMIT", "Authorized catalog exceeds the bounded suggestion read budget");
  // Scan the complete bounded authorized catalog before filtering or pagination.
  const candidates: PreparedSuggestions["candidates"] = [];
  for (const entry of visible) {
    const content = await readKnowledgeVersionContent(db, entry.version_id);
    if (sha256(canonical(content)) !== entry.hash) return reject("KNOWLEDGE_HASH_MISMATCH", "Candidate differs from the frozen version");
    if (content.kind !== "skill") return reject("KNOWLEDGE_SNAPSHOT_INVALID", "Candidate kind differs from the frozen catalog");
    candidates.push({ entry, raw: content.files?.["references/applicability.json"] });
  }
  return { catalogHash: catalog!.hash, candidates, truncated: false };
}

export async function computeSkillSuggestions(db: KnowledgeDb, actor: KnowledgeActor, input: SuggestProjectSkillsPayload,
  prepared: PreparedSuggestions, lock = false) {
  // Version -> item is the management revocation lock order. No CAS I/O under these locks.
  const ids = prepared.candidates.map(c => c.entry.version_id);
  if (lock && ids.length) {
    await db`SELECT id FROM project_knowledge_versions WHERE project_id=${actor.projectId} AND id IN ${db(ids)} ORDER BY id FOR SHARE`;
    const itemIds = [...new Set(prepared.candidates.map(c => c.entry.item_id))].sort();
    await db`SELECT id FROM project_knowledge_items WHERE project_id=${actor.projectId} AND id IN ${db(itemIds)} ORDER BY id FOR SHARE`;
  }
  // Final candidate and active Job/Attempt checks share one database statement, including an empty catalog.
  const { job, visible: entries } = await currentSuggestionScope(db, actor, prepared.candidates.map(c => c.entry));
  const snapshot = job.agent_snapshot_json as Record<string, unknown>;
  const image = snapshot.runtime_image as { image_digest?: unknown } | undefined;
  const network = snapshot.network_policy as { allow_egress?: unknown } | undefined;
  const start = job.started_at ? new Date(job.started_at as string).getTime() : NaN;
  const seconds = Number(job.timeout_sec), now = Date.now();
  const environment: SuggestionEnvironment = {
    runtime_digest: typeof image?.image_digest === "string" && /^sha256:[a-f0-9]{64}$/.test(image.image_digest) ? image.image_digest : null,
    tools: Array.isArray(snapshot.platform_tools) && snapshot.platform_tools.every(t => typeof t === "string") ? snapshot.platform_tools as string[] : null,
    allow_egress: typeof network?.allow_egress === "boolean" ? network.allow_egress : null,
    remaining_seconds: Number.isFinite(start) && start <= now && Number.isSafeInteger(seconds) && seconds > 0 ? Math.max(0, seconds - (now - start) / 1000) : null,
  };
  const visible = prepared.candidates.filter(c => entries.includes(c.entry));
  const assessments = visible.map(({ entry, raw }) => ({ selector: projectSkillSelector(entry), content_hash: entry.hash,
    version_id: entry.version_id, version: entry.version,
    declaration_source: { path: "references/applicability.json", hash: raw === undefined ? null : sha256(raw), trust: "author_claim" },
    ...assessSkillApplicability(raw, input.target, environment) }));
  const compatible = assessments.filter(e => e.status === "compatible");
  const diagnostics = assessments.filter(e => e.status !== "compatible");
  return { policy_version: SKILL_SUGGESTION_POLICY,
    context_hash: sha256(canonical({ job: actor.jobId, attempt: actor.attemptId, snapshot: actor.snapshot,
      target: input.target, limit: input.limit, offset: input.offset, policy: SKILL_SUGGESTION_POLICY })), catalog_hash: prepared.catalogHash,
    target: input.target, target_provenance: "caller_declared", observation: environment, observed_at: new Date(now).toISOString(),
    items: compatible.slice(input.offset, input.offset + input.limit),
    diagnostics: diagnostics.slice(input.offset, input.offset + input.limit),
    diagnostics_next_offset: input.offset + input.limit < diagnostics.length ? input.offset + input.limit : null,
    offset: input.offset, limit: input.limit, next_offset: input.offset + input.limit < compatible.length ? input.offset + input.limit : null,
    total: compatible.length, truncated: prepared.truncated, denominator_scope: "authorized_project_skills",
    effectiveness: "unknown", independent_sample_count: 0, token_budget: "unknown", exposure: "unknown",
    unsupported_sources: "other_sources_and_packs_not_assessed" };
}

export async function recordSkillChoice(tx: KnowledgeDb, actor: KnowledgeActor, input: RecordSkillChoicePayload, prepared: PreparedSuggestions) {
  const suggestion = await computeSkillSuggestions(tx, actor, input, prepared, true);
  if (input.policy_version !== suggestion.policy_version || input.context_hash !== suggestion.context_hash || input.catalog_hash !== suggestion.catalog_hash)
    return reject("KNOWLEDGE_SUGGESTION_STALE", "Re-read suggestions for this policy and Job context");
  if (input.decision !== "none") {
    const candidates = input.decision === "select" ? suggestion.items : [...suggestion.items, ...suggestion.diagnostics];
    if (!candidates.some(e => e.selector === input.selector && e.content_hash === input.expected_content_hash))
      return reject("KNOWLEDGE_CHOICE_UNAVAILABLE", "Exact choice is not in the current authorized suggestion page");
  }
  return { decision: input.decision, ...(input.selector ? { selector: input.selector, content_hash: input.expected_content_hash } : {}),
    reason: input.reason, claim_kind: "agent_selection_declaration", suggestion };
}
