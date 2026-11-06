import { z } from "zod";
import type { RealAgentResult } from "@deepsonar/runtime-sandbox";
import { sql } from "./db.js";
import type { JobEvidenceWriter } from "./evidence.js";
import { PlatformRuntimeHandlerError, type PlatformRuntimeHandlerContext } from "./domains/platform-api/registry.js";
import { completionDoneEventId, completionInputDigest, completionReceiptId } from "./domains/event-ingestion/completion-receipt.js";

const receiptShape = z.object({
  v: z.literal(1), operation: z.literal("mark_job_done"), idempotency_key: z.string().uuid(),
  proposal_revision: z.number().int().nonnegative(), attempt_id: z.string().uuid(), snapshot_digest: z.string(),
  status: z.enum(["rejected", "persisted_deferred"]),
  result: z.object({ statusCode: z.number().int(), body: z.object({ accepted: z.boolean().optional(), error_code: z.string().optional() }) }),
});
const code = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : null;
const count = (value: unknown): number | null => {
  let n = NaN;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && /^\d+$/.test(value)) n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** Read-only observations, not completion/settlement authority or permission to replay. */
export async function readCompletionFailureDiagnostic(input: {
  jobId: string; attemptId: string; snapshot: unknown;
}, database: typeof sql = sql): Promise<Record<string, unknown>> {
  const references = { job: `/jobs/${input.jobId}`, evidence: `/jobs/${input.jobId}/evidence`,
    completion: `/control/v1/jobs/${input.jobId}/operations/mark_job_done` };
  const base = { job_id: input.jobId, attempt_id: input.attemptId, references,
    observed_at: new Date().toISOString(), next_action: "inspect_original_receipt_and_evidence" };
  try {
    const [owned] = await database`SELECT j.id FROM jobs j JOIN job_attempts a ON a.job_id=j.id
      WHERE j.id=${input.jobId} AND a.id=${input.attemptId}`;
    if (!owned) return { ...base, read_status: "scope_unavailable", completion_state: "unknown" };
    const [outputs] = await database`SELECT
      (SELECT count(*) FROM artifacts a JOIN events e ON e.job_id=a.job_id AND e.event_id=a.source_event_id
        WHERE a.job_id=${input.jobId} AND e.attempt_id=${input.attemptId}) AS artifacts,
      (SELECT count(*) FROM findings f JOIN artifacts a ON a.id=f.artifact_id AND a.project_id=f.project_id
        JOIN events e ON e.job_id=a.job_id AND e.event_id=a.source_event_id
        WHERE a.job_id=${input.jobId} AND e.attempt_id=${input.attemptId}) AS findings,
      (SELECT count(*) FROM events e WHERE e.job_id=${input.jobId} AND e.attempt_id=${input.attemptId} AND e.type='fact') AS facts,
      (SELECT count(*) FROM artifacts a WHERE a.job_id=${input.jobId} AND NOT EXISTS
        (SELECT 1 FROM events e WHERE e.job_id=a.job_id AND e.event_id=a.source_event_id AND e.attempt_id IS NOT NULL)) AS unattributed_job_artifacts`;
    const outputCounts = { scope: "event_attributed_current_attempt", artifacts: count(outputs?.artifacts),
      findings: count(outputs?.findings), facts: count(outputs?.facts), reports: null,
      report_attribution: "report tables have no Attempt identity", unattributed_job_artifacts: count(outputs?.unattributed_job_artifacts) };
    const [row] = await database`SELECT event_id,payload_json FROM events WHERE job_id=${input.jobId}
      AND attempt_id=${input.attemptId} AND type='control_receipt' AND payload_json->>'operation'='mark_job_done'
      ORDER BY job_seq DESC LIMIT 1`;
    if (!row) return { ...base, read_status: "ok", output_counts: outputCounts, completion_state: "no_durable_receipt_observed" };
    const parsed = receiptShape.safeParse(row.payload_json);
    if (!parsed.success || parsed.data.attempt_id !== input.attemptId
      || parsed.data.snapshot_digest !== completionInputDigest(input.snapshot)
      || row.event_id !== completionReceiptId(input.jobId, parsed.data.idempotency_key)) {
      return { ...base, read_status: "receipt_unverified", output_counts: outputCounts, completion_state: "unknown" };
    }
    const receipt = parsed.data;
    const receiptMetadata = { key: receipt.idempotency_key, revision: receipt.proposal_revision,
      status: receipt.status, status_code: receipt.result.statusCode, rejection_code: code(receipt.result.body.error_code) };
    const receiptReference = `${references.completion}?receipt_key=${receipt.idempotency_key}`;
    if (receipt.status === "rejected" && receipt.result.statusCode >= 400 && receipt.result.statusCode < 500
      && receipt.result.body.accepted !== true) return { ...base, read_status: "ok", output_counts: outputCounts,
      completion_state: "rejected", receipt: receiptMetadata, references: { ...references, completion: receiptReference } };
    if (receipt.status !== "persisted_deferred" || receipt.result.statusCode !== 200 || receipt.result.body.accepted !== true) {
      return { ...base, read_status: "receipt_unverified", output_counts: outputCounts, completion_state: "unknown" };
    }
    const [done] = await database`SELECT event_id FROM events WHERE job_id=${input.jobId} AND attempt_id=${input.attemptId}
      AND type='done' AND event_id=${completionDoneEventId(input.jobId, receipt.idempotency_key)} LIMIT 1`;
    return { ...base, read_status: "ok", output_counts: outputCounts,
      completion_state: done ? "done_event_persisted" : "accepted_awaiting_settlement", receipt: receiptMetadata,
      references: { ...references, completion: receiptReference } };
  } catch {
    // Missing diagnostic reads do not prove an absent proposal, zero usage or zero output.
    return { ...base, read_status: "unavailable", completion_state: "unknown", output_counts: null };
  }
}

export function createCompletionFailureDiagnostics(input: {
  jobId: string; attemptId: string; snapshot: unknown; writer: Pick<JobEvidenceWriter, "appendNormalized">;
  database?: typeof sql;
}) {
  let lastTool: Record<string, unknown> | null = null;
  let lastHostRejection: Record<string, unknown> | null = null;
  let captureState: "not_attempted" | "persisted" | "unavailable" = "not_attempted";
  return {
    observePersisted(event: Record<string, unknown>, evidenceSeq: number) {
      if (event.type !== "tool.call.started" && event.type !== "tool.call.completed") return;
      const completed = event.type === "tool.call.completed";
      let resultCategory = "not_observed";
      if (completed) resultCategory = event.isError === true ? "error" : "returned";
      const name = typeof event.toolName === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(event.toolName) ? event.toolName : null;
      lastTool = { name, phase: completed ? "completed" : "started", result_category: resultCategory,
        persisted_observed_at: new Date().toISOString(), evidence_seq: evidenceSeq };
    },
    wrapControlHandler(handler: (context: PlatformRuntimeHandlerContext) => Promise<Record<string, unknown>>) {
      return async (context: PlatformRuntimeHandlerContext) => {
        try { return await handler(context); } catch (error) {
          lastHostRejection = { operation: code(context.operationId),
            code: error instanceof PlatformRuntimeHandlerError ? code(error.rejection?.errorCode ?? error.code) : "UNCLASSIFIED",
            observed_at: new Date().toISOString() };
          throw error;
        }
      };
    },
    async capture(reason: { phase: "runner_exception" | "runtime_failure" | "completion_missing";
      host_done_observed: boolean; error_kind?: RealAgentResult["errorKind"]; runner_error_source?: RealAgentResult["runnerErrorSource"] }) {
      const diagnostic = await readCompletionFailureDiagnostic(input, input.database);
      try {
        await input.writer.appendNormalized({ type: "run.completion_diagnostic", v: 1, ...diagnostic,
          reason, last_persisted_tool: lastTool, last_host_rejection: lastHostRejection });
        captureState = "persisted";
      } catch { captureState = "unavailable"; }
    },
    missingCompletionError() {
      const error = new Error(`AGENT_COMPLETION_UNOBSERVED: Agent 未通过 mark_job_done 提交最终摘要；`
        + `job=${input.jobId} attempt=${input.attemptId} diagnostic=${captureState}；`
        + "检查受权限保护的 Job 证据与原完成回执；未观察到完成不等于没有提交，不能换 key 重放或重置额度。");
      Object.assign(error, { code: "AGENT_COMPLETION_UNOBSERVED" });
      return error;
    },
  };
}
