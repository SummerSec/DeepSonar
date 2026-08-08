import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("semantic event authorization integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("semantic event authority rejects stale/malformed Jobs and preserves terminal ordering", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("../../db.js");
    const { ingestEvent } = await import("../../core.js");
    const { ControlInputError } = await import("../../control-input.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `event-authority-${randomUUID()}`;
    const jobIds: string[] = [];
    const workerSnapshot = {
      name: "review",
      role_kind: "role",
      platform_tools: ["emit_progress", "emit_fact", "mark_job_done", "request_human"],
    };
    const auditSnapshot = {
      name: "audit",
      role_kind: "role",
      platform_tools: ["emit_progress", "emit_finding", "mark_job_done"],
    };
    const hubSnapshot = {
      name: "hub_reason",
      role_kind: "hub",
      platform_tools: ["list_available_roles", "emit_progress", "submit_hub_decision", "mark_job_done"],
    };

    await sql`
      INSERT INTO projects (id, canvas_id, name, config_json)
      VALUES (${projectId}, ${canvasId}, 'event-authority', ${sql.json({ rules: { hubEnabled: false } })})`;
    await sql`
      INSERT INTO canvases (id, project_id, title, target_json)
      VALUES (
        ${canvasId}, ${projectId}, 'event-authority',
        ${sql.json({ network_policy: { allow_egress: false } })}
      )`;
    await sql`
      INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
      VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({})})`;

    const makeJob = async (
      type: string,
      status: string,
      snapshot: unknown,
    ): Promise<string> => {
      const id = randomUUID();
      jobIds.push(id);
      const encodedSnapshot = snapshot === null ? sql.unsafe("'null'::jsonb") : sql.json(snapshot as never);
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES (${id}, ${projectId}, ${canvasId}, ${type}, ${status}, ${encodedSnapshot}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${canvasId}, ${id}, 'job', ${`${type}-${id.slice(0, 8)}`}, ${status}, ${sql.json({ baseline: true })})`;
      return id;
    };

    const payloadFor = (type: string): unknown => {
      switch (type) {
        case "progress": return { message: "late event" };
        case "fact": return { title: "late fact", description: "late description" };
        case "finding": return {
          title: "late finding",
          summary: "late finding remains valid before authorization",
          severity: "low",
          suggest_verify: false,
        };
        case "hub_decision": return { complete: { from: [], description: "late decision" } };
        case "human": return { reason: "late operator decision" };
        case "done": return { summary: "late completion" };
        default: throw new Error(`unknown test event type ${type}`);
      }
    };

    const assertRejectedWithoutWrites = async (jobId: string, type: string, code: string) => {
      const eventId = randomUUID();
      const [before] = await sql<{ events: number; dedup: number; limits: number; nodes: number; findings: number }[]>`
        SELECT
          (SELECT COUNT(*)::int FROM events WHERE job_id = ${jobId}) AS events,
          (SELECT COUNT(*)::int FROM event_dedup WHERE job_id = ${jobId}) AS dedup,
          (SELECT COUNT(*)::int FROM job_event_rate_limits WHERE job_id = ${jobId}) AS limits,
          (SELECT COUNT(*)::int FROM canvas_nodes WHERE job_id = ${jobId}) AS nodes,
          (SELECT COUNT(*)::int FROM findings WHERE job_id = ${jobId}) AS findings`;
      await assert.rejects(
        ingestEvent(jobId, { v: 1, event_id: eventId, type: type as never, payload: payloadFor(type) as never }),
        (error: unknown) => {
          assert.ok(error instanceof ControlInputError, `${type}: expected ControlInputError`);
          assert.equal(error.code, code, `${type}: stable error code`);
          return true;
        },
      );
      const [after] = await sql<{ events: number; dedup: number; limits: number; nodes: number; findings: number }[]>`
        SELECT
          (SELECT COUNT(*)::int FROM events WHERE job_id = ${jobId}) AS events,
          (SELECT COUNT(*)::int FROM event_dedup WHERE job_id = ${jobId}) AS dedup,
          (SELECT COUNT(*)::int FROM job_event_rate_limits WHERE job_id = ${jobId}) AS limits,
          (SELECT COUNT(*)::int FROM canvas_nodes WHERE job_id = ${jobId}) AS nodes,
          (SELECT COUNT(*)::int FROM findings WHERE job_id = ${jobId}) AS findings`;
      assert.deepEqual(after, before, `${type}: rejected event must roll back dedup/quota/event/Canvas writes`);
      const [dedup] = await sql`SELECT 1 FROM event_dedup WHERE event_id = ${eventId}`;
      assert.equal(dedup, undefined, `${type}: rejected event id must remain retryable`);
    };

    try {
      const staleJobs = ["succeeded", "waiting_human", "cancelled"].map(async (status) => ({
        status,
        jobId: await makeJob("review", status, workerSnapshot),
      }));
      const stale = await Promise.all(staleJobs);
      for (const { jobId } of stale) {
        for (const type of ["progress", "fact", "finding", "hub_decision", "human", "done"]) {
          await assertRejectedWithoutWrites(jobId, type, "job_not_running");
        }
      }

      const auditJob = await makeJob("audit_module", "running", auditSnapshot);
      await assertRejectedWithoutWrites(auditJob, "fact", "tool_not_allowed");
      const workerJob = await makeJob("review", "running", workerSnapshot);
      await assertRejectedWithoutWrites(workerJob, "finding", "tool_not_allowed");
      const restrictedJob = await makeJob("review", "running", {
        name: "review",
        role_kind: "role",
        platform_tools: ["emit_progress", "mark_job_done"],
      });
      await assertRejectedWithoutWrites(restrictedJob, "fact", "tool_not_allowed");

      const legacyAuditJob = await makeJob("audit_module", "running", {
        name: "audit_module",
        agent_cli: "claude-code",
        credential_id: null,
        model: null,
      });
      const legacyAccepted = await ingestEvent(legacyAuditJob, {
        v: 1,
        event_id: randomUUID(),
        type: "progress",
        payload: { message: "legacy snapshot canonicalized" },
      });
      assert.equal(legacyAccepted.deduped, false);

      const customJob = await makeJob("explore", "running", {
        agent_cli: "claude-code",
        credential_id: null,
        model: null,
      });
      const customAccepted = await ingestEvent(customJob, {
        v: 1,
        event_id: randomUUID(),
        type: "fact",
        payload: { title: "custom role fact", description: "custom role is still a role" },
      });
      assert.equal(customAccepted.deduped, false);

      for (const [type, snapshot] of [
        ["verify_finding", { name: "verify", role_kind: "role" }],
        ["hub_reason", { name: "hub_reason", role_kind: "role" }],
        ["audit_module", { name: "audit_module", role_kind: "hub" }],
      ] as const) {
        const malformedJob = await makeJob(type, "running", snapshot);
        const eventType = type === "verify_finding" ? "progress" : type === "hub_reason" ? "hub_decision" : "progress";
        await assertRejectedWithoutWrites(malformedJob, eventType, "tool_not_allowed");
      }
      const reviewAsAuditJob = await makeJob("review", "running", { name: "audit", role_kind: "role" });
      await assertRejectedWithoutWrites(reviewAsAuditJob, "finding", "tool_not_allowed");
      const auditAsReviewJob = await makeJob("audit_module", "running", { name: "review", role_kind: "role" });
      await assertRejectedWithoutWrites(auditAsReviewJob, "progress", "tool_not_allowed");
      const hubNameMismatchJob = await makeJob("hub_reason", "running", { name: "review", role_kind: "hub" });
      await assertRejectedWithoutWrites(hubNameMismatchJob, "hub_decision", "tool_not_allowed");
      for (const snapshot of [null, ["not-an-object"], "not-an-object", 42]) {
        const malformedJsonJob = await makeJob("review", "running", snapshot);
        await assertRejectedWithoutWrites(malformedJsonJob, "progress", "tool_not_allowed");
      }
      const emptyTypeJob = await makeJob("", "running", {});
      await assertRejectedWithoutWrites(emptyTypeJob, "progress", "tool_not_allowed");
      const unknownWithoutNameJob = await makeJob("custom_missing_name", "running", {});
      await assertRejectedWithoutWrites(unknownWithoutNameJob, "progress", "tool_not_allowed");
      const customType = "custom_authorized_role";
      const customMatchingJob = await makeJob(customType, "running", {
        name: customType,
        role_kind: "role",
        platform_tools: ["emit_progress", "emit_fact", "mark_job_done"],
      });
      const customFact = await ingestEvent(customMatchingJob, {
        v: 1,
        event_id: randomUUID(),
        type: "fact",
        payload: { title: "custom authorized fact", description: "custom snapshot contract" },
      });
      assert.equal(customFact.deduped, false);
      const customDone = await ingestEvent(customMatchingJob, {
        v: 1,
        event_id: randomUUID(),
        type: "done",
        payload: { summary: "custom authorized done" },
      });
      assert.equal(customDone.deduped, false);
      const customMismatchJob = await makeJob("custom_name_mismatch", "running", {
        name: "different_custom_role",
        role_kind: "role",
        platform_tools: ["emit_progress", "emit_fact", "mark_job_done"],
      });
      await assertRejectedWithoutWrites(customMismatchJob, "fact", "tool_not_allowed");
      const customMissingToolsJob = await makeJob("custom_missing_tools", "running", {
        name: "custom_missing_tools",
        role_kind: "role",
      });
      await assertRejectedWithoutWrites(customMissingToolsJob, "fact", "tool_not_allowed");

      const verifyHumanJob = await makeJob("verify_finding", "running", {
        name: "verify",
        role_kind: "system",
        platform_tools: ["emit_progress", "mark_job_done"],
      });
      await assertRejectedWithoutWrites(verifyHumanJob, "human", "tool_not_allowed");
      const reportHumanJob = await makeJob("report", "running", {
        name: "report",
        role_kind: "system",
        platform_tools: ["emit_progress", "mark_job_done"],
      });
      await assertRejectedWithoutWrites(reportHumanJob, "human", "tool_not_allowed");
      const workerHubJob = await makeJob("review", "running", workerSnapshot);
      await assertRejectedWithoutWrites(workerHubJob, "hub_decision", "tool_not_allowed");

      // The Hub complete gate is intentionally independent of authorization:
      // close the helper Jobs used above so only the legal Hub under test is
      // active on this Canvas.
      await sql`
        UPDATE jobs SET status = 'succeeded'
        WHERE project_id = ${projectId}
          AND status IN ('pending', 'claimed', 'provisioning', 'running', 'waiting_human')`;
      await sql`
        UPDATE canvas_nodes SET status = 'succeeded'
        WHERE canvas_id = ${canvasId} AND job_id IS NOT NULL AND status = 'running'`;

      const hubJob = await makeJob("hub_reason", "running", {
        ...hubSnapshot,
        name: "hub",
      });
      const hubDecisionEventId = randomUUID();
      const hubDecision = await ingestEvent(hubJob, {
        v: 1,
        event_id: hubDecisionEventId,
        type: "hub_decision",
        payload: { complete: { from: [], description: "legal Hub decision" } },
      });
      assert.equal(hubDecision.deduped, false);
      const hubDone = await ingestEvent(hubJob, {
        v: 1,
        event_id: randomUUID(),
        type: "done",
        payload: { summary: "legal Hub completion" },
      });
      assert.equal(hubDone.deduped, false);
      const [hubState] = await sql<{ status: string; events: number }[]>`
        SELECT status, (SELECT COUNT(*)::int FROM events WHERE job_id = ${hubJob}) AS events
        FROM jobs WHERE id = ${hubJob}`;
      assert.deepEqual(hubState, { status: "succeeded", events: 2 });
      const hubReplay = await ingestEvent(hubJob, {
        v: 1,
        event_id: hubDecisionEventId,
        type: "hub_decision",
        payload: { complete: { from: [], description: "replayed after terminal" } },
      });
      assert.deepEqual(hubReplay, { deduped: true }, "dedup must win before status/history on a terminal replay");

      const humanJob = await makeJob("review", "running", workerSnapshot);
      await ingestEvent(humanJob, {
        v: 1,
        event_id: randomUUID(),
        type: "human",
        payload: { reason: "operator review" },
      });
      await sql`UPDATE jobs SET status = 'running' WHERE id = ${humanJob}`;
      await assertRejectedWithoutWrites(humanJob, "done", "duplicate_tool_call");

      const duplicateDoneJob = await makeJob("review", "running", workerSnapshot);
      await ingestEvent(duplicateDoneJob, {
        v: 1,
        event_id: randomUUID(),
        type: "done",
        payload: { summary: "first done" },
      });
      await sql`UPDATE jobs SET status = 'running' WHERE id = ${duplicateDoneJob}`;
      await assertRejectedWithoutWrites(duplicateDoneJob, "done", "duplicate_tool_call");

      const doneThenHubJob = await makeJob("hub_reason", "running", hubSnapshot);
      await ingestEvent(doneThenHubJob, {
        v: 1,
        event_id: randomUUID(),
        type: "done",
        payload: { summary: "done before Hub" },
      });
      // A recovery/status repair can temporarily restore running. The history
      // guard must still reject the impossible done -> hub order after the
      // current event has been appended in the outer transaction.
      await sql`UPDATE jobs SET status = 'running' WHERE id = ${doneThenHubJob}`;
      await assertRejectedWithoutWrites(doneThenHubJob, "hub_decision", "duplicate_tool_call");
    } finally {
      await sql`DELETE FROM canvas_edges WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM task_reports WHERE project_id = ${projectId}`;
      await sql`DELETE FROM finding_verification_rounds WHERE finding_id IN (SELECT id FROM findings WHERE project_id = ${projectId})`;
      await sql`DELETE FROM findings WHERE project_id = ${projectId}`;
      await sql`DELETE FROM event_dedup WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ${projectId})`;
      await sql`DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ${projectId})`;
      await sql`UPDATE jobs SET parent_job_id = NULL WHERE project_id = ${projectId}`;
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE id = ${canvasId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await sql.end({ timeout: 5 });
    }
  });
}
