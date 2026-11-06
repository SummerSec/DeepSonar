/** Read-only, synthetic-fixture diagnostics. Never serialize raw errors, payloads,
 * transcript text, credential/token material, resource addresses or commands. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function createOmFailureDiagnostics(root: string) {
  const signatures: Array<{ text: string; file: string; line: number }> = [];
  const codes = new Set(["exception", "runtime_image_not_ready", "context_window_exceeded", "pi_stream_truncated",
    "event_rate_limited", "device_not_authorized", "device_not_available", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EACCES", "ENOENT", "ECONNRESET"]);
  for (const file of ["apps/scheduler/src/executor-real.ts", "apps/scheduler/src/gateway.ts",
    "apps/scheduler/src/gateway-request-policy.ts", "apps/scheduler/src/gateway-provider-binding.ts",
    "packages/runtime-sandbox/src/runtime-agent.ts", "packages/runtime-sandbox/src/opensandbox.ts",
    "packages/runtime-sandbox/src/model-request-policy.ts"]) {
    const source = await readFile(path.join(root, file), "utf8");
    for (const match of source.matchAll(/new Error\((["'])([^"'\r\n]{12,240})\1\)/gu)) {
      signatures.push({ text: match[2]!, file, line: source.slice(0, match.index).split("\n").length });
    }
    for (const match of source.matchAll(/["'`]([A-Z][A-Z0-9_]{5,120})["'`]/gu)) codes.add(match[1]!);
  }
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const summarize = (value: unknown) => {
    const text = value instanceof Error ? `${value.name}: ${value.message}` : typeof value === "string" ? value : JSON.stringify(value ?? null) ?? "[unserializable]";
    const tokens = new Set(text.match(/\b[A-Za-z][A-Za-z0-9_]{5,120}\b/gu) ?? []);
    const categories: string[] = [];
    for (const [category, pattern] of [
      ["javascript_type_error", /TypeError|Cannot read properties/u],
      ["network_or_transport", /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|connect timeout/iu],
      ["image_admission", /runtime_image_not_ready|immutable reference|ImagePull|image pull/iu],
      ["runtime_materialization", /Upload failed|uploadFile|materializ|物化/iu],
      ["process_exit", /exit code|exited with|process exited/iu],
      ["gateway_binding", /GATEWAY_PROVIDER_BINDING/u],
      ["request_policy", /GATEWAY_REQUEST_BUDGET|MODEL_REQUEST_POLICY|PI_OM_.*BUDGET/u],
      ["missing_control_completion", /未通过 mark_job_done|没有冻结的平台控制 operation/u],
    ] as const) if (pattern.test(text)) categories.push(category);
    return { bytes: Buffer.byteLength(text), sha256: hash(text),
      source_error_sites: signatures.filter(entry => text.includes(entry.text)).slice(0, 8).map(({ file, line }) => ({ file, line })),
      defined_codes: [...tokens].filter(code => codes.has(code)).sort().slice(0, 16), categories };
  };
  const eventTypes = new Set(["log", "progress", "done", "failed", "error", "hub_decision", "control_receipt", "agent_usage",
    "finding", "fact", "heartbeat", "usage", "runtime_diagnostic", "context_compacted", "context_compaction"]);
  return { summarize, async read(db: any, jobId: string) {
    const [job] = await db`SELECT id,status,error,sandbox_id,transcript_uri FROM jobs WHERE id=${jobId}`;
    const attempts = await db`SELECT id,attempt_no,status,phase,error,outcome_json,sandbox_id,session_id,started_at,finished_at
      FROM job_attempts WHERE job_id=${jobId} ORDER BY attempt_no`;
    const effects = await db`SELECT attempt_id,effect_kind,status,error,effect_started_at,settled_at
      FROM job_attempt_effects WHERE job_id=${jobId} ORDER BY created_at LIMIT 100`;
    const tokens = await db`SELECT workload,count(*)::int AS minted,sum(used_requests)::int AS used_requests
      FROM job_tokens WHERE job_id=${jobId} GROUP BY workload`;
    const events = await db`SELECT attempt_id,job_seq,type,payload_json FROM events WHERE job_id=${jobId} ORDER BY job_seq DESC LIMIT 80`;
    return {
      job: { id: jobId, status: job?.status, sandbox_handle_recorded: Boolean(job?.sandbox_id),
        transcript_recorded: Boolean(job?.transcript_uri), error: summarize(job?.error) },
      attempts: attempts.map((row: any) => ({ id: row.id, attempt_no: row.attempt_no, status: row.status, phase: row.phase,
        sandbox_handle_recorded: Boolean(row.sandbox_id), cli_session_recorded: Boolean(row.session_id),
        started_at: row.started_at, finished_at: row.finished_at, error: summarize(row.error), outcome: summarize(row.outcome_json) })),
      effects: effects.map((row: any) => ({ attempt_id: row.attempt_id,
        kind: ["provision", "agent_run", "gateway_model_request"].includes(row.effect_kind) ? row.effect_kind : "other",
        status: row.status, effect_started_at: row.effect_started_at, settled_at: row.settled_at, error: summarize(row.error) })),
      token_scopes: tokens.map((row: any) => ({ workload: ["main", "observational_memory"].includes(row.workload) ? row.workload : "other",
        minted: row.minted, used_requests: row.used_requests })),
      events: events.map((row: any) => ({ attempt_id: row.attempt_id, sequence: row.job_seq,
        type: eventTypes.has(row.type) ? row.type : "other", type_sha256: hash(String(row.type)),
        outcome: summarize({ code: row.payload_json?.code, error: row.payload_json?.error, reason: row.payload_json?.reason }) })),
    };
  } };
}

/** Test-only observation around the real methods; inputs/results are delegated
 * unchanged. An async process handle is not evidence of CLI initialization. */
export function observeOmRuntime(runner: any, summarize: (error: unknown) => unknown) {
  const trace: Array<Record<string, unknown>> = [];
  const restore: Array<() => void> = [];
  const hosts = new WeakSet<object>();
  const record = (entry: Record<string, unknown>) => { if (trace.length < 160) trace.push({ at: new Date().toISOString(), ...entry }); };
  const safeSummary = (error: unknown) => { try { return summarize(error); } catch { return { code: "OM_DIAGNOSTIC_SUMMARY_FAILED" }; } };
  const wrap = (target: any, key: string, stage: string, after?: (value: any) => void) => {
    const original = target[key];
    if (typeof original !== "function") return;
    const owned = Object.getOwnPropertyDescriptor(target, key);
    try {
      target[key] = async function (this: any, ...args: unknown[]) {
        record({ stage, outcome: "entered" });
        try {
          const result = await original.apply(this, args);
          try { after?.(result); } catch { record({ stage, outcome: "observation_unavailable" }); }
          record({ stage, outcome: "returned", ...(Number.isInteger(result?.exitCode) ? { exit_code: result.exitCode } : {}) });
          return result;
        } catch (error) { record({ stage, outcome: "threw", error: safeSummary(error) }); throw error; }
      };
      restore.push(() => { if (owned) Object.defineProperty(target, key, owned); else delete target[key]; });
    } catch { record({ stage, outcome: "observation_unavailable" }); }
  };
  const observeHost = (host: any) => {
    if (!host || typeof host !== "object" || hosts.has(host)) return;
    hosts.add(host);
    for (const key of ["uploadFile", "run", "runAsync"]) wrap(host, key, `host.${key}`);
  };
  wrap(runner, "provision", "runner.provision");
  wrap(runner, "ensureHost", "runner.ensureHost", observeHost);
  // executeReal uses ensureHost; do not turn synchronous hostOf into a Promise.
  return { trace, close: () => { for (const undo of restore.reverse()) { try { undo(); } catch { record({ stage: "observation.restore", outcome: "unavailable" }); } } } };
}
