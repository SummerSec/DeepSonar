import { SubmitPlanPayload } from "@deepsonar/shared-types";
import { sql } from "../../db.js";
import { controlInputDigest } from "../event-ingestion/control-receipt.js";

/** Immediate Plan mutations settle in their semantic event, not a second receipt ledger. */
export async function planRevisionReceipt(jobId: string, key: string, input?: unknown) {
  const [event] = await sql`SELECT id::text AS revision,job_id,type,payload_json FROM events WHERE event_id=${key}`;
  if (!event) return null;
  const stored = SubmitPlanPayload.safeParse(event.payload_json);
  if (event.job_id !== jobId || event.type !== "plan" || !stored.success || !stored.data.revision
    || (input !== undefined && controlInputDigest(stored.data) !== controlInputDigest(input))) {
    return {statusCode:409, body:{accepted:false,error_code:"IDEMPOTENCY_KEY_CONFLICT",error:"Key belongs to a different input or operation",retryable:false}};
  }
  return {statusCode:200, body:{accepted:true,operation:"submit_plan",receipt_status:"committed",
    event_id:key,revision:String(event.revision),plan_job_id:stored.data.revision.plan_job_id}};
}

export async function isPlanRevisionKey(key: string): Promise<boolean> {
  const [row] = await sql`SELECT 1 FROM events WHERE event_id=${key} AND type='plan' AND payload_json ? 'revision'`;
  return Boolean(row);
}
