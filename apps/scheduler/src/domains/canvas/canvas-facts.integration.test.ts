import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("canvas facts integration requires TEST_DATABASE_URL", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  test("Fact API、结构化 human 与人工验证派生保持画布范围和事务一致性", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = (await import("postgres")).default(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_canvas_facts_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";
      process.env.AGENT_MODE = "fake";

      const [fastifyModule, websocketModule, dbModule, routesModule, coreModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("../../db.js"),
        import("../../routes.js"),
        import("../../core.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { migrate, sql } = dbModule;
      const { registerRoutes } = routesModule;
      const { ingestEvent, normalizePendingJobPriorities } = coreModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = Fastify({ logger: false });
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const projectId = randomUUID();
      const canvasId = randomUUID();
      const otherCanvasId = randomUUID();
      await sql`
        INSERT INTO projects (id, name, config_json)
        VALUES (${projectId}, 'Fact API integration', ${sql.json({
          rules: {
            hubEnabled: false,
            minVerifySeverity: "high",
            maxVerificationRounds: 3,
            maxFollowupDepth: 12,
          },
          roles: { enabled: ["review", "test"] },
        })})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES
          (${canvasId}, ${projectId}, 'Fact canvas', ${sql.json({ network_policy: { allow_egress: false } })}),
          (${otherCanvasId}, ${projectId}, 'Other canvas', ${sql.json({ network_policy: { allow_egress: false } })})`;
      const [root, otherRoot] = await sql<{ id: string }[]>`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES
          (${canvasId}, 'root', 'Root', 'active', ${sql.json({})}),
          (${otherCanvasId}, 'root', 'Other root', 'active', ${sql.json({})})
        RETURNING id`;

      const baseSnapshot = { name: "audit", role_kind: "role", platform_tools: ["emit_finding", "mark_job_done"] };
      const createOrigin = async (canvas: string, followupDepth = 0) => {
        const id = randomUUID();
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, type, status, followup_depth, agent_snapshot_json, payload_json)
          VALUES (${id}, ${projectId}, ${canvas}, 'audit', 'succeeded', ${followupDepth}, ${sql.json(baseSnapshot)}, ${sql.json({})})`;
        return id;
      };
      const createFinding = async (input: { title: string; severity: string; canvas?: string; followupDepth?: number }) => {
        const targetCanvas = input.canvas ?? canvasId;
        const originJobId = await createOrigin(targetCanvas, input.followupDepth ?? 0);
        const [node] = await sql<{ id: string }[]>`
          INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
          VALUES (${targetCanvas}, ${originJobId}, 'finding', ${input.title}, 'open', ${sql.json({ severity: input.severity })})
          RETURNING id`;
        const findingId = randomUUID();
        await sql`
          INSERT INTO findings (id, project_id, job_id, node_id, fingerprint, title, severity, summary, raw_json)
          VALUES (
            ${findingId}, ${projectId}, ${originJobId}, ${node.id}, ${`fp-${findingId}`},
            ${input.title}, ${input.severity}, ${`${input.title} 的结构化摘要`}, ${sql.json({})}
          )`;
        return { findingId, nodeId: node.id, originJobId };
      };

      const high = await createFinding({ title: "High finding", severity: "high" });
      const low = await createFinding({ title: "Low finding", severity: "low" });
      const evidenceTarget = await createFinding({ title: "Evidence finding", severity: "medium" });
      const depthTarget = await createFinding({ title: "Depth finding", severity: "high", followupDepth: 11 });
      const foreignTarget = await createFinding({ title: "Other canvas finding", severity: "high", canvas: otherCanvasId });

      const reviewJobId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, finding_id, type, status, agent_snapshot_json, payload_json)
        VALUES (
          ${reviewJobId}, ${projectId}, ${canvasId}, ${high.findingId}, 'review', 'succeeded',
          ${sql.json({ name: "review", role_kind: "role", platform_tools: ["emit_fact", "mark_job_done"] })},
          ${sql.json({ verification_followup: { finding_id: high.findingId, scheduler_owned: true } })}
        )`;
      const plainFactId = randomUUID();
      const legalFactId = randomUUID();
      const spoofFactId = randomUUID();
      await sql`
        INSERT INTO canvas_nodes (
          id, canvas_id, job_id, node_type, title, body_json, status, verification_status, created_at
        ) VALUES
          (
            ${plainFactId}, ${canvasId}, ${high.originJobId}, 'fact', 'Plain fact',
            ${sql.json({ description: "普通事实没有 Finding 关联" })}, 'open', 'unverified', '2026-08-14T00:03:00.000Z'
          ),
          (
            ${legalFactId}, ${canvasId}, ${reviewJobId}, 'fact', 'Legal evidence',
            ${sql.json({
              description: "结构化复核证据",
              verification: {
                finding_id: high.findingId,
                evidence_kind: "review",
                outcome: "supports",
                subject_revision: "app@abc123",
              },
            })}, 'open', 'verified', '2026-08-14T00:02:00.000Z'
          ),
          (
            ${spoofFactId}, ${canvasId}, ${reviewJobId}, 'fact', 'Spoof evidence',
            ${sql.json({
              description: "只有 JSON finding_id 但没有直接证据边",
              verification: {
                finding_id: high.findingId,
                evidence_kind: "review",
                outcome: "supports",
                subject_revision: "app@spoof",
              },
            })}, 'open', 'unverified', '2026-08-14T00:01:00.000Z'
          )`;
      await sql`
        INSERT INTO canvas_edges (canvas_id, from_node_id, to_node_id, edge_type)
        VALUES (${canvasId}, ${high.nodeId}, ${legalFactId}, 'reviewed_by')`;

      const firstPageResponse = await app.inject({ method: "GET", url: `/canvases/${canvasId}/facts?limit=2` });
      assert.equal(firstPageResponse.statusCode, 200, firstPageResponse.payload);
      const firstPage = firstPageResponse.json();
      assert.deepEqual(firstPage.items.map((item: { id: string }) => item.id), [plainFactId, legalFactId]);
      assert.equal(firstPage.has_more, true);
      assert.equal(firstPage.items[0].verification, null);
      assert.equal(firstPage.items[1].verification.finding_id, high.findingId);
      assert.deepEqual(Object.keys(firstPage.items[1]).sort(), [
        "canvas_id", "created_at", "description", "finding", "id", "job", "job_id", "title",
        "updated_at", "verification", "verification_status",
      ]);

      const lateFactId = randomUUID();
      await sql`
        INSERT INTO canvas_nodes (
          id, canvas_id, job_id, node_type, title, body_json, status, verification_status, created_at
        ) VALUES (
          ${lateFactId}, ${canvasId}, ${high.originJobId}, 'fact', 'Late fact',
          ${sql.json({ description: "第一页读取后到达的新事实" })}, 'open', 'unverified', '2026-08-14T00:04:00.000Z'
        )`;
      const secondPageResponse = await app.inject({
        method: "GET",
        url: `/canvases/${canvasId}/facts?limit=2&after=${encodeURIComponent(firstPage.next_cursor)}`,
      });
      assert.equal(secondPageResponse.statusCode, 200, secondPageResponse.payload);
      const secondPage = secondPageResponse.json();
      assert.deepEqual(secondPage.items.map((item: { id: string }) => item.id), [spoofFactId]);
      assert.equal(secondPage.items[0].verification, null, "伪造 body_json 不能形成关联");

      const filtered = await app.inject({
        method: "GET",
        url: `/canvases/${canvasId}/facts?evidence_kind=review&finding_id=${high.findingId}&job_id=${reviewJobId}`,
      });
      assert.equal(filtered.statusCode, 200, filtered.payload);
      assert.deepEqual(filtered.json().items.map((item: { id: string }) => item.id), [legalFactId]);
      const multiFiltered = await app.inject({
        method: "GET",
        url: `/canvases/${canvasId}/facts?verification_status=verified,unverified&job_id=${reviewJobId},${high.originJobId}`,
      });
      assert.equal(multiFiltered.statusCode, 200, multiFiltered.payload);
      assert.deepEqual(multiFiltered.json().items.map((item: { id: string }) => item.id), [lateFactId, plainFactId, legalFactId, spoofFactId]);
      assert.equal((await app.inject({ method: "GET", url: `/canvases/${canvasId}/facts?finding_id=bad` })).statusCode, 400);
      assert.equal((await app.inject({ method: "GET", url: `/canvases/${canvasId}/facts?after=badcursor` })).statusCode, 400);

      const detailResponse = await app.inject({ method: "GET", url: `/canvases/${canvasId}/facts/${legalFactId}` });
      assert.equal(detailResponse.statusCode, 200, detailResponse.payload);
      const detail = detailResponse.json();
      assert.equal(detail.fact.body_json.verification.subject_revision, "app@abc123");
      assert.equal(detail.finding.id, high.findingId);
      assert.equal(detail.job.id, reviewJobId);
      assert.equal(detail.trace.edges.some((edge: { edge_type: string }) => edge.edge_type === "reviewed_by"), true);
      assert.equal(detail.trace.nodes.some((node: { id: string }) => node.id === high.nodeId), true);
      assert.equal((await app.inject({ method: "GET", url: `/canvases/${otherCanvasId}/facts/${legalFactId}` })).statusCode, 404);

      const patchResponse = await app.inject({
        method: "PATCH",
        url: `/canvases/${canvasId}/facts/${plainFactId}/verification`,
        payload: { status: "rejected", note: "人工确认该事实不成立" },
      });
      assert.equal(patchResponse.statusCode, 200, patchResponse.payload);
      assert.equal(patchResponse.json().fact.verification_status, "rejected");
      const [patchedFact] = await sql`SELECT verification_status, body_json FROM canvas_nodes WHERE id = ${plainFactId}`;
      assert.equal(patchedFact.verification_status, "rejected");
      assert.equal((patchedFact.body_json as Record<string, any>).manual_verification.note, "人工确认该事实不成立");
      const [factAudit] = await sql`
        SELECT action FROM audit_logs WHERE action = 'canvas.fact.verification' AND resource_id = ${plainFactId}`;
      assert.ok(factAudit);
      const nonFactPatch = await app.inject({
        method: "PATCH",
        url: `/canvases/${canvasId}/facts/${root.id}/verification`,
        payload: { status: "verified" },
      });
      assert.equal(nonFactPatch.statusCode, 409, nonFactPatch.payload);
      assert.equal((await app.inject({
        method: "PATCH",
        url: `/canvases/${otherCanvasId}/facts/${plainFactId}/verification`,
        payload: { status: "verified" },
      })).statusCode, 404);
      assert.equal((await app.inject({
        method: "PATCH",
        url: `/canvases/${canvasId}/facts/${otherRoot.id}/verification`,
        payload: { status: "verified" },
      })).statusCode, 404);

      const humanSnapshot = {
        name: "hub_reason",
        role_kind: "hub",
        platform_tools: ["request_human"],
      };
      const createHumanHub = async (findingId: string, label: string) => {
        const jobId = randomUUID();
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, finding_id, type, status, agent_snapshot_json, payload_json)
          VALUES (${jobId}, ${projectId}, ${canvasId}, ${findingId}, 'hub_reason', 'running', ${sql.json(humanSnapshot)}, ${sql.json({})})`;
        const [node] = await sql<{ id: string }[]>`
          INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
          VALUES (${canvasId}, ${jobId}, 'job', ${label}, 'running', ${sql.json({ type: "hub_reason" })})
          RETURNING id`;
        return { jobId, nodeId: node.id };
      };
      const lowHub = await createHumanHub(low.findingId, "Low human hub");
      const beforeLow = await sql`
        SELECT
          (SELECT COUNT(*)::int FROM events WHERE job_id = ${lowHub.jobId}) AS events,
          (SELECT COUNT(*)::int FROM canvas_nodes WHERE job_id = ${lowHub.jobId}) AS nodes`;
      await assert.rejects(
        ingestEvent(lowHub.jobId, {
          v: 1,
          event_id: randomUUID(),
          type: "human",
          payload: {
            reason: "低严重度 Finding 不应阻塞人工处理。",
            subject: { type: "finding", finding_id: low.findingId, subject_revision: "app@low" },
          },
        }),
        /invalid_human/,
      );
      const [afterLow] = await sql`
        SELECT j.status,
          (SELECT COUNT(*)::int FROM events WHERE job_id = ${lowHub.jobId}) AS events,
          (SELECT COUNT(*)::int FROM canvas_nodes WHERE job_id = ${lowHub.jobId}) AS nodes
        FROM jobs j WHERE j.id = ${lowHub.jobId}`;
      assert.equal(afterLow.status, "running");
      assert.equal(afterLow.events, beforeLow[0].events);
      assert.equal(afterLow.nodes, beforeLow[0].nodes);

      const crossCanvasHub = await createHumanHub(foreignTarget.findingId, "Cross canvas human hub");
      const crossCanvasEventId = randomUUID();
      await assert.rejects(
        ingestEvent(crossCanvasHub.jobId, {
          v: 1,
          event_id: crossCanvasEventId,
          type: "human",
          payload: {
            reason: "跨画布 Finding 不得成为当前任务阻塞目标。",
            subject: { type: "finding", finding_id: foreignTarget.findingId, subject_revision: "app@foreign" },
          },
        }),
        /invalid_human/,
      );
      const [crossCanvasState] = await sql`
        SELECT j.status,
          (SELECT COUNT(*)::int FROM events WHERE event_id = ${crossCanvasEventId}) AS events,
          (SELECT COUNT(*)::int FROM canvas_nodes WHERE job_id = ${crossCanvasHub.jobId} AND node_type = 'human') AS human_nodes
        FROM jobs j WHERE j.id = ${crossCanvasHub.jobId}`;
      assert.deepEqual(crossCanvasState, { status: "running", events: 0, human_nodes: 0 });

      const platformHub = await createHumanHub(high.findingId, "Platform blocker hub");
      await ingestEvent(platformHub.jobId, {
        v: 1,
        event_id: randomUUID(),
        type: "human",
        payload: {
          reason: "缺少隔离环境凭据，需要人工安全提供。",
          subject: { type: "platform_blocker", kind: "credential" },
        },
      });
      const [platformState, platformNode, platformJobNode] = await Promise.all([
        sql`SELECT status FROM jobs WHERE id = ${platformHub.jobId}`,
        sql`SELECT body_json FROM canvas_nodes WHERE job_id = ${platformHub.jobId} AND node_type = 'human'`,
        sql`SELECT status FROM canvas_nodes WHERE id = ${platformHub.nodeId}`,
      ]);
      assert.equal(platformState[0].status, "waiting_human");
      assert.equal(platformJobNode[0].status, "waiting_human");
      assert.deepEqual((platformNode[0].body_json as Record<string, unknown>).subject, {
        type: "platform_blocker",
        kind: "credential",
      });
      await sql`UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE id = ${platformHub.jobId}`;

      const highHub = await createHumanHub(high.findingId, "High human hub");
      await ingestEvent(highHub.jobId, {
        v: 1,
        event_id: randomUUID(),
        type: "human",
        payload: {
          reason: "高严重度 Finding 需要人工业务决策。",
          subject: { type: "finding", finding_id: high.findingId, subject_revision: "app@high" },
        },
      });
      const [waitingHub, humanNode] = await Promise.all([
        sql`SELECT status FROM jobs WHERE id = ${highHub.jobId}`,
        sql`SELECT body_json FROM canvas_nodes WHERE job_id = ${highHub.jobId} AND node_type = 'human'`,
      ]);
      assert.equal(waitingHub[0].status, "waiting_human");
      assert.deepEqual((humanNode[0].body_json as Record<string, unknown>).subject, {
        type: "finding",
        finding_id: high.findingId,
        subject_revision: "app@high",
      });

      const manualVerify = await app.inject({
        method: "POST",
        url: `/findings/${high.findingId}/verify`,
        payload: { reason: "operator requests immediate verification" },
      });
      assert.equal(manualVerify.statusCode, 202, manualVerify.payload);
      const manualVerifyBody = manualVerify.json();
      assert.equal(manualVerifyBody.finding_id, high.findingId);
      assert.equal(manualVerifyBody.resumed_job_id, highHub.jobId);
      const [manualJob, manualRound, resumedHub] = await Promise.all([
        sql`SELECT finding_id, payload_json, followup_depth FROM jobs WHERE id = ${manualVerifyBody.verify_job_id}`,
        sql`SELECT requirements_json FROM finding_verification_rounds WHERE id = ${manualVerifyBody.round_id}`,
        sql`SELECT status FROM jobs WHERE id = ${highHub.jobId}`,
      ]);
      assert.equal(manualJob[0].finding_id, high.findingId);
      assert.equal((manualJob[0].payload_json as Record<string, any>).manual_override.source, "operator");
      assert.equal((manualRound[0].requirements_json as Record<string, unknown>).manual_override, true);
      assert.equal(resumedHub[0].status, "pending");
      const duplicateVerify = await app.inject({ method: "POST", url: `/findings/${high.findingId}/verify`, payload: {} });
      assert.equal(duplicateVerify.statusCode, 409, duplicateVerify.payload);

      await sql`UPDATE findings SET verify_status = 'needs_human' WHERE id = ${low.findingId}`;
      const terminalVerify = await app.inject({ method: "POST", url: `/findings/${low.findingId}/verify`, payload: {} });
      assert.equal(terminalVerify.statusCode, 409, terminalVerify.payload);
      assert.equal(terminalVerify.json().error_code, "FINDING_VERIFY_TERMINAL");
      const terminalEvidence = await app.inject({
        method: "POST",
        url: `/findings/${low.findingId}/evidence-jobs`,
        payload: { role: "review" },
      });
      assert.equal(terminalEvidence.statusCode, 409, terminalEvidence.payload);

      const evidenceJob = await app.inject({
        method: "POST",
        url: `/findings/${evidenceTarget.findingId}/evidence-jobs`,
        payload: { role: "review" },
      });
      assert.equal(evidenceJob.statusCode, 202, evidenceJob.payload);
      const evidenceBody = evidenceJob.json();
      const [createdEvidence] = await sql`
        SELECT finding_id, type, priority, followup_depth, payload_json
        FROM jobs WHERE id = ${evidenceBody.job_id}`;
      assert.equal(createdEvidence.finding_id, evidenceTarget.findingId);
      assert.equal(createdEvidence.type, "review");
      assert.equal(createdEvidence.followup_depth, 1);
      assert.equal((createdEvidence.payload_json as Record<string, any>).verification_followup.scheduler_owned, true);
      assert.equal((createdEvidence.payload_json as Record<string, any>).verification_followup.manual_override, true);
      await normalizePendingJobPriorities(sql);
      const [normalizedEvidence] = await sql`
        SELECT priority, payload_json FROM jobs WHERE id = ${evidenceBody.job_id}`;
      assert.equal(normalizedEvidence.priority, createdEvidence.priority);
      assert.equal((normalizedEvidence.payload_json as Record<string, any>).scheduling_purpose, "convergence_evidence");
      const duplicateEvidence = await app.inject({
        method: "POST",
        url: `/findings/${evidenceTarget.findingId}/evidence-jobs`,
        payload: { role: "review" },
      });
      assert.equal(duplicateEvidence.statusCode, 409, duplicateEvidence.payload);
      assert.equal(duplicateEvidence.json().error_code, "ACTIVE_EVIDENCE_JOB_EXISTS");
      const invalidEvidenceRole = await app.inject({
        method: "POST",
        url: `/findings/${evidenceTarget.findingId}/evidence-jobs`,
        payload: { role: "audit" },
      });
      assert.equal(invalidEvidenceRole.statusCode, 400, invalidEvidenceRole.payload);
      const depthEvidence = await app.inject({
        method: "POST",
        url: `/findings/${depthTarget.findingId}/evidence-jobs`,
        payload: { role: "test" },
      });
      assert.equal(depthEvidence.statusCode, 409, depthEvidence.payload);
      assert.equal(depthEvidence.json().error_code, "FOLLOWUP_DEPTH_LIMIT");

      const boundHubJobId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES (
          ${boundHubJobId}, ${projectId}, ${canvasId}, 'hub_reason', 'running',
          ${sql.json({ name: "hub_reason", role_kind: "hub", platform_tools: ["submit_hub_decision"] })},
          ${sql.json({ trigger: { kind: "hub_finding", finding_id: high.findingId } })}
        )`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${canvasId}, ${boundHubJobId}, 'job', 'Binding Hub', 'running', ${sql.json({ type: "hub_reason" })})`;
      await ingestEvent(boundHubJobId, {
        v: 1,
        event_id: randomUUID(),
        type: "hub_decision",
        payload: {
          intents: [{
            from: [high.nodeId],
            role: "review",
            description: "对高风险 Finding 执行绑定复核",
            prompt: "对当前 canonical Finding 执行独立复核，并提交绑定 finding_id 的结构化 review 证据。",
          }, {
            from: [high.nodeId],
            role: "test",
            description: "对高风险 Finding 执行绑定实测",
            prompt: "对当前 canonical Finding 执行隔离运行实测，并提交绑定 finding_id 的结构化 test 证据。",
          }],
        },
      });
      const boundEvidenceJobs = await sql`
        SELECT id, finding_id, type, payload_json
        FROM jobs
        WHERE parent_job_id = ${boundHubJobId} AND type IN ('review','test')
        ORDER BY type`;
      assert.deepEqual(boundEvidenceJobs.map((job) => job.type), ["review", "test"]);
      for (const boundEvidenceJob of boundEvidenceJobs) {
        assert.equal(boundEvidenceJob.finding_id, high.findingId);
        assert.equal((boundEvidenceJob.payload_json as Record<string, any>).scheduling_purpose, "convergence_evidence");
        assert.equal((boundEvidenceJob.payload_json as Record<string, any>).verification_followup.finding_id, high.findingId);
        assert.equal((boundEvidenceJob.payload_json as Record<string, any>).verification_followup.scheduler_owned, true);
      }
      const boundIntentEdges = await sql`
        SELECT 1
        FROM canvas_edges e
        JOIN canvas_nodes intent ON intent.id = e.to_node_id
        JOIN jobs evidence_job ON evidence_job.id = intent.job_id AND evidence_job.parent_job_id = ${boundHubJobId}
        WHERE e.canvas_id = ${canvasId}
          AND e.from_node_id = ${high.nodeId}
          AND e.edge_type = 'from'`;
      assert.equal(boundIntentEdges.length, 2);
      const hubDuplicateEvidence = await app.inject({
        method: "POST",
        url: `/findings/${high.findingId}/evidence-jobs`,
        payload: { role: "test" },
      });
      assert.equal(hubDuplicateEvidence.statusCode, 409, hubDuplicateEvidence.payload);
      assert.equal(hubDuplicateEvidence.json().error_code, "ACTIVE_EVIDENCE_JOB_EXISTS");
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
