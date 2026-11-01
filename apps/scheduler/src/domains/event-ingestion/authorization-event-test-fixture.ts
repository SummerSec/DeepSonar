import type { SubmitPlanPayload, SubmitPlanResultPayload } from "@deepsonar/shared-types";
import { contentSha256 } from "../plan-protocol/criterion-model.js";

/** Pure negative-authorization payloads: valid current contracts, no Job/DB writes. */
export function authorizationEventPayloads(jobId: string) {
  const plan: SubmitPlanPayload["plan"] = {
    v: 2,
    objective_id: "f472c096-698f-457f-b6a9-776f7c4ef59d",
    objective_revision: "1",
    route_revision: "1",
    goal: "late plan goal",
    assumptions: [],
    tasks: [{
      id: "late-task",
      title: "late task title",
      role: "explore",
      description: "late task description",
      prompt: "Review the scoped evidence and retain the late task output.",
      from: [],
      depends_on: [],
      inputs: [],
      expected_outputs: ["late review evidence"],
    }],
    completion: {
      mode: "explicit_result",
      description: "late completion policy",
      required_outputs: ["late review evidence"],
    },
    budget: { max_tasks: 1, max_rounds: 1, max_no_progress_rounds: 0, max_parallel_tasks: 1 },
    open_questions: [],
  };
  return {
    progress: { message: "late event" },
    fact: { title: "late fact", description: "late description" },
    finding: {
      title: "late finding",
      summary: "late finding remains valid before authorization",
      severity: "low",
    },
    hub_decision: { complete: { from: [], description: "late decision" } },
    plan: {
      plan,
      revision: {
        v: 2,
        kind: "execution_route",
        plan_job_id: jobId,
        objective_id: plan.objective_id,
        expected_objective_revision: plan.objective_revision,
        expected_route_revision: "0",
        expected_plan_sha256: null,
        rationale: "Execute the bounded current route",
      },
    } satisfies SubmitPlanPayload,
    plan_result: {
      v: 2,
      objective_id: plan.objective_id,
      objective_revision: plan.objective_revision,
      route_revision: plan.route_revision,
      plan_sha256: contentSha256(plan),
      outcome: "continue",
      summary: "late plan result summary",
      execution: [{ task_id: "late-task", status: "pending" }],
      open_questions: [],
    } satisfies SubmitPlanResultPayload,
    human: {
      reason: "late operator decision",
      subject: { type: "platform_blocker", kind: "business_decision" },
    },
    done: { summary: "late completion" },
  };
}

export function authorizationPayloadFor(type: string, jobId: string): unknown {
  const payloads = authorizationEventPayloads(jobId);
  if (!Object.hasOwn(payloads, type)) throw new Error(`unknown test event type ${type}`);
  return payloads[type as keyof typeof payloads];
}
