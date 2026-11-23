import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

/**
 * #1223：`waiting_human` 的断点被密钥误判封为 blocked 后，前台 resume / rerun-current
 * 一律回 HUMAN_REPLY_REQUIRED，与后台泵形成互锁。这里用真实 PG 核对恢复入口返回的是
 * 真实阻断原因（断点不可用），以及未回复时仍然是 HUMAN_REPLY_REQUIRED。
 */
if (testDatabaseUrl) {
  test("waiting_human resume reports the real checkpoint blocker instead of asking to reply again", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_human_checkpoint_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let closeApp: (() => Promise<void>) | null = null;
    let endSql: (() => Promise<void>) | null = null;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";

      const [fastifyModule, websocketModule, dbModule, routesModule, authModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
        import("./auth.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { sql, migrate } = dbModule;
      const { generateToken } = authModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();

      const projectId = randomUUID();
      const canvasId = `checkpoint-${randomUUID()}`;
      const rootNodeId = randomUUID();
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, '断点恢复集成项目')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, '断点恢复画布', ${sql.json({ network_policy: { allow_egress: false } } as never)})`;
      await sql`
        INSERT INTO canvas_nodes (id, canvas_id, node_type, title, status, body_json)
        VALUES (${rootNodeId}, ${canvasId}, 'root', 'root', 'active', ${sql.json({})})`;

      const insertWaitingJob = async (requestStatus: "open" | "answered") => {
        const jobId = randomUUID();
        const attemptId = randomUUID();
        const eventId = `human-${randomUUID()}`;
        const requestId = randomUUID();
        const messageId = randomUUID();
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
          VALUES (${jobId}, ${projectId}, ${canvasId}, 'hub_reason', 'waiting_human', ${sql.json({})}, ${sql.json({ name: "hub_reason" })})`;
        await sql`
          INSERT INTO job_attempts (id, job_id, attempt_no, status, phase)
          VALUES (${attemptId}, ${jobId}, 1, 'active', 'agent.suspended')`;
        await sql`
          INSERT INTO events (job_id, job_seq, attempt_id, event_id, type, payload_json)
          VALUES (${jobId}, 1, ${attemptId}, ${eventId}, 'human', ${sql.json({})})`;
        await sql`
          INSERT INTO human_requests (
            id, source_event_id, project_id, canvas_id, job_id, attempt_id, revision, status, payload_json,
            checkpoint_status, checkpoint_error_code, process_exited_at, resources_released_at, answered_at, reply_message_id
          ) VALUES (
            ${requestId}, ${eventId}, ${projectId}, ${canvasId}, ${jobId}, ${attemptId}, 1, ${requestStatus}, ${sql.json({ question: "继续还是收口" } as never)},
            'blocked', 'HUMAN_CHECKPOINT_SECRET_DETECTED', now(), now(),
            ${requestStatus === "answered" ? sql`now()` : null}, ${requestStatus === "answered" ? messageId : null}
          )`;
        if (requestStatus === "answered") {
          await sql`
            INSERT INTO human_messages (
              id, request_id, request_revision, canvas_id, human_node_id, target_kind, target_node_id, target_job_id, body, delivery_status
            ) VALUES (${messageId}, ${requestId}, 1, ${canvasId}, ${rootNodeId}, 'job', ${rootNodeId}, ${jobId}, '继续', 'planned')`;
        }
        return { jobId, requestId, attemptId };
      };

      const resumeAnswered = await insertWaitingJob("answered");
      const rerunAnswered = await insertWaitingJob("answered");
      const resumeUnanswered = await insertWaitingJob("open");
      const rerunUnanswered = await insertWaitingJob("open");

      const token = generateToken();
      await sql`
        INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
        VALUES ('断点恢复 Token', ${projectId}, ${token.prefix}, ${token.hash}, ${["jobs:control", "tasks:read"]})`;
      const headers = { authorization: `Bearer ${token.plaintext}` };
      const app = Fastify({ logger: false });
      await app.register(websocket);
      routesModule.registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const call = async (jobId: string, path: string, payload?: Record<string, unknown>) =>
        app.inject({ method: "POST", url: `/jobs/${jobId}/${path}`, headers,
          ...(payload ? { payload } : {}) });

      const ready = await insertWaitingJob("answered");
      const { humanSnapshotDigest } = await import("./domains/job-control/human-continuation-store.js");
      const manifest = { v: 2, mode: "structured", files: [], job_id: ready.jobId,
        request_id: ready.requestId, attempt_id: ready.attemptId, snapshot_sha256: humanSnapshotDigest({ name: "hub_reason" }) };
      await sql`UPDATE human_requests SET checkpoint_status='ready', checkpoint_error_code=NULL,
        manifest_json=${sql.json(manifest)} WHERE id=${ready.requestId}`;
      await sql`INSERT INTO job_execution_clocks (job_id, budget_ms) VALUES (${ready.jobId}, 60000)`;
      for (const previous of [null, "SNAPSHOT_STALE", "HUMAN_CONTINUATION_AUTHORIZATION_BLOCKED", null]) {
        await sql`UPDATE human_requests SET resume_error_code=${previous} WHERE id=${ready.requestId}`;
        for (const path of ["resume", "rerun-current"]) {
          const result = await call(ready.jobId, path);
          assert.equal(result.statusCode, 409, result.body);
          assert.equal(result.json().error_code, previous ?? "HUMAN_CONTINUATION_PENDING", result.body);
          if (previous) assert.match(result.json().error, /上次/);
        }
      }
      await sql`UPDATE human_requests SET resume_error_code='SNAPSHOT_STALE',
        checkpoint_expires_at=now()-interval '1 second' WHERE id=${ready.requestId}`;
      assert.equal((await call(ready.jobId, "resume")).json().error_code, "HUMAN_CHECKPOINT_EXPIRED");

      for (const [path, answered, unanswered] of [
        ["resume", resumeAnswered, resumeUnanswered],
        ["rerun-current", rerunAnswered, rerunUnanswered],
      ] as const) {
        const blocked = await call(answered.jobId, path);
        assert.equal(blocked.statusCode, 409, `${path}: ${blocked.body}`);
        assert.equal(blocked.json().error_code, "HUMAN_CHECKPOINT_SECRET_DETECTED", path);
        assert.doesNotMatch(blocked.json().error, /请回复对应人工请求/);
        assert.match(blocked.json().error, /取消该任务或新建任务/);

        const stillUnanswered = await call(unanswered.jobId, path);
        assert.equal(stillUnanswered.statusCode, 409, `${path}: ${stillUnanswered.body}`);
        assert.equal(stillUnanswered.json().error_code, "HUMAN_REPLY_REQUIRED", path);
      }

      const [unchanged] = await sql`SELECT status, checkpoint_status, resumed_at FROM human_requests
        WHERE id = ${rerunAnswered.requestId}`;
      assert.deepEqual(
        { status: unchanged.status, checkpoint_status: unchanged.checkpoint_status, resumed_at: unchanged.resumed_at },
        { status: "answered", checkpoint_status: "blocked", resumed_at: null },
      );
      const [jobAfter] = await sql`SELECT status FROM jobs WHERE id = ${rerunAnswered.jobId}`;
      assert.equal(jobAfter.status, "waiting_human");
      const [requestAfter] = await sql`SELECT status, resumed_at FROM human_requests WHERE id = ${rerunAnswered.requestId}`;
      assert.equal(requestAfter.status, "answered");
      assert.equal(requestAfter.resumed_at, null);

      // #1223 期望 2：放弃写回位于所有校验之后。该夹具没有完整的冻结网关预算，
      // 重跑会在预算检查处被拒——被拒时人工请求必须完全没动（不能先关再报错）。
      const refusedByBudget = await call(rerunAnswered.jobId, "rerun-current", { abandon_checkpoint: true });
      assert.notEqual(refusedByBudget.statusCode, 200, refusedByBudget.body);
      const [requestAfterAbandon] = await sql`SELECT status, close_reason, resumed_at FROM human_requests
        WHERE id = ${rerunAnswered.requestId}`;
      assert.deepEqual({ status: requestAfterAbandon.status, close_reason: requestAfterAbandon.close_reason,
        resumed_at: requestAfterAbandon.resumed_at }, { status: "answered", close_reason: null, resumed_at: null });

      // 断点仍在保存（preparing）时同样不算不可恢复，拒绝且不改状态。
      const preparing = await insertWaitingJob("answered");
      await sql`UPDATE human_requests SET checkpoint_status='preparing', checkpoint_error_code=NULL
        WHERE id=${preparing.requestId}`;
      const preparingRefused = await call(preparing.jobId, "rerun-current", { abandon_checkpoint: true });
      assert.equal(preparingRefused.statusCode, 409, preparingRefused.body);
      assert.equal(preparingRefused.json().error_code, "CHECKPOINT_ABANDON_NOT_APPLICABLE");
      const [preparingAfter] = await sql`SELECT status, checkpoint_status FROM human_requests WHERE id=${preparing.requestId}`;
      assert.deepEqual({ status: preparingAfter.status, checkpoint_status: preparingAfter.checkpoint_status },
        { status: "answered", checkpoint_status: "preparing" });

      // 断点已失败但不是当前 Attempt 的请求：保守拒绝，不改状态。
      const staleAttempt = await insertWaitingJob("answered");
      await sql`INSERT INTO job_attempts (id, job_id, attempt_no, status, phase)
        VALUES (${randomUUID()}, ${staleAttempt.jobId}, 2, 'active', 'agent.suspended')`;
      const staleRefused = await call(staleAttempt.jobId, "rerun-current", { abandon_checkpoint: true });
      assert.equal(staleRefused.statusCode, 409, staleRefused.body);
      assert.equal(staleRefused.json().error_code, "CHECKPOINT_ABANDON_NOT_APPLICABLE");
      const [staleAfter] = await sql`SELECT status FROM human_requests WHERE id=${staleAttempt.requestId}`;
      assert.equal(staleAfter.status, "answered");

      // 现场仍可用时不允许放弃，避免把可续做的现场当作不可用丢掉。
      const usable = await insertWaitingJob("answered");
      await sql`UPDATE human_requests SET checkpoint_status='ready', checkpoint_error_code=NULL,
        manifest_json=${sql.json({ v: 2, mode: "structured", files: [], job_id: usable.jobId,
          request_id: usable.requestId, attempt_id: usable.attemptId,
          snapshot_sha256: humanSnapshotDigest({ name: "hub_reason" }) })} WHERE id=${usable.requestId}`;
      const refused = await call(usable.jobId, "rerun-current", { abandon_checkpoint: true });
      assert.equal(refused.statusCode, 409, refused.body);
      assert.equal(refused.json().error_code, "CHECKPOINT_ABANDON_NOT_APPLICABLE");
      const [usableAfter] = await sql`SELECT status FROM human_requests WHERE id = ${usable.requestId}`;
      assert.equal(usableAfter.status, "answered");
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    }
  });
}
