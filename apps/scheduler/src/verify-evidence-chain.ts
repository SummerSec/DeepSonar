/**
 * Fact / Artifact / Evidence reference-chain diagnostics (#577).
 *
 * used_fact_ids from the Fact collection path are canvas_nodes.id values.
 * Absence from the Artifact four tables does NOT mean a dangling Fact.
 * Content-integrity digests are distinct from Hub wake evidence_signature /
 * gate_fingerprint — changing integrity must not duplicate Hub wakes.
 */
import { createHash } from "node:crypto";
import { textField } from "./verify-fact-gate.js";

export type EvidenceRefKind =
  | "fact_node"
  | "artifact"
  | "artifact_evidence"
  | "artifact_ref"
  | "job_evidence";

export type Recheckability = "recheckable" | "unrecheckable" | "unknown";

export type EvidenceChainErrorCode =
  | "not_found"
  | "wrong_type"
  | "cross_project"
  | "cross_canvas"
  | "source_job_missing"
  | "source_job_failed"
  | "attempt_missing"
  | "revision_mismatch"
  | "digest_mismatch"
  | "digest_missing"
  | "content_unreadable"
  | "expired_or_deleted"
  | "not_runtime_proof"
  | "ownership_incomplete";

export type ArtifactRefView = {
  uri: string;
  sha256?: string | null;
};

export type RuntimeProofView = {
  subject_revision?: string | null;
  steps?: readonly string[] | null;
  environment?: string | null;
  runtime_digest?: string | null;
  exit_code?: number | null;
  artifact_refs?: readonly ArtifactRefView[] | null;
  expected?: string | null;
  actual?: string | null;
};

export type FactNodeSnapshot = {
  node_id: string;
  node_type?: string | null;
  project_id?: string | null;
  canvas_id?: string | null;
  finding_id?: string | null;
  job_id?: string | null;
  attempt_id?: string | null;
  job_status?: string | null;
  source_job_id?: string | null;
  source_role?: string | null;
  subject_revision?: string | null;
  evidence_kind?: string | null;
  outcome?: string | null;
  expected?: string | null;
  actual?: string | null;
  steps?: readonly string[] | null;
  environment?: string | null;
  runtime_digest?: string | null;
  exit_code?: number | null;
  artifact_refs?: readonly ArtifactRefView[] | null;
  /** Bound Artifact row id when present — optional, never required for Fact identity. */
  artifact_id?: string | null;
  /** Whether retained raw bytes are readable under auth. */
  content_readable?: boolean | null;
  content_unreadable_reason?: string | null;
  /** Observed content digests keyed by artifact uri (integrity only). */
  observed_content_digests?: Readonly<Record<string, string>> | null;
};

export type ArtifactSnapshot = {
  artifact_id: string;
  project_id?: string | null;
  canvas_id?: string | null;
  job_id?: string | null;
  node_id?: string | null;
  revision?: number | null;
  status?: string | null;
  readable?: boolean | null;
  unreadable_reason?: string | null;
};

export type ArtifactEvidenceSnapshot = {
  evidence_id: string;
  artifact_id: string;
  project_id?: string | null;
  canvas_id?: string | null;
  uri?: string | null;
  sha256?: string | null;
  readable?: boolean | null;
  unreadable_reason?: string | null;
  observed_sha256?: string | null;
};

export type EvidenceChainDiagnostic = {
  ref_kind: EvidenceRefKind;
  ref_id: string;
  exists: boolean;
  ownership: {
    project_id: string | null;
    canvas_id: string | null;
    job_id: string | null;
    attempt_id: string | null;
  };
  source: {
    job_id: string | null;
    job_status: string | null;
    role: string | null;
  };
  subject_revision: string | null;
  /** sha256 of retained bytes — NOT a Hub wake signature. */
  content_integrity_digest: string | null;
  readable: boolean;
  recheckability: Recheckability;
  recheckability_reason: string | null;
  error_code: EvidenceChainErrorCode | null;
  error_message: string | null;
  /** Clarifies Fact nodes are not dangling merely because Artifact tables lack the id. */
  note: string | null;
  runtime_proof: boolean;
};

export type ConfirmRecordView = {
  finding_id: string;
  project_id?: string | null;
  canvas_id?: string | null;
  subject_revision?: string | null;
  strategy_id?: string | null;
  strategy_version?: number | null;
  used_fact_ids?: readonly string[] | null;
  /** Optional frozen wake signature — never derived from content digests. */
  evidence_signature?: string | null;
  gate_fingerprint?: string | null;
};

export type ConfirmChainResolution = {
  finding_id: string;
  subject_revision: string | null;
  strategy_id: string | null;
  strategy_version: number | null;
  used_fact_ids: string[];
  facts: EvidenceChainDiagnostic[];
  blocking_errors: Array<{
    fact_id: string;
    error_code: EvidenceChainErrorCode;
    message: string;
  }>;
  /** Ops follow-up only — never a dangling-count assertion without authorized sample replay. */
  sample_replay_note: string;
};

export type EvidenceIntegrityDecision = {
  ok: boolean;
  required_missing: string[];
  reasons: string[];
};

const FAILED_JOB = new Set(["failed", "timeout", "orphan", "cancelled"]);

/** Layers that own raw retention, digest check, TTL, deletion, and source failure (#577). */
export const EVIDENCE_RETENTION_LAYERS = {
  raw_job_evidence: {
    owner: "Scheduler job evidence store (blobDir/jobs/<job_id>/)",
    responsibilities: ["retain stream/session bytes", "manifest sha256", "inflight → finalized"],
  },
  artifact_rows: {
    owner: "Postgres artifacts / artifact_claims / artifact_evidence / artifact_relations",
    responsibilities: ["structured observation identity", "optional uri + sha256", "project/canvas/job binding"],
  },
  content_integrity: {
    owner: "verify-evidence-chain content digests",
    responsibilities: ["sha256 match of retained bytes", "runtime_digest for env/runtime", "mismatch blocks confirm when required"],
  },
  wake_signature: {
    owner: "verify evidence_signature + gate_fingerprint",
    responsibilities: ["Hub wake edge trigger", "must ignore content-integrity churn"],
  },
  source_failure: {
    owner: "verify-fact-gate FAILED_JOB / outcome checks",
    responsibilities: ["reject Facts whose source Job failed", "conflict / revision / finding_id gates"],
  },
  deletion_expiry: {
    owner: "ops retention / GC of job evidence and blobs",
    responsibilities: [
      "expired/deleted leave audit + unrecheckable status",
      "historical confirm semantics preserved",
    ],
  },
} as const;

export function contentIntegrityDigest(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hasDigestedArtifactRefs(refs: readonly ArtifactRefView[] | null | undefined): boolean {
  if (!Array.isArray(refs) || refs.length === 0) return false;
  return refs.some((ref) => textField(ref.uri).length > 0 && textField(ref.sha256).length > 0);
}

/**
 * Runtime proof requires revision + steps + (environment|runtime_digest) +
 * (exit_code | digested artifact_refs). Text expected/actual alone is NOT proof.
 */
export function isRuntimeProof(proof: RuntimeProofView | null | undefined): boolean {
  if (!proof) return false;
  const revision = textField(proof.subject_revision);
  const steps = Array.isArray(proof.steps) ? proof.steps.map((s) => textField(s)).filter(Boolean) : [];
  const env = textField(proof.environment);
  const runtimeDigest = textField(proof.runtime_digest);
  const hasExit = typeof proof.exit_code === "number" && Number.isFinite(proof.exit_code);
  const hasDigests = hasDigestedArtifactRefs(proof.artifact_refs ?? null);
  return (
    revision.length > 0 &&
    steps.length > 0 &&
    (env.length > 0 || runtimeDigest.length > 0) &&
    (hasExit || hasDigests)
  );
}

export function evaluateDeclaredDigest(
  declared: string | null | undefined,
  observed: string | null | undefined,
): "match" | "mismatch" | "missing_observed" | "missing_declared" {
  const want = textField(declared).toLowerCase();
  const got = textField(observed).toLowerCase();
  if (!want) return "missing_declared";
  if (!got) return "missing_observed";
  return want === got ? "match" : "mismatch";
}

function ownershipIncomplete(fact: FactNodeSnapshot): boolean {
  const jobId = textField(fact.source_job_id) || textField(fact.job_id);
  const role = textField(fact.source_role);
  return !jobId || !role;
}

export function diagnoseFactNode(
  fact: FactNodeSnapshot | null | undefined,
  opts: {
    refId: string;
    expectedProjectId?: string | null;
    expectedCanvasId?: string | null;
    expectedRevision?: string | null;
  },
): EvidenceChainDiagnostic {
  const baseNote =
    "used_fact_ids 引用 canvas_nodes.id；不得仅因 Artifact 四表无此 id 判定悬空";
  if (!fact) {
    return {
      ref_kind: "fact_node",
      ref_id: opts.refId,
      exists: false,
      ownership: { project_id: null, canvas_id: null, job_id: null, attempt_id: null },
      source: { job_id: null, job_status: null, role: null },
      subject_revision: null,
      content_integrity_digest: null,
      readable: false,
      recheckability: "unrecheckable",
      recheckability_reason: "fact_node_not_found",
      error_code: "not_found",
      error_message: `Fact 节点 ${opts.refId} 不存在或不可解析`,
      note: baseNote,
      runtime_proof: false,
    };
  }

  const nodeType = textField(fact.node_type) || "fact";
  if (nodeType !== "fact") {
    return {
      ref_kind: "fact_node",
      ref_id: fact.node_id,
      exists: true,
      ownership: {
        project_id: fact.project_id ?? null,
        canvas_id: fact.canvas_id ?? null,
        job_id: textField(fact.source_job_id) || textField(fact.job_id) || null,
        attempt_id: fact.attempt_id ?? null,
      },
      source: {
        job_id: textField(fact.source_job_id) || textField(fact.job_id) || null,
        job_status: fact.job_status ?? null,
        role: textField(fact.source_role) || null,
      },
      subject_revision: fact.subject_revision ?? null,
      content_integrity_digest: null,
      readable: false,
      recheckability: "unrecheckable",
      recheckability_reason: "wrong_node_type",
      error_code: "wrong_type",
      error_message: `引用 ${fact.node_id} 的 node_type=${nodeType}，期望 fact`,
      note: baseNote,
      runtime_proof: false,
    };
  }

  const jobId = textField(fact.source_job_id) || textField(fact.job_id) || null;
  const role = textField(fact.source_role) || null;
  const jobStatus = textField(fact.job_status) || null;
  const expectedProject = textField(opts.expectedProjectId);
  const expectedCanvas = textField(opts.expectedCanvasId);
  const expectedRevision = textField(opts.expectedRevision);
  const projectId = textField(fact.project_id) || null;
  const canvasId = textField(fact.canvas_id) || null;
  const revision = textField(fact.subject_revision) || null;
  const runtimeProof = isRuntimeProof(fact);

  let errorCode: EvidenceChainErrorCode | null = null;
  let errorMessage: string | null = null;
  if (ownershipIncomplete(fact) || !jobId) {
    errorCode = "ownership_incomplete";
    errorMessage = `Fact ${fact.node_id} 缺少来源 Job/角色 ownership`;
  } else if (!jobStatus) {
    errorCode = "source_job_missing";
    errorMessage = `Fact ${fact.node_id} 来源 Job ${jobId} 无法解析状态`;
  } else if (FAILED_JOB.has(jobStatus)) {
    errorCode = "source_job_failed";
    errorMessage = `Fact ${fact.node_id} 来源 Job ${jobId} 状态为 ${jobStatus}`;
  } else if (expectedProject && projectId && projectId !== expectedProject) {
    errorCode = "cross_project";
    errorMessage = `Fact ${fact.node_id} project_id=${projectId} 与确认记录 ${expectedProject} 不一致`;
  } else if (expectedCanvas && canvasId && canvasId !== expectedCanvas) {
    errorCode = "cross_canvas";
    errorMessage = `Fact ${fact.node_id} canvas_id=${canvasId} 与确认记录 ${expectedCanvas} 不一致`;
  } else if (expectedRevision && revision && revision !== expectedRevision) {
    errorCode = "revision_mismatch";
    errorMessage = `Fact ${fact.node_id} subject_revision=${revision} 与目标 ${expectedRevision} 不一致`;
  }

  // Content integrity: declared sha256 must match observed when both present.
  const refs = Array.isArray(fact.artifact_refs) ? fact.artifact_refs : [];
  const observed = fact.observed_content_digests ?? {};
  for (const ref of refs) {
    const uri = textField(ref.uri);
    const declared = textField(ref.sha256);
    if (!uri || !declared) continue;
    const result = evaluateDeclaredDigest(declared, observed[uri] ?? null);
    if (result === "mismatch") {
      errorCode = "digest_mismatch";
      errorMessage = `Fact ${fact.node_id} artifact_ref ${uri} 内容摘要不符`;
      break;
    }
  }

  let readable = fact.content_readable !== false;
  let recheckability: Recheckability = "recheckable";
  let recheckReason: string | null = null;
  if (fact.content_readable === false) {
    readable = false;
    recheckability = "unrecheckable";
    recheckReason = textField(fact.content_unreadable_reason) || "content_unreadable";
    if (!errorCode) {
      errorCode = recheckReason === "expired_or_deleted" ? "expired_or_deleted" : "content_unreadable";
      errorMessage = `Fact ${fact.node_id} 原始产物当前不可复查：${recheckReason}`;
    }
  } else if (refs.some((ref) => textField(ref.sha256)) && Object.keys(observed).length === 0) {
    recheckability = "unknown";
    recheckReason = "declared_digest_without_observed_bytes";
  }

  const primaryDigest =
    textField(fact.runtime_digest) ||
    refs.map((ref) => textField(ref.sha256)).find((d) => d.length > 0) ||
    null;

  return {
    ref_kind: "fact_node",
    ref_id: fact.node_id,
    exists: true,
    ownership: {
      project_id: projectId,
      canvas_id: canvasId,
      job_id: jobId,
      attempt_id: fact.attempt_id ?? null,
    },
    source: { job_id: jobId, job_status: jobStatus || null, role },
    subject_revision: revision,
    content_integrity_digest: primaryDigest,
    readable,
    recheckability,
    recheckability_reason: recheckReason,
    error_code: errorCode,
    error_message: errorMessage,
    note: fact.artifact_id
      ? `${baseNote}；可选绑定 artifact_id=${fact.artifact_id}`
      : baseNote,
    runtime_proof: runtimeProof,
  };
}

export function diagnoseArtifact(
  artifact: ArtifactSnapshot | null | undefined,
  opts: { refId: string; expectedProjectId?: string | null; expectedCanvasId?: string | null },
): EvidenceChainDiagnostic {
  if (!artifact) {
    return {
      ref_kind: "artifact",
      ref_id: opts.refId,
      exists: false,
      ownership: { project_id: null, canvas_id: null, job_id: null, attempt_id: null },
      source: { job_id: null, job_status: null, role: null },
      subject_revision: null,
      content_integrity_digest: null,
      readable: false,
      recheckability: "unrecheckable",
      recheckability_reason: "artifact_not_found",
      error_code: "not_found",
      error_message: `Artifact ${opts.refId} 不存在`,
      note: "Artifact 四表查询仅适用于 artifact 引用类型",
      runtime_proof: false,
    };
  }
  const expectedProject = textField(opts.expectedProjectId);
  const expectedCanvas = textField(opts.expectedCanvasId);
  let errorCode: EvidenceChainErrorCode | null = null;
  let errorMessage: string | null = null;
  if (expectedProject && artifact.project_id && artifact.project_id !== expectedProject) {
    errorCode = "cross_project";
    errorMessage = `Artifact ${artifact.artifact_id} 跨项目`;
  } else if (expectedCanvas && artifact.canvas_id && artifact.canvas_id !== expectedCanvas) {
    errorCode = "cross_canvas";
    errorMessage = `Artifact ${artifact.artifact_id} 跨画布`;
  }
  const readable = artifact.readable !== false;
  return {
    ref_kind: "artifact",
    ref_id: artifact.artifact_id,
    exists: true,
    ownership: {
      project_id: artifact.project_id ?? null,
      canvas_id: artifact.canvas_id ?? null,
      job_id: artifact.job_id ?? null,
      attempt_id: null,
    },
    source: { job_id: artifact.job_id ?? null, job_status: artifact.status ?? null, role: null },
    subject_revision: artifact.revision != null ? String(artifact.revision) : null,
    content_integrity_digest: null,
    readable,
    recheckability: readable ? "recheckable" : "unrecheckable",
    recheckability_reason: readable ? null : textField(artifact.unreadable_reason) || "content_unreadable",
    error_code: errorCode ?? (readable ? null : "content_unreadable"),
    error_message: errorMessage ?? (readable ? null : `Artifact ${artifact.artifact_id} 不可读`),
    note: null,
    runtime_proof: false,
  };
}

export function diagnoseArtifactEvidence(
  row: ArtifactEvidenceSnapshot | null | undefined,
  opts: { refId: string; expectedProjectId?: string | null },
): EvidenceChainDiagnostic {
  if (!row) {
    return {
      ref_kind: "artifact_evidence",
      ref_id: opts.refId,
      exists: false,
      ownership: { project_id: null, canvas_id: null, job_id: null, attempt_id: null },
      source: { job_id: null, job_status: null, role: null },
      subject_revision: null,
      content_integrity_digest: null,
      readable: false,
      recheckability: "unrecheckable",
      recheckability_reason: "artifact_evidence_not_found",
      error_code: "not_found",
      error_message: `artifact_evidence ${opts.refId} 不存在`,
      note: "不得把 used_fact_ids 当成 artifact_evidence FK",
      runtime_proof: false,
    };
  }
  const digestResult = evaluateDeclaredDigest(row.sha256, row.observed_sha256);
  let errorCode: EvidenceChainErrorCode | null = null;
  let errorMessage: string | null = null;
  if (digestResult === "mismatch") {
    errorCode = "digest_mismatch";
    errorMessage = `artifact_evidence ${row.evidence_id} sha256 不符`;
  }
  const readable = row.readable !== false;
  if (!readable && !errorCode) {
    errorCode = "content_unreadable";
    errorMessage = textField(row.unreadable_reason) || "content_unreadable";
  }
  return {
    ref_kind: "artifact_evidence",
    ref_id: row.evidence_id,
    exists: true,
    ownership: {
      project_id: row.project_id ?? null,
      canvas_id: row.canvas_id ?? null,
      job_id: null,
      attempt_id: null,
    },
    source: { job_id: null, job_status: null, role: null },
    subject_revision: null,
    content_integrity_digest: textField(row.sha256) || textField(row.observed_sha256) || null,
    readable,
    recheckability: readable ? (digestResult === "mismatch" ? "unrecheckable" : "recheckable") : "unrecheckable",
    recheckability_reason: readable ? (digestResult === "mismatch" ? "digest_mismatch" : null) : textField(row.unreadable_reason) || "content_unreadable",
    error_code: errorCode,
    error_message: errorMessage,
    note: null,
    runtime_proof: false,
  };
}

/**
 * Resolve every Fact participating in a confirm record without widening perms.
 * Lookups are limited to the supplied fact map (caller scopes by project/canvas).
 */
export function resolveConfirmEvidenceChain(
  confirm: ConfirmRecordView,
  factsById: ReadonlyMap<string, FactNodeSnapshot>,
): ConfirmChainResolution {
  const used = [...new Set((confirm.used_fact_ids ?? []).map((id) => textField(id)).filter(Boolean))];
  const facts = used.map((id) =>
    diagnoseFactNode(factsById.get(id), {
      refId: id,
      expectedProjectId: confirm.project_id,
      expectedCanvasId: confirm.canvas_id,
      expectedRevision: confirm.subject_revision,
    }),
  );
  const blocking = facts
    .filter((fact) => fact.error_code)
    .map((fact) => ({
      fact_id: fact.ref_id,
      error_code: fact.error_code!,
      message: fact.error_message ?? fact.error_code!,
    }));
  return {
    finding_id: confirm.finding_id,
    subject_revision: confirm.subject_revision ?? null,
    strategy_id: confirm.strategy_id ?? null,
    strategy_version: confirm.strategy_version ?? null,
    used_fact_ids: used,
    facts,
    blocking_errors: blocking,
    sample_replay_note:
      "生产样本脱敏复核与悬空计数/TPR 属运维授权回放，本路径不预断言悬空数量",
  };
}

/**
 * Under a valid strategy: required runtime proof missing, or declared content
 * digest mismatch, cannot satisfy confirm.
 */
export function evaluateEvidenceIntegrityForConfirm(
  facts: readonly FactNodeSnapshot[],
  opts?: {
    requireRuntimeProof?: boolean;
    /** When true, declared sha256 without observed bytes is required_missing. */
    requireObservedDigests?: boolean;
  },
): EvidenceIntegrityDecision {
  const required_missing: string[] = [];
  const reasons: string[] = [];
  const requireProof = opts?.requireRuntimeProof === true;
  const requireObserved = opts?.requireObservedDigests === true;

  if (requireProof) {
    const okProof = facts.some((fact) => isRuntimeProof(fact));
    if (!okProof) {
      required_missing.push("runtime_proof");
      reasons.push("策略要求运行证明，但参与 Fact 仅有文本 expected/actual 或缺少 steps/digest/exit");
    }
  }

  for (const fact of facts) {
    const refs = Array.isArray(fact.artifact_refs) ? fact.artifact_refs : [];
    const observed = fact.observed_content_digests ?? {};
    for (const ref of refs) {
      const uri = textField(ref.uri);
      const declared = textField(ref.sha256);
      if (!uri || !declared) continue;
      const result = evaluateDeclaredDigest(declared, observed[uri] ?? null);
      if (result === "mismatch") {
        required_missing.push("content_digest_mismatch");
        reasons.push(`Fact ${fact.node_id} uri=${uri} 内容摘要不符`);
      } else if (result === "missing_observed" && (requireProof || requireObserved)) {
        required_missing.push("content_digest_unverified");
        reasons.push(`Fact ${fact.node_id} uri=${uri} 声明了 sha256 但无法读取观测摘要`);
      }
    }
    if (fact.content_readable === false && requireProof) {
      required_missing.push("runtime_artifact_unreadable");
      reasons.push(
        `Fact ${fact.node_id} 产物不可复查：${textField(fact.content_unreadable_reason) || "content_unreadable"}`,
      );
    }
  }

  const uniqueMissing = [...new Set(required_missing)];
  return {
    ok: uniqueMissing.length === 0,
    required_missing: uniqueMissing,
    reasons,
  };
}

/**
 * Merge Fact-first strategy decision with evidence-chain integrity constraints.
 * Does not rewrite wake signatures.
 */
export function mergeStrategyWithEvidenceIntegrity<T extends {
  ok: boolean;
  required_missing: string[];
  reasons: string[];
  confirm_reason: string | null;
}>(strategy: T, integrity: EvidenceIntegrityDecision): T {
  if (integrity.ok) return strategy;
  const required = [...new Set([...strategy.required_missing, ...integrity.required_missing])];
  return {
    ...strategy,
    ok: false,
    required_missing: required,
    reasons: [...strategy.reasons, ...integrity.reasons],
    confirm_reason: null,
  };
}

/** Prove wake fingerprint ignores content-integrity fields (#577 acceptance 5). */
export function wakeSignaturePayload(input: {
  reviewNodeIds: readonly string[];
  testNodeIds: readonly string[];
  requiredMissing: readonly string[];
}): string {
  return JSON.stringify({
    review: [...input.reviewNodeIds].sort(),
    test: [...input.testNodeIds].sort(),
    missing: [...input.requiredMissing].sort(),
  });
}

/** Map EvidenceSnapshot-like rows into FactNodeSnapshot for diagnostics / integrity. */
export function factNodeSnapshotsFromEvidenceRows(rows: readonly Record<string, unknown>[]): FactNodeSnapshot[] {
  const byId = new Map<string, FactNodeSnapshot>();
  for (const row of rows) {
    const nodeId = String(row.node_id ?? row.id ?? "").trim();
    if (!nodeId || byId.has(nodeId)) continue;
    const refsRaw = row.artifact_refs;
    const artifact_refs = Array.isArray(refsRaw)
      ? refsRaw
          .map((item) => {
            if (!item || typeof item !== "object") return null;
            const uri = String((item as { uri?: unknown }).uri ?? "").trim();
            if (!uri) return null;
            const sha256 = String((item as { sha256?: unknown }).sha256 ?? "").trim();
            return sha256 ? { uri, sha256 } : { uri };
          })
          .filter((item): item is { uri: string; sha256?: string } => item != null)
      : [];
    const observedRaw = row.observed_content_digests;
    const observed_content_digests =
      observedRaw && typeof observedRaw === "object" && !Array.isArray(observedRaw)
        ? Object.fromEntries(
            Object.entries(observedRaw as Record<string, unknown>)
              .filter(([, value]) => typeof value === "string" && value.trim())
              .map(([key, value]) => [key, String(value).trim()]),
          )
        : null;
    byId.set(nodeId, {
      node_id: nodeId,
      node_type: typeof row.node_type === "string" ? row.node_type : "fact",
      project_id: typeof row.project_id === "string" ? row.project_id : null,
      canvas_id: typeof row.canvas_id === "string" ? row.canvas_id : null,
      finding_id: typeof row.finding_id === "string" ? row.finding_id : null,
      job_id: typeof row.job_id === "string" ? row.job_id : null,
      attempt_id: typeof row.attempt_id === "string" ? row.attempt_id : null,
      job_status: typeof row.job_status === "string" ? row.job_status : null,
      source_job_id: typeof row.source_job_id === "string" ? row.source_job_id : null,
      source_role: typeof row.source_role === "string" ? row.source_role : null,
      subject_revision: typeof row.subject_revision === "string" ? row.subject_revision : null,
      evidence_kind: typeof row.evidence_kind === "string" ? row.evidence_kind : null,
      outcome: typeof row.outcome === "string" ? row.outcome : null,
      expected: typeof row.expected === "string" ? row.expected : null,
      actual: typeof row.actual === "string" ? row.actual : null,
      steps: Array.isArray(row.steps) ? row.steps.map(String) : null,
      environment: typeof row.environment === "string" ? row.environment : null,
      runtime_digest: typeof row.runtime_digest === "string" ? row.runtime_digest : null,
      exit_code: typeof row.exit_code === "number" ? row.exit_code : null,
      artifact_refs,
      artifact_id: typeof row.artifact_id === "string" ? row.artifact_id : null,
      content_readable: row.content_readable === false ? false : true,
      content_unreadable_reason:
        typeof row.content_unreadable_reason === "string" ? row.content_unreadable_reason : null,
      observed_content_digests,
    });
  }
  return [...byId.values()];
}

/** Confirm audit fields: content integrity separate from Hub wake fingerprints. */
export function confirmIntegrityAuditFromFacts(
  usedFactIds: readonly string[],
  facts: readonly FactNodeSnapshot[],
): {
  content_integrity_digest: string | null;
  used_fact_replay: Array<{
    ref_id: string;
    source_job_id: string | null;
    attempt_id: string | null;
    subject_revision: string | null;
    evidence_kind: string | null;
    content_integrity_digest: string | null;
    runtime_digest: string | null;
    runtime_proof: boolean;
    text_only_not_reproduction_proof: boolean;
  }>;
} {
  const byId = new Map(facts.map((f) => [f.node_id, f]));
  const digests: string[] = [];
  const used_fact_replay = [...usedFactIds].map((id) => {
    const fact = byId.get(id);
    const diag = diagnoseFactNode(fact, { refId: id });
    if (diag.content_integrity_digest) digests.push(diag.content_integrity_digest);
    const kind = fact?.evidence_kind ?? null;
    const textOnly =
      kind === "test" &&
      Boolean(fact?.expected?.trim()) &&
      Boolean(fact?.actual?.trim()) &&
      !diag.runtime_proof;
    return {
      ref_id: id,
      source_job_id: diag.source.job_id,
      attempt_id: diag.ownership.attempt_id,
      subject_revision: diag.subject_revision,
      evidence_kind: kind,
      content_integrity_digest: diag.content_integrity_digest,
      runtime_digest: fact?.runtime_digest ?? null,
      runtime_proof: diag.runtime_proof,
      text_only_not_reproduction_proof: textOnly,
    };
  });
  const content_integrity_digest =
    digests.length === 0
      ? null
      : contentIntegrityDigest(JSON.stringify([...digests].sort())).slice(0, 32);
  return { content_integrity_digest, used_fact_replay };
}

