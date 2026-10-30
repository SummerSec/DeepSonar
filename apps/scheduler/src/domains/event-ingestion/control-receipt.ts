import { createHash } from "node:crypto";
import type { sql } from '../../db.js';

/** Shared key ownership, always rechecked under the existing Job transaction lock. */
export async function readControlReceiptByKey(db: typeof sql, jobId: string, key: string) {
  const [row] = await db`SELECT payload_json FROM events WHERE job_id=${jobId}
    AND type='control_receipt' AND payload_json->>'idempotency_key'=${key} LIMIT 1`;
  return row?.payload_json as Record<string, unknown> | undefined;
}

export function controlInputDigest(input: unknown): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  };
  return createHash("sha256").update(canonical(input)).digest("hex");
}
/** Mirrors the existing executor's terminal normalization, not an alternate payload schema. */
export function planSettlementDigest(operation:string, input:unknown) {
  const payload=input as Record<string,unknown>;
  if(operation==='request_human') return controlInputDigest({...payload,reason:String(payload.reason).trim()});
  if(Array.isArray(payload.intents)) return controlInputDigest({...payload,intents:payload.intents.map((intent:Record<string,unknown>)=>({
    ...intent,role:String(intent.role).trim(),description:String(intent.description).trim(),prompt:String(intent.prompt).trim(),
  }))});
  return controlInputDigest(payload);
}
