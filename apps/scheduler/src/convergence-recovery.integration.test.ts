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
      DISPATCH_CLAIM_ADVISORY_KEY,
      advanceCanvasAfterTerminalJob,
      createJob,
      finalizeJob,
      fixedPriorityForJob,
      maybeTriggerHub,
      normalizePendingJobPriority,
      normalizePendingJobPriorities,
    } = await import("./core.js");
    const { claimPendingJobs } = await import("./dispatcher.js");
    const { maybeDispatchReport } = await import("./report.js");
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
      parentJobId?: string | null;
      createdAt?: Date;
    }): Promise<string> => {
      const id = input.id ?? randomUUID();
      await sql`
        INSERT INTO jobs (
          id, project_id, canvas_id, type, status, priority, payload_json,
          agent_snapshot_json, finding_id, parent_job_id, created_at
        ) VALUES (
          ${id}, ${input.projectId ?? projectId}, ${input.canvasId ?? canvasId}, ${input.type},
          ${input.status ?? "pending"}, ${input.priority ?? 0}, ${sql.json((input.payload ?? {}) as never)},
          ${sql.json(snapshot)}, ${input.findingId ?? null}, ${input.parentJobId ?? null}, ${input.createdAt ?? new Date()}
        )`;
      jobIds.push(id);
      return id;
    };

    try {
      await sql`
        INSERT INTO projects (id, name, config_json)
        VALUES (${projectId}, ${`convergence-recovery-${projectId}`}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'Convergence recovery', ${sql.json({ network_policy: { allow_egress: false } })})`;
      await sql`
        INSERT INTO projects (id, name, config_json)
        VALUES (${secondProjectId}, ${`convergence-recovery-${secondProjectId}`}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${secondCanvasId}, ${secondProjectId}, 'Convergence recovery concurrent', ${sql.json({ network_policy: { allow_egress: false } })})`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({})}),
               (${secondCanvasId}, 'root', 'root', 'active', ${sql.json({})})`;

      const publicPurposeAttempt = await createJob({
        projectId,
        canvasId,
        type: "audit_module",
        payload: {
          scheduling_purpose: "convergence_evidence",
          verification_followup: {
            finding_id: "public-spoof",
            required_evidence: ["review"],
            scheduler_owned: true,
            manual_override: true,
          },
          caller: "public-test",
        },
      });
      assert.ok(publicPurposeAttempt.job);
      jobIds.push(publicPurposeAttempt.job.id as string);
      assert.equal(publicPurposeAttempt.job.priority, FIXED_PRIORITY.role);
      assert.equal(
        (publicPurposeAttempt.job.payload_json as Record<string, unknown>).scheduling_purpose,
        "discovery",
      );
      assert.equal(
        ((publicPurposeAttempt.job.payload_json as Record<string, unknown>).verification_followup as Record<string, unknown>)
          ?.scheduler_owned,
        undefined,
      );
      assert.equal(
        ((publicPurposeAttempt.job.payload_json as Record<string, unknown>).verification_followup as Record<string, unknown>)
          ?.manual_override,
        undefined,
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
        payload: { legacy: true, scheduling_purpose: "convergence_evidence" },
      });
      const internalFollowupId = await insertJob({
        type: "review",
        projectId,
        canvasId,
        parentJobId: oldHubId,
        priority: 999,
        payload: {
          scheduling_purpose: "convergence_evidence",
          verification_followup: { finding_id: findingId, required_evidence: ["review"], scheduler_owned: true },
        },
      });
      const verifyId = await insertJob({
        type: "verify_finding",
        projectId,
        canvasId,
        findingId,
        priority: 999,
        payload: { legacy: true, scheduling_purpose: "convergence_evidence" },
      });
      const reportId = await insertJob({
        type: "report",
        projectId,
        canvasId,
        priority: 999,
        payload: { legacy: true, scheduling_purpose: "convergence_evidence" },
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
        WHERE id = ANY(${[oldHubId, newHubId, roleId, internalFollowupId, verifyId, reportId]}::uuid[])
        ORDER BY created_at, id`;
      const byId = new Map(normalizedRows.map((row) => [String(row.id), row]));
      assert.equal(byId.get(oldHubId)?.priority, FIXED_PRIORITY.hub);
      assert.equal(byId.get(newHubId)?.priority, FIXED_PRIORITY.hub);
      assert.equal(byId.get(roleId)?.priority, FIXED_PRIORITY.role);
      assert.equal(byId.get(internalFollowupId)?.priority, FIXED_PRIORITY.convergenceEvidence);
      assert.equal(byId.get(verifyId)?.priority, FIXED_PRIORITY.verifyCritical);
      assert.equal(byId.get(reportId)?.priority, FIXED_PRIORITY.report);
      assert.equal((byId.get(roleId)?.payload_json as Record<string, unknown>).scheduling_purpose, "discovery");
      assert.equal(
        (byId.get(internalFollowupId)?.payload_json as Record<string, unknown>).scheduling_purpose,
        "convergence_evidence",
      );
      assert.equal((byId.get(verifyId)?.payload_json as Record<string, unknown>).scheduling_purpose, "verify");

      // Resume normalization must apply the same scheduler-owned rule as
      // boot repair; a historical public lane cannot regain 220 on resume.
      const resumeLegacyId = await insertJob({
        type: "audit_module",
        projectId,
        canvasId,
        priority: 999,
        payload: { scheduling_purpose: "convergence_evidence", legacy: true },
      });
      assert.equal(await normalizePendingJobPriority(resumeLegacyId, sql), true);
      const [resumedLegacy] = await sql`
        SELECT priority, payload_json FROM jobs WHERE id = ${resumeLegacyId}`;
      assert.equal(resumedLegacy.priority, FIXED_PRIORITY.role);
      assert.equal((resumedLegacy.payload_json as Record<string, unknown>).scheduling_purpose, "discovery");

      await sql`
        UPDATE global_settings
        SET rules_json = ${sql.json({
          maxGlobalJobs: 4,
          maxJobsPerProject: 4,
          maxConcurrentByAgentCli: { "claude-code": 4 },
        })}, updated_at = now()
        WHERE id = 'global'`;
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ANY(${[roleId, internalFollowupId, verifyId, reportId, resumeLegacyId]}::uuid[])`;
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

      // A failed Hub must stop at the canvas boundary.  The terminal path is
      // the same one used by dispatcher/reaper/reconcile when provisioning a
      // frozen runtime image fails; it must not replace the failed Job with a
      // new canvas_idle Hub on every recovery pass.
      const failedHubId = await insertJob({
        projectId: secondProjectId,
        canvasId: secondCanvasId,
        type: "hub_reason",
        status: "running",
        priority: FIXED_PRIORITY.hub,
        payload: {
          scheduling_purpose: "hub",
          trigger: { kind: "canvas_idle", after_job_type: "hub_reason", after_job_status: "failed" },
        },
      });
      const [{ hubCountBeforeFailure }] = await sql`
        SELECT COUNT(*)::int AS "hubCountBeforeFailure" FROM jobs
        WHERE canvas_id = ${secondCanvasId} AND type = 'hub_reason'`;
      const finalizedFailedHub = await sql.begin(async (tx) =>
        finalizeJob(tx as unknown as typeof sql, failedHubId, "failed", { error: "frozen image missing" }),
      );
      assert.equal(finalizedFailedHub, true);
      const [{ hubCountAfterFailure }] = await sql`
        SELECT COUNT(*)::int AS "hubCountAfterFailure" FROM jobs
        WHERE canvas_id = ${secondCanvasId} AND type = 'hub_reason'`;
      assert.equal(Number(hubCountAfterFailure), Number(hubCountBeforeFailure));
      const [{ pendingHubCountAfterFailure }] = await sql`
        SELECT COUNT(*)::int AS "pendingHubCountAfterFailure" FROM jobs
        WHERE canvas_id = ${secondCanvasId} AND type = 'hub_reason'
          AND status IN ('pending', 'claimed', 'provisioning', 'running')`;
      assert.equal(Number(pendingHubCountAfterFailure), 0);
      const [failedHub] = await sql`SELECT status FROM jobs WHERE id = ${failedHubId}`;
      assert.equal(failedHub.status, "failed");

      // Hard retry is a destructive management operation.  It takes the same
      // dispatcher-claim advisory lock before the canvas row, so a concurrent
      // claim cannot pass the active check and race the wipe. This transaction
      // probe models the route's lock/recheck/insert sequence without writing
      // an audit row (audit_logs is intentionally append-only in test DBs).
      const retryProbe = () =>
        sql.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
          const [lockedCanvas] = await tx`SELECT id FROM canvases WHERE id = ${secondCanvasId} FOR UPDATE`;
          assert.ok(lockedCanvas);
          const activeInside = await tx`
            SELECT 1 FROM jobs WHERE canvas_id = ${secondCanvasId}
              AND status IN ('pending','claimed','provisioning','running','waiting_human') LIMIT 1`;
          if (activeInside.length > 0) return "active" as const;
          await tx`
            INSERT INTO jobs (
              project_id, canvas_id, type, status, priority, payload_json, agent_snapshot_json
            ) VALUES (
              ${secondProjectId}, ${secondCanvasId}, 'hub_reason', 'pending', ${FIXED_PRIORITY.hub},
              ${sql.json({ scheduling_purpose: "hub", trigger: { kind: "retry_probe" } })}, ${sql.json(snapshot)}
            )`;
          await tx`SELECT pg_sleep(0.05)`;
          return "reset" as const;
        });
      const retryProbeResults = await Promise.all([retryProbe(), retryProbe()]);
      assert.deepEqual([...retryProbeResults].sort(), ["active", "reset"]);
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE canvas_id = ${secondCanvasId} AND type = 'hub_reason'`;
      await insertJob({
        projectId: secondProjectId,
        canvasId: secondCanvasId,
        type: "audit_module",
        status: "succeeded",
        priority: FIXED_PRIORITY.role,
      });

      // Verify finalization and the generic terminal-advance recovery path
      // can touch the same waiting-round graph concurrently. Both enter via
      // the canvas-first helper; a short lock timeout makes any 40P01 visible
      // instead of allowing a long integration hang.
      const deadlockOriginId = await insertJob({
        projectId: secondProjectId,
        canvasId: secondCanvasId,
        type: "audit_module",
        status: "succeeded",
        priority: FIXED_PRIORITY.role,
      });
      const deadlockFindingId = randomUUID();
      findingIds.push(deadlockFindingId);
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, summary, verify_status)
        VALUES (${deadlockFindingId}, ${secondProjectId}, ${deadlockOriginId}, ${`deadlock-${deadlockFindingId}`},
          'deadlock fixture', 'high', 'lock-order fixture', 'verifying')`;
      const deadlockVerifyId = await insertJob({
        projectId: secondProjectId,
        canvasId: secondCanvasId,
        type: "verify_finding",
        status: "running",
        findingId: deadlockFindingId,
        priority: FIXED_PRIORITY.verifyHigh,
        payload: { scheduling_purpose: "verify", verification_eligibility: "eligible" },
      });
      await sql`
        INSERT INTO finding_verification_rounds (
          finding_id, attempt, verify_job_id, status, requirements_json, evidence_snapshot_json
        ) VALUES (
          ${deadlockFindingId}, 1, ${deadlockVerifyId}, 'pending',
          ${sql.json({ eligibility: "eligible" })}, ${sql.json({})}
        )`;
      await Promise.all([
        sql.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '2s'`;
          await finalizeJob(tx as unknown as typeof sql, deadlockVerifyId, "failed", { error: "deadlock-fixture" });
        }),
        sql.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '2s'`;
          await advanceCanvasAfterTerminalJob(
            tx as unknown as typeof sql,
            { id: deadlockOriginId, project_id: secondProjectId, canvas_id: secondCanvasId, type: "audit_module" },
            "failed",
          );
        }),
      ]);

      // Canonical report ingress is serialized by canvas -> task_reports. Two
      // concurrent terminal callers must produce one ingress-key Job without
      // surfacing a unique-violation rollback from the losing transaction.
      await sql`UPDATE finding_verification_rounds
        SET status = 'needs_human', final_outcome = 'needs_human', finished_at = now()
        WHERE finding_id = ${deadlockFindingId}`;
      await sql`UPDATE findings SET verify_status = 'needs_human' WHERE id = ${deadlockFindingId}`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${secondCanvasId}, 'human', 'deadlock fixture blocker', 'open',
          ${sql.json({ finding_id: deadlockFindingId, kind: 'verification_blocker' })})`;
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE canvas_id = ${secondCanvasId} AND type = 'hub_reason'`;
      await sql`UPDATE canvas_nodes SET status = 'analysis_complete' WHERE canvas_id = ${secondCanvasId} AND node_type = 'root'`;
      const reportDispatches = await Promise.all([
        sql.begin((tx) => maybeDispatchReport(tx as unknown as typeof sql, secondCanvasId)),
        sql.begin((tx) => maybeDispatchReport(tx as unknown as typeof sql, secondCanvasId)),
      ]);
      assert.equal(reportDispatches.filter((result) => result.dispatched).length, 1);
      const [{ reportCount }] = await sql`
        SELECT COUNT(*)::int AS "reportCount" FROM jobs
        WHERE canvas_id = ${secondCanvasId} AND type = 'report' AND ingress_key = ${`report:${secondCanvasId}`}`;
      const [{ taskReportCount }] = await sql`
        SELECT COUNT(*)::int AS "taskReportCount" FROM task_reports WHERE canvas_id = ${secondCanvasId}`;
      assert.equal(Number(reportCount), 1);
      assert.equal(Number(taskReportCount), 1);
      await sql`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE canvas_id = ${secondCanvasId} AND type = 'report'`;

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
      await sql`DELETE FROM task_reports WHERE canvas_id = ANY(${[canvasId, secondCanvasId]})`;
      await sql`UPDATE jobs SET parent_job_id = NULL WHERE canvas_id = ANY(${[canvasId, secondCanvasId]})`;
      await sql`DELETE FROM jobs WHERE canvas_id = ANY(${[canvasId, secondCanvasId]})`;
      await sql`DELETE FROM canvases WHERE id = ANY(${[canvasId, secondCanvasId]})`;
      await sql`DELETE FROM projects WHERE id = ANY(${[projectId, secondProjectId]}::uuid[])`;
      await sql.end({ timeout: 5 });
    }
  });
}
