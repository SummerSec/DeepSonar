import {
  appendContextTransform,
  applyContextCompactedEvent,
  contextTextDigest,
  createContextState,
  markContextCompactionUnobservable,
  validateContextState,
  type ContextCompactionEvent,
  type ContextState,
} from "@deepsonar/runtime-sandbox";
import { updateAttemptContext, type AttemptDatabase } from "../job-attempt/index.js";

export function createJobRuntimeContext(input: {
  attemptId?: string | null;
  adapterId: string;
  adapterVersion: string;
  runtimeIdentity: string;
  compactionPolicy: string;
  snapshotDigest?: string | null;
  initialInput: string;
  graph?: {
    yaml: string;
    truncated: boolean;
    omitted: Record<string, number>;
    maxChars: number;
    suffix?: string;
  } | null;
}): ContextState {
  let state = createContextState({
    attempt_id: input.attemptId,
    adapter_id: input.adapterId,
    adapter_version: input.adapterVersion,
    runtime_identity: input.runtimeIdentity,
    policy: input.compactionPolicy,
    input_digest: contextTextDigest(input.initialInput),
    snapshot_digest: input.snapshotDigest,
  });
  if (input.graph) {
    state = appendContextTransform(state, {
      stage: "graph_scope",
      version: 1,
      input_digest: state.transforms.at(-1)!.output_digest,
      output_digest: contextTextDigest(`${input.initialInput}${input.graph.yaml}`),
      budget: { unit: "chars", limit: input.graph.maxChars, observed: input.graph.yaml.length },
      omission: input.graph.truncated
        ? { kind: "graph", count: Object.values(input.graph.omitted).reduce((sum, value) => sum + value, 0), reason: "图投影超过字符预算", truncated: true }
        : null,
      source: "scheduler",
    });
    if (input.graph.truncated) {
      state = appendContextTransform(state, {
        stage: "budget_truncation",
        version: 1,
        input_digest: state.transforms.at(-1)!.output_digest,
        output_digest: contextTextDigest(`${input.initialInput}${input.graph.yaml}`),
        budget: { unit: "chars", limit: input.graph.maxChars, observed: input.graph.yaml.length },
        omission: { kind: "graph", count: Object.values(input.graph.omitted).reduce((sum, value) => sum + value, 0), reason: "图投影已截断", truncated: true },
        source: "scheduler",
      });
    }
    if (input.graph.suffix) {
      state = appendContextTransform(state, {
        stage: "summary_handoff",
        version: 1,
        input_digest: state.transforms.at(-1)!.output_digest,
        output_digest: contextTextDigest(`${input.initialInput}${input.graph.yaml}${input.graph.suffix}`),
        budget: null,
        omission: null,
        source: "scheduler",
      });
    }
  }
  return state;
}

export async function persistJobRuntimeContext(
  db: AttemptDatabase,
  jobId: string,
  context: ContextState,
): Promise<void> {
  validateContextState(context);
  await db.begin(async (txRaw) => {
    const tx = txRaw as unknown as AttemptDatabase;
    if (context.attempt_id) {
      const attempt = await updateAttemptContext(tx, context.attempt_id, context);
      if (!attempt) throw new Error("CONTEXT_ATTEMPT_NOT_ACTIVE");
    }
    await tx`
      UPDATE jobs
         SET payload_json = jsonb_set(
           COALESCE(payload_json, '{}'::jsonb),
           '{runtime_evidence}',
           COALESCE(payload_json->'runtime_evidence', '{}'::jsonb)
             || jsonb_build_object('context', ${tx.json(context as never)}::jsonb),
           true
         )
       WHERE id = ${jobId}`;
  });
}

export function applyRuntimeContextEvent(state: ContextState, value: Record<string, unknown>): ContextState {
  if (value.type === "context.compaction_unknown") {
    const source = value.source === "unsupported" ? "unsupported" : "unknown";
    return markContextCompactionUnobservable(state, source, String(value.reason ?? "未观测到可验证的压缩事件").slice(0, 160));
  }
  if (value.type !== "context.compacted") throw new Error("CONTEXT_EVENT_UNSUPPORTED");
  return applyContextCompactedEvent(state, value as unknown as ContextCompactionEvent);
}

export interface ContextDiagnostics {
  context_id: string;
  context_revision: number;
  attempt_id: string | null;
  adapter_id: string;
  adapter_version: string;
  runtime_identity: string;
  transform_chain_digest: string;
  transforms: Array<{
    stage: string;
    version: number;
    revision: number;
    input_digest: string;
    output_digest: string;
    budget: ContextState["transforms"][number]["budget"];
    omission: ContextState["transforms"][number]["omission"];
    source: string;
  }>;
  compaction: ContextState["compaction"];
}

export function projectContextDiagnostics(value: unknown): ContextDiagnostics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    validateContextState(value as ContextState);
  } catch {
    return null;
  }
  const state = value as ContextState;
  return {
    context_id: state.context_id,
    context_revision: state.context_revision,
    attempt_id: state.attempt_id,
    adapter_id: state.adapter_id,
    adapter_version: state.adapter_version,
    runtime_identity: state.runtime_identity,
    transform_chain_digest: state.transform_chain_digest,
    transforms: state.transforms.slice(-16).map((item) => ({
      stage: item.stage,
      version: item.version,
      revision: item.revision,
      input_digest: item.input_digest,
      output_digest: item.output_digest,
      budget: item.budget,
      omission: item.omission,
      source: item.source,
    })),
    compaction: state.compaction,
  };
}
