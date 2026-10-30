import { PlanDecisionBasis } from "@deepsonar/shared-types";
import type { sql } from "../../db.js";
import { ControlInputError } from "../../control-input.js";
import { planCriteria, type CriterionProjection } from "./criterion-model.js";
import { activePlanBasis, explicitPlanOwner, readPlanObjective } from "./objective.js";

/** Positive authorization only; a negative observation is not an authorization by itself. */
export function criteriaAuthorizeCompletion(criteria: readonly CriterionProjection[], required: readonly string[]): boolean {
  return required.length>0 && criteria.length===required.length && new Set(required).size===required.length
    && required.every(id=>criteria.some(c=>c.id===id && !c.truncated && c.state==='satisfied'
      && c.bindings.length>0 && c.bindings.every(b=>b.state==='satisfied'
        && b.binding.authority==='operator_attestation' && b.binding.assessment==='satisfies')));
}

/** Final callers already hold Canvas then current Job. Preflight never obtains authority by itself. */
export async function validatePlanDecision(
  db: typeof sql, jobId: string, job: Record<string,unknown>, basisInput: unknown,
  kind: 'hub_decision'|'human', options: {eventId?:string; final?:boolean; maxIntents?:number; references?:readonly string[]} = {},
) {
  const canvasId=typeof job.canvas_id==='string'?job.canvas_id:null;
  if (!canvasId) return null; // Existing semantic validation owns the missing-Canvas rejection.
  if (basisInput===undefined) {
    // A plain human stop remains available even if the graph budget is exhausted.
    if (kind==='human') return null;
    if (await activePlanBasis(db,canvasId,String(job.project_id),options.eventId)
      || await explicitPlanOwner(db,canvasId,String(job.project_id))) {
      throw new ControlInputError('plan_context_required','该任务已启用目标依据，Hub 决策不得省略当前 plan_basis。','plan_basis');
    }
    return null;
  }
  const parsed=PlanDecisionBasis.safeParse(basisInput);
  if (!parsed.success) throw new ControlInputError('invalid_payload','计划决策依据不符合版本化契约。','plan_basis');
  const basis=parsed.data;
  if ((kind==='human') !== ['blocked','needs_human'].includes(basis.outcome)) {
    throw new ControlInputError('invalid_payload','停止须使用 request_human，工作与完成须使用既有 Hub 决策。','plan_basis.outcome');
  }
  if (options.final) await db`SELECT id FROM jobs WHERE id=${basis.plan_job_id}
    AND canvas_id=${canvasId} AND project_id=${String(job.project_id)} FOR SHARE`;
  const objective=await readPlanObjective(db,jobId,canvasId,basis.plan_job_id,basis.source_refs.map(r=>r.fact_id),options.eventId);
  if (basis.expected_revision!==objective.revision || basis.plan_sha256!==objective.planSha
    || basis.expected_task_input_sha256!==objective.baseline || basis.expected_projection_sha256!==objective.projectionSha) {
    throw new ControlInputError('plan_stale_revision','目标、任务输入、判据或来源已变化；请重新读取 plan_gap。','plan_basis.expected_revision');
  }
  if (!objective.criteria.some(c=>c.id===basis.criterion_id)) throw new ControlInputError('invalid_payload','判据不属于当前目标。','plan_basis.criterion_id');
  const graph=(objective.jobPayload as {graph_query?:{projected_node_ids?:unknown;plan_read?:{projection_sha256?:unknown;criterion_ids?:unknown}}}|null)?.graph_query;
  const seen=new Set(Array.isArray(graph?.projected_node_ids)?graph.projected_node_ids:[]);
  for (const ref of basis.source_refs) {
    const source=objective.sources.get(ref.fact_id);
    if (!seen.has(ref.fact_id) || !source || source.source_sha256!==ref.source_sha256) {
      throw new ControlInputError('plan_source_unavailable','来源必须是本 Job 已读的当前 Canvas Fact 内容版本。','plan_basis.source_refs');
    }
  }
  if (kind==='human') return {basis,objective};
  const references=options.references ?? [];
  if (!references.every(id=>seen.has(id)) || !basis.source_refs.every(ref=>references.includes(ref.fact_id))) {
    throw new ControlInputError('plan_source_unavailable','Hub 引用必须本 Job 已读，并包含所声明的来源 Fact。','plan_basis.source_refs');
  }
  if (objective.staleObjective) throw new ControlInputError('plan_stale_revision','已接纳目标的范围版本已失效，需人工处理；不能重置单步预算。','plan_basis');
  const unknown=await hasUnknownPlanEffects(db,canvasId,objective.projectId);
  if (unknown) throw new ControlInputError('plan_unknown_effect','存在未对账外部效果，禁止继续派发或完成。','plan_basis');
  if (basis.outcome==='continue') {
    if (objective.spent || (options.maxIntents ?? 1)<1) throw new ControlInputError('plan_budget_exhausted','本任务的一次补证预算已用尽；请说明停止原因或请求人工。','plan_basis.outcome');
    if (objective.plan.tasks.some(task=>task.depends_on.length>0)) throw new ControlInputError('invalid_payload','首片仅支持独立单步补证，不执行 Plan 依赖图。','plan_basis');
  } else {
    const required=planCriteria(objective.plan).map(c=>c.id);
    const delivered=Array.isArray(graph?.plan_read?.criterion_ids)?graph.plan_read.criterion_ids:[];
    const refs=new Set(basis.source_refs.map(ref=>ref.fact_id));
    const allSources=objective.criteria.flatMap(c=>c.bindings.map(b=>b.binding.fact_id));
    if (!criteriaAuthorizeCompletion(objective.criteria,required) || graph?.plan_read?.projection_sha256!==objective.projectionSha
      || !required.every(id=>delivered.includes(id)) || !allSources.every(id=>refs.has(id))) {
      throw new ControlInputError('plan_completion_unproven','必须读完当前全部必要判据，且每项均有当前有效的正向授权评价；缺项、截断、反驳或不足均不能完成。','plan_basis.outcome');
    }
  }
  return {basis,objective};
}


async function hasUnknownPlanEffects(db:typeof sql,canvasId:string,projectId:string) {
  const [unknown]=await db`SELECT 1 FROM job_attempt_effects effect JOIN jobs j ON j.id=effect.job_id
    WHERE j.canvas_id=${canvasId} AND j.project_id=${projectId}
      AND (effect.status='unknown' OR (effect.status='effect_pending' AND j.status NOT IN ('pending','claimed','provisioning','running','waiting_human')))
    LIMIT 1`;
  return Boolean(unknown);
}

/** Shared by automatic Report/budget convergence as well as explicit Hub complete. */
export async function planCompletionBlockers(db:typeof sql,canvasId:string):Promise<string[]> {
  const [canvas]=await db`SELECT project_id FROM canvases WHERE id=${canvasId}`;
  if (!canvas) return [];
  try {
    const active=await activePlanBasis(db,canvasId,String(canvas.project_id));
    const owner=active?.plan_job_id ?? await explicitPlanOwner(db,canvasId,String(canvas.project_id));
    if (!owner) return [];
    if (await hasUnknownPlanEffects(db,canvasId,String(canvas.project_id))) return ["plan_unknown_effect"];
    const current=await readPlanObjective(db,owner,canvasId,owner);
    return !current.staleObjective && criteriaAuthorizeCompletion(current.criteria,planCriteria(current.plan).map(c=>c.id))
      ? [] : ['plan_criteria_unproven'];
  } catch (error) {
    if (error instanceof ControlInputError) return ['plan_objective_unavailable'];
    throw error;
  }
}
