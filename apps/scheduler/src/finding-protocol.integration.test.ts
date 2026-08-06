import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Finding protocol PostgreSQL integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("task policy freezes and Finding ingestion rejects, recomputes, and preserves future CVSS", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("./db.js");
    const { ensureCanvasForTask, ingestEvent } = await import("./core.js");
    const { ControlInputError } = await import("./control-input.js");
    await migrate();

    const projectId = randomUUID();
    const [originalGlobal] = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    let canvasId: string | null = null;
    const auditJobId = randomUUID();
    try {
      await sql`
        UPDATE global_settings
        SET rules_json = rules_json || ${sql.json({
          finding_protocol: {
            mode: "agent_choice",
            default_profile: "general",
            allowed_profiles: ["general", "security.vulnerability"],
            display_name: "global-general",
          },
        })}, updated_at = now()
        WHERE id = 'global'`;
      await sql`
        INSERT INTO projects (id, canvas_id, name, config_json)
        VALUES (${projectId}, ${`finding-protocol-${projectId}`}, 'finding-protocol', ${sql.json({
          rules: { hubEnabled: false },
          finding_protocol: {
            mode: "fixed",
            default_profile: "quality.bug",
            allowed_profiles: ["quality.bug"],
            display_name: "project-quality",
          },
        })})`;

      canvasId = await ensureCanvasForTask({
        projectId,
        title: "frozen protocol",
        target: {
          goal: "prove finding protocol",
          finding_protocol: {
            mode: "fixed",
            default_profile: "security.vulnerability",
            allowed_profiles: ["security.vulnerability"],
            display_name: "task-security",
            scoring: {
              accepted_versions: ["4.0", "3.1", "5.0"],
              require_scoring_for_profiles: ["security.vulnerability"],
            },
          },
        },
      });
      const [canvas] = await sql`SELECT target_json FROM canvases WHERE id = ${canvasId}`;
      const effective = ((canvas.target_json as Record<string, unknown>).effective_finding_protocol ?? {}) as Record<string, unknown>;
      assert.equal(effective.source, "task");
      assert.equal(effective.default_profile, "security.vulnerability");
      assert.equal(effective.display_name, "task-security");

      await sql`
        UPDATE projects SET config_json = config_json || ${sql.json({
          finding_protocol: {
            mode: "fixed",
            default_profile: "general",
            allowed_profiles: ["general"],
            display_name: "changed-after-creation",
          },
        })}
        WHERE id = ${projectId}`;
      const [afterConfigChange] = await sql`SELECT target_json FROM canvases WHERE id = ${canvasId}`;
      assert.deepEqual(
        (afterConfigChange.target_json as Record<string, unknown>).effective_finding_protocol,
        effective,
      );

      const auditSnapshot = {
        name: "audit",
        role_kind: "role",
        platform_tools: ["emit_progress", "emit_finding", "mark_job_done"],
      };
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES (${auditJobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json(auditSnapshot)}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${canvasId}, ${auditJobId}, 'intent', 'audit', 'running', ${sql.json({})})`;

      const rejectedEventId = randomUUID();
      await assert.rejects(
        ingestEvent(auditJobId, {
          v: 1,
          event_id: rejectedEventId,
          type: "finding",
          payload: { title: "wrong profile", profile: "quality.bug" },
        }),
        (error: unknown) => {
          assert.ok(error instanceof ControlInputError);
          assert.equal(error.code, "invalid_payload");
          assert.match(error.message, /冻结协议|fixed to security\.vulnerability/);
          return true;
        },
      );
      const [rejectedCounts] = await sql<{ events: number; findings: number }[]>`
        SELECT
          (SELECT COUNT(*)::int FROM events WHERE event_id = ${rejectedEventId}) AS events,
          (SELECT COUNT(*)::int FROM findings WHERE job_id = ${auditJobId}) AS findings`;
      assert.deepEqual(rejectedCounts, { events: 0, findings: 0 });

      await ingestEvent(auditJobId, {
        v: 1,
        event_id: randomUUID(),
        type: "finding",
        payload: {
          title: "recomputed score",
          profile: "security.vulnerability",
          category: "security.vuln",
          severity: "low",
          scoring: {
            standard: "CVSS",
            version: "4.0",
            vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H",
            base_score: 0.1,
          },
        },
      });
      const [supported] = await sql`
        SELECT profile, category, severity, scoring_json FROM findings
        WHERE job_id = ${auditJobId} AND title = 'recomputed score'`;
      assert.equal(supported.profile, "security.vulnerability");
      assert.equal(supported.category, "security.vuln");
      assert.equal(supported.severity, "critical");
      assert.equal((supported.scoring_json as Record<string, unknown>).base_score, 10);
      assert.equal((supported.scoring_json as Record<string, unknown>).reported_base_score, 0.1);
      assert.equal((supported.scoring_json as Record<string, unknown>).source, "system_recomputed");

      await ingestEvent(auditJobId, {
        v: 1,
        event_id: randomUUID(),
        type: "finding",
        payload: {
          title: "future score",
          severity: "medium",
          scoring: {
            standard: "CVSS",
            version: "5.0",
            vector: "CVSS:5.0/AV:N/FUTURE:X",
            metrics: { FUTURE: "X" },
            base_score: 10,
          },
        },
      });
      const [future] = await sql`
        SELECT severity, scoring_json FROM findings
        WHERE job_id = ${auditJobId} AND title = 'future score'`;
      assert.equal(future.severity, "medium");
      assert.equal((future.scoring_json as Record<string, unknown>).status, "unsupported_version");
      assert.equal((future.scoring_json as Record<string, unknown>).base_score, null);
      assert.equal((future.scoring_json as Record<string, unknown>).reported_base_score, 10);
    } finally {
      await sql`UPDATE global_settings SET rules_json = ${sql.json((originalGlobal?.rules_json ?? {}) as never)}, updated_at = now() WHERE id = 'global'`;
      if (canvasId) {
        await sql`DELETE FROM canvas_edges WHERE canvas_id = ${canvasId}`;
        await sql`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
        await sql`DELETE FROM task_reports WHERE canvas_id = ${canvasId}`;
      }
      await sql`DELETE FROM finding_verification_rounds WHERE finding_id IN (SELECT id FROM findings WHERE project_id = ${projectId})`;
      await sql`DELETE FROM findings WHERE project_id = ${projectId}`;
      await sql`DELETE FROM event_dedup WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ${projectId})`;
      await sql`DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ${projectId})`;
      await sql`UPDATE jobs SET parent_job_id = NULL WHERE project_id = ${projectId}`;
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE project_id = ${projectId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await sql.end({ timeout: 5 });
    }
  });
}
