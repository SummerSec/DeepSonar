/**
 * Semantic-event attribution after cancel / timeout / orphan (#400).
 *
 * Linearization point is the Job row status observed under the ingest lock.
 * Events accepted before that point stay on the Job ledger; events after it
 * are rejected, do not advance the canvas, and remain retryable by event_id.
 */

import { CONTROL_INPUT_ERROR_CODES, ControlInputError } from "./control-input.js";
import { TERMINAL_JOB_STATUSES } from "./domains/job-lifecycle/transition-policy.js";

export const EVENT_LINEARIZATION = "job_status_at_lock" as const;

export const LATE_EVENT_JOB_STATUSES = [
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  "orphan",
  "waiting_human",
  "pending",
  "claimed",
  "provisioning",
] as const;

export interface EventAttribution {
  job_id: string;
  job_status: string;
  attempt_id: string | null;
  job_seq: number | null;
  linearization: typeof EVENT_LINEARIZATION;
  accepted: boolean;
  canvas_mutated: boolean;
}

export function isSemanticAcceptingStatus(status: string): boolean {
  return status === "running";
}

export function lateEventAttribution(input: {
  jobId: string;
  jobStatus: string;
  attemptId?: string | null;
  jobSeq?: number | null;
}): EventAttribution {
  return {
    job_id: input.jobId,
    job_status: input.jobStatus,
    attempt_id: input.attemptId ?? null,
    job_seq: input.jobSeq ?? null,
    linearization: EVENT_LINEARIZATION,
    accepted: false,
    canvas_mutated: false,
  };
}

export function jobNotRunningError(attribution: EventAttribution): ControlInputError {
  const terminal = (TERMINAL_JOB_STATUSES as readonly string[]).includes(attribution.job_status)
    || attribution.job_status === "failed"
    || attribution.job_status === "timeout"
    || attribution.job_status === "orphan";
  const message = terminal
    ? `语义事件只能提交给 status=running 的 Job；当前已是 ${attribution.job_status}，迟到事件不入图。`
    : "语义事件只能提交给 status=running 的 Job。";
  return new ControlInputError(
    CONTROL_INPUT_ERROR_CODES.jobNotRunning,
    message,
    "status",
    { ...attribution },
  );
}

export function acceptedEventAttribution(input: {
  jobId: string;
  attemptId?: string | null;
  jobSeq: number;
}): EventAttribution {
  return {
    job_id: input.jobId,
    job_status: "running",
    attempt_id: input.attemptId ?? null,
    job_seq: input.jobSeq,
    linearization: EVENT_LINEARIZATION,
    accepted: true,
    canvas_mutated: true,
  };
}
