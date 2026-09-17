/**
 * DB-backed read-only Fact/Evidence trace for Finding confirm records (#577).
 * Pure diagnostics live in verify-evidence-chain.ts; this module loads scoped rows.
 */
import { sql } from "./db.js";
import { readEvidenceManifest } from "./evidence.js";
import {
  EVIDENCE_RETENTION_LAYERS,
  evaluateDeclaredDigest,
  factNodeSnapshotsFromEvidenceRows,
  resolveConfirmEvidenceChain,
  type ConfirmChainResolution,
} from "./verify-evidence-chain.js";
import { gateFingerprint, type FactFirstGateResult } from "./verify-fact-gate.js";

type Tx = typeof sql;
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function extractUsedFactIds(finding: Record<string, unknown>, rounds: readonly Record<string, unknown>[]): string[] {
  const raw = record(finding.raw_json);
  const state = record(raw.verification_state);
  const fromState = stringArray(state.used_fact_ids);
  if (fromState.length > 0) return [...new Set(fromState)];
  const confirmTrace = record(state.confirm_trace);
  const replay = Array.isArray(confirmTrace.used_fact_replay)
    ? confirmTrace.used_fact_replay
    : state.used_fact_replay;
  if (Array.isArray(replay)) {
    const ids = replay
      .map((item) => (item && typeof item === "object" ? text((item as { ref_id?: unknown }).ref_id) : ""))
      .filter(Boolean);
    if (ids.length > 0) return [...new Set(ids)];
  }
  for (const round of [...rounds].reverse()) {
    if (String(round.final_outcome ?? round.status ?? "") !== "confirmed") continue;
    const req = record(round.requirements_json);
    const gate = record(req.gate);
    const ids = stringArray(req.used_fact_ids).length > 0 ? stringArray(req.used_fact_ids) : stringArray(gate.used_fact_ids);
    if (ids.length > 0) return [...new Set(ids)];
    const snap = record(round.evidence_snapshot_json);
    const snapGate = record(snap.gate);
    const snapIds = stringArray(snapGate.used_fact_ids);
    if (snapIds.length > 0) return [...new Set(snapIds)];
  }
  return [];
}

function extractSubjectRevision(finding: Record<string, unknown>, rounds: readonly Record<string, unknown>[]): string | null {
  const raw = record(finding.raw_json);
  const state = record(raw.verification_state);
  const frozen = text(state.subject_revision);
  if (frozen) return frozen;
  for (const round of [...rounds].reverse()) {
    if (String(round.final_outcome ?? round.status ?? "") !== "confirmed") continue;
    const req = record(round.requirements_json);
    const rev = text(req.subject_revision);
    if (rev) return rev;
  }
  return null;
}

async function observedDigestsForJob(jobId: string | null): Promise<{
  observed: Record<string, string>;
  readable: boolean;
  reason: string | null;
}> {
  if (!jobId) return { observed: {}, readable: false, reason: "no_ownership_job" };
  try {
    const manifest = await readEvidenceManifest(jobId);
    if (!manifest?.files?.length) {
      return { observed: {}, readable: false, reason: "evidence_manifest_missing_or_empty" };
    }
    const observed: Record<string, string> = {};
    for (const file of manifest.files) {
      if (file.sha256) {
        observed[file.path] = file.sha256;
        observed[file.name] = file.sha256;
      }
    }
    return { observed, readable: true, reason: null };
  } catch {
    return { observed: {}, readable: false, reason: "evidence_manifest_unavailable" };
  }
}

export type FactEvidenceTraceResponse = ConfirmChainResolution & {
  gate_fingerprint: string | null;
  evidence_signature: string | null;
  content_integrity_digest: string | null;
  layers: typeof EVIDENCE_RETENTION_LAYERS;
  replay: { ok: boolean; steps: string[]; blockers: string[] };
};

/**
 * Load read-only Fact/Evidence chain for a Finding. Scoped to Finding project;
 * used_fact_ids are canvas Fact node ids (not artifact_evidence).
 */
export async function loadFactEvidenceTrace(
  tx: Tx,
  finding: Record<string, unknown>,
  verificationRounds: readonly Record<string, unknown>[] = [],
): Promise<FactEvidenceTraceResponse> {
  const findingId = String(finding.id ?? "");
  const projectId = String(finding.project_id ?? "");
  const canvasId = (finding.canvas_id as string | null | undefined) ?? null;
  const usedFactIds = extractUsedFactIds(finding, verificationRounds);
  const subjectRevision = extractSubjectRevision(finding, verificationRounds);
  const raw = record(finding.raw_json);
  const state = record(raw.verification_state);
  const evidenceSignature = text(state.evidence_signature) || null;
  const gateRaw = record(state.gate);
  const gate =
    text(gateRaw.result)
      ? { result: gateRaw.result as FactFirstGateResult["result"], missing: stringArray(gateRaw.missing) }
      : null;
  const confirmTrace = record(state.confirm_trace);
  const storedIntegrity =
    text(confirmTrace.content_integrity_digest) || text(state.content_integrity_digest) || null;

  const empty: FactEvidenceTraceResponse = {
    finding_id: findingId,
    subject_revision: subjectRevision,
    strategy_id: typeof state.strategy_id === "string" ? state.strategy_id : null,
    strategy_version: typeof state.strategy_version === "number" ? state.strategy_version : null,
    used_fact_ids: usedFactIds,
    facts: [],
    blocking_errors: usedFactIds.length === 0 ? [{ fact_id: "", error_code: "not_found", message: "no_used_fact_ids" }] : [],
    sample_replay_note: "生产样本脱敏复核与悬空计数/TPR 属运维授权回放，本路径不预断言悬空数量",
    gate_fingerprint: gate ? gateFingerprint(gate) : null,
    evidence_signature: evidenceSignature,
    content_integrity_digest: storedIntegrity,
    layers: EVIDENCE_RETENTION_LAYERS,
    replay: {
      ok: false,
      steps: ["load used_fact_ids", "resolve canvas Fact nodes", "diagnose ownership/revision/digest"],
      blockers: usedFactIds.length === 0 ? ["no_used_fact_ids"] : [],
    },
  };
  if (usedFactIds.length === 0) return empty;

  const nodes = await tx`
    SELECT n.id, n.node_type, n.canvas_id, n.job_id, n.body_json,
           j.project_id, j.status AS job_status,
           a.id AS attempt_id,
           art.id AS artifact_id
    FROM canvas_nodes n
    LEFT JOIN jobs j ON j.id = n.job_id
    LEFT JOIN LATERAL (
      SELECT id FROM job_attempts WHERE job_id = n.job_id ORDER BY attempt_no DESC LIMIT 1
    ) a ON true
    LEFT JOIN artifacts art ON art.node_id = n.id AND art.superseded_at IS NULL
    WHERE n.id = ANY(${usedFactIds}::uuid[])
      AND (j.project_id IS NULL OR j.project_id = ${projectId})`;

  const rows: Record<string, unknown>[] = [];
  for (const row of nodes) {
    const body = record(row.body_json);
    const verification = record(body.verification);
    const jobId = (row.job_id as string | null) ?? null;
    const { observed, readable, reason } = await observedDigestsForJob(jobId);
    const refs = Array.isArray(verification.artifact_refs) ? verification.artifact_refs : [];
    // Normalize observed keys to declared uris when path suffix matches.
    const observedForRefs: Record<string, string> = { ...observed };
    for (const ref of refs) {
      if (!ref || typeof ref !== "object") continue;
      const uri = text((ref as { uri?: unknown }).uri);
      if (!uri || observedForRefs[uri]) continue;
      const hit = Object.entries(observed).find(
        ([key]) => uri.endsWith(key) || key.endsWith(uri) || uri.includes(key),
      );
      if (hit) observedForRefs[uri] = hit[1];
    }
    rows.push({
      node_id: String(row.id),
      node_type: String(row.node_type),
      project_id: (row.project_id as string | null) ?? projectId,
      canvas_id: (row.canvas_id as string | null) ?? canvasId,
      job_id: jobId,
      attempt_id: (row.attempt_id as string | null) ?? null,
      job_status: (row.job_status as string | null) ?? null,
      artifact_id: (row.artifact_id as string | null) ?? (text(body.artifact_id) || null),
      finding_id: text(verification.finding_id) || null,
      source_job_id: text(verification.source_job_id) || jobId,
      source_role: text(verification.source_role) || null,
      subject_revision: text(verification.subject_revision) || null,
      evidence_kind: text(verification.evidence_kind) || null,
      outcome: text(verification.outcome) || null,
      expected: text(verification.expected) || null,
      actual: text(verification.actual) || null,
      steps: verification.steps,
      environment: text(verification.environment) || null,
      runtime_digest: text(verification.runtime_digest) || null,
      exit_code: typeof verification.exit_code === "number" ? verification.exit_code : null,
      artifact_refs: verification.artifact_refs ?? [],
      observed_content_digests: observedForRefs,
      content_readable: readable || refs.length === 0,
      content_unreadable_reason: readable || refs.length === 0 ? null : reason,
    });
  }

  const snapshots = factNodeSnapshotsFromEvidenceRows(rows);
  const byId = new Map(snapshots.map((s) => [s.node_id, s]));

  // Missing canvas Fact: if the id hits artifact_evidence, mark wrong_type (not dangling).
  const missingIds = usedFactIds.filter((id) => !byId.has(id));
  const artifactEvidenceHits = new Set<string>();
  if (missingIds.length > 0) {
    try {
      const hits = await tx`
        SELECT id::text AS id FROM artifact_evidence WHERE id = ANY(${missingIds}::uuid[])`;
      for (const hit of hits) artifactEvidenceHits.add(String(hit.id));
    } catch {
      // table may be unavailable in unit harness; treat as plain missing
    }
  }

  const resolution = resolveConfirmEvidenceChain(
    {
      finding_id: findingId,
      project_id: projectId,
      canvas_id: canvasId,
      subject_revision: subjectRevision,
      used_fact_ids: usedFactIds,
      strategy_id: typeof state.strategy_id === "string" ? state.strategy_id : null,
      strategy_version: typeof state.strategy_version === "number" ? state.strategy_version : null,
    },
    byId,
  );

  for (const fact of resolution.facts) {
    if (fact.error_code === "not_found" && artifactEvidenceHits.has(fact.ref_id)) {
      fact.ref_kind = "artifact_evidence";
      fact.error_code = "wrong_type";
      fact.error_message = `used_fact_ids 命中 artifact_evidence ${fact.ref_id}，应为 canvas Fact 节点；不是悬空`;
      fact.note = "不得把 used_fact_ids 当成 artifact_evidence FK；四表命中 ≠ Fact 存在";
    }
  }

  // Annotate digest mismatches explicitly when observed differs.
  for (const fact of resolution.facts) {
    const snap = byId.get(fact.ref_id);
    if (!snap?.artifact_refs) continue;
    for (const ref of snap.artifact_refs) {
      const declared = text(ref.sha256);
      const uri = text(ref.uri);
      if (!uri || !declared) continue;
      const result = evaluateDeclaredDigest(declared, snap.observed_content_digests?.[uri] ?? null);
      if (result === "mismatch" && fact.error_code !== "digest_mismatch") {
        fact.error_code = "digest_mismatch";
        fact.error_message = `uri=${uri} 声明摘要与观测不符`;
      }
    }
  }

  const blocking_errors = resolution.facts
    .filter((fact) => fact.error_code)
    .map((fact) => ({
      fact_id: fact.ref_id,
      error_code: fact.error_code!,
      message: fact.error_message ?? fact.error_code!,
    }));
  resolution.blocking_errors = blocking_errors;
  const blockers = blocking_errors.map((e) => `${e.error_code}:${e.fact_id}`);
  return {
    ...resolution,
    gate_fingerprint: gate ? gateFingerprint(gate) : null,
    evidence_signature: evidenceSignature,
    content_integrity_digest: storedIntegrity,
    layers: EVIDENCE_RETENTION_LAYERS,
    replay: {
      ok: blockers.length === 0,
      steps: [
        "parse confirm used_fact_ids",
        "resolve canvas_nodes Fact + Job/Attempt ownership",
        "compare subject_revision",
        "recheck artifact_ref content digests vs Evidence manifest",
      ],
      blockers,
    },
  };
}

export const factEvidenceTraceInternals = {
  extractUsedFactIds,
  extractSubjectRevision,
};
