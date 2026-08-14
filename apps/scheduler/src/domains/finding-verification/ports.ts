/**
 * Finding verification uses the caller's transaction.  The context never
 * starts a nested transaction and never updates a Job status directly.
 */
export type FindingVerificationTransaction = (...args: any[]) => Promise<any[]>;

export interface FindingVerificationCloseOptions {
  jobStatus: "succeeded" | "failed" | "timeout" | "orphan" | "cancelled";
  proposedVerdict?: string | null;
  summary?: string | null;
  error?: string | null;
}

export interface FindingVerificationCloseResult {
  outcome: "confirmed" | "rework" | "needs_human" | "skipped";
  forceHub: boolean;
  hubTrigger?: Record<string, unknown>;
  sourceNodeIds?: string[];
}

export interface FindingAnalysisCompleteGate {
  ok: boolean;
  blockers: string[];
  problems: Array<Record<string, unknown>>;
}

export interface FindingVerificationLegacyPort {
  collectEvidenceSnapshot(tx: FindingVerificationTransaction, findingId: string, originJobId: string | null): Promise<unknown>;
  createVerifyRound(tx: FindingVerificationTransaction, options: Record<string, unknown>): Promise<unknown>;
  evaluateFollowup(tx: FindingVerificationTransaction, job: Record<string, unknown>, finding: Record<string, unknown>): Promise<void>;
  settleCanvasFindingsAtGuardrail(tx: FindingVerificationTransaction, canvasId: string, reason: string): Promise<unknown>;
  closeVerifyRound(tx: FindingVerificationTransaction, jobId: string, options: FindingVerificationCloseOptions): Promise<FindingVerificationCloseResult>;
  maybeReverifyAfterFollowup(tx: FindingVerificationTransaction, job: Record<string, unknown>): Promise<void>;
  attachVerificationEvidence(tx: FindingVerificationTransaction, job: Record<string, unknown>, nodeId: string, canvasId: string, verification: unknown): Promise<boolean>;
  careSeverityMeta(tx: FindingVerificationTransaction, projectId: string): Promise<unknown>;
  canvasFindingsConverged(tx: FindingVerificationTransaction, canvasId: string, options?: Record<string, unknown>): Promise<unknown>;
  evaluateAnalysisCompleteGate(tx: FindingVerificationTransaction, canvasId: string, options?: Record<string, unknown>): Promise<FindingAnalysisCompleteGate>;
  hasSucceededRoleWork(tx: FindingVerificationTransaction, canvasId: string): Promise<boolean>;
  findingVerificationSummaries(tx: FindingVerificationTransaction, findingIds: readonly string[]): Promise<Map<string, Record<string, unknown>>>;
  findingVerificationSummary(tx: FindingVerificationTransaction, findingId: string): Promise<Record<string, unknown>>;
  normalizePendingVerificationRounds(db?: FindingVerificationTransaction): Promise<unknown>;
  isSeverityInVerifyScope(minSeverity: string, severity: unknown): boolean;
  buildVerificationFollowupPayload(trigger: Record<string, unknown> | undefined, from: string[], role: string): Record<string, unknown> | null;
  buildEvidenceSnapshot(rows: readonly Record<string, unknown>[], originJobId: string | null): unknown;
  mapProposedVerdict(raw: string | undefined | null): string;
}
