import { createHash } from "node:crypto";
import type { RepairFeedbackCategory } from "@deepsonar/shared-types";
import type { sql } from "../../db.js";

export type KnowledgeDb = typeof sql;
export type KnowledgeRow = Record<string, unknown>;
export class KnowledgeOperationError extends Error {
  constructor(
    public readonly error_code: string,
    message: string,
    public readonly category: RepairFeedbackCategory = "model_correctable",
    public readonly next_action = "Re-read the current work and correct the request",
    public readonly path?: string,
  ) { super(message); this.name = "KnowledgeOperationError"; }
}
export const reject = (code: string, message: string, path?: string): never => {
  throw new KnowledgeOperationError(code, message, "model_correctable", "Re-read the current state and submit a corrected request", path);
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
