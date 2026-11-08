import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

type Db = typeof import("../../db.js").sql;
type Fixture = { projectId: string; canvasId: string; jobId: string; attemptId: string };

/** Controlled provider plus real Reaper/SQL/Control boundary; not an OS restart or vendor-model experiment. */
export async function runHubPlatformStopFixtures(t: TestContext, input: {
  db: Db; setup: () => Promise<Fixture>; app: FastifyInstance;
  directedHub: (order: "target_first" | "hub_first") => Promise<{ hub: Fixture; target: Fixture }>;
  setJobStatus: (jobId: string, status: "waiting_human" | "timeout") => Promise<void>;
}): Promise<void> {
  const { db, setup, app } = input;
  const api = await import("../platform-api/index.js");
  const attempts = await import("./application.js");
  const { applyPlanObjectivePatch } = await import("../plan-protocol/objective.js");
  const { controlInputDigest } = await import("../event-ingestion/control-receipt.js");
  const { COMPLETION_REPAIR_LIMIT, completionReceiptId } = await import("../event-ingestion/completion-receipt.js");
  const { stopPlatformBlockedHubs } = await import("../job-lifecycle/hub-platform-stop.js");
  const { reapOnce } = await import("../../reaper.js");
  const { runner } = await import("../../runtime.js");
  const hub = async () => {
    const f = await setup();
    await db`UPDATE jobs SET type='hub_reason',agent_snapshot_json=agent_snapshot_json || '{"name":"hub_reason","role_kind":"hub"}' WHERE id=${f.jobId}`;
    await db`UPDATE projects SET config_json='{"rules":{"hubEnabled":false}}' WHERE id=${f.projectId}`;
    return f;
  };
  const stopObjective = async (f: Fixture) => {
    const [canvas] = await db`SELECT title,target_json FROM canvases WHERE id=${f.canvasId}`;
    const { target, objective } = applyPlanObjectivePatch({ title: canvas.title, target: canvas.target_json, patch: {
      expected_revision: null, goal: "Retain the bounded platform stop evidence", completion: {
        mode: "all_tasks", description: "Retain the scoped result", required_outputs: [],
      }, budget: { max_tasks: 2, max_rounds: 2, max_no_progress_rounds: 1, max_parallel_tasks: 1 },
    } });
    const frozen = { ...target, plan_objective: { ...objective, status: "stopped" } };
    await db`UPDATE canvases SET target_json=${db.json(z.json().parse(frozen))} WHERE id=${f.canvasId}`;
    await db`UPDATE canvas_nodes SET body_json=body_json || ${db.json(z.json().parse({ target: frozen }))} WHERE canvas_id=${f.canvasId} AND node_type='root'`;
    return frozen;
  };
  const appendEvent = async (f: Fixture, type: "control_receipt" | "human", payload: Record<string, unknown>) => {
    const receiptKey = randomUUID(), completion = type === "control_receipt" && payload.operation === "mark_job_done";
    const key = completion ? completionReceiptId(f.jobId, receiptKey) : randomUUID();
    const value = completion ? { v: 1, idempotency_key: receiptKey, input_digest: controlInputDigest(payload),
      snapshot_digest: controlInputDigest("controlled snapshot fixture"), proposal_revision: 0, attempt_id: f.attemptId,
      result: { statusCode: payload.status === "rejected" ? 422 : 200, body: { accepted: payload.status !== "rejected" } },
      repair_token_limit: null, ...payload } : payload;
    await db.begin(async raw => {
      const tx = raw as unknown as Db;
      await tx`SELECT id FROM jobs WHERE id=${f.jobId} FOR UPDATE`;
      const [{ next }] = await tx`SELECT COALESCE(MAX(job_seq),0)+1 AS next FROM events WHERE job_id=${f.jobId}`;
      if (completion) await tx`INSERT INTO event_dedup(event_id,job_id) VALUES(${key},${f.jobId})`;
      await tx`INSERT INTO events(job_id,attempt_id,event_id,job_seq,type,payload_json)
        VALUES(${f.jobId},${f.attemptId},${key},${next},${type},${tx.json(z.json().parse(value))})`;
    });
    return key;
  };
  const history = async (f: Fixture, count: number, limit: number | null = null, deadline = new Date(Date.now() + 3_600_000).toISOString()) => {
    const keys: string[] = [];
    for (let i = 0; i < count; i++) keys.push(await appendEvent(f, "control_receipt", {
      operation: "mark_job_done", status: "rejected", attempt_id: f.attemptId, proposal_revision: i,
      repair_token_limit: limit, execution_deadline: deadline,
    }));
    return keys;
  };
  const state = async (f: Fixture) => ({
    jobs: await db`SELECT * FROM jobs WHERE canvas_id=${f.canvasId} ORDER BY id`,
    attempts: await db`SELECT * FROM job_attempts WHERE job_id=${f.jobId} ORDER BY attempt_no`,
    effects: await db`SELECT * FROM job_attempt_effects WHERE job_id=${f.jobId} ORDER BY effect_id`,
    ledger: await db`SELECT * FROM job_usage_ledger WHERE job_id=${f.jobId} ORDER BY id`,
    tokens: await db`SELECT * FROM job_tokens WHERE job_id=${f.jobId} ORDER BY id`,
    grants: await db`SELECT * FROM job_capability_tokens WHERE job_id=${f.jobId} ORDER BY id`,
    canvas: await db`SELECT * FROM canvases WHERE id=${f.canvasId}`,
    nodes: await db`SELECT * FROM canvas_nodes WHERE canvas_id=${f.canvasId} ORDER BY id`,
    events: await db`SELECT * FROM events WHERE job_id=${f.jobId} ORDER BY id`,
    dedup: await db`SELECT * FROM event_dedup WHERE job_id=${f.jobId} ORDER BY event_id`,
  });

  const assertScopedCanvas = async (f: Fixture, before: Awaited<ReturnType<typeof state>>, after: Awaited<ReturnType<typeof state>>) => {
    assert.equal(before.canvas.length, 1); assert.equal(after.canvas.length, 1);
    // Node projection writes advance the authoritative audit cursor. Every
    // other Canvas column, including target/convergence and retention floor,
    // must remain byte-for-byte equal; the journal must name only this Hub.
    assert.deepEqual(after.canvas[0], { ...before.canvas[0], change_revision: after.canvas[0].change_revision });
    const owned = before.nodes.filter(node => node.job_id === f.jobId && ["job", "intent"].includes(node.node_type)).map(node => String(node.id));
    assert.ok(owned.length > 0);
    const changes = await db`SELECT revision,entity_type,entity_id,op FROM canvas_changes WHERE canvas_id=${f.canvasId}
      AND revision>${before.canvas[0].change_revision} AND revision<=${after.canvas[0].change_revision} ORDER BY revision`;
    assert.equal(BigInt(String(after.canvas[0].change_revision)) - BigInt(String(before.canvas[0].change_revision)), BigInt(owned.length * 2));
    assert.equal(changes.length, owned.length * 2, "kernel stop and Reaper each project only the captured Hub nodes");
    assert.ok(changes.every(change => change.entity_type === "node" && change.op === "upsert" && owned.includes(change.entity_id)));
    for (const id of owned) assert.equal(changes.filter(change => change.entity_id === id).length, 2);
  };

  await t.test("real Reaper automatically stops ordinary/directed Hubs without completion, redispatch or invented usage", async () => {
    for (const order of ["ordinary", "target_first", "hub_first"] as const) {
      const prepared = order === "ordinary" ? { hub: await hub(), target: await setup() } : await input.directedHub(order);
      const f = prepared.hub, other = prepared.target;
      const targetState = async () => {
        const s = await state(other);
        return { jobs: s.jobs.filter(job => job.id === other.jobId), attempts: s.attempts, effects: s.effects,
          ledger: s.ledger, tokens: s.tokens, grants: s.grants, events: s.events, dedup: s.dedup,
          canvas: other.canvasId === f.canvasId ? s.canvas.map(({ change_revision: _revision, ...canvas }) => canvas) : s.canvas,
          nodes: s.nodes.filter(node => node.job_id !== f.jobId) };
      };
      const frozen = await stopObjective(f), targetBefore = await targetState();
      const sandbox = `platform-stop-${randomUUID()}`;
      await db`UPDATE jobs SET sandbox_id=${sandbox} WHERE id=${f.jobId}`;
      await db`UPDATE job_attempts SET sandbox_id=${sandbox},state_json=jsonb_set(state_json,'{sandbox_id}',to_jsonb(${sandbox}::text)) WHERE id=${f.attemptId}`;
      await db.begin(async raw => {
        const tx = raw as unknown as Db;
        await tx`SELECT id FROM jobs WHERE id=${f.jobId} FOR UPDATE`;
        await attempts.beginEffect(tx, f.attemptId, { effectId: "agent:run", kind: "agent_run" });
        await attempts.beginEffect(tx, f.attemptId, { effectId: "gateway:unknown", kind: "gateway_model_request" });
        await attempts.settleEffect(tx, f.attemptId, "gateway:unknown", { status: "unknown", outcome: { result: "interrupted" } });
      });
      const grant = await api.mintJobCapabilityToken(f.jobId), credential = randomUUID(), token = randomUUID();
      await db`INSERT INTO credentials(id,project_id,name,kind,provider,ciphertext,nonce,auth_tag,fingerprint,last4,status)
        VALUES(${credential},${f.projectId},'unused FK fixture','llm_provider','openai','fixture-not-a-secret','fixture','fixture',${randomUUID()},'test','disabled')`;
      await db`INSERT INTO job_tokens(id,job_id,project_id,credential_id,token_prefix,token_hash,max_requests,expires_at)
        VALUES(${token},${f.jobId},${f.projectId},${credential},${randomUUID()},${controlInputDigest(randomUUID())},1,clock_timestamp()+interval '1 hour')`;
      const before = await state(f), destroyed: string[] = [], originalDestroy = runner.destroy;
      runner.destroy = async handle => { destroyed.push(handle.sandboxId); await originalDestroy.call(runner, handle); };
      try {
        const [highWater] = await db`SELECT COALESCE(max(id),0)::text AS cursor FROM events`;
        const result = await reapOnce(String(highWater.cursor)); assert.equal(result.platformStops, 1);
        assert.deepEqual(destroyed, [sandbox]);
        const after = await state(f), stoppedHub = after.jobs.find(job => job.id === f.jobId)!;
        assert.equal(stoppedHub.status, "failed"); assert.equal(stoppedHub.error, "plan_objective_stopped");
        assert.equal(after.attempts[0].status, "failed");
        assert.ok(after.effects.every(effect => effect.status === "unknown"));
        assert.ok(after.effects.every(effect => effect.replay_policy === "never"));
        assert.deepEqual(after.ledger, before.ledger); assert.deepEqual(after.events, before.events);
        assert.deepEqual(stoppedHub.agent_snapshot_json, before.jobs.find(job => job.id === f.jobId)!.agent_snapshot_json);
        assert.deepEqual(after.canvas[0].target_json.plan_objective, frozen.plan_objective);
        if (order === "ordinary") {
          assert.equal(after.canvas[0].target_json.convergence.paused_reason, "plan_objective_stopped");
          assert.equal(after.nodes.find(node => node.node_type === "root")!.body_json.platform_stop.outcome, "inconclusive");
        } else {
          await assertScopedCanvas(f, before, after);
          assert.deepEqual(after.nodes.filter(node => node.job_id !== f.jobId), before.nodes.filter(node => node.job_id !== f.jobId));
        }
        assert.equal(after.nodes.find(node => node.job_id === f.jobId)!.body_json.platform_stop.outcome, "inconclusive");
        assert.equal(after.nodes.filter(node => node.node_type === "human").length, 0);
        assert.equal(after.jobs.length, before.jobs.length, "no successor or Report is dispatched");
        assert.ok(after.grants[0].revoked_at); assert.equal(after.tokens[0].status, "revoked");
        const denied = await app.inject({ method: "POST", url: `/control/v1/jobs/${f.jobId}/operations/mark_job_done`,
          headers: { authorization: `Bearer ${grant.token}`, "idempotency-key": randomUUID(), "x-deepsonar-proposal-revision": "0" }, payload: { summary: "Must refuse the original executor" } });
        assert.equal(denied.statusCode, 401, denied.payload);
        assert.deepEqual(await targetState(), targetBefore, "a directed Hub cannot stop or reconcile its target");
        const replay = await reapOnce(String(highWater.cursor)); assert.equal(replay.platformStops, 0); assert.deepEqual(destroyed, [sandbox]);
      } finally { runner.destroy = originalDestroy; }
    }
  });

  await t.test("Kernel receipt/token/deadline exhaustion exits; below-limit and unknown usage remain unchanged", async () => {
    for (const gate of ["receipts", "tokens", "deadline", "below_limit", "unknown_usage"]) {
      const f = await hub();
      const keys = await history(f, gate === "receipts" ? COMPLETION_REPAIR_LIMIT : 1, gate === "tokens" || gate === "unknown_usage" ? 8 : null,
        gate === "deadline" ? new Date(Date.now() - 1_000).toISOString() : undefined);
      if (gate === "tokens" || gate === "unknown_usage") await db.begin(async raw => {
        const tx = raw as unknown as Db;
        await tx`SELECT id FROM jobs WHERE id=${f.jobId} FOR UPDATE`;
        await attempts.beginEffect(tx, f.attemptId, { effectId: "repair:usage", kind: "gateway_model_request", intent: { repair_receipt_ref: keys[0] } });
        await attempts.settleEffect(tx, f.attemptId, "repair:usage", { status: gate === "tokens" ? "settled" : "unknown" });
        await tx`INSERT INTO job_usage_ledger(job_id,project_id,attempt_id,effect_id,request_no,provider,model,input_tokens,output_tokens,total_tokens,settlement_status)
          VALUES(${f.jobId},${f.projectId},${f.attemptId},'repair:usage',1,'integration','integration',5,3,8,'settled')`;
      });
      const before = await state(f);
      await stopPlatformBlockedHubs({ db });
      const after = await state(f);
      if (["below_limit", "unknown_usage"].includes(gate)) assert.deepEqual(after, before, gate);
      else {
        assert.equal(after.jobs[0].status, "failed", gate);
        assert.equal(after.jobs[0].error, { receipts: "completion_repair_exhausted", tokens: "repair_token_exhausted", deadline: "repair_deadline_exhausted" }[gate as "receipts" | "tokens" | "deadline"]);
        assert.deepEqual(after.ledger, before.ledger); assert.deepEqual(after.events, before.events);
      }
    }
  });

  await t.test("untrusted receipt shape, status, dedup, foreign history and unauthorized old owner cannot exhaust this execution", async () => {
    for (const gate of ["version", "status", "identity", "dedup", "foreign_attempt", "old_owner"]) {
      const f = await hub(), keys = await history(f, COMPLETION_REPAIR_LIMIT);
      if (gate === "version") await db`UPDATE events SET payload_json=jsonb_set(payload_json,'{v}','2') WHERE event_id=${keys[0]}`;
      else if (gate === "status") await db`UPDATE events SET payload_json=jsonb_set(payload_json,'{status}','"unknown"') WHERE event_id=${keys[0]}`;
      else if (gate === "identity") await db`UPDATE events SET payload_json=jsonb_set(payload_json,'{idempotency_key}',to_jsonb(${randomUUID()}::text)) WHERE event_id=${keys[0]}`;
      else if (gate === "dedup") await db`DELETE FROM event_dedup WHERE event_id=${keys[0]}`;
      else if (gate === "foreign_attempt") {
        const other = await setup();
        await db`UPDATE events SET attempt_id=${other.attemptId},payload_json=jsonb_set(payload_json,'{attempt_id}',to_jsonb(${other.attemptId}::text)) WHERE event_id=${keys[0]}`;
      } else await db.begin(async raw => {
        const tx = raw as unknown as Db;
        await tx`SELECT id FROM jobs WHERE id=${f.jobId} FOR UPDATE`;
        await attempts.settleAttemptTerminal(tx, f.jobId, "failed");
        await attempts.createAttempt(tx, f.jobId);
      });
      const before = await state(f);
      await stopPlatformBlockedHubs({ db });
      assert.deepEqual(await state(f), before, gate);
    }
  });

  await t.test("scoped Hub exit preserves live peers and reporting roots and cannot dispatch a Report", async () => {
    for (const gate of ["peer", "analysis_complete", "reporting", "succeeded", "report_failed"]) {
      const f = await hub(); await stopObjective(f);
      if (gate === "peer") {
        const peer = await setup();
        await db`UPDATE jobs SET project_id=${f.projectId},canvas_id=${f.canvasId} WHERE id=${peer.jobId}`;
        await db`UPDATE canvas_nodes SET canvas_id=${f.canvasId} WHERE job_id=${peer.jobId}`;
      } else await db`UPDATE canvas_nodes SET status=${gate} WHERE canvas_id=${f.canvasId} AND node_type='root'`;
      const before = await state(f), [highWater] = await db`SELECT COALESCE(max(id),0)::text AS cursor FROM events`;
      await reapOnce(String(highWater.cursor));
      const after = await state(f);
      assert.equal(after.jobs.find(job => job.id === f.jobId)!.status, "failed");
      assert.equal(after.nodes.find(node => node.job_id === f.jobId)!.body_json.platform_stop.outcome, "inconclusive");
      await assertScopedCanvas(f, before, after);
      assert.deepEqual(after.nodes.filter(node => node.job_id !== f.jobId), before.nodes.filter(node => node.job_id !== f.jobId), gate);
      assert.deepEqual(after.jobs.filter(job => job.id !== f.jobId), before.jobs.filter(job => job.id !== f.jobId), "no peer mutation or Report creation");
    }
  });

  await t.test("accepted human/completion, cancellation, terminal and sandbox drift are not replaced by a platform stop", async () => {
    for (const gate of ["business_wait", "authorization_wait", "high_risk_wait", "accepted_human", "accepted_done", "cancel", "terminal", "sandbox_drift", "foreign_project", "malformed_objective"]) {
      const f = await hub(); await stopObjective(f);
      if (gate.endsWith("_wait")) {
        await input.setJobStatus(f.jobId, "waiting_human");
        await appendEvent(f, "human", { reason: "Preserve the accepted request", subject: { type: "platform_blocker", kind: { business_wait: "business_decision", authorization_wait: "authorization", high_risk_wait: "high_risk_action" }[gate as "business_wait" | "authorization_wait" | "high_risk_wait"] } });
      } else if (gate.startsWith("accepted_")) await appendEvent(f, "control_receipt", {
        operation: gate === "accepted_human" ? "request_human" : "mark_job_done", status: "persisted_deferred",
      });
      else if (gate === "cancel") await db.begin(async raw => {
        const tx = raw as unknown as Db;
        await tx`SELECT id FROM jobs WHERE id=${f.jobId} FOR UPDATE`;
        await attempts.requestAttemptCancel(tx, f.jobId, "fixture cancellation");
      });
      else if (gate === "terminal") await input.setJobStatus(f.jobId, "timeout");
      else if (gate === "foreign_project") {
        const other = await setup(); await db`UPDATE jobs SET project_id=${other.projectId} WHERE id=${f.jobId}`;
      } else if (gate === "malformed_objective") await db`UPDATE canvases SET target_json=jsonb_set(target_json,'{plan_objective}','{"status":"stopped"}') WHERE id=${f.canvasId}`;
      else await db`UPDATE jobs SET sandbox_id='foreign-sandbox' WHERE id=${f.jobId}`;
      const before = await state(f); await stopPlatformBlockedHubs({ db }); assert.deepEqual(await state(f), before, gate);
    }
  });

  await t.test("stop/grant SQL failure rolls back and rotating passes reach later eligible Hubs", async () => {
    const blocked = await hub(), healthy = await hub(); await stopObjective(blocked); await stopObjective(healthy);
    const grant = await api.mintJobCapabilityToken(blocked.jobId);
    await db.unsafe(`CREATE FUNCTION reject_platform_stop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.id='${grant.id}'::uuid THEN RAISE EXCEPTION 'fixture grant failure'; END IF; RETURN NEW; END $$`);
    await db.unsafe("CREATE TRIGGER reject_platform_stop BEFORE UPDATE ON job_capability_tokens FOR EACH ROW EXECUTE FUNCTION reject_platform_stop()");
    const before = await state(blocked);
    try {
      // Start immediately before blocked so UUID ordering cannot make the test accidental.
      const [previous] = await db`SELECT id FROM jobs WHERE id<${blocked.jobId} ORDER BY id DESC LIMIT 1`;
      const first = await stopPlatformBlockedHubs({ db, afterJobId: previous ? String(previous.id) : null, limit: 1 });
      assert.equal(first.nextJobId, blocked.jobId); assert.equal(first.stoppedJobs.length, 0);
      assert.deepEqual(await state(blocked), before);
      let cursor: string | null = first.nextJobId, reached = false;
      for (let i = 0; i < 40 && !reached; i++) {
        const pass = await stopPlatformBlockedHubs({ db, afterJobId: cursor, limit: 1 }); cursor = pass.nextJobId;
        reached = pass.stoppedJobs.some(job => job.id === healthy.jobId);
      }
      assert.ok(reached, "a failed head cannot starve a later eligible Hub"); assert.deepEqual(await state(blocked), before);
    } finally {
      await db.unsafe("DROP TRIGGER reject_platform_stop ON job_capability_tokens"); await db.unsafe("DROP FUNCTION reject_platform_stop()");
    }
    await stopPlatformBlockedHubs({ db }); assert.equal((await state(blocked)).jobs[0].status, "failed");
  });
}
