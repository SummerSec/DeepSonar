import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Job Attempt integration requires TEST_DATABASE_URL", { skip: "TEST_DATABASE_URL 未设置" }, () => {});
} else {
  test("Attempt active 唯一、终态收口和效果未知窗口在同一事务中成立", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";
    const { migrate, sql } = await import("../../db.js");
    const {
      createAttempt,
      beginEffect,
      settleAttemptTerminal,
      requestAttemptCancel,
      updateAttemptSession,
    } = await import("./application.js");
    const {
      applyRuntimeContextEvent,
      createJobRuntimeContext,
      persistJobRuntimeContext,
    } = await import("../context/index.js");
    const { assertContextResume, contextIdentity, validateContextState } = await import("@deepsonar/runtime-sandbox");
    await migrate();
    const projectId = randomUUID();
    const canvasId = `attempt-${randomUUID()}`;
    const jobId = randomUUID();
    try {
      await sql`INSERT INTO projects (id, canvas_id, name) VALUES (${projectId}, ${canvasId}, 'Attempt 测试')`;
      await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasId}, ${projectId}, 'Attempt 测试')`;
      await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json) VALUES (${jobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json({ agent_cli: 'claude-code' } as never)})`;
      const first = await sql.begin((tx) => createAttempt(tx as unknown as typeof sql, jobId, { agent_cli: "claude-code" }));
      const firstAttemptId = String(first.id);
      const second = await Promise.all([
        sql.begin((tx) => createAttempt(tx as unknown as typeof sql, jobId, { agent_cli: "claude-code" })),
        sql.begin((tx) => createAttempt(tx as unknown as typeof sql, jobId, { agent_cli: "claude-code" })),
      ]);
      const concurrentIds = new Set(second.map((row) => String(row.id)));
      assert.equal(concurrentIds.size, 1);
      assert.equal([...concurrentIds][0], firstAttemptId, "并发 createAttempt 必须复用同一 active Attempt");
      const [activeBeforeContext] = await sql`
        SELECT id, status FROM job_attempts WHERE job_id = ${jobId} AND status = 'active'`;
      assert.equal(String(activeBeforeContext?.id ?? ""), firstAttemptId);
      const initialContext = createJobRuntimeContext({
        attemptId: firstAttemptId,
        adapterId: "pi",
        adapterVersion: "1.0.0",
        runtimeIdentity: `sha256:${"c".repeat(64)}`,
        compactionPolicy: "automatic",
        initialInput: "集成测试上下文",
      });
      const compactedContext = applyRuntimeContextEvent(initialContext, {
        type: "context.compacted",
        event_id: "integration-compaction-1",
        context_id: initialContext.context_id,
        context_revision: 1,
        adapter_id: initialContext.adapter_id,
        adapter_version: initialContext.adapter_version,
        runtime_identity: initialContext.runtime_identity,
        transform_chain_digest: initialContext.transform_chain_digest,
        policy: initialContext.policy,
        boundary: {
          kind: "tail",
          retained_tail_count: 8,
          retained_tail_digest: `sha256:${"d".repeat(64)}`,
        },
        input_digest: initialContext.transforms.at(-1)!.output_digest,
        output_digest: `sha256:${"e".repeat(64)}`,
        budget: { unit: "tokens", limit: 4096, observed: 3900 },
        omission: { kind: "history", count: 12, reason: "自动压缩", truncated: true },
        source: "adapter",
      });
      await persistJobRuntimeContext(sql as unknown as Parameters<typeof persistJobRuntimeContext>[0], jobId, compactedContext);
      const [persistedCompaction] = await sql`SELECT state_json FROM job_attempts WHERE id = ${firstAttemptId}`;
      const restoredCompaction = persistedCompaction.state_json.runtime_context;
      validateContextState(restoredCompaction);
      assertContextResume(contextIdentity(compactedContext), contextIdentity(restoredCompaction));
      assert.equal(restoredCompaction.compactions.at(-1).boundary.retained_tail_count, 8);
      assert.equal(restoredCompaction.compactions.at(-1).boundary.retained_tail_digest, `sha256:${"d".repeat(64)}`);
      assert.equal(restoredCompaction.compactions.at(-1).omission.count, 12);

      const overflowContext = applyRuntimeContextEvent(compactedContext, {
        type: "context.compaction_unknown",
        source: "provider",
        reason: "provider overflow 未暴露压缩边界",
      });
      await persistJobRuntimeContext(sql as unknown as Parameters<typeof persistJobRuntimeContext>[0], jobId, overflowContext);
      const [persistedBeforeRestart] = await sql`SELECT state_json FROM job_attempts WHERE id = ${firstAttemptId}`;
      const restoredContext = persistedBeforeRestart.state_json.runtime_context;
      validateContextState(restoredContext);
      assertContextResume(contextIdentity(overflowContext), contextIdentity(restoredContext));
      assert.equal(restoredContext.compaction.observation, "unknown");
      assert.equal(restoredContext.context_revision, 1);
      assert.equal(restoredContext.compactions.at(-1).boundary.retained_tail_count, 8);
      assert.throws(
        () => assertContextResume(contextIdentity(overflowContext), {
          ...contextIdentity(restoredContext),
          context_revision: 2,
        }),
        /CONTEXT_RESUME_IDENTITY_MISMATCH:context_revision/,
      );
      await sql.begin(async (tx) => {
        await updateAttemptSession(tx as unknown as typeof sql, firstAttemptId, {
          sessionId: "integration-session-1",
          sessionFile: "/workspace/.deepsonar-home/.pi/agent/integration-session-1.jsonl",
        });
        await beginEffect(tx as unknown as typeof sql, firstAttemptId, {
          effectId: "provision:1",
          kind: "provision",
          inputDigest: "a".repeat(64),
          resourceIdentity: { job_id: jobId },
          intent: { image: "test" },
        });
        await requestAttemptCancel(tx as unknown as typeof sql, jobId, "测试取消");
        await settleAttemptTerminal(tx as unknown as typeof sql, jobId, "cancelled", { reason: "测试取消" }, "测试取消");
      });
      const [attempt] = await sql`SELECT status, cancel_requested, phase, state_json FROM job_attempts WHERE id = ${firstAttemptId}`;
      const [effect] = await sql`SELECT status FROM job_attempt_effects WHERE attempt_id = ${firstAttemptId} AND effect_id = 'provision:1'`;
      assert.deepEqual({ status: attempt.status, cancel_requested: attempt.cancel_requested, phase: attempt.phase, effect: effect.status }, { status: "cancelled", cancel_requested: true, phase: "terminal", effect: "unknown" });
      assert.equal(attempt.state_json.session_id, "integration-session-1");
      assert.equal(attempt.state_json.session_file, "/workspace/.deepsonar-home/.pi/agent/integration-session-1.jsonl");
    } finally {
      await sql`DELETE FROM jobs WHERE id = ${jobId}`;
      await sql`DELETE FROM canvases WHERE id = ${canvasId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  });
}
