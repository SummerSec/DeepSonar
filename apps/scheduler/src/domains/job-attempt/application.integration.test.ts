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
      assert.equal(new Set(second.map((row) => String(row.id))).size, 1);
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
