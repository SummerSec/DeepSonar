import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteProjectsLeavingAuditShells } from "../../test-project-teardown.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("quality metrics (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("quality and replay APIs derive scoped metrics from live tables", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const [{ default: Fastify }, { default: websocket }, { migrate, sql }, { registerRoutes }] = await Promise.all([
      import("fastify"),
      import("@fastify/websocket"),
      import("../../db.js"),
      import("../../routes.js"),
    ]);
    await migrate();
    const app = Fastify({ logger: false });
    await app.register(websocket);
    registerRoutes(app);
    await app.ready();

    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const canvasId = randomUUID();
    const otherCanvasId = randomUUID();
    const makerId = randomUUID();
    const verifyId = randomUUID();
    const hubId = randomUUID();
    const childId = randomUUID();
    const confirmedId = randomUUID();
    const fpId = randomUUID();
    const attemptId = randomUUID();
    try {
      await sql`INSERT INTO projects (id, name, status) VALUES (${projectId}, 'quality project', 'active')`;
      await sql`INSERT INTO projects (id, name, status) VALUES (${otherProjectId}, 'other quality', 'active')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'quality task', ${sql.json({})})`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${otherCanvasId}, ${otherProjectId}, 'other task', ${sql.json({})})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json, started_at, finished_at, created_at)
        VALUES (
          ${makerId}, ${projectId}, ${canvasId}, 'audit', 'succeeded',
          ${sql.json({ model: "claude", agent_cli: "claude-code", runtime_image: { image_key: "deepsonar-base" } })},
          ${sql.json({})}, ${"2026-09-11T01:00:00.000Z"}, ${"2026-09-11T01:10:00.000Z"}, ${"2026-09-11T00:50:00.000Z"}
        )`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json, started_at, finished_at, created_at)
        VALUES (
          ${hubId}, ${projectId}, ${canvasId}, 'hub_reason', 'succeeded',
          ${sql.json({ model: "claude", provider: "anthropic", runtime_image: { image_key: "deepsonar-base", digest: "sha256:hub" } })},
          ${sql.json({ trigger: { kind: "graph_progress" }, scheduling_purpose: "hub" })},
          ${"2026-09-11T01:20:00.000Z"}, ${"2026-09-11T01:25:00.000Z"}, ${"2026-09-11T01:15:00.000Z"}
        )`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, parent_job_id, type, status, agent_snapshot_json, payload_json, started_at, finished_at)
        VALUES (
          ${childId}, ${projectId}, ${canvasId}, ${hubId}, 'review', 'succeeded',
          ${sql.json({})}, ${sql.json({})}, ${"2026-09-11T01:26:00.000Z"}, ${"2026-09-11T01:30:00.000Z"}
        )`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, finding_id, type, status, agent_snapshot_json, payload_json, started_at, finished_at)
        VALUES (
          ${verifyId}, ${projectId}, ${canvasId}, ${confirmedId}, 'verify_finding', 'succeeded',
          ${sql.json({})}, ${sql.json({})}, ${"2026-09-11T01:31:00.000Z"}, ${"2026-09-11T01:36:00.000Z"}
        )`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, verify_status, disposition, created_at)
        VALUES
          (${confirmedId}, ${projectId}, ${makerId}, ${`fp-ok-${canvasId}`}, 'confirmed finding', 'confirmed', 'open', ${"2026-09-11T01:05:00.000Z"}),
          (${fpId}, ${projectId}, ${makerId}, ${`fp-bad-${canvasId}`}, 'rejected finding', 'pending', 'rejected_fp', ${"2026-09-11T01:06:00.000Z"})`;
      await sql`
        INSERT INTO finding_verification_rounds (finding_id, attempt, verify_job_id, status, proposed_verdict, final_outcome)
        VALUES (${confirmedId}, 1, ${verifyId}, 'confirmed', 'rework', 'confirmed')`;
      await sql`
        INSERT INTO events (job_id, event_id, job_seq, type, payload_json)
        VALUES (
          ${hubId}, ${randomUUID()}, 1, 'hub_decision',
          ${sql.json({ intents: [{ role: "review", description: "复核已确认条目", from: [] }] })}
        )`;
      await sql`
        INSERT INTO job_attempts (id, job_id, attempt_no, status, phase)
        VALUES (${attemptId}, ${hubId}, 1, 'succeeded', 'terminal')`;
      await sql`
        INSERT INTO job_usage_ledger (
          job_id, project_id, attempt_id, effect_id, request_no, provider, model, total_tokens, settlement_status, source
        ) VALUES (
          ${hubId}, ${projectId}, ${attemptId}, 'gateway.1', 1, 'anthropic', 'claude', 42, 'settled', 'gateway_response'
        )`;

      const global = await app.inject({ method: "GET", url: `/dashboard/quality?project_id=${projectId}` });
      assert.equal(global.statusCode, 200, global.payload);
      const globalBody = global.json() as {
        scope: { kind: string; project_id: string };
        findings: { confirmation: { rate: number; numerator: number; denominator: number }; false_positive: { rate: number } };
        verify: { disagreement: { rate: number; numerator: number } };
        cost: { total_tokens: number };
      };
      assert.equal(globalBody.scope.kind, "project");
      assert.equal(globalBody.scope.project_id, projectId);
      assert.equal(globalBody.findings.confirmation.numerator, 1);
      assert.equal(globalBody.findings.confirmation.denominator, 2);
      assert.equal(globalBody.findings.false_positive.rate, 0.5);
      assert.equal(globalBody.verify.disagreement.numerator, 1);

      const project = await app.inject({ method: "GET", url: `/projects/${projectId}/quality` });
      assert.equal(project.statusCode, 200, project.payload);
      assert.equal(project.json().findings.confirmation.rate, globalBody.findings.confirmation.rate);

      const task = await app.inject({ method: "GET", url: `/canvases/${canvasId}/quality` });
      assert.equal(task.statusCode, 200, task.payload);
      assert.equal(task.json().scope.kind, "task");
      assert.equal(task.json().scope.canvas_id, canvasId);

      const missing = await app.inject({ method: "GET", url: `/projects/${randomUUID()}/quality` });
      assert.equal(missing.statusCode, 404);

      const replay = await app.inject({ method: "GET", url: `/canvases/${canvasId}/quality/replay` });
      assert.equal(replay.statusCode, 200, replay.payload);
      const replayBody = replay.json() as {
        format: { schema_version: number; record_kind: string };
        records: Array<{
          job_id: string;
          recalled_experiences: unknown[];
          plan: { kind: string; intents: Array<{ role: string }> };
          execution: { child_jobs: Array<{ id: string }> };
          cost: { hub_tokens: number };
        }>;
      };
      assert.deepEqual(replayBody.format, { schema_version: 1, record_kind: "hub_replay" });
      assert.equal(replayBody.records.length, 1);
      assert.equal(replayBody.records[0]!.job_id, hubId);
      assert.deepEqual(replayBody.records[0]!.recalled_experiences, []);
      assert.equal(replayBody.records[0]!.plan.kind, "intents");
      assert.equal(replayBody.records[0]!.plan.intents[0]!.role, "review");
      assert.ok(replayBody.records[0]!.execution.child_jobs.some((child) => child.id === childId));
      assert.equal(replayBody.records[0]!.cost.hub_tokens, 42);

      const dashboardReplay = await app.inject({ method: "GET", url: `/dashboard/quality/replay?project_id=${projectId}` });
      assert.equal(dashboardReplay.statusCode, 200, dashboardReplay.payload);
      assert.equal(dashboardReplay.json().records[0].job_id, hubId);

      const other = await app.inject({ method: "GET", url: `/projects/${otherProjectId}/quality` });
      assert.equal(other.json().findings.total, 0);
    } finally {
      await sql`DELETE FROM job_usage_ledger WHERE project_id = ${projectId}`;
      await sql`DELETE FROM job_attempts WHERE job_id = ANY(${[hubId, makerId, verifyId, childId]}::uuid[])`;
      await sql`DELETE FROM events WHERE job_id = ${hubId}`;
      await sql`DELETE FROM finding_verification_rounds WHERE finding_id = ANY(${[confirmedId, fpId]}::uuid[])`;
      await sql`DELETE FROM findings WHERE project_id = ANY(${[projectId, otherProjectId]}::uuid[])`;
      await sql`DELETE FROM jobs WHERE project_id = ANY(${[projectId, otherProjectId]}::uuid[])`;
      await sql`DELETE FROM canvases WHERE project_id = ANY(${[projectId, otherProjectId]}::uuid[])`;
      await deleteProjectsLeavingAuditShells(sql, [projectId, otherProjectId]);
      await app.close();
    }
  });
}
