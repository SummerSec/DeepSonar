import { HumanPayload, PlanDecisionBasis } from '@deepsonar/shared-types';
import type { sql } from '../../db.js';
import { contentSha256 } from './criterion-model.js';

export type SupplementationState = 'not_dispatched' | 'queued' | 'preparing' | 'running' | 'waiting_human' | 'succeeded' | 'failed' | 'cancelled' | 'timeout' | 'unknown';
export interface PlanExecutionProjection {
  v: 1;
  scope: 'single_supplementation';
  state: SupplementationState;
  reason: string;
  truncated: boolean;
  source: { decision_event_id: string; decision_job_id: string; criterion_id: string; job_id?: string; attempt_id?: string; intent_node_id?: string } | null;
  job_status?: string;
  attempt_status?: string;
  attempt_phase?: string;
  reported_blocker?: { event_id: string; authority: 'agent_report'; kind: string };
  completion_assessment: 'unknown';
  source_sha256: string;
}

/** A read-only lifecycle summary, never evidence of semantic success or negative observations. */
export async function loadPlanExecution(db: typeof sql, canvasId: string, projectId: string, planJobId: string, planSha: string): Promise<PlanExecutionProjection> {
  const finish = (value: Omit<PlanExecutionProjection, 'v'|'scope'|'completion_assessment'|'source_sha256'>): PlanExecutionProjection => {
    const body = { v: 1 as const, scope: 'single_supplementation' as const, ...value, completion_assessment: 'unknown' as const };
    return { ...body, source_sha256: contentSha256(body) };
  };
  // Only committed Hub events anchor dispatch. A pending control_receipt cannot be an execution root.
  const decisions = await db`SELECT e.event_id,e.job_id,e.payload_json->'plan_basis' AS basis
    FROM events e JOIN jobs parent ON parent.id=e.job_id
    WHERE parent.canvas_id=${canvasId} AND parent.project_id=${projectId} AND parent.type<>'report'
      AND e.type='hub_decision' AND e.payload_json->'plan_basis'->>'plan_job_id'=${planJobId}
      AND e.payload_json->'plan_basis'->>'outcome'='continue' ORDER BY e.id LIMIT 2`;
  if (!decisions.length) return finish({ state:'not_dispatched', reason:'no_committed_supplementation', truncated:false, source:null });
  if (decisions.length>1) return finish({ state:'unknown', reason:'multiple_supplementation_decisions', truncated:true, source:null });
  const decision=decisions[0], basis=PlanDecisionBasis.safeParse(decision.basis);
  if (!basis.success || basis.data.plan_sha256!==planSha) return finish({ state:'unknown', reason:'decision_plan_version_mismatch', truncated:false, source:null });
  const source={ decision_event_id:String(decision.event_id), decision_job_id:String(decision.job_id), criterion_id:basis.data.criterion_id };
  const children=await db`SELECT j.id,j.status,a.id AS attempt_id,a.status AS attempt_status,a.phase AS attempt_phase,
      a.cancel_requested,a.outcome_json->>'reason' AS attempt_reason,
      ARRAY(SELECT n.id::text FROM canvas_nodes n WHERE n.canvas_id=j.canvas_id AND n.job_id=j.id AND n.node_type='intent' ORDER BY n.id LIMIT 2) AS intent_ids,
      EXISTS(SELECT 1 FROM job_attempt_effects e JOIN job_attempts owner ON owner.id=e.attempt_id
        WHERE (e.job_id=j.id OR owner.job_id=j.id) AND (e.job_id<>owner.job_id OR e.status='unknown'
          OR (e.status='effect_pending' AND (owner.status<>'active' OR j.status NOT IN ('pending','claimed','provisioning','running','waiting_human'))))) AS unknown_effect,
      h.event_id AS human_event_id,h.payload_json AS human_payload
    FROM jobs j
    LEFT JOIN LATERAL (SELECT * FROM job_attempts WHERE job_id=j.id ORDER BY attempt_no DESC LIMIT 1) a ON true
    LEFT JOIN LATERAL (SELECT event_id,payload_json FROM events WHERE job_id=j.id AND attempt_id=a.id AND type='human' ORDER BY id DESC LIMIT 1) h ON true
    WHERE j.canvas_id=${canvasId} AND j.project_id=${projectId} AND j.parent_job_id=${source.decision_job_id}
      AND j.type<>'report' AND j.payload_json->'plan_context'->>'plan_job_id'=${planJobId}
      AND j.payload_json->'plan_context'->>'plan_sha256'=${planSha}
      AND j.payload_json->'plan_context'->>'decision_event_id'=${source.decision_event_id}
      AND j.payload_json->'plan_context'->'scheduler_owned'='true'::jsonb ORDER BY j.id LIMIT 2`;
  if (children.length!==1) return finish({ state:'unknown', reason:'dispatch_link_unavailable', truncated:children.length>1, source });
  const child=children[0], jobId=String(child.id);
  const attempt=child.attempt_id ? {id:child.attempt_id,status:child.attempt_status,phase:child.attempt_phase,cancel_requested:child.cancel_requested,reason:child.attempt_reason} : null;
  const nodes=child.intent_ids as string[];
  const effect=child.unknown_effect;
  const linked={...source,job_id:jobId,...(attempt?{attempt_id:String(attempt.id)}:{}),...(nodes.length===1?{intent_node_id:nodes[0]}:{})};
  const details={source:linked,job_status:String(child.status),...(attempt?{attempt_status:String(attempt.status),attempt_phase:String(attempt.phase)}:{})};
  let state:SupplementationState='unknown', reason='lifecycle_inconsistent';
  if (effect) reason='unknown_external_effect';
  else if (nodes.length!==1) reason='intent_link_unavailable';
  else if (child.status==='orphan' || ['unknown','orphan','interrupted'].includes(attempt?.status)) reason='execution_context_unavailable';
  else if (['pending','claimed'].includes(child.status) && (!attempt || attempt.status==='active')) { state='queued'; reason='awaiting_dispatch'; }
  else if (child.status==='provisioning' && attempt?.status==='active') { state='preparing'; reason='preparing_execution'; }
  else if (child.status==='running' && attempt?.status==='active') { state='running'; reason=attempt.cancel_requested?'cancellation_requested':'execution_in_progress'; }
  else if (child.status==='waiting_human' && attempt?.status==='active') { state='waiting_human'; reason='awaiting_human'; }
  else if (attempt && ['succeeded','failed','cancelled','timeout'].includes(child.status) && attempt.status===child.status) {
    state=child.status as SupplementationState; reason=`job_${state}`;
    // Never expose free-form errors or infer environment/budget categories from their text.
    if (['provision_timeout','reaper_timeout','reaper_stall','human_timeout'].includes(attempt.reason)) reason=String(attempt.reason);
  }
  let reported_blocker:PlanExecutionProjection['reported_blocker'];
  if (state==='waiting_human' && attempt) {
    const human=HumanPayload.safeParse(child.human_payload);
    if (human.success && human.data.subject.type==='platform_blocker') reported_blocker={event_id:String(child.human_event_id),authority:'agent_report',kind:human.data.subject.kind};
  }
  return finish({...details,state,reason,truncated:nodes.length>1,...(reported_blocker?{reported_blocker}:{})});
}
