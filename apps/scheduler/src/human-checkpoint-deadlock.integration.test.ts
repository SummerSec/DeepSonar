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
        // Cancellation and interruption validate the frozen total-state identity.
        await sql`
          INSERT INTO job_attempts (id, job_id, attempt_no, status, phase, state_json)
          VALUES (${attemptId}, ${jobId}, 1, 'active', 'agent.suspended',
            ${sql.json({ version: 1, attempt_id: attemptId, job_id: jobId })})`;
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

      // #1223 期望 2：断点不可用时可以显式放弃现场。封存断点时旧 Attempt 已按
      // interrupted 收口（markAttemptInterrupted 会 settle 掉未决网关请求），但该夹具没有
      // 完整的冻结预算，重跑仍会被预算检查拒绝——所以这里断言放弃路径的只读性：
      // 被拒时人工请求必须完全没动，不能先关请求再报错。
      // #1223 评审：只认任意 409 不够，必须证明被拒在预算这一层且没有留半截状态。
      const [jobBefore] = await sql`SELECT status, started_at, finished_at FROM jobs WHERE id = ${rerunAnswered.jobId}`;
      const attemptsBefore = await sql`SELECT attempt_no, status, phase FROM job_attempts
        WHERE job_id = ${rerunAnswered.jobId} ORDER BY attempt_no`;
      const refusedByBudget = await call(rerunAnswered.jobId, "rerun-current", { abandon_checkpoint: true });
      assert.equal(refusedByBudget.statusCode, 409, refusedByBudget.body);
      assert.equal(refusedByBudget.json().error_code, "GATEWAY_REQUEST_BUDGET_HISTORY_MISSING", refusedByBudget.body);
      const [requestAfterAbandon] = await sql`SELECT status, close_reason, resumed_at FROM human_requests
        WHERE id = ${rerunAnswered.requestId}`;
      assert.deepEqual({ status: requestAfterAbandon.status, close_reason: requestAfterAbandon.close_reason,
        resumed_at: requestAfterAbandon.resumed_at }, { status: "answered", close_reason: null, resumed_at: null });
      const [jobAfterBudget] = await sql`SELECT status, started_at, finished_at FROM jobs WHERE id = ${rerunAnswered.jobId}`;
      assert.deepEqual(jobAfterBudget, jobBefore, "被拒后 Job 状态与时间戳不得变化");
      const attemptsAfter = await sql`SELECT attempt_no, status, phase FROM job_attempts
        WHERE job_id = ${rerunAnswered.jobId} ORDER BY attempt_no`;
      assert.deepEqual(attemptsAfter, attemptsBefore, "被拒后不得新增或改写 Attempt");
      assert.deepEqual(refusedByBudget.json().missing_fields, ["agent_snapshot_json.runtime_knobs"],
        "被拒必须指向冻结预算缺失，而不是别的拒绝");

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
      // 必须先让旧 Attempt 终态，否则会撞 job_attempts_one_active_idx（唯一 active 约束）。
      const staleAttempt = await insertWaitingJob("answered");
      await sql`UPDATE job_attempts SET status='interrupted', phase='interrupted', finished_at=now()
        WHERE job_id=${staleAttempt.jobId} AND status='active'`;
      const staleAttemptId = randomUUID();
      await sql`INSERT INTO job_attempts (id, job_id, attempt_no, status, phase, state_json)
        VALUES (${staleAttemptId}, ${staleAttempt.jobId}, 2, 'active', 'agent.suspended',
          ${sql.json({ version: 1, attempt_id: staleAttemptId, job_id: staleAttempt.jobId })})`;
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

      const readOnlyToken = generateToken();
      await sql`INSERT INTO api_tokens (name,project_id,token_prefix,token_hash,scopes)
        VALUES ('只读退出 Token',${projectId},${readOnlyToken.prefix},${readOnlyToken.hash},${["tasks:read"]})`;
      const { markAttemptInterrupted } = await import("./domains/job-attempt/index.js");
      const { pumpHumanContinuations } = await import("./domains/job-control/human-continuation-pump.js");
      for (const stage of ["active", "interrupted"] as const) {
        const exit = await insertWaitingJob("answered");
        if (stage === "interrupted") {
          await markAttemptInterrupted(sql, exit.jobId, "human_wait_checkpoint_sealed", { preservePendingGatewayRequests: true });
        } else {
          await sql`UPDATE human_requests SET process_exited_at=NULL,resources_released_at=NULL WHERE id=${exit.requestId}`;
        }
        const [originalAttempt] = await sql`SELECT * FROM job_attempts WHERE id=${exit.attemptId}`;
        assert.equal(originalAttempt.status, stage);
        const [originalReply] = await sql`SELECT reply_message_id FROM human_requests WHERE id=${exit.requestId}`;
        const denied = await app.inject({ method: "POST", url: `/jobs/${exit.jobId}/cancel`,
          headers: { authorization: `Bearer ${readOnlyToken.plaintext}` }, payload: { force: true } });
        assert.equal(denied.statusCode, 403, denied.body);
        assert.equal((await sql`SELECT status FROM jobs WHERE id=${exit.jobId}`)[0].status, "waiting_human");
        const cancelled = await app.inject({ method: "POST", url: `/jobs/${exit.jobId}/cancel`, headers,
          payload: { force: true, reason: "断点不可用，结束本次运行" } });
        assert.equal(cancelled.statusCode, 200, cancelled.body);
        assert.equal(cancelled.json().status, "cancelled");
        const [settled] = await sql`SELECT status,finished_at FROM jobs WHERE id=${exit.jobId}`;
        assert.equal(settled.status, "cancelled");
        assert.ok(settled.finished_at);
        const [closedRequest] = await sql`SELECT status,close_reason,reply_message_id,resumed_at,checkpoint_status,checkpoint_error_code
          FROM human_requests WHERE id=${exit.requestId}`;
        assert.deepEqual(closedRequest, { status: "closed", close_reason: "cancelled",
          reply_message_id: originalReply.reply_message_id, resumed_at: null, checkpoint_status: "blocked",
          checkpoint_error_code: "HUMAN_CHECKPOINT_SECRET_DETECTED" });
        const [retainedReply] = await sql`SELECT body,delivery_status FROM human_messages WHERE id=${originalReply.reply_message_id}`;
        assert.deepEqual(retainedReply, { body: "继续", delivery_status: "planned" });
        const [settledAttempt] = await sql`SELECT * FROM job_attempts WHERE id=${exit.attemptId}`;
        if (stage === "interrupted") assert.deepEqual(settledAttempt, originalAttempt, "historical interrupted Attempt stays immutable");
        else assert.equal(settledAttempt.status, "cancelled");
        const [logged] = await sql`SELECT after_json FROM audit_logs WHERE resource_id=${exit.jobId} AND action='job.force_cancel'`;
        assert.deepEqual(logged.after_json, { status: "cancelled", force: true, reason: "断点不可用，结束本次运行" });
        const duplicate = await app.inject({ method: "POST", url: `/jobs/${exit.jobId}/cancel`, headers, payload: { force: true } });
        assert.equal(duplicate.statusCode, 409, duplicate.body);
        assert.equal(duplicate.json().error_code, "JOB_NOT_CANCELLABLE");
        await pumpHumanContinuations(1, exit.requestId);
        assert.equal((await sql`SELECT status FROM jobs WHERE id=${exit.jobId}`)[0].status, "cancelled");
        assert.equal((await sql`SELECT count(*)::int AS n FROM job_attempts WHERE job_id=${exit.jobId}`)[0].n, 1);
      }
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    }
  });
}
