import { loadPlanExecution } from "./execution-projection.js";
import type { GraphQueryPayload } from "@deepsonar/shared-types";
import type { sql } from "../../db.js";
import { readPlanObjective, readPlanExecutionState } from "./objective.js";

export interface PlanReadProof { projection_sha256:string; criterion_ids:string[] }
export async function queryPlanGap(db:typeof sql,jobId:string,canvasId:string,input:GraphQueryPayload) {
  const objective=await readPlanObjective(db,jobId,canvasId,input.id,input.ids ?? []);
  const offset=Number(input.cursor ?? '0'), limit=input.limit ?? 4;
  const selected=objective.criteria.slice(offset,offset+limit);
  const facts=input.ids?.length ? input.ids : [...objective.sources.keys()].sort().slice(0,4);
  const sources=facts.map(fact_id=>{
    const source=objective.sources.get(fact_id);
    return source ? {fact_id,source_sha256:source.source_sha256,eligible:source.eligible,reasons:source.reasons,
      verification_status:source.verification_status,source:source.source}
      : {fact_id,available:false};
  });
  const [root]=await db`SELECT id FROM canvas_nodes WHERE canvas_id=${canvasId} AND node_type='root' ORDER BY id LIMIT 1`;
  const [canvas] = objective.plan.v === 2 ? await db`SELECT target_json FROM canvases WHERE id=${canvasId}` : [];
  const more=offset+selected.length<objective.criteria.length;
  const omittedBindings=selected.reduce((sum,c)=>sum+Math.max(0,c.bindings.length-4),0);
  const omittedSources=Math.max(0,objective.sources.size-facts.length);
  return {
    items:[{plan_job_id:objective.planJobId,plan_sha256:objective.planSha,revision:objective.revision,
      task_input_sha256:objective.baseline,projection_sha256:objective.projectionSha,
      goal:objective.plan.goal,stale_objective:objective.staleObjective,supplementation_remaining:objective.plan.v === 1 ? 0 : null,
      ...(objective.plan.v === 2 ? { protocol: 2, objective_id: objective.plan.objective_id,
        objective_revision: objective.plan.objective_revision, route_revision: objective.plan.route_revision,
        budget: objective.plan.budget, execution: readPlanExecutionState(canvas?.target_json) } : { historical: true }),
      required_criterion_count:objective.criteria.length,
      supplementation_execution:await loadPlanExecution(db,canvasId,objective.projectId,objective.planJobId,objective.planSha),
      criteria:selected.map(c=>({...c,bindings:c.bindings.slice(0,4).map(({binding,...state})=>({
        ...state,binding_id:binding.binding_id,fact_id:binding.fact_id,authority:binding.authority,
        assessment:binding.assessment,observation:binding.observation,rationale:binding.rationale.slice(0,500),
        source:binding.source,source_sha256:binding.expected_source_sha256,
      }))})),source_refs:sources}],
    truncated:more || omittedBindings>0 || omittedSources>0 || selected.some(c=>c.truncated),
    omitted:{criteria:Math.max(0,objective.criteria.length-offset-selected.length),bindings:omittedBindings,sources:omittedSources},
    referable_ids:[...(root?[String(root.id)]:[]),...facts.filter(id=>objective.sources.get(id))],
    ...(more?{next_cursor:String(offset+selected.length)}:{}),
    plan_read:{projection_sha256:objective.projectionSha,criterion_ids:selected.filter(c=>!c.truncated && c.bindings.length<=4).map(c=>c.id)} satisfies PlanReadProof,
  };
}

export function mergePlanRead(previous:PlanReadProof|undefined,incoming:PlanReadProof):PlanReadProof {
  return {projection_sha256:incoming.projection_sha256,
    criterion_ids:[...new Set([...(previous?.projection_sha256===incoming.projection_sha256?previous.criterion_ids:[]),...incoming.criterion_ids])].slice(0,33)};
}
