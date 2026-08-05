import type {
  FindingVerificationCloseOptions,
  FindingVerificationCloseResult,
  FindingAnalysisCompleteGate,
  FindingVerificationLegacyPort,
  FindingVerificationTransaction,
} from "./ports.js";

export type {
  FindingVerificationCloseOptions,
  FindingVerificationCloseResult,
  FindingAnalysisCompleteGate,
  FindingVerificationLegacyPort,
  FindingVerificationTransaction,
} from "./ports.js";

export interface FindingVerificationApplication {
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
  buildVerificationFollowupPayload(trigger: Record<string, unknown>, from: string[], role: string): Record<string, unknown>;
  buildEvidenceSnapshot(rows: readonly Record<string, unknown>[], originJobId: string | null): unknown;
  mapProposedVerdict(raw: string | undefined | null): string;
}

/**
 * Application adapter for the gradual migration from verify.ts.  All callers
 * cross this narrow seam; the legacy module remains a compatibility adapter
 * until its implementation can move without changing transaction ordering.
 */
export function createFindingVerificationApplication(
  ports: FindingVerificationLegacyPort,
): FindingVerificationApplication {
  return {
    collectEvidenceSnapshot: ports.collectEvidenceSnapshot,
    createVerifyRound: ports.createVerifyRound,
    evaluateFollowup: ports.evaluateFollowup,
    settleCanvasFindingsAtGuardrail: ports.settleCanvasFindingsAtGuardrail,
    closeVerifyRound: ports.closeVerifyRound,
    maybeReverifyAfterFollowup: ports.maybeReverifyAfterFollowup,
    attachVerificationEvidence: ports.attachVerificationEvidence,
    careSeverityMeta: ports.careSeverityMeta,
    canvasFindingsConverged: ports.canvasFindingsConverged,
    evaluateAnalysisCompleteGate: ports.evaluateAnalysisCompleteGate,
    hasSucceededRoleWork: ports.hasSucceededRoleWork,
    findingVerificationSummaries: ports.findingVerificationSummaries,
    findingVerificationSummary: ports.findingVerificationSummary,
    normalizePendingVerificationRounds: ports.normalizePendingVerificationRounds,
    buildVerificationFollowupPayload: ports.buildVerificationFollowupPayload,
    buildEvidenceSnapshot: ports.buildEvidenceSnapshot,
    mapProposedVerdict: ports.mapProposedVerdict,
  };
}
