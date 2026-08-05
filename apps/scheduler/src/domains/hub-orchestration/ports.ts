import type { sql } from "../../db.js";

/** The tagged postgres client or an already-open transaction supplied by a caller. */
export type HubOrchestrationDatabase = typeof sql;
export type HubOrchestrationTransaction = HubOrchestrationDatabase;

export interface HubProjectRules {
  minVerifySeverity: string;
  auditTimeoutSec: number;
  hubEnabled: boolean;
  maxHubRounds: number;
}

export interface HubCanvasConvergence {
  hub_paused: boolean;
  paused_reason?: string;
  paused_at?: string;
  auto_stopped: boolean;
  pending_confirmed_ids?: string[];
}

export interface HubJobRecord {
  /** Database rows are intentionally opaque at the bounded-context seam. */
  id?: unknown;
  project_id?: unknown;
  canvas_id?: unknown;
  type?: unknown;
  priority?: unknown;
  [key: string]: unknown;
}

export type HubCanvasJobTerminalStatus =
  | "succeeded"
  | "failed"
  | "timeout"
  | "orphan"
  | "cancelled";

export interface HubAnalysisCompleteGate {
  ok: boolean;
  blockers: string[];
}

export interface HubOrchestrationPorts {
  rulesForProject: (tx: HubOrchestrationTransaction, projectId: string) => Promise<HubProjectRules>;
  lockCanvasForConvergence: (
    tx: HubOrchestrationTransaction,
    canvasId: string | null | undefined,
  ) => Promise<boolean>;
  readCanvasConvergence: (
    tx: HubOrchestrationTransaction,
    canvasId: string,
  ) => Promise<HubCanvasConvergence>;
  patchCanvasConvergence: (
    tx: HubOrchestrationTransaction,
    canvasId: string,
    patch: Partial<HubCanvasConvergence>,
  ) => Promise<HubCanvasConvergence>;
  careSeverities: (minSeverity: string) => string[];
  resolveAgentSnapshotForJob: (
    tx: HubOrchestrationTransaction,
    projectId: string,
    type: string,
  ) => Promise<unknown>;
  fixedPriorityForJob: (input: { type: string; purpose?: string }) => number;
  insertEdgeIfAbsent: (
    tx: HubOrchestrationTransaction,
    canvasId: string,
    fromId: string,
    toId: string,
    edgeType: string,
  ) => Promise<void>;
  settleCanvasFindingsAtGuardrail: (
    tx: HubOrchestrationTransaction,
    canvasId: string,
    reason: string,
  ) => Promise<unknown>;
  evaluateAnalysisCompleteGate: (
    tx: HubOrchestrationTransaction,
    canvasId: string,
    options: { excludeJobId?: string | null },
  ) => Promise<HubAnalysisCompleteGate>;
  hasSucceededRoleWork: (tx: HubOrchestrationTransaction, canvasId: string) => Promise<boolean>;
  maybeDispatchReport: (tx: HubOrchestrationTransaction, canvasId: string) => Promise<unknown>;
}
