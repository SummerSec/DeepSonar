import { createHash } from "node:crypto";
import type { RepairFeedbackCategory } from "@deepsonar/shared-types";
import type { sql } from "../../db.js";

export type KnowledgeDb = typeof sql;
export type KnowledgeRow = Record<string, unknown>;
const STOP_ACTIONS: Readonly<Record<string, string>> = {
  KNOWLEDGE_JOB_INACTIVE: "Stop this operation; the Job or Attempt is inactive. Scheduler must determine whether a governed recovery is permitted.",
  KNOWLEDGE_SCOPE_DENIED: "Stop this operation; the current Job grant does not authorize it. Report the scope blocker without changing permissions or retrying the same request.",
  KNOWLEDGE_REVOKED: "Stop using this version or source; its authorization is unavailable or revoked. Do not replay the request or bypass the frozen Job scope.",
  KNOWLEDGE_SNAPSHOT_INVALID: "Stop this operation and report the invalid frozen snapshot to Scheduler; the Agent cannot repair or replace the Job snapshot.",
  KNOWLEDGE_BUDGET_EXHAUSTED: "Stop this knowledge work and report its exhausted budget; do not create a new request to reset the budget.",
  KNOWLEDGE_CATALOG_LIMIT: "Stop and report the frozen catalog size blocker to Scheduler; changing tool input cannot reduce the snapshot.",
  KNOWLEDGE_SUGGESTION_CATALOG_LIMIT: "Stop and report the authorized catalog size blocker to Scheduler; do not bypass the bounded read budget.",
  KNOWLEDGE_IDEMPOTENCY_CONFLICT: "Stop this conflicting operation and report the conflict to Scheduler; do not assume this request has a receipt or change keys to replay an accepted or unknown effect.",
};

export class KnowledgeOperationError extends Error {
  constructor(
    public readonly error_code: string,
    message: string,
    public readonly category: RepairFeedbackCategory = STOP_ACTIONS[error_code] ? "permanent_failure" : "model_correctable",
    public readonly next_action = STOP_ACTIONS[error_code] ?? "Re-read the current authorized state, correct the input, and submit with a new Idempotency-Key while this Job and Attempt remain active",
    public readonly path?: string,
  ) { super(message); this.name = "KnowledgeOperationError"; }
}
export const reject = (code: string, message: string, path?: string): never => {
  throw new KnowledgeOperationError(code, message, undefined, undefined, path);
};
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
/** event_dedup.event_id is globally unique; scope the idempotency key to its owning Job. */
export function knowledgeEventId(jobId: string, key: string): string {
  const hex = sha256(`${jobId}:${key}`).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export const asRows = (value: unknown): KnowledgeRow[] => Array.isArray(value) ? value as KnowledgeRow[] : [];
