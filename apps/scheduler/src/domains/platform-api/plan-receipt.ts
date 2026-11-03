import { createHash } from 'node:crypto';
import { ControlInputError } from '../../control-input.js';
import { sql } from '../../db.js';
import { completionInputDigest } from '../event-ingestion/completion-receipt.js';
import { readControlReceiptByKey, planSettlementDigest } from '../event-ingestion/control-receipt.js';
import { controlRuntimeRejection } from './repair.js';
import { consumeEventRateLimit, EventRateLimitError } from '../event-ingestion/rate-limit.js';
import { invokeRuntimeHandler, type PlatformRuntimeHandlerContext } from './registry.js';
import type { CapabilityPrincipal } from './tokens.js';
import { validateCompletionRecoveryDecision, recoveryGrantForHub } from '../job-attempt/recovery.js';
import { CompletionRecoveryDecision, type CompletionRecoveryGrant } from '@deepsonar/shared-types';

export const PLAN_RECEIPT_OPERATIONS = ['submit_hub_decision', 'request_human'] as const;
export type PlanReceiptOperation = typeof PLAN_RECEIPT_OPERATIONS[number];
type Result = { statusCode: number; body: Record<string, unknown> };
export type PlanReceipt = {
  v: 1; operation: PlanReceiptOperation; idempotency_key: string; input_digest: string; resolved_input_digest:string;
  event_id: string; settlement_digest:string; attempt_id: string; snapshot_digest: string; status: 'persisted_deferred'; result: Result;
  capability_token_id?: string;
};
const reject = (code: string, error: string): Result => ({statusCode:409,body:{accepted:false,error_code:code,error,retryable:false}});
function receiptId(job: string, key: string) {
  const hex=createHash('sha256').update(`deepsonar:plan-receipt:v1:${job}:${key}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export async function readPlanReceipt(db:typeof sql, jobId:string, key:string):Promise<PlanReceipt|null> {
  const row=await readControlReceiptByKey(db,jobId,key);
  return row?.v===1 && PLAN_RECEIPT_OPERATIONS.includes(row.operation as PlanReceiptOperation)
    && row.status==='persisted_deferred' ? row as PlanReceipt : null;
}
async function canRestore(db:typeof sql, jobId:string, attemptId:string, checkEffects=true, grant?: CompletionRecoveryGrant) {
  const notCheck=!checkEffects;
  const recovery = Boolean(grant);
  const targetJob = grant?.target_job_id ?? jobId;
  const targetAttempt = grant?.target_attempt_id ?? attemptId;
  const [row]=await db`SELECT a.id FROM job_attempts a JOIN jobs j ON j.id=a.job_id
    WHERE j.id=${jobId} AND a.id=${attemptId} AND a.status='active' AND NOT a.cancel_requested
      AND j.status='running' AND j.lease_expires_at>clock_timestamp()
      AND j.started_at+j.timeout_sec*interval '1 second'>clock_timestamp()
      AND (${notCheck} OR NOT EXISTS (SELECT 1 FROM job_attempt_effects e JOIN jobs source ON source.id=e.job_id
        WHERE source.canvas_id=j.canvas_id AND source.project_id=j.project_id
        AND NOT (${recovery} AND e.job_id=${targetJob} AND e.attempt_id=${targetAttempt})
        AND (e.status='unknown' OR (e.status='effect_pending' AND source.status NOT IN ('pending','claimed','provisioning','running','waiting_human')))))`;
  return Boolean(row);
}

/** Receipt acceptance never dispatches. Final semantic ingestion remains the sole revision/budget authority. */
export async function invokeDurablePlanDecision(input: {
  principal:CapabilityPrincipal; operation:PlanReceiptOperation; key:string; payload:unknown; requestInput?:unknown;
}, db:typeof sql=sql):Promise<Result> {
  const {principal,operation,key,payload}=input;
  const digest=completionInputDigest(input.requestInput ?? payload);
  const resolvedDigest=completionInputDigest(payload);
  const context:PlatformRuntimeHandlerContext={jobId:principal.jobId,projectId:principal.projectId,
    canvasId:principal.canvasId,operationId:operation,input:payload,eventId:key,tokenId:principal.tokenId,idempotencyKey:key};
  const recovery = operation === 'submit_hub_decision' && payload && typeof payload === 'object' && 'recovery' in payload
    ? CompletionRecoveryDecision.parse((payload as {recovery:unknown}).recovery) : undefined;
  let recoveryGrant: CompletionRecoveryGrant | undefined;
  let preparedAttempt:string|undefined;
  const matches=(receipt:PlanReceipt)=>receipt.operation===operation && receipt.input_digest===digest
    && receipt.resolved_input_digest===resolvedDigest && receipt.event_id===key && receipt.snapshot_digest===principal.snapshotSha256;
  // Database preflight runs before acquiring transaction locks. The locked prepare is local-only.
  if(!await readControlReceiptByKey(db,principal.jobId,key)) {
    const [attempt]=await db`SELECT id FROM job_attempts WHERE job_id=${principal.jobId} AND status='active' AND NOT cancel_requested`;
    if(!attempt) return reject('PLAN_RECEIPT_INACTIVE','Plan receipt requires an active Attempt');
    await invokeRuntimeHandler({...context,planPhase:'validate',planAttemptId:String(attempt.id)});
  }
  let receipt:PlanReceipt|undefined;
  let result:Result;
  try {
    result=await db.begin(async raw=>{
      const tx=raw as unknown as typeof sql;
      if(!principal.canvasId) return reject('PLAN_RECEIPT_SCOPE_INVALID','Plan receipt requires the current Canvas');
      await tx`SELECT id FROM canvases WHERE id=${principal.canvasId} AND project_id=${principal.projectId} FOR UPDATE`;
      const [job]=await tx`SELECT * FROM jobs WHERE id=${principal.jobId} FOR UPDATE`;
      if(!job || job.canvas_id!==principal.canvasId || job.project_id!==principal.projectId
        || completionInputDigest(job.agent_snapshot_json)!==principal.snapshotSha256) return reject('PLAN_RECEIPT_SCOPE_INVALID','Plan receipt scope or snapshot changed');
      const prior=await readControlReceiptByKey(tx,principal.jobId,key);
      if(prior) {
        const saved=await readPlanReceipt(tx,principal.jobId,key);
        if(!saved || !matches(saved)) return reject('IDEMPOTENCY_KEY_CONFLICT','Key belongs to a different operation, input or snapshot');
        receipt=saved;return saved.result;
      }
      const [knowledge]=await tx`SELECT id FROM project_knowledge_receipts WHERE job_id=${principal.jobId} AND idempotency_key=${key}`;
      const [used]=await tx`SELECT event_id FROM event_dedup WHERE event_id=${key}`;
      if(knowledge || used) return reject('IDEMPOTENCY_KEY_CONFLICT','Key already belongs to another committed operation');
      const [previous]=await tx`SELECT id FROM events WHERE job_id=${principal.jobId} AND type='control_receipt'
        AND payload_json->>'operation'=${operation} AND payload_json->>'status'='persisted_deferred' LIMIT 1`;
      if(previous) return reject('PLAN_DECISION_ALREADY_ACCEPTED','Read the original receipt; this Job already accepted this Plan operation');
      const [attempt]=await tx`SELECT id FROM job_attempts WHERE job_id=${principal.jobId} AND status='active' AND NOT cancel_requested FOR UPDATE`;
      if(!attempt || !await canRestore(tx,principal.jobId,String(attempt.id),false)) return reject('PLAN_RECEIPT_INACTIVE','Plan acceptance requires an active leased Attempt without unknown effects');
      if (recovery) recoveryGrant = (await validateCompletionRecoveryDecision(tx, job, recovery,
        { lockTarget: true, tokenId: principal.tokenId })).grant;
      preparedAttempt=String(attempt.id);
      const prepared=await invokeRuntimeHandler({...context,planPhase:'prepare',planAttemptId:preparedAttempt}) as Record<string,unknown>;
      if(prepared?.plan_prepared!==true) return reject('PLAN_PREPARE_UNSUPPORTED','Runtime does not support durable Plan preparation');
      const ref=receiptId(principal.jobId,key);
      const response:Result={statusCode:200,body:{accepted:true,operation,receipt_ref:ref,receipt_status:'persisted_deferred'}};
      receipt={v:1,operation,idempotency_key:key,input_digest:digest,resolved_input_digest:resolvedDigest,settlement_digest:planSettlementDigest(operation,payload),event_id:key,attempt_id:preparedAttempt,
        snapshot_digest:principal.snapshotSha256,capability_token_id:principal.tokenId,status:'persisted_deferred',result:response};
      await consumeEventRateLimit(tx,principal.jobId,'control_receipt',new Date());
      const [{next}]=await tx`SELECT COALESCE(MAX(job_seq),0)+1 AS next FROM events WHERE job_id=${principal.jobId}`;
      await tx`INSERT INTO event_dedup(event_id,job_id) VALUES(${ref},${principal.jobId})`;
      await tx`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json)
        VALUES(${principal.jobId},${ref},${next},${preparedAttempt},'control_receipt',${tx.json(receipt as never)})`;
      return response;
    }) as unknown as Result;
  } catch(error) {
    // Resolve an uncertain commit before releasing the local reservation. No effect replay is authorized here.
    try {
      const saved=await db.begin(async raw=>{
        const tx=raw as unknown as typeof sql;
        await tx`SELECT id FROM jobs WHERE id=${principal.jobId} FOR UPDATE`;
        const prior=await readPlanReceipt(tx,principal.jobId,key);
        if(!prior && preparedAttempt) await invokeRuntimeHandler({...context,planPhase:'abort',planAttemptId:preparedAttempt}).catch(()=>{});
        return prior;
      });
      if(saved) return matches(saved) ? saved.result : reject('IDEMPOTENCY_KEY_CONFLICT','Stored receipt does not match this request');
    }catch {return {statusCode:503,body:{accepted:false,error_code:'PLAN_RECEIPT_UNCERTAIN',error:'Receipt outcome unknown; query receipt_key before retrying unchanged input',retryable:false}};}
    if(error instanceof ControlInputError) return {statusCode:409,body:{...controlRuntimeRejection({operation,code:error.code,message:error.message,
      retryable:false,statusCode:409,path:error.path,details:error.details,idempotencyKey:key})}};
    if(error instanceof EventRateLimitError) return {statusCode:429,body:{...controlRuntimeRejection({operation,code:error.code,message:error.message,retryable:true,statusCode:429,details:{...error.metadata},idempotencyKey:key})}};
    throw error;
  }
  let restore = Boolean(receipt && result.statusCode===200);
  if (restore && recovery && receipt) {
    try {
      const [hub] = await db`SELECT * FROM jobs WHERE id=${principal.jobId}`;
      recoveryGrant = recoveryGrantForHub(hub, recovery);
      if (!receipt.capability_token_id) restore = false;
      else await validateCompletionRecoveryDecision(db, hub, recovery, { tokenId: receipt.capability_token_id });
    } catch { restore = false; }
  }
  if(receipt && restore && await canRestore(db,principal.jobId,receipt.attempt_id,operation!=='request_human',recoveryGrant)) {
    const [settled]=await db`SELECT event_id FROM events WHERE job_id=${principal.jobId} AND event_id=${receipt.event_id}`;
    if(!settled) await invokeRuntimeHandler({...context,planPhase:'commit',planAttemptId:receipt.attempt_id}).catch(()=>{});
  } else if(preparedAttempt) {
    await invokeRuntimeHandler({...context,planPhase:'abort',planAttemptId:preparedAttempt}).catch(()=>{});
  }
  return result;
}
