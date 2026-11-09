import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import postgres from "postgres";
import type { HumanPayload as HumanPayloadType } from "@deepsonar/shared-types";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
type InjectResponse = { statusCode: number; payload: string; json(): any };

if (!testDatabaseUrl) {
  test("Platform API integration requires TEST_DATABASE_URL", {
    skip: "TEST_DATABASE_URL 未设置",
  }, () => {});
} else {
  test("Job capability token 驱动 Platform API 完成闭环并保持幂等", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_platform_api_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;

    const projectId = randomUUID();
    const canvasId = randomUUID();
    const jobId = randomUUID();
    const operations = ["emit_progress", "emit_fact", "emit_finding", "submit_hub_decision", "mark_job_done", "request_human"];

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.AGENT_MODE = "fake";

      const [{ default: Fastify }, dbModule, platformApi] = await Promise.all([
        import("fastify"),
        import("../../db.js"),
        import("./index.js"),
      ]);
      const { sql, migrate } = dbModule;
      const {
        clearPlatformApiIdempotencyCache,
        activateProvisionedJobCapabilityTokens,
        mintJobCapabilityToken,
        registerPlatformControlRoutes,
        registerRuntimeHandler,
        unregisterRuntimeHandler,
        PlatformRuntimeHandlerError,
      } = platformApi;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();

      const app = Fastify({ logger: false });
      registerPlatformControlRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const snapshot = { name: "audit", platform_tools: operations };
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'Platform API 集成测试')`;
      await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasId}, ${projectId}, 'Platform API 集成测试')`;
      await sql`
        INSERT INTO jobs (
          id, project_id, canvas_id, type, status, agent_snapshot_json,
          started_at, timeout_sec, lease_expires_at
        ) VALUES (
          ${jobId}, ${projectId}, ${canvasId}, 'audit', 'provisioning', ${sql.json(snapshot)},
          now(), 3600, now() + interval '1 hour'
        )`;

      const { createAttempt } = await import("../job-attempt/application.js");
      await sql.begin(tx => createAttempt(tx as unknown as typeof sql, jobId));
      const grant = await mintJobCapabilityToken(jobId);
      const auth = { authorization: `Bearer ${grant.token}` };
      const base = `/control/v1/jobs/${jobId}`;
      const beforeRunning = await app.inject({ method: "GET", url: `${base}/agent/capabilities_list`, headers: auth });
      assert.equal(beforeRunning.statusCode, 409, beforeRunning.payload);
      assert.equal(beforeRunning.json().error_code, "CAPABILITY_JOB_NOT_ACTIVE");
      await sql`UPDATE jobs SET status = 'running', started_at = now() WHERE id = ${jobId}`;
      assert.equal(await activateProvisionedJobCapabilityTokens(jobId), 1);
      const calls: Array<{ operationId: string; eventId: string; input: unknown }> = [];
      const handler = async (context: { operationId: string; eventId: string; input: unknown; completionPhase?: string }) => {
        if (context.completionPhase === "prepare") return { completion_prepared: true };
        calls.push(context);
        return { accepted: true, operation_id: context.operationId, event_id: context.eventId };
      };
      registerRuntimeHandler(jobId, handler, operations);

      const capabilities = await app.inject({ method: "GET", url: `${base}/agent/capabilities_list`, headers: auth });
      assert.equal(capabilities.statusCode, 200, capabilities.payload);
      const projection = capabilities.json();
      assert.deepEqual(projection.operation_ids, operations);
      assert.equal(projection.operations.length, operations.length);
      for (const operation of projection.operations) {
        assert.equal(operation.input_schema.type, "object");
      }
      assert.equal("token" in projection, false);

      let completionRevision = 0;
      const invoke = (operationId: string, key: string, payload: unknown) => app.inject({
        method: "POST",
        url: `${base}/operations/${operationId}`,
        headers: { ...auth, "idempotency-key": key, ...(operationId === "mark_job_done" ? { "x-deepsonar-proposal-revision": String(completionRevision++) } : {}) },
        payload,
      } as never) as unknown as Promise<InjectResponse>;
      const oversizedDone = await invoke("mark_job_done", randomUUID(), {
        summary: `${"界".repeat(2730)}ab界`,
      });
      assert.equal(oversizedDone.statusCode, 422, oversizedDone.payload);
      const oversizedBody = oversizedDone.json();
      assert.equal(oversizedBody.accepted, false);
      assert.equal(oversizedBody.error_code, "invalid_done");
      assert.equal(oversizedBody.retryable, true);
      assert.equal(oversizedBody.path, "summary");
      assert.notEqual(oversizedBody.error, "Platform operation was rejected");
      assert.equal(oversizedBody.repair.category, "model_correctable");
      assert.equal(oversizedBody.repair.operation, "mark_job_done");
      assert.deepEqual(oversizedBody.repair.expected, { kind: "utf8_bytes_max", max: 8192 });
      assert.equal(oversizedBody.repair.observed_shape.type, "string");
      assert.ok(oversizedBody.repair.observed_shape.utf8_bytes > 8192);
      assert.match(String(oversizedBody.repair.next_action), /Idempotency-Key/);
      assert.equal(JSON.stringify(oversizedBody).includes("界".repeat(8)), false);
      assert.equal(calls.length, 0, "oversized done must be rejected before the runtime handler");
      const [stillRunning] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${jobId}`;
      assert.equal(stillRunning?.status, "running");
      for (const [operation, payload, errorCode] of [
        ["emit_progress", { message: "" }, "invalid_progress"],
        ["emit_fact", { title: "missing description" }, "invalid_payload"],
        ["emit_finding", { title: "short", summary: "short" }, "invalid_payload"],
        ["submit_hub_decision", {}, "invalid_payload"],
        ["request_human", {
          reason: "missing subject",
          guidance: {
            question: "Which concrete decision is needed for this request?",
            required_action: "Review the scoped request and select an available outcome.",
            reply_instructions: "Reply with the selected outcome and its subject reference.",
            after_reply: "The Scheduler rechecks the original scope; a reply does not grant access or complete the Job.",
          },
        }, "invalid_human"],
      ] as const) {
        const rejected = await invoke(operation, randomUUID(), payload);
        assert.equal(rejected.statusCode, 422, rejected.payload);
        assert.equal(rejected.json().accepted, false);
        assert.equal(rejected.json().error_code, errorCode);
        assert.equal(rejected.json().retryable, true);
      }
      const factKey = randomUUID();
      const fact = {
        title: "控制 API 事实",
        description: "通过真实 Job token 和 HTTP 路由提交的集成测试事实。",
      };
      assert.equal((await invoke("emit_fact", factKey, fact)).statusCode, 200);
      assert.equal((await invoke("emit_fact", factKey, fact)).statusCode, 200);
      assert.equal(calls.filter((call) => call.operationId === "emit_fact").length, 1, "幂等重放不得重复调用 handler");
      const conflict = await invoke("emit_fact", factKey, { ...fact, title: "冲突事实" });
      assert.equal(conflict.statusCode, 409, conflict.payload);
      assert.equal(conflict.json().error_code, "IDEMPOTENCY_KEY_CONFLICT");

      unregisterRuntimeHandler(jobId);
      const findingKey = randomUUID();
      const finding = {
        title: "Platform API 集成验证发现",
        severity: "high",
        summary: "该发现用于验证控制 API 在运行时 handler 暂时不可用后可使用同一幂等键安全恢复。",
      };
      const unavailable = await invoke("emit_finding", findingKey, finding);
      assert.equal(unavailable.statusCode, 503, unavailable.payload);
      assert.equal(unavailable.json().error_code, "HANDLER_UNAVAILABLE");
      assert.equal(unavailable.json().accepted, false);
      assert.equal(unavailable.json().retryable, true);
      assert.equal(unavailable.json().repair.category, "transient_retryable");
      assert.equal(unavailable.json().repair.operation, "emit_finding");
      assert.match(String(unavailable.json().repair.next_action), /Idempotency-Key/);
      let sideEffects = 0;
      registerRuntimeHandler(jobId, async () => {
        sideEffects++; // Models an effect accepted before the response path fails.
        throw new Error("secret-handler-boom");
      }, ["emit_progress"]);
      const crashed = await invoke("emit_progress", randomUUID(), { message: "handler crash probe" });
      assert.equal(crashed.statusCode, 500, crashed.payload);
      assert.equal(crashed.json().error_code, "HANDLER_FAILED");
      assert.equal(crashed.json().repair.category, "unknown_external_effect");
      assert.equal(crashed.json().retryable, false);
      assert.equal(sideEffects, 1);
      assert.match(crashed.json().repair.next_action, /不得自动重试/);
      assert.equal(JSON.stringify(crashed.json()).includes("secret-handler-boom"), false);
      registerRuntimeHandler(jobId, async () => {
        throw new PlatformRuntimeHandlerError("OPERATION_REJECTED", "字段不符合契约。", {
          statusCode: 422,
          errorCode: "invalid_payload",
          retryable: true,
          details: {
            error_code: "provider_internal",
            error: "sk-live-should-not-leak",
            retryable: false,
            accepted: true,
            repair: { category: "permanent_failure" },
          },
        });
      }, operations);
      const hostile = await invoke("emit_progress", randomUUID(), { message: "hostile details probe" });
      assert.equal(hostile.statusCode, 422, hostile.payload);
      assert.equal(hostile.json().error_code, "invalid_payload");
      assert.equal(hostile.json().retryable, true);
      assert.equal(hostile.json().accepted, false);
      assert.equal(hostile.json().repair.category, "model_correctable");
      assert.equal(hostile.json().details?.error_code, undefined);
      assert.equal(JSON.stringify(hostile.json()).includes("sk-live-should-not-leak"), false);
      // #776: exercise the frozen baseline through the real route argument wiring.
      // OPERATION_REJECTED carries rawInput; HANDLER_FAILED deliberately does not.
      const baseline = JSON.parse(readFileSync(new URL("../../fixtures/repair-feedback/baseline.json", import.meta.url), "utf8"));
      for (const sample of baseline.cases) {
        const fixtureJob = randomUUID();
        await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
          VALUES(${fixtureJob},${projectId},${canvasId},'audit','running',${sql.json(snapshot)},now(),3600,now()+interval '1 hour')`;
        await sql.begin(tx => createAttempt(tx as unknown as typeof sql, fixtureJob));
        const fixtureGrant = await mintJobCapabilityToken(fixtureJob);
        let acceptedEffects = 0;
        registerRuntimeHandler(fixtureJob, async (context) => {
          assert.notEqual(sample.source, "schema", "invalid schema must not reach handler");
          if (sample.source === "platform_failure") {
            if (context.completionPhase === "prepare") throw new Error("fixture-private-marker");
            assert.equal(context.completionPhase, undefined);
            acceptedEffects++; // Synthetic effect accepted before the response fails.
            throw new Error("fixture-private-marker");
          }
          throw new PlatformRuntimeHandlerError("OPERATION_REJECTED", sample.message, {
            statusCode: 422, errorCode: sample.code, retryable: sample.retryable,
            path: sample.path ?? undefined,
          });
        }, operations);
        // The frozen constructor baseline predates durable completion preparation.
        // Its generic HANDLER_FAILED projection must now be exercised through an
        // ordinary handler; completion prepare itself accepts no external effect.
        if (sample.source === "platform_failure") {
          const preparation = await app.inject({ method: "POST", url: `/control/v1/jobs/${fixtureJob}/operations/mark_job_done`,
            headers: { authorization: `Bearer ${fixtureGrant.token}`, "idempotency-key": randomUUID(), "x-deepsonar-proposal-revision": "0" },
            payload: { summary: "fixture-private-marker" } });
          assert.equal(preparation.statusCode, 503);
          assert.equal(preparation.json().error_code, "HANDLER_UNAVAILABLE");
          assert.equal(preparation.json().accepted, false);
          assert.equal(preparation.json().retryable, true);
          assert.equal(preparation.json().repair.category, "transient_retryable");
          assert.equal(acceptedEffects, 0, "completion preparation has not accepted an external effect");
        }
        const operation = sample.source === "platform_failure" ? "emit_progress" : sample.operation;
        const key = randomUUID();
        const replay = await app.inject({ method: "POST", url: `/control/v1/jobs/${fixtureJob}/operations/${operation}`,
          headers: { authorization: `Bearer ${fixtureGrant.token}`, "idempotency-key": key, "x-deepsonar-proposal-revision": "0" },
          payload: sample.source === "platform_failure" ? { message: "fixture-private-marker" } : sample.payload ?? { summary: "fixture-private-marker" } });
        assert.equal(replay.statusCode, sample.source === "platform_failure" ? 500 : 422, sample.id);
        const body = replay.json();
        assert.equal(body.accepted, false, sample.id);
        assert.equal(body.repair.operation, operation, sample.id);
        if (sample.source === "platform_failure") {
          assert.equal(body.error_code, "HANDLER_FAILED");
          assert.equal(body.retryable, false);
          assert.equal(acceptedEffects, 1);
          assert.match(body.repair.next_action, /不得自动重试/);
        }
        assert.equal(body.repair.category, sample.category, sample.id);
        assert.equal(body.repair.idempotency_key, key, sample.id);
        assert.deepEqual(body.repair.observed_shape, sample.observed_shape, sample.id);
        assert.deepEqual(body.repair.expected, sample.expected, sample.id);
        assert.equal(JSON.stringify(body).includes("fixture-private-marker"), false, sample.id);
        unregisterRuntimeHandler(fixtureJob);
      }
      registerRuntimeHandler(jobId, handler, operations);
      assert.equal((await invoke("emit_finding", findingKey, finding)).statusCode, 200, "503 不得污染幂等缓存");

      assert.equal((await invoke("submit_hub_decision", randomUUID(), {
        complete: { from: [], description: "所有验证步骤已经完成并可以收敛。" },
      })).statusCode, 200);
      assert.equal((await invoke("mark_job_done", randomUUID(), {
        summary: "Platform API 集成闭环已经完成。",
      })).statusCode, 200);
      assert.deepEqual(calls.map((call) => call.operationId), ["emit_fact", "emit_finding", "submit_hub_decision", "mark_job_done"]);

      const humanJobId = randomUUID();
      await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, started_at, timeout_sec, lease_expires_at)
        VALUES (${humanJobId}, ${projectId}, ${canvasId}, 'audit', 'provisioning', ${sql.json({ name: "audit", platform_tools: ["request_human"] })},
          now(), 3600, now() + interval '1 hour')`;
      const [humanJobNode] = await sql<{ id: string }[]>`INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${canvasId}, ${humanJobId}, 'job', 'Actionable human request integration', 'running', ${sql.json({ type: "audit" })}) RETURNING id`;
      await sql.begin(tx => createAttempt(tx as unknown as typeof sql, humanJobId));
      const humanGrant = await mintJobCapabilityToken(humanJobId);
      await sql`UPDATE jobs SET status = 'running', started_at = now() WHERE id = ${humanJobId}`;
      assert.equal(await activateProvisionedJobCapabilityTokens(humanJobId), 1);
      const { ingestEvent } = await import("../../core.js");
      let acceptedHumanCalls = 0;
      registerRuntimeHandler(humanJobId, async context => {
        acceptedHumanCalls++;
        await ingestEvent(humanJobId, {
          v: 1,
          event_id: context.eventId,
          type: "human",
          payload: context.input,
        });
        return { accepted: true, event_id: context.eventId };
      }, ["request_human"]);
      const humanBase = `/control/v1/jobs/${humanJobId}`;
      const humanInvoke = (key: string, payload: Record<string, unknown>) => app.inject({
        method: "POST",
        url: `${humanBase}/operations/request_human`,
        headers: { authorization: `Bearer ${humanGrant.token}`, "idempotency-key": key },
        payload,
      }) as unknown as Promise<InjectResponse>;
      const humanReason = "缺少隔离测试环境凭据，无法继续当前授权范围内的动态复现。";
      const humanSubject = { type: "platform_blocker", kind: "credential" };
      const missingGuidance = await humanInvoke(randomUUID(), { reason: humanReason, subject: humanSubject });
      assert.equal(missingGuidance.statusCode, 422, missingGuidance.payload);
      assert.equal(missingGuidance.json().error_code, "invalid_human");
      assert.equal(missingGuidance.json().repair.category, "model_correctable");
      assert.equal(missingGuidance.json().repair.operation, "request_human");
      assert.equal(missingGuidance.json().repair.path, "guidance");
      assert.equal(acceptedHumanCalls, 0, "missing guidance must be rejected before the runtime handler");
      const lateInstruction = "逐项确认目标主机、端口、用途、授权范围和凭据有效期；继续使用当前 Job 的既有权限边界。".repeat(20);
      const humanGuidance = {
        question: "请确认是否能通过已配置的治理凭据引用访问隔离测试环境？",
        required_action: `请在当前已知且受治理的凭据配置中准备只读凭据引用；不要粘贴秘密。${lateInstruction}`,
        reply_instructions: "请回复已配置的非秘密凭据引用；若未配置，请明确回复未配置。",
        after_reply: "收到后将复核原 Job 权限并决定能否继续；回复不扩权、不构成 ACK 或任务完成。",
      };
      assert.ok(humanGuidance.required_action.length > 500, "fixture guidance must extend past the old short summary area");
      const acceptedHuman = await humanInvoke(randomUUID(), { reason: humanReason, subject: humanSubject, guidance: humanGuidance });
      assert.equal(acceptedHuman.statusCode, 200, acceptedHuman.payload);
      assert.equal(acceptedHuman.json().accepted, true);
      assert.equal(acceptedHumanCalls, 1);
      const [persistedHuman] = await sql<{ status: string; body_json: HumanPayloadType; payload_json: HumanPayloadType }[]>`
        SELECT j.status, n.body_json, e.payload_json
        FROM jobs j
        JOIN canvas_nodes n ON n.job_id = j.id AND n.node_type = 'human'
        JOIN events e ON e.job_id = j.id AND e.type = 'human'
        WHERE j.id = ${humanJobId}`;
      assert.equal(persistedHuman.status, "waiting_human");
      assert.deepEqual(persistedHuman.body_json, { reason: humanReason, subject: humanSubject, guidance: humanGuidance });
      assert.deepEqual(persistedHuman.payload_json, { reason: humanReason, subject: humanSubject, guidance: humanGuidance });
      assert.equal(persistedHuman.body_json.guidance.required_action, humanGuidance.required_action);
      assert.ok(humanJobNode.id);
      unregisterRuntimeHandler(humanJobId);

      const narrowGrant = await mintJobCapabilityToken(jobId, { operationIds: ["emit_fact"] });
      const denied = await app.inject({
        method: "POST",
        url: `${base}/operations/emit_finding`,
        headers: { authorization: `Bearer ${narrowGrant.token}`, "idempotency-key": randomUUID() },
        payload: finding,
      });
      assert.equal(denied.statusCode, 403, denied.payload);
      assert.equal(denied.json().error_code, "OPERATION_NOT_ALLOWED");

      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${jobId}`;
      const terminal = await app.inject({ method: "GET", url: `${base}/capabilities`, headers: auth });
      assert.equal(terminal.statusCode, 409, terminal.payload);
      assert.equal(terminal.json().error_code, "CAPABILITY_JOB_NOT_ACTIVE");
      clearPlatformApiIdempotencyCache();
      unregisterRuntimeHandler(jobId);
    } finally {
      if (closeApp) await closeApp().catch(() => {});
      if (endSql) await endSql().catch(() => {});
      if (databaseCreated) {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
      }
      await admin.end({ timeout: 5 }).catch(() => {});
    }
  });
}
