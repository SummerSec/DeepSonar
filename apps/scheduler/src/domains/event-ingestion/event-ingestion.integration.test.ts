import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("event-ingestion integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("event append, duplicate replay, concurrent sequencing, rollback, and finalize lock order", async () => {
    // Install the explicit URL before importing db/core so a developer .env
    // cannot redirect this integration run to an existing database.
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("../../db.js");
    const { createEventIngestionApplication } = await import("./application.js");
    const { finalizeJob, ingestEvent } = await import("../../core.js");
    const { ControlInputError } = await import("../../control-input.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `event-ingestion-${randomUUID()}`;
    const movedCanvasId = `event-ingestion-moved-${randomUUID()}`;
    const jobId = randomUUID();
    const legacyJobId = randomUUID();
    const repointJobId = randomUUID();
    const factRepointJobId = randomUUID();
    const verificationJobId = randomUUID();
    const terminalVerifyJobId = randomUUID();
    const verificationFindingId = randomUUID();
    const multiCanvasJobId = randomUUID();
    const conflictingCanvasJobId = randomUUID();
    const reportOnlyJobId = randomUUID();
    const reportConflictJobId = randomUUID();
    const foreignProjectId = randomUUID();
    const foreignCanvasId = `event-ingestion-foreign-${randomUUID()}`;
    const foreignOriginJobId = randomUUID();
    const foreignFindingId = randomUUID();
    const fixture = {
      jobId,
      projectId,
      canvasId,
      eventIds: [] as string[],
    };

    await sql`
      INSERT INTO projects (id, canvas_id, name, config_json)
      VALUES (${projectId}, ${canvasId}, 'event-ingestion', ${sql.json({ rules: { hubEnabled: false } })})`;
    await sql`
      INSERT INTO projects (id, canvas_id, name, config_json)
      VALUES (${foreignProjectId}, ${foreignCanvasId}, 'event-ingestion-foreign', ${sql.json({ rules: { hubEnabled: false } })})`;
    await sql`
      INSERT INTO canvases (id, project_id, title, target_json)
      VALUES (${canvasId}, ${projectId}, 'event-ingestion', ${sql.json({})})`;
    await sql`
      INSERT INTO canvases (id, project_id, title, target_json)
      VALUES (${movedCanvasId}, ${projectId}, 'event-ingestion-moved', ${sql.json({})})`;
    await sql`
      INSERT INTO canvases (id, project_id, title, target_json)
      VALUES (${foreignCanvasId}, ${foreignProjectId}, 'event-ingestion-foreign', ${sql.json({})})`;
    await sql`
      INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
      VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({})})`;
    const [foreignFindingNode] = await sql<{ id: string }[]>`
      INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
      VALUES (${foreignCanvasId}, 'finding', 'foreign finding', 'open', ${sql.json({ severity: 'high' })})
      RETURNING id`;
    await sql`
      INSERT INTO jobs (
        id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
      ) VALUES (
        ${foreignOriginJobId}, ${foreignProjectId}, ${foreignCanvasId}, 'audit_module', 'succeeded',
        ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
      )`;
    await sql`
      INSERT INTO findings (
        id, project_id, job_id, node_id, fingerprint, title, severity, summary, raw_json
      ) VALUES (
        ${foreignFindingId}, ${foreignProjectId}, ${foreignOriginJobId}, ${foreignFindingNode.id},
        ${`foreign-${foreignFindingId}`}, 'foreign finding', 'high', 'foreign project evidence target', ${sql.json({})}
      )`;
    await sql`
      INSERT INTO jobs (
        id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
      ) VALUES (
        ${jobId}, ${projectId}, ${canvasId}, 'audit_module', 'running',
        ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
      )`;
    await sql`
      INSERT INTO jobs (
        id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
      ) VALUES (
        ${legacyJobId}, ${projectId}, NULL, 'audit_module', 'running',
        ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
      )`;
    await sql`
      INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
      VALUES (${canvasId}, ${legacyJobId}, 'job', 'legacy job', 'running', ${sql.json({})})`;
    await sql`
      INSERT INTO jobs (
        id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
      ) VALUES (
        ${repointJobId}, ${projectId}, NULL, 'audit_module', 'running',
        ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
      )`;
    const [repointNode] = await sql<{ id: string }[]>`
      INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
      VALUES (${canvasId}, ${repointJobId}, 'job', 'repoint job', 'running', ${sql.json({})})
      RETURNING id`;
    await sql`
      INSERT INTO jobs (
        id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
      ) VALUES (
        ${factRepointJobId}, ${projectId}, NULL, 'review', 'running',
        ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
      )`;
    const [factRepointNode] = await sql<{ id: string }[]>`
      INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
      VALUES (${canvasId}, ${factRepointJobId}, 'intent', 'fact target', 'running', ${sql.json({})})
      RETURNING id`;
    const [verificationFindingNode] = await sql<{ id: string }[]>`
      INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
      VALUES (${canvasId}, 'finding', 'verification finding', 'open', ${sql.json({ severity: 'high' })})
      RETURNING id`;
    await sql`
      INSERT INTO findings (
        id, project_id, job_id, node_id, fingerprint, title, severity, summary, raw_json
      ) VALUES (
        ${verificationFindingId}, ${projectId}, ${jobId}, ${verificationFindingNode.id},
        ${`verification-${verificationFindingId}`}, 'verification finding', 'high', 'finding under test', ${sql.json({})}
      )`;
    await sql`
      INSERT INTO jobs (
        id, project_id, canvas_id, finding_id, type, status, agent_snapshot_json, payload_json
      ) VALUES (
        ${verificationJobId}, ${projectId}, ${canvasId}, ${verificationFindingId}, 'test', 'running',
        ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })},
        ${sql.json({ verification_followup: { finding_id: verificationFindingId } })}
      )`;
    await sql`
      INSERT INTO jobs (
        id, project_id, canvas_id, finding_id, type, status, agent_snapshot_json, payload_json
      ) VALUES (
        ${terminalVerifyJobId}, ${projectId}, ${canvasId}, ${verificationFindingId}, 'verify_finding', 'running',
        ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
      )`;
    await sql`
      INSERT INTO jobs (
        id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
      ) VALUES (
        ${multiCanvasJobId}, ${projectId}, NULL, 'audit_module', 'running',
        ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
      )`;
    await sql`
      INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
      VALUES
        (${canvasId}, ${multiCanvasJobId}, 'job', 'multi canvas A', 'running', ${sql.json({})}),
        (${movedCanvasId}, ${multiCanvasJobId}, 'intent', 'multi canvas B', 'pending', ${sql.json({})})`;
    await sql`
      INSERT INTO jobs (
        id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
      ) VALUES (
        ${conflictingCanvasJobId}, ${projectId}, ${canvasId}, 'audit_module', 'running',
        ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
      )`;
    await sql`
      INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
      VALUES (${movedCanvasId}, ${conflictingCanvasJobId}, 'job', 'conflicting canvas', 'running', ${sql.json({})})`;
    await sql`
      INSERT INTO jobs (
        id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
      ) VALUES (
        ${reportOnlyJobId}, ${projectId}, NULL, 'audit_module', 'running',
        ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
      )`;
    await sql`
      INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
      VALUES (${canvasId}, ${reportOnlyJobId}, 'report', 'legacy report-only node', 'running', ${sql.json({})})`;
    await sql`
      INSERT INTO jobs (
        id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
      ) VALUES (
        ${reportConflictJobId}, ${projectId}, ${canvasId}, 'audit_module', 'running',
        ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
      )`;
    await sql`
      INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
      VALUES (${movedCanvasId}, ${reportConflictJobId}, 'report', 'cross canvas report', 'running', ${sql.json({})})`;

    const marker = (tx: typeof sql, eventId: string) =>
      tx`UPDATE canvas_nodes
          SET body_json = body_json || ${sql.json({ last_event_id: eventId })}, updated_at = now()
          WHERE canvas_id = ${canvasId} AND node_type = 'root'`;

    try {
      let callbackCount = 0;
      const app = createEventIngestionApplication(sql, async (tx, _job, envelope) => {
        callbackCount += 1;
        await tx`UPDATE canvas_nodes
          SET body_json = body_json || ${tx.json({ last_event_id: envelope.event_id })}, updated_at = now()
          WHERE canvas_id = ${canvasId} AND node_type = 'root'`;
      });

      const duplicateId = randomUUID();
      fixture.eventIds.push(duplicateId);
      const first = await app.ingestEvent(jobId, {
        v: 1,
        event_id: duplicateId,
        type: "progress",
        payload: { message: "first" },
      });
      const duplicate = await app.ingestEvent(jobId, {
        v: 1,
        event_id: duplicateId,
        type: "progress",
        payload: { message: "replay must not run" },
      });
      assert.deepEqual(first, { deduped: false, seq: 1 });
      assert.deepEqual(duplicate, { deduped: true });
      assert.equal(callbackCount, 1, "duplicate event must not invoke semantic side effects");

      // Verification binding failures must reject the whole fact event.  The
      // fact node, event row and dedup marker are all inside one transaction;
      // no ordinary fact may survive a failed evidence attachment.
      const invalidVerificationEventId = randomUUID();
      fixture.eventIds.push(invalidVerificationEventId);
      await assert.rejects(
        ingestEvent(factRepointJobId, {
          v: 1,
          event_id: invalidVerificationEventId,
          type: "fact",
          payload: {
            intent_node_id: factRepointNode.id,
            title: "should rollback",
            description: "invalid verification binding",
            verification: {
              finding_id: randomUUID(),
              evidence_kind: "test",
              outcome: "supports",
              subject_revision: "app@test",
            },
          },
        }),
        (error: unknown) => error instanceof Error && /invalid_verification/.test(error.message),
      );
      const [rolledBackFact] = await sql`
        SELECT 1 FROM canvas_nodes WHERE job_id = ${factRepointJobId} AND title = 'should rollback'`;
      const [rolledBackFactEvent] = await sql`SELECT 1 FROM events WHERE event_id = ${invalidVerificationEventId}`;
      const [rolledBackFactDedup] = await sql`SELECT 1 FROM event_dedup WHERE event_id = ${invalidVerificationEventId}`;
      assert.equal(rolledBackFact, undefined);
      assert.equal(rolledBackFactEvent, undefined);
      assert.equal(rolledBackFactDedup, undefined);

      // The current Job, its scheduler-owned follow-up target, and the
      // Finding's project/origin Job must agree.  A foreign-project Finding is
      // rejected before its evidence node can commit.
      const foreignProjectEventId = randomUUID();
      fixture.eventIds.push(foreignProjectEventId);
      await assert.rejects(
        ingestEvent(verificationJobId, {
          v: 1,
          event_id: foreignProjectEventId,
          type: "fact",
          payload: {
            title: "foreign project evidence",
            description: "foreign-project evidence must roll back",
            verification: {
              finding_id: foreignFindingId,
              evidence_kind: "test",
              outcome: "supports",
              subject_revision: "foreign@test",
              steps: ["run"],
              expected: "reject",
              actual: "accepted",
            },
          },
        }),
        (error: unknown) => error instanceof Error && /invalid_verification/.test(error.message),
      );
      const [foreignRollbackFact] = await sql`
        SELECT 1 FROM canvas_nodes WHERE job_id = ${verificationJobId} AND title = 'foreign project evidence'`;
      assert.equal(foreignRollbackFact, undefined);

      // A test Job cannot masquerade as a review evidence producer.
      const wrongKindEventId = randomUUID();
      fixture.eventIds.push(wrongKindEventId);
      await assert.rejects(
        ingestEvent(verificationJobId, {
          v: 1,
          event_id: wrongKindEventId,
          type: "fact",
          payload: {
            title: "wrong evidence kind",
            description: "wrong evidence kind must roll back",
            verification: {
              finding_id: verificationFindingId,
              evidence_kind: "review",
              outcome: "supports",
              subject_revision: "app@test",
            },
          },
        }),
        (error: unknown) => error instanceof Error && /invalid_verification/.test(error.message),
      );
      const [wrongKindRollbackFact] = await sql`
        SELECT 1 FROM canvas_nodes WHERE job_id = ${verificationJobId} AND title = 'wrong evidence kind'`;
      assert.equal(wrongKindRollbackFact, undefined);

      // A correctly bound test Job may attach structured evidence to its new
      // fact node.  The finding edge and verification body must commit with
      // the event, proving the strict host boundary accepts valid input.
      const validVerificationEventId = randomUUID();
      fixture.eventIds.push(validVerificationEventId);
      const validVerification = await ingestEvent(verificationJobId, {
        v: 1,
        event_id: validVerificationEventId,
        type: "fact",
        payload: {
          title: "verified fact",
          description: "the isolated test produced structured evidence",
          verification: {
            finding_id: verificationFindingId,
            evidence_kind: "test",
            outcome: "supports",
            subject_revision: "app@verified",
            steps: ["run the isolated test"],
            expected: "the request is rejected",
            actual: "the request is rejected",
          },
        },
      });
      assert.deepEqual(validVerification, { deduped: false, seq: 1 });
      const [verifiedFact] = await sql<{
        id: string;
        body_json: { verification?: { finding_id?: string; evidence_kind?: string; outcome?: string } };
      }[]>`
        SELECT id, body_json FROM canvas_nodes
        WHERE job_id = ${verificationJobId} AND node_type = 'fact' AND title = 'verified fact'`;
      assert.equal(verifiedFact?.body_json.verification?.finding_id, verificationFindingId);
      assert.equal(verifiedFact?.body_json.verification?.evidence_kind, "test");
      assert.equal(verifiedFact?.body_json.verification?.outcome, "supports");
      const [verificationEdge] = await sql`
        SELECT 1 FROM canvas_edges
        WHERE canvas_id = ${canvasId}
          AND from_node_id = ${verificationFindingNode.id}
          AND to_node_id = ${verifiedFact?.id}
          AND edge_type = 'tested_by'`;
      assert.ok(verificationEdge, "valid verification must create a tested_by edge");

      // Terminal preconditions are enforced again by core/ingest, not only by
      // executor-real's semantic buffer: verify requires verdict, while a
      // regular role must not smuggle verifier-only fields into done.
      const verifyMissingVerdictId = randomUUID();
      fixture.eventIds.push(verifyMissingVerdictId);
      await assert.rejects(
        ingestEvent(terminalVerifyJobId, {
          v: 1,
          event_id: verifyMissingVerdictId,
          type: "done",
          payload: { summary: "missing verdict" },
        }),
        (error: unknown) => error instanceof Error && /invalid_done/.test(error.message),
      );
      const verifyWhitespaceEvidenceId = randomUUID();
      fixture.eventIds.push(verifyWhitespaceEvidenceId);
      await assert.rejects(
        ingestEvent(terminalVerifyJobId, {
          v: 1,
          event_id: verifyWhitespaceEvidenceId,
          type: "done",
          payload: { summary: "whitespace evidence", verdict: "rework", missing_evidence: ["   "] },
        }),
        (error: unknown) => error instanceof Error,
      );
      const nonVerifyVerdictId = randomUUID();
      fixture.eventIds.push(nonVerifyVerdictId);
      await assert.rejects(
        ingestEvent(verificationJobId, {
          v: 1,
          event_id: nonVerifyVerdictId,
          type: "done",
          payload: { summary: "unexpected verdict", verdict: "confirmed" },
        }),
        (error: unknown) => error instanceof Error && /invalid_done/.test(error.message),
      );

      // Simulate a legacy node re-point between the read-only hint preflight
      // and transaction start.  The first Canvas lock must fail closed during
      // the in-transaction node recheck; the retry resolves and writes only
      // the new Canvas.
      const repointEventId = randomUUID();
      fixture.eventIds.push(repointEventId);
      const repointApp = createEventIngestionApplication(sql, async (tx, _job, envelope) => {
        await tx`UPDATE canvas_nodes
          SET body_json = body_json || ${tx.json({ repointed_event_id: envelope.event_id })}, updated_at = now()
          WHERE id = ${repointNode.id}`;
      });
      const originalBegin = sql.begin;
      let moved = false;
      sql.begin = (async (callback: unknown) => {
        if (!moved) {
          moved = true;
          await sql`UPDATE canvas_nodes SET canvas_id = ${movedCanvasId} WHERE id = ${repointNode.id}`;
        }
        return (originalBegin as unknown as (callback: unknown) => Promise<unknown>).call(sql, callback);
      }) as never;
      try {
        const repointed = await repointApp.ingestEvent(repointJobId, {
          v: 1,
          event_id: repointEventId,
          type: "progress",
          payload: { message: "repoint" },
        });
        assert.deepEqual(repointed, { deduped: false, seq: 1 });
      } finally {
        sql.begin = originalBegin;
      }
      assert.equal(moved, true, "the simulated re-point must occur between hint preflight and transaction start");
      const [repointedNode] = await sql<{ canvas_id: string; body_json: { repointed_event_id?: string } }[]>`
        SELECT canvas_id, body_json FROM canvas_nodes WHERE id = ${repointNode.id}`;
      assert.equal(repointedNode?.canvas_id, movedCanvasId);
      assert.equal(repointedNode?.body_json.repointed_event_id, repointEventId);
      const [oldCanvasNode] = await sql`SELECT id FROM canvas_nodes WHERE id = ${repointNode.id} AND canvas_id = ${canvasId}`;
      assert.equal(oldCanvasNode, undefined, "the old Canvas must not receive the side effect");

      // Repeat the same race for a fact's explicit intent target.  The target
      // row is independently revalidated under the locked Canvas before the
      // callback can write the fact convergence side effect.
      const factRepointEventId = randomUUID();
      fixture.eventIds.push(factRepointEventId);
      const factRepointApp = createEventIngestionApplication(sql, async (tx, _job, envelope) => {
        await tx`UPDATE canvas_nodes
          SET body_json = body_json || ${tx.json({ fact_repointed_event_id: envelope.event_id })}, updated_at = now()
          WHERE id = ${factRepointNode.id}`;
      });
      const factOriginalBegin = sql.begin;
      let factMoved = false;
      sql.begin = (async (callback: unknown) => {
        if (!factMoved) {
          factMoved = true;
          await sql`UPDATE canvas_nodes SET canvas_id = ${movedCanvasId} WHERE id = ${factRepointNode.id}`;
        }
        return (factOriginalBegin as unknown as (callback: unknown) => Promise<unknown>).call(sql, callback);
      }) as never;
      try {
        const factRepointed = await factRepointApp.ingestEvent(factRepointJobId, {
          v: 1,
          event_id: factRepointEventId,
          type: "fact",
          payload: { intent_node_id: factRepointNode.id, title: "fact", description: "repointed target" },
        });
        assert.deepEqual(factRepointed, { deduped: false, seq: 1 });
      } finally {
        sql.begin = factOriginalBegin;
      }
      assert.equal(factMoved, true, "the fact target re-point must be simulated");
      const [factRepointedNode] = await sql<{ canvas_id: string; body_json: { fact_repointed_event_id?: string } }[]>`
        SELECT canvas_id, body_json FROM canvas_nodes WHERE id = ${factRepointNode.id}`;
      assert.equal(factRepointedNode?.canvas_id, movedCanvasId);
      assert.equal(factRepointedNode?.body_json.fact_repointed_event_id, factRepointEventId);

      // Legacy Jobs can lack canvas_id while their job node still points at a
      // Canvas.  The ingress boundary must discover that Canvas before the Job
      // lock so the real core side effect cannot reintroduce reverse locking.
      const legacyEventId = randomUUID();
      fixture.eventIds.push(legacyEventId);
      const legacyResult = await ingestEvent(legacyJobId, {
        v: 1,
        event_id: legacyEventId,
        type: "progress",
        payload: { message: "legacy canvas hint" },
      });
      assert.deepEqual(legacyResult, { deduped: false, seq: 1 });
      const [legacyNode] = await sql<{ body_json: { last_progress?: { message?: string } } }[]>`
        SELECT body_json FROM canvas_nodes WHERE job_id = ${legacyJobId} AND node_type = 'job'`;
      assert.equal(legacyNode?.body_json.last_progress?.message, "legacy canvas hint");
      await sql.begin(async (tx) => {
        await finalizeJob(tx as unknown as typeof sql, legacyJobId, "succeeded", { summary: "legacy terminal" });
      });
      const [legacyTerminalNode] = await sql<{ status: string }[]>`
        SELECT status FROM canvas_nodes WHERE job_id = ${legacyJobId} AND node_type = 'job'`;
      assert.equal(legacyTerminalNode?.status, "succeeded");

      // A legacy Job may have only a report node and no jobs.canvas_id.  The
      // terminal path must discover and lock that report Canvas before the
      // Job row, then update the report node normally.
      await sql.begin(async (tx) => {
        await finalizeJob(tx as unknown as typeof sql, reportOnlyJobId, "succeeded", { summary: "report-only" });
      });
      const [reportOnlyJob] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${reportOnlyJobId}`;
      const [reportOnlyNode] = await sql<{ status: string; canvas_id: string }[]>`
        SELECT status, canvas_id FROM canvas_nodes WHERE job_id = ${reportOnlyJobId}`;
      assert.equal(reportOnlyJob?.status, "succeeded");
      assert.equal(reportOnlyNode?.status, "succeeded");
      assert.equal(reportOnlyNode?.canvas_id, canvasId);

      await assert.rejects(
        sql.begin(async (tx) => {
          await finalizeJob(tx as unknown as typeof sql, reportConflictJobId, "succeeded", { summary: "must reject" });
        }),
        /outside canvas/,
      );
      const [reportConflictJob] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${reportConflictJobId}`;
      const [reportConflictNode] = await sql<{ status: string }[]>`
        SELECT status FROM canvas_nodes WHERE job_id = ${reportConflictJobId}`;
      assert.equal(reportConflictJob?.status, "running");
      assert.equal(reportConflictNode?.status, "running");

      await assert.rejects(
        sql.begin(async (tx) => {
          await finalizeJob(tx as unknown as typeof sql, multiCanvasJobId, "succeeded", { summary: "must reject" });
        }),
        /multiple convergence canvases/,
      );
      const [multiCanvasJob] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${multiCanvasJobId}`;
      const multiCanvasNodes = await sql<{ status: string }[]>`
        SELECT status FROM canvas_nodes WHERE job_id = ${multiCanvasJobId} ORDER BY id`;
      assert.equal(multiCanvasJob?.status, "running");
      assert.deepEqual(
        multiCanvasNodes.map((node) => node.status).sort(),
        ["pending", "running"],
      );

      await assert.rejects(
        sql.begin(async (tx) => {
          await finalizeJob(tx as unknown as typeof sql, conflictingCanvasJobId, "succeeded", { summary: "must reject" });
        }),
        /outside canvas/,
      );
      const [conflictingJob] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${conflictingCanvasJobId}`;
      const [conflictingNode] = await sql<{ status: string }[]>`
        SELECT status FROM canvas_nodes WHERE job_id = ${conflictingCanvasJobId}`;
      assert.equal(conflictingJob?.status, "running");
      assert.equal(conflictingNode?.status, "running");

      const concurrentIds = [randomUUID(), randomUUID()];
      fixture.eventIds.push(...concurrentIds);
      const concurrent = await Promise.all(
        concurrentIds.map((eventId) =>
          app.ingestEvent(jobId, {
            v: 1,
            event_id: eventId,
            type: "progress",
            payload: { message: eventId },
          }),
        ),
      );
      assert.deepEqual(concurrent.map((result) => result.deduped), [false, false]);
      assert.deepEqual(
        concurrent.map((result) => result.seq).sort((a, b) => Number(a) - Number(b)),
        [2, 3],
        "the Job lock must serialize MAX(job_seq)+1",
      );

      let failOnce = true;
      const failingApp = createEventIngestionApplication(sql, async (tx, _job, envelope) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("simulated semantic crash");
        }
        await marker(tx, envelope.event_id);
      });
      const retryId = randomUUID();
      fixture.eventIds.push(retryId);
      await assert.rejects(
        failingApp.ingestEvent(jobId, {
          v: 1,
          event_id: retryId,
          type: "progress",
          payload: { message: "rollback" },
        }),
        /simulated semantic crash/,
      );
      const [rolledBackEvent] = await sql`SELECT 1 FROM events WHERE event_id = ${retryId}`;
      const [rolledBackDedup] = await sql`SELECT 1 FROM event_dedup WHERE event_id = ${retryId}`;
      assert.equal(rolledBackEvent, undefined, "append must roll back with side-effect failure");
      assert.equal(rolledBackDedup, undefined, "dedup marker must roll back with side-effect failure");

      const retried = await failingApp.ingestEvent(jobId, {
        v: 1,
        event_id: retryId,
        type: "progress",
        payload: { message: "retry" },
      });
      assert.equal(retried.deduped, false);
      assert.equal(retried.seq, 4);

      // Compete the Canvas-first done event with a direct finalize path. Both
      // paths must settle without deadlock; exactly one is allowed to win the
      // Job lock. A direct finalize winner makes the event fail closed before
      // its append/quota writes, while an ingest winner makes direct finalize
      // return false for the already-succeeded Job.
      const terminalJobId = randomUUID();
      await sql`
        INSERT INTO jobs (
          id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json
        ) VALUES (
          ${terminalJobId}, ${projectId}, ${canvasId}, 'audit_module', 'running',
          ${sql.json({ agent_cli: "claude-code", credential_id: null, model: null })}, ${sql.json({})}
        )`;
      const terminalEventId = randomUUID();
      fixture.eventIds.push(terminalEventId);
      const finalizeDirect = sql.begin(async (rawTx) =>
        finalizeJob(rawTx as unknown as typeof sql, terminalJobId, "succeeded", { summary: "direct" }),
      );
      const finalizeEvent = ingestEvent(terminalJobId, {
        v: 1,
        event_id: terminalEventId,
        type: "done",
        payload: { summary: "event completed" },
      });
      const results = await Promise.race([
        Promise.allSettled([finalizeDirect, finalizeEvent]),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Canvas/Job lock-order deadlock")), 5000)),
      ]);
      const [directResult, eventResult] = results;
      assert.equal(directResult.status, "fulfilled", "direct finalize must settle");
      if (eventResult.status === "fulfilled") {
        assert.deepEqual(eventResult.value, { deduped: false, seq: 1 }, "ingest winner commits the event");
        assert.equal((directResult.value as boolean), false, "direct finalize loses after ingest winner");
      } else {
        assert.ok(eventResult.reason instanceof ControlInputError, "late ingest must use the stable control error");
        assert.equal(eventResult.reason.code, "job_not_running");
        assert.equal((directResult.value as boolean), true, "direct finalize winner must commit");
      }
      const [terminalEvent] = await sql`SELECT 1 FROM events WHERE event_id = ${terminalEventId}`;
      const [terminalDedup] = await sql`SELECT 1 FROM event_dedup WHERE event_id = ${terminalEventId}`;
      const [terminalQuota] = await sql`SELECT 1 FROM job_event_rate_limits WHERE job_id = ${terminalJobId}`;
      if (eventResult.status === "fulfilled") {
        assert.ok(terminalEvent);
        assert.ok(terminalDedup);
        assert.ok(terminalQuota);
      } else {
        assert.equal(terminalEvent, undefined, "direct finalize winner must not leave a late event");
        assert.equal(terminalDedup, undefined, "direct finalize winner must not leave dedup");
        assert.equal(terminalQuota, undefined, "direct finalize winner must not consume event quota");
      }
      const [terminal] = await sql<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${terminalJobId}`;
      assert.equal(terminal?.status, "succeeded");
    } finally {
      for (const eventId of fixture.eventIds) {
        await sql`DELETE FROM event_dedup WHERE event_id = ${eventId}`;
        await sql`DELETE FROM events WHERE event_id = ${eventId}`;
      }
      await sql`DELETE FROM canvas_edges WHERE canvas_id IN (SELECT id FROM canvases WHERE project_id = ${projectId})`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id IN (SELECT id FROM canvases WHERE project_id = ${projectId})`;
      await sql`DELETE FROM task_reports WHERE project_id = ${projectId}`;
      await sql`DELETE FROM finding_verification_rounds WHERE finding_id IN (SELECT id FROM findings WHERE project_id = ${projectId})`;
      await sql`DELETE FROM findings WHERE project_id = ${projectId}`;
      await sql`UPDATE jobs SET parent_job_id = NULL WHERE project_id = ${projectId}`;
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE project_id = ${projectId}`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await sql`DELETE FROM canvas_edges WHERE canvas_id = ${foreignCanvasId}`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id = ${foreignCanvasId}`;
      await sql`DELETE FROM task_reports WHERE project_id = ${foreignProjectId}`;
      await sql`DELETE FROM finding_verification_rounds WHERE finding_id IN (SELECT id FROM findings WHERE project_id = ${foreignProjectId})`;
      await sql`DELETE FROM findings WHERE project_id = ${foreignProjectId}`;
      await sql`UPDATE jobs SET parent_job_id = NULL WHERE project_id = ${foreignProjectId}`;
      await sql`DELETE FROM jobs WHERE project_id = ${foreignProjectId}`;
      await sql`DELETE FROM canvases WHERE project_id = ${foreignProjectId}`;
      await sql`DELETE FROM projects WHERE id = ${foreignProjectId}`;
      await sql.end();
    }
  });
}
