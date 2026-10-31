import type { sql } from "../../db.js";
import type { CurrentIdentityField } from "./identity.js";

type Db = typeof sql;

export const RELATION_PAIR_LIMIT = 256;

export interface StrongCandidateSelection {
  /** UUID ASC; only these peers enter this bounded comparison pass. */
  peerIds: string[];
  /** Observed rows include the sentinel, not an invented full corpus total. */
  observedCount: number;
  truncated: boolean;
  countKind: "exact" | "lower_bound";
}

/** The deployed raw selector, not a relation decision. Freshness uses SQL
 * now() in the caller transaction; no label/split/Job/lexical/time overrides. */
export async function selectStrongRelationCandidates(db: Db, input: {
  projectId: string;
  findingId: string;
  rootCause: Pick<CurrentIdentityField, "status" | "identity_digest">;
}): Promise<StrongCandidateSelection> {
  const root = input.rootCause;
  if (root.status !== "valid" || !root.identity_digest) {
    return { peerIds: [], observedCount: 0, truncated: false, countKind: "exact" };
  }
  const candidates = await db`SELECT DISTINCT m.finding_id
    FROM project_finding_identity_mappings m
    JOIN project_finding_identity_sources s
      ON s.project_id = m.project_id AND s.source_id = m.source_id
     AND s.finding_id = m.finding_id
    JOIN project_finding_identity_source_revisions r
      ON r.project_id = m.project_id AND r.source_id = m.source_id
     AND r.finding_id = m.finding_id AND r.revision = m.source_revision
    WHERE m.project_id = ${input.projectId}::uuid AND m.field = 'root_cause'
      AND r.identity_fields_json ->> 'root_cause' = ${root.identity_digest}
      AND m.revoked_at IS NULL AND s.revoked_at IS NULL
      AND s.current_revision = m.source_revision AND r.freshness_until > now()
      AND m.finding_id > ${input.findingId}::uuid
    ORDER BY m.finding_id LIMIT ${RELATION_PAIR_LIMIT + 1}` as Array<{ finding_id: string }>;
  const truncated = candidates.length > RELATION_PAIR_LIMIT;
  return {
    peerIds: candidates.slice(0, RELATION_PAIR_LIMIT).map((candidate) => String(candidate.finding_id)),
    observedCount: candidates.length,
    truncated,
    countKind: truncated ? "lower_bound" : "exact",
  };
}
