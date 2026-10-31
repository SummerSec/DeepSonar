import { PlanDecisionBasis, SubmitPlanPayload } from "@deepsonar/shared-types";
import type { sql } from "../../db.js";
import { ControlInputError } from "../../control-input.js";
import { taskInputSha256 } from "./task-input.js";
import { readPlanAudit } from "./application.js";
import { contentSha256 } from "./criterion-model.js";
import { loadPlanCriteria } from "./criterion-projection.js";
import { criterionEvidenceBudget } from "./criterion-evidence.js";
import { loadCriterionSource, type CriterionSource } from "./criterion-source.js";

/** Only committed semantic events are authority; report display windows are never decision heads. */
export async function activePlanBasis(db: typeof sql, canvasId: string, projectId: string, excludeEventId?: string) {
  const [row] = await db`SELECT e.payload_json->'plan_basis' AS basis FROM events e
    JOIN jobs j ON j.id=e.job_id AND j.canvas_id=${canvasId} AND j.project_id=${projectId}
    WHERE e.type IN ('hub_decision','human') AND e.payload_json ? 'plan_basis'
      AND e.event_id IS DISTINCT FROM ${excludeEventId ?? null}
    ORDER BY e.id ASC LIMIT 1`;
  if (!row) return null;
  const parsed = PlanDecisionBasis.safeParse(row.basis);
  if (!parsed.success) throw new ControlInputError("invalid_payload", "当前目标的持久决策依据无效，需人工处理。", "plan_basis");
  return parsed.data;
}

/** Explicit Plan submission enables the guard before the first basis-bearing decision. */
export async function explicitPlanOwner(db:typeof sql,canvasId:string,projectId:string):Promise<string|null> {
  const [row]=await db`SELECT e.job_id FROM events e JOIN jobs j ON j.id=e.job_id
    WHERE j.canvas_id=${canvasId} AND j.project_id=${projectId} AND j.type<>'report' AND e.type='plan'
    ORDER BY e.id ASC LIMIT 1`;
  return row ? String(row.job_id) : null;
}

export async function planContext(db:typeof sql,canvasId:string,projectId:string) {
  const active=await activePlanBasis(db,canvasId,projectId);

  const owner=active?.plan_job_id ?? await explicitPlanOwner(db,canvasId,projectId);
  if(!owner) return null;
  const [row]=await db`SELECT payload_json FROM jobs WHERE id=${owner}`;
  const audit=readPlanAudit(row?.payload_json);
  return {plan_job_id:owner,plan_sha256:audit?.raw ? contentSha256(audit.raw) : null};
}

export async function readPlanObjective(
  db: typeof sql, jobId: string, canvasId: string, requestedPlanId?: string,
  sourceIds: readonly string[] = [], excludeEventId?: string,
) {
  const [job] = await db`SELECT j.project_id, c.title, c.target_json, j.payload_json FROM jobs j
    JOIN canvases c ON c.id=j.canvas_id AND c.project_id=j.project_id
    WHERE j.id=${jobId} AND j.canvas_id=${canvasId}`;
  if (!job) throw new ControlInputError("invalid_payload", "计划读取必须在当前 Job 的 Canvas 内。", "plan_basis");
  const projectId=String(job.project_id);
  const active=await activePlanBasis(db,canvasId,projectId,excludeEventId);
  const ownerId=active?.plan_job_id ?? await explicitPlanOwner(db,canvasId,projectId);
  const planJobId=requestedPlanId ?? ownerId ?? jobId;
  if (ownerId && ownerId!==planJobId) throw new ControlInputError("invalid_payload", "当前任务已绑定另一个目标，不得重置补证预算。", "plan_basis.plan_job_id");
  const [owner]=await db`SELECT payload_json FROM jobs WHERE id=${planJobId}
    AND canvas_id=${canvasId} AND project_id=${projectId} AND type <> 'report'`;
  const audit=readPlanAudit(owner?.payload_json);
  const plan=audit?.raw;
  if (!plan || audit.source!=="submit_plan") throw new ControlInputError("invalid_payload", "需要当前任务内显式提交的 Plan 原文。", "plan_basis.plan_job_id");
  const [origin]=await db`SELECT e.id::text AS id,e.payload_json FROM events e
    JOIN jobs j ON j.id=e.job_id AND j.canvas_id=${canvasId} AND j.project_id=${projectId}
    WHERE e.type='plan' AND e.event_id IS DISTINCT FROM ${excludeEventId ?? null}
      AND ((e.job_id=${planJobId} AND NOT (e.payload_json ? 'revision'))
        OR e.payload_json->'revision'->>'plan_job_id'=${planJobId}) ORDER BY e.id DESC LIMIT 1`;
  const original=SubmitPlanPayload.safeParse(origin?.payload_json);
  const planSha=contentSha256(plan);
  if (!original.success || contentSha256(original.data.plan)!==planSha) throw new ControlInputError("invalid_payload", "Plan 原文与持久来源事件不一致。", "plan_basis.plan_sha256");
  const [head]=await db`SELECT e.id::text AS id FROM events e
    JOIN jobs j ON j.id=e.job_id AND j.canvas_id=${canvasId} AND j.project_id=${projectId}
    WHERE e.event_id IS DISTINCT FROM ${excludeEventId ?? null} AND (
      (e.type='plan' AND (e.job_id=${planJobId} OR e.payload_json->'revision'->>'plan_job_id'=${planJobId})) OR
      (e.type IN ('hub_decision','human') AND e.payload_json->'plan_basis'->>'plan_job_id'=${planJobId}))
    ORDER BY e.id DESC LIMIT 1`;
  const [spent]=await db`SELECT 1 FROM events e
    JOIN jobs j ON j.id=e.job_id AND j.canvas_id=${canvasId} AND j.project_id=${projectId}
    WHERE e.type='hub_decision' AND e.payload_json->'plan_basis'->>'outcome'='continue'
      AND e.event_id IS DISTINCT FROM ${excludeEventId ?? null} LIMIT 1`;
  const budget=criterionEvidenceBudget(), sources=new Map<string,CriterionSource|null>();
  const criteria=await loadPlanCriteria(db,canvasId,projectId,planJobId,plan,budget,sources);
  for (const factId of [...new Set(sourceIds)].sort()) {
    if (!sources.has(factId)) sources.set(factId,await loadCriterionSource(db,canvasId,projectId,factId,budget));
  }
  const baseline=taskInputSha256(job.title,job.target_json);
  const initialInput=(owner?.payload_json as {plan_input_sha256?:unknown}|null)?.plan_input_sha256;
  const revision=String(head?.id ?? origin.id);
  const sourceVersions=[...sources].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([id,source])=>({
    id,sha256:source?.source_sha256 ?? null,eligible:source?.eligible ?? false,
    verification_status:source?.verification_status ?? null,verification_epoch:source?.verification_epoch ?? null,
  }));
  const projectionSha=contentSha256({planJobId,planSha,baseline,revision,criteria,sources:sourceVersions});
  return {jobId,canvasId,projectId,jobPayload:job.payload_json,planJobId,plan,planSha,baseline,revision,
    active,initialInput,spent:Boolean(spent),criteria,sources,projectionSha,
    staleObjective:Boolean((typeof initialInput === "string" && initialInput !== baseline) || active && ((!original.data.revision && active.plan_sha256!==planSha) || active.expected_task_input_sha256!==baseline))};
}
export type PlanObjective = Awaited<ReturnType<typeof readPlanObjective>>;
