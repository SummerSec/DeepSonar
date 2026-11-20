import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MODEL_REQUEST_POLICY_SOURCE, type RuntimeHost, type RuntimeProcess, type RuntimeProcessChunk } from "@deepsonar/runtime-sandbox";
import type { AgentRuntimeSnapshot } from "./domains/role-runtime-snapshot/index.js";
import type { sql } from "./db.js";
import { deleteDispatchFixtureRows } from "./dispatch-create-circuit.fixture.js";

/** Controlled transport only. The production runner still frames and decodes
 * Claude stream-json, handles process exit and decides whether to resume. */
class RefusalProcess implements RuntimeProcess {
  stdinClosed = false;
  writes = 0;
  private ended = false;
  private queue: RuntimeProcessChunk[] = [];
  private wake?: () => void;
  constructor(private readonly reply: () => Promise<{ stdout: string; exitCode: number }>) {}
  async write() {
    try {
      assert.equal(++this.writes, 1, "no prompt or private-file operation may be replayed");
      const { stdout, exitCode } = await this.reply();
      const split = Math.floor(stdout.length / 2);
      this.queue.push({ type: "stdout", chunk: stdout.slice(0, split) }, { type: "stdout", chunk: stdout.slice(split) },
        { type: "exit", exitCode });
    } finally {
      this.ended = true;
      this.wake?.();
    }
  }
  async closeStdin() { this.stdinClosed = true; }
  async kill() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<RuntimeProcessChunk> {
    while (!this.ended || this.queue.length) {
      const next = this.queue.shift();
      if (next) yield next;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}

/** Real dispatch -> executeReal -> runRealAgent -> classifier -> PostgreSQL.
 * Native CLI behavior is covered separately by claude-request-budget-cli.test.ts.
 * This fixture uses synthetic public CLI records and the actual local refusal. */
export async function runCredentialRefusalDispatchFixture(
  db: typeof sql, projectId: string, roleName: string, snapshot: AgentRuntimeSnapshot,
): Promise<void> {
  const { config } = await import("./config.js");
  const { runner } = await import("./runtime.js");
  const { dispatchOnce, drainInFlight } = await import("./dispatcher.js");
  const { DEFAULT_FINDING_PROTOCOL } = await import("./finding-protocol.js");
  const runtime = { ...config.runtime };
  const provision = runner.provision, ensureHost = runner.ensureHost;
  const hubEnabled = config.hub.enabled;
  const [settings] = await db`SELECT rules_json FROM global_settings WHERE id='global'`;
  const jobId = randomUUID(), canvasId = `credential-refusal-${randomUUID()}`;
  const sessionId = randomUUID();
  const secret = `synthetic-private-${randomUUID()}`;
  const directory = await mkdtemp(path.join(tmpdir(), "credential-refusal-policy-"));
  let policy: { close(): Promise<void> } | undefined;
  let launches = 0, provisions = 0, refusals = 0;
  let failed = false;
  let failure: unknown;
  const processes: RefusalProcess[] = [];
  try {
    const script = path.join(directory, "policy.mjs");
    await writeFile(script, MODEL_REQUEST_POLICY_SOURCE);
    const api = await import(pathToFileURL(script).href);
    const admission = await api.startModelRequestPolicy({ upstream: "http://127.0.0.1:1/gateway", token: secret, port: 0 });
    policy = admission;
    const url = `http://127.0.0.1:${admission.server.address().port}/gateway/v1/messages`;
    const host: RuntimeHost = {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      uploadFile: async () => {}, readWorkspaceFile: async () => Buffer.alloc(0), writeHumanInboxFile: async () => {},
      runAsync: async command => {
        if (command.startsWith("python3 -c ") && command.includes("PRIVATE_JOB_FILES_REJECTED")) {
          return new RefusalProcess(async () => ({ stdout: "ok\n", exitCode: 0 }));
        }
        assert.match(command, /claude -p/u);
        launches++;
        const process = new RefusalProcess(async () => {
          const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5_000), headers: { authorization: `Bearer ${secret}`,
            "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: secret }] }) });
          assert.equal(response.status, 400);
          assert.equal(response.headers.get("x-should-retry"), "false");
          const body = await response.text();
          assert.equal(JSON.parse(body).error.type, "credential_in_business_data");
          assert.ok(!body.includes(secret));
          refusals++;
          const init = JSON.stringify({ type: "system", subtype: "init", session_id: sessionId });
          const result = JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true,
            session_id: sessionId, result: `API Error: ${response.status} ${body}` });
          return { stdout: `${init}\n${result}\n`, exitCode: 1 };
        });
        processes.push(process);
        return process;
      },
    };
    Object.assign(config.runtime, { agentMode: "real", provider: "fake" });
    Object.assign(config.hub, { enabled: false });
    runner.provision = async input => { provisions++; return provision.call(runner, input); };
    runner.ensureHost = async () => host;
    await db`UPDATE global_settings SET rules_json=${db.json({ ...settings!.rules_json,
      maxGlobalJobs: 1, maxJobsPerProject: 1, maxConcurrentProvisioning: 1, hubEnabled: false })} WHERE id='global'`;
    await db`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${projectId},'credential refusal',
      ${db.json({ network_policy: { allow_egress: false }, effective_finding_protocol: DEFAULT_FINDING_PROTOCOL })})`;
    await db`INSERT INTO canvas_nodes(canvas_id,node_type,title,status,body_json)
      VALUES(${canvasId},'root','credential refusal','active','{}'::jsonb)`;
    await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json)
      VALUES(${jobId},${projectId},${canvasId},${roleName},'pending',${db.json(snapshot as never)},
        ${db.json({ intent: { prompt: "Exercise a deterministic credential refusal without model IO." } })})`;
    assert.equal(await dispatchOnce(), 1);
    await drainInFlight();
    assert.equal(provisions, 1);
    assert.equal(launches, 1, "permanent credential refusal cannot resume the CLI");
    assert.equal(refusals, 1);
    assert.equal(processes[0]!.writes, 1);
    const [job] = await db`SELECT status,error,finished_at,transcript_uri FROM jobs WHERE id=${jobId}`;
    assert.equal(job!.status, "failed", String(job!.error));
    assert.match(String(job!.error), /^credential_in_business_data: /u);
    assert.ok(job!.finished_at);
    assert.ok(job!.transcript_uri, "executeReal must persist its failure evidence before Dispatcher closes the Job");
    const attempts = await db`SELECT status,phase,error,outcome_json,state_json,finished_at FROM job_attempts WHERE job_id=${jobId}`;
    assert.equal(attempts.length, 1, "the dispatcher must not create a retry Attempt");
    assert.equal(attempts[0]!.status, "failed");
    assert.equal(attempts[0]!.phase, "terminal");
    assert.equal(attempts[0]!.outcome_json.reason, "credential_in_business_data");
    assert.equal(attempts[0]!.state_json.session_id, sessionId, "no-retry proof must include an observed CLI session");
    assert.equal(attempts[0]!.error, job!.error);
    assert.ok(attempts[0]!.finished_at);
    const [effect] = await db`SELECT status,replay_policy FROM job_attempt_effects WHERE job_id=${jobId} AND effect_kind='agent_run'`;
    assert.equal(effect!.status, "unknown", "a refusal cannot settle all earlier Agent effects or authorize replay");
    assert.equal(effect!.replay_policy, "never");
    assert.ok(!JSON.stringify({ job, attempts }).includes(secret));
    assert.equal(await dispatchOnce(), 0, "terminal refusal cannot silently requeue the Job");
    assert.equal(provisions, 1);
    assert.equal(launches, 1);
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    await Promise.all(processes.map(process => process.kill().catch(error => { cleanupErrors.push(error); })));
    await drainInFlight().catch(error => { cleanupErrors.push(error); });
    runner.provision = provision;
    runner.ensureHost = ensureHost;
    Object.assign(config.runtime, runtime);
    Object.assign(config.hub, { enabled: hubEnabled });
    await db`UPDATE global_settings SET rules_json=${db.json(settings!.rules_json)} WHERE id='global'`
      .catch(error => { cleanupErrors.push(error); });
    await deleteDispatchFixtureRows(db, [jobId], [canvasId]).catch(error => { cleanupErrors.push(error); });
    // The loopback server owns an event-loop handle even if PostgreSQL teardown fails.
    await policy?.close().catch(error => { cleanupErrors.push(error); });
    await rm(directory, { recursive: true, force: true }).catch(error => { cleanupErrors.push(error); });
    if (cleanupErrors.length) throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "credential refusal fixture cleanup failed", { cause: failed ? failure : cleanupErrors[0] });
  }
}
