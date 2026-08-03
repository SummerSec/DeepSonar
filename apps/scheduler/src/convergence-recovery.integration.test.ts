import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("convergence recovery integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("boot normalization repairs legacy rounds/priorities and serializes Hub candidates", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("./db.js");
    const {
      FIXED_PRIORITY,
      createJob,
      fixedPriorityForJob,
      maybeTriggerHub,
      normalizePendingJobPriorities,
    } = await import("./core.js");
    const { claimPendingJobs } = await import("./dispatcher.js");
    const { normalizePendingVerificationRounds } = await import("./verify.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `convergence-recovery-${randomUUID()}`;
    const secondProjectId = randomUUID();
    const secondCanvasId = `convergence-recovery-${randomUUID()}`;
    const snapshot = {
      agent_cli: "claude-code",
      credential_id: null,
      credential_provider: null,
      model: null,
    };
    const jobIds: string[] = [];
    const findingIds: string[] = [];
    const originalRules = (await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`)[0]?.rules_json ?? {};

    const insertJob = async (input: {
      id?: string;
      projectId?: string;
      canvasId?: string;
      type: string;
      status?: string;
      priority?: number;
      payload?: Record<string, unknown>;
      findingId?: string | null;
      createdAt?: Date;
    }): Promise<string> => {
      const id = input.id ?? randomUUID();
      await sql`
        INSERT INTO jobs (
          id, project_id, canvas_id, type, status, priority, payload_json,
          agent_snapshot_json, finding_id, created_at
        ) VALUES (
          ${id}, ${input.projectId ?? projectId}, ${input.canvasId ?? canvasId}, ${input.type},
          ${input.status ?? "pending"}, ${input.priority ?? 0}, ${sql.json((input.payload ?? {}) as never)},
          ${sql.json(snapshot)}, ${input.findingId ?? null}, ${input.createdAt ?? new Date()}
        )`;
      jobIds.push(id);
      return id;
    };

    try {
      await sql`
        INSERT INTO projects (id, canvas_id, name, config_json)
        VALUES (${projectId}, ${canvasId}, ${`convergence-recovery-${projectId}`}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'Convergence recovery', ${sql.json({})})`;
      await sql`
        INSERT INTO projects (id, canvas_id, name, config_json)
        VALUES (${secondProjectId}, ${secondCanvasId}, ${`convergence-recovery-${secondProjectId}`}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${secondCanvasId}, ${secondProjectId}, 'Convergence recovery concurrent', ${sql.json({})})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({})}),
               (${secondCanvasId}, 'root', 'root', 'active', ${sql.json({})})`;

      const publicPurposeAttempt = await createJob({
        projectId,
        canvasId,
        type: "audit_module",
        payload: { scheduling_purpose: "convergence_evidence", caller: "public-test" },
      });
      assert.ok(publicPurposeAttempt.job);
      jobIds.push(publicPurposeAttempt.job.id as string);
      assert.equal(publicPurposeAttempt.job.priority, FIXED_PRIORITY.role);
      assert.equal(
        (publicPurposeAttempt.job.payload_json as Record<string, unknown>).scheduling_purpose,
        "discovery",
      );
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${publicPurposeAttempt.job.id as string}`;

      const originJobId = await insertJob({
        type: "audit_module",
        projectId,
        canvasId,
        status: "succeeded",
        priority: FIXED_PRIORITY.role,
      });
      const [findingNode] = await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'finding', 'legacy finding', 'pending', ${sql.json({})})
        RETURNING id`;
      const findingId = randomUUID();
      findingIds.push(findingId);
      await sql`
        INSERT INTO findings (id, project_id, job_id, node_id, fingerprint, title, severity, summary)
        VALUES (${findingId}, ${projectId}, ${originJobId}, ${findingNode.id as string},
          ${`legacy-${findingId}`}, 'legacy finding', 'critical', 'legacy priority fixture')`;

      const oldHubId = await insertJob({
        type: "hub_reason",
        projectId,
        canvasId,
        priority: 1,
        payload: { legacy: true },
        createdAt: new Date(Date.now() - 2_000),
      });
      const newHubId = await insertJob({
        type: "hub_reason",
        projectId,
        canvasId,
        priority: 999,
        payload: { legacy: true },
        createdAt: new Date(Date.now() - 1_000),
      });
      const roleId = await insertJob({
        type: "review",
        projectId,
        canvasId,
        priority: 999,
        payload: { legacy: true },
      });
      const verifyId = await insertJob({
        type: "verify_finding",
        projectId,
        canvasId,
        findingId,
        priority: 999,
        payload: { legacy: true },
      });
      const reportId = await insertJob({
        type: "report",
        projectId,
        canvasId,
        priority: 999,
        payload: { legacy: true },
      });
      await sql`
        INSERT INTO finding_verification_rounds (
          finding_id, attempt, verify_job_id, status, requirements_json, evidence_snapshot_json
        ) VALUES (
          ${findingId}, 1, ${verifyId}, 'pending',
          ${sql.json({ eligibility: "eligible" })}, ${sql.json({})}
        )`;

      const normalized = await normalizePendingJobPriorities(sql);
      assert.ok(normalized.updated >= 5);
      const normalizedRows = await sql`
        SELECT id, type, priority, payload_json FROM jobs
        WHERE id = ANY(${[oldHubId, newHubId, roleId, verifyId, reportId]}::uuid[])
        ORDER BY created_at, id`;
      const byId = new Map(normalizedRows.map((row) => [String(row.id), row]));
      assert.equal(byId.get(oldHubId)?.priority, FIXED_PRIORITY.hub);
      assert.equal(byId.get(newHubId)?.priority, FIXED_PRIORITY.hub);
      assert.equal(byId.get(roleId)?.priority, FIXED_PRIORITY.role);
      assert.equal(byId.get(verifyId)?.priority, FIXED_PRIORITY.verifyCritical);
      assert.equal(byId.get(reportId)?.priority, FIXED_PRIORITY.report);
      assert.equal((byId.get(roleId)?.payload_json as Record<string, unknown>).scheduling_purpose, "discovery");
      assert.equal((byId.get(verifyId)?.payload_json as Record<string, unknown>).scheduling_purpose, "verify");

      await sql`
        UPDATE global_settings
        SET rules_json = ${sql.json({
          maxGlobalJobs: 4,
          maxJobsPerProject: 4,
          maxConcurrentByAgentCli: { "claude-code": 4 },
        })}, updated_at = now()
        WHERE id = 'global'`;
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ANY(${[roleId, verifyId, reportId]}::uuid[])`;
      const firstClaim = await claimPendingJobs();
      assert.deepEqual(firstClaim.map((job) => job.id), [oldHubId]);
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${oldHubId}`;
      const secondClaim = await claimPendingJobs();
      assert.deepEqual(secondClaim.map((job) => job.id), [newHubId]);
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${newHubId}`;

      const concurrentOrigin = await insertJob({
        projectId: secondProjectId,
        canvasId: secondCanvasId,
        type: "audit_module",
        status: "succeeded",
        priority: FIXED_PRIORITY.role,
      });
      const trigger = () =>
        sql.begin(async (tx) =>
          maybeTriggerHub(tx as unknown as typeof sql, {
            id: concurrentOrigin,
            project_id: secondProjectId,
            canvas_id: secondCanvasId,
            type: "audit_module",
          }),
        );
      await Promise.all([trigger(), trigger()]);
      const [{ hubCount }] = await sql`
        SELECT COUNT(*)::int AS "hubCount" FROM jobs
        WHERE canvas_id = ${secondCanvasId} AND type = 'hub_reason'`;
      assert.equal(Number(hubCount), 1);
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE canvas_id = ${secondCanvasId} AND type = 'hub_reason'`;

      // Reports use the same deterministic system-candidate rule: pending
      // reports never block one another, and only the oldest may claim.
      await sql`UPDATE canvas_nodes SET status = 'analysis_complete' WHERE canvas_id = ${canvasId} AND node_type = 'root'`;
      const oldReportId = await insertJob({
        type: "report",
        projectId,
        canvasId,
        priority: 1,
        payload: { legacy: true },
        createdAt: new Date(Date.now() - 2_000),
      });
      const newReportId = await insertJob({
        type: "report",
        projectId,
        canvasId,
        priority: 999,
        payload: { legacy: true },
        createdAt: new Date(Date.now() - 1_000),
      });
      await normalizePendingJobPriorities(sql);
      const reportClaim = await claimPendingJobs();
      assert.deepEqual(reportClaim.map((job) => job.id), [oldReportId]);
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${newReportId}`;

      // Legacy NULL-job rounds are classified once from current evidence. A
      // second boot sees the same waiting round/active Verify and creates no
      // duplicate attempt or Job.
      const waitingFindingId = randomUUID();
      findingIds.push(waitingFindingId);
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, summary)
        VALUES (${waitingFindingId}, ${projectId}, ${originJobId}, ${`waiting-${waitingFindingId}`},
          'waiting legacy finding', 'high', 'waiting fixture')`;
      await sql`
        INSERT INTO finding_verification_rounds (finding_id, attempt, status, requirements_json)
        VALUES (${waitingFindingId}, 1, 'pending', ${sql.json({})})`;
      const firstRoundRepair = await normalizePendingVerificationRounds(sql);
      assert.ok(firstRoundRepair.missingJobReclassified >= 1);
      const [waitingRound] = await sql`
        SELECT verify_job_id, requirements_json FROM finding_verification_rounds WHERE finding_id = ${waitingFindingId}`;
      assert.equal(waitingRound.verify_job_id, null);
      assert.equal((waitingRound.requirements_json as Record<string, unknown>).eligibility, "waiting_evidence");
      const jobsBeforeSecondRoundRepair = Number((await sql`
        SELECT COUNT(*)::int AS count FROM jobs WHERE finding_id = ${waitingFindingId}`)[0].count);
      await normalizePendingVerificationRounds(sql);
      const jobsAfterSecondRoundRepair = Number((await sql`
        SELECT COUNT(*)::int AS count FROM jobs WHERE finding_id = ${waitingFindingId}`)[0].count);
      assert.equal(jobsAfterSecondRoundRepair, jobsBeforeSecondRoundRepair);

      // A legacy round may point at a terminal Verify after a crash between
      // Job finalization and round close. Reuse the existing failure recovery
      // path; it must not create a second Verify attempt for this Finding.
      const staleFindingId = randomUUID();
      findingIds.push(staleFindingId);
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, summary)
        VALUES (${staleFindingId}, ${projectId}, ${originJobId}, ${`stale-${staleFindingId}`},
          'stale terminal finding', 'high', 'stale terminal fixture')`;
      const staleVerifyId = await insertJob({
        type: "verify_finding",
        projectId,
        canvasId,
        findingId: staleFindingId,
        status: "failed",
        priority: FIXED_PRIORITY.verifyHigh,
        payload: { scheduling_purpose: "verify", verification_eligibility: "eligible" },
      });
      await sql`
        INSERT INTO finding_verification_rounds (
          finding_id, attempt, verify_job_id, status, requirements_json, evidence_snapshot_json
        ) VALUES (
          ${staleFindingId}, 1, ${staleVerifyId}, 'pending',
          ${sql.json({ eligibility: "eligible" })}, ${sql.json({})}
        )`;
      await normalizePendingVerificationRounds(sql);
      const [repairedStaleRound] = await sql`
        SELECT status, final_outcome FROM finding_verification_rounds WHERE finding_id = ${staleFindingId}`;
      assert.equal(repairedStaleRound.status, "failed");
      assert.equal(repairedStaleRound.final_outcome, "rework");
      const staleVerifyCount = Number((await sql`
        SELECT COUNT(*)::int AS count FROM jobs WHERE finding_id = ${staleFindingId}`)[0].count);
      assert.equal(staleVerifyCount, 1);
    } finally {
      await sql`UPDATE global_settings SET rules_json = ${sql.json(originalRules as never)}, updated_at = now() WHERE id = 'global'`;
      await sql`DELETE FROM finding_verification_rounds WHERE finding_id = ANY(${findingIds}::uuid[])`;
      await sql`DELETE FROM findings WHERE id = ANY(${findingIds}::uuid[])`;
      await sql`DELETE FROM canvas_edges WHERE canvas_id = ANY(${[canvasId, secondCanvasId]})`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id = ANY(${[canvasId, secondCanvasId]})`;
      await sql`UPDATE jobs SET parent_job_id = NULL WHERE canvas_id = ANY(${[canvasId, secondCanvasId]})`;
      await sql`DELETE FROM jobs WHERE canvas_id = ANY(${[canvasId, secondCanvasId]})`;
      await sql`DELETE FROM canvases WHERE id = ANY(${[canvasId, secondCanvasId]})`;
      await sql`DELETE FROM projects WHERE id = ANY(${[projectId, secondProjectId]}::uuid[])`;
      await sql.end({ timeout: 5 });
    }
  });
}
