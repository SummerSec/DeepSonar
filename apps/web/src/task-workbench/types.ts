import type { TaskLifecycleStatus } from "../task-lifecycle";

/** UI 投影，不替换后端 Job/Finding/Fact/Report 真相。 */

export type TaskActionKind = "human_decision" | "model_repair" | "transient_retry" | "unknown_effect";
export type TaskActionPriority = "critical" | "high" | "normal" | "low";
export type TaskTraceKind = "intent" | "plan" | "capability" | "run" | "evidence" | "decision" | "report";
export type TaskCognitionStatus = "unknown" | "supported" | "conflict" | "refuted" | "needs_human";
export type TaskDeliveryStatus = "none" | "draft" | "stale" | "delivered";

export type TaskOutcomeSummary = {
  objective: string;
  lifecycle: TaskLifecycleStatus;
  lifecycle_reason: string;
  confirmed_count: number;
  pending_verification_count: number;
  needs_human_count: number;
  conflict_count: number;
  covered_scope: string[];
  uncovered_scope: string[];
  current_report_version: number | null;
  report_stale: boolean;
  last_updated_at: string;
};

export type TaskAction = {
  id: string;
  kind: TaskActionKind;
  title: string;
  reason: string;
  impact: string;
  evidence_refs: string[];
  recommended_action: string;
  reversible: boolean;
  next_state: string;
  priority: TaskActionPriority;
  href?: string;
};

export type TaskTraceEntry = {
  id: string;
  kind: TaskTraceKind;
  title: string;
  status: string;
  reason: string | null;
  source_refs: string[];
  digest: string | null;
  created_at: string;
};

export type TaskStatusLines = {
  execution: { status: TaskLifecycleStatus; label: string };
  cognition: { status: TaskCognitionStatus; label: string };
  delivery: { status: TaskDeliveryStatus; label: string };
};
