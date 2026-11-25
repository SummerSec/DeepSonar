import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Finding 人工收口集成测试（设置 TEST_DATABASE_URL 后运行）", {
    skip: "未设置 TEST_DATABASE_URL，拒绝使用调度器默认数据库",
  }, () => {});
} else {
  test("人工 needs_human 收口与 Hub 恢复保持同一事务", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_finding_human_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;
    let stopListening: (() => Promise<unknown>) | null = null;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";

      const [fastifyModule, websocketModule, dbModule, routesModule, authModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
        import("./auth.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { sql, migrate } = dbModule;
      const { generateToken } = authModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();

      const projectId = randomUUID();
      const canvasId = randomUUID();
      const sourceJobId = randomUUID();
      const findingId = randomUUID();
      const hubJobId = randomUUID();
      const hubNodeId = randomUUID();
      const findingNodeId = randomUUID();
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, '人工收口集成项目')`;
      await sql`INSERT INTO canvases (id, project_id, title) VALUES (${canvasId}, ${projectId}, '人工收口集成画布')`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES (${sourceJobId}, ${projectId}, ${canvasId}, 'audit', 'succeeded', ${sql.json({})}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvas_nodes (id, canvas_id, node_type, title, status, body_json)
        VALUES (${findingNodeId}, ${canvasId}, 'finding', '待人工 Finding', 'verifying', ${sql.json({})})`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, node_id, fingerprint, title, severity, verify_status)
        VALUES (${findingId}, ${projectId}, ${sourceJobId}, ${findingNodeId}, ${`human-${findingId}`}, '待人工 Finding', 'high', 'verifying')`;
      await sql`
        INSERT INTO finding_verification_rounds (finding_id, attempt, status, requirements_json)
        VALUES (${findingId}, 1, 'pending', ${sql.json({ eligibility: 'waiting_evidence' })})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES (${hubJobId}, ${projectId}, ${canvasId}, 'hub_reason', 'waiting_human', ${sql.json({})}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvas_nodes (id, canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${hubNodeId}, ${canvasId}, ${hubJobId}, 'job', '等待人工 Hub', 'waiting_human', ${sql.json({ type: 'hub_reason' })})`;

      const token = generateToken();
      await sql`
        INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
        VALUES ('人工收口项目 Token', ${projectId}, ${token.prefix}, ${token.hash}, ${['findings:write', 'findings:read']})`;
      const headers = { authorization: `Bearer ${token.plaintext}` };
      const app = Fastify({ logger: false });
      await app.register(websocket);
      routesModule.registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      let notified = false;
      let resolveNotification!: () => void;
      const notification = new Promise<void>((resolve) => {
        resolveNotification = resolve;
      });
      const listener = await sql.listen("deepsonar_jobs", (payload) => {
        if (payload === "finding_needs_human") {
          notified = true;
          resolveNotification();
        }
      });
      stopListening = async () => {
        await listener.unlisten();
      };
      const response = await app.inject({
        method: "PATCH",
        url: `/findings/${findingId}/verify-status`,
        headers,
        payload: { verify_status: "needs_human", reason: "集成测试人工判断" },
      });
      assert.equal(response.statusCode, 200, response.payload);
      await Promise.race([
        notification,
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
      assert.equal(notified, true, "人工收口应在提交事务后通知 dispatcher");

      const [settledFinding] = await sql`SELECT verify_status FROM findings WHERE id = ${findingId}`;
      assert.equal(settledFinding.verify_status, "needs_human");
      const [settledRound] = await sql`
        SELECT id, status, final_outcome FROM finding_verification_rounds WHERE finding_id = ${findingId}`;
      assert.equal(settledRound.status, "needs_human");
      assert.equal(settledRound.final_outcome, "needs_human");
      const [blocker] = await sql`
        SELECT id, body_json, status FROM canvas_nodes
        WHERE canvas_id = ${canvasId} AND node_type = 'human'
          AND body_json->>'finding_id' = ${findingId}`;
      assert.equal(blocker.status, "open");
      assert.equal((blocker.body_json as Record<string, unknown>).kind, "verification_blocker");
      const [resumedHub] = await sql`SELECT status FROM jobs WHERE id = ${hubJobId}`;
      assert.equal(resumedHub.status, "pending");
      const [resumedHubNode] = await sql`SELECT status FROM canvas_nodes WHERE id = ${hubNodeId}`;
      assert.equal(resumedHubNode.status, "pending");

      const detail = await app.inject({ method: "GET", url: `/findings/${findingId}`, headers });
      assert.equal(detail.statusCode, 200, detail.payload);
      const expected = detail.json().verification_control;
      assert.deepEqual(expected, { verify_status: "needs_human", subject_revision: null, latest_round_id: String(settledRound.id) });
      const closeBody = { verify_status: "inconclusive", reason: "目前没有已授权设备，结束本次技术验证", expected, mutation_id: randomUUID() };
      const patch = (payload: unknown, finding = findingId, authHeaders = headers) => app.inject({
        method: "PATCH", url: `/findings/${finding}/verify-status`, headers: authHeaders, payload: payload as Record<string, unknown>,
      });
      assert.equal((await patch(closeBody, findingId, { authorization: "" })).statusCode, 401);
      assert.equal((await patch(closeBody, findingId, { authorization: "Bearer invalid-token" })).statusCode, 401);
      const stale = await patch({ ...closeBody, expected: { ...expected, subject_revision: "stale@revision" } });
      assert.equal(stale.statusCode, 409, stale.payload);
      assert.equal(stale.json().error_code, "FINDING_VERIFICATION_STALE");
      const staleRound = await patch({ ...closeBody, expected: { ...expected, latest_round_id: randomUUID() } });
      assert.equal(staleRound.statusCode, 409, staleRound.payload);
      const readToken = generateToken();
      await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
        VALUES ('只读',${projectId},${readToken.prefix},${readToken.hash},${['findings:read','jobs:control']})`;
      assert.equal((await patch(closeBody, findingId, { authorization: `Bearer ${readToken.plaintext}` })).statusCode, 403);

      // 审计故障必须回滚状态、轮次和 blocker，不能仅 console.error 后成功。
      await sql.unsafe(`CREATE FUNCTION reject_operator_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action = 'finding.verify_status.inconclusive' THEN RAISE EXCEPTION 'audit fixture failure'; END IF; RETURN NEW; END $$`);
      await sql.unsafe(`CREATE TRIGGER reject_operator_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_operator_audit()`);
      const auditFailure = await patch(closeBody);
      assert.equal(auditFailure.statusCode, 500, auditFailure.payload);
      assert.equal((await sql`SELECT verify_status FROM findings WHERE id=${findingId}`)[0].verify_status, "needs_human");
      assert.equal((await sql`SELECT count(*)::int AS n FROM finding_verification_rounds WHERE finding_id=${findingId}`)[0].n, 1);
      assert.equal((await sql`SELECT status FROM canvas_nodes WHERE id=${blocker.id}`)[0].status, "open");
      await sql.unsafe(`DROP TRIGGER reject_operator_audit ON audit_logs`);

      const activeId = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,canvas_id,finding_id,type,status,agent_snapshot_json)
        VALUES (${activeId},${projectId},${canvasId},${findingId},'test','pending','{}')`;
      assert.equal((await patch(closeBody)).json().error_code, "FINDING_VERIFICATION_ACTIVE");
      await sql`UPDATE jobs SET status='failed' WHERE id=${activeId}`;
      const { createAttempt } = await import("./domains/job-attempt/index.js");
      const attempt = await createAttempt(sql, activeId, { agent_cli: "pi", adapter_id: "pi", adapter_version: "1", runtime_image_ref: "fixture:test" });
      await sql`INSERT INTO job_attempt_effects(attempt_id,job_id,effect_id,effect_kind,status) VALUES (${String(attempt.id)},${activeId},'unknown-fixture','fixture','unknown')`;
      assert.equal((await patch(closeBody)).json().error_code, "FINDING_EFFECT_UNRESOLVED");
      await sql`UPDATE job_attempt_effects SET status='settled' WHERE job_id=${activeId}`;
      assert.equal((await patch(closeBody)).json().error_code, "FINDING_VERIFICATION_ACTIVE");
      await sql`UPDATE job_attempts SET status='failed',phase='terminal',finished_at=now() WHERE id=${String(attempt.id)}`;
      await sql`UPDATE jobs SET status='waiting_human',started_at=now()-interval '10 minutes' WHERE id=${hubJobId}`;
      const [hubBeforeClose] = await sql`SELECT * FROM jobs WHERE id=${hubJobId}`;
      const unrelatedHumanId = randomUUID();
      await sql`INSERT INTO canvas_nodes(id,canvas_id,node_type,title,status,body_json)
        VALUES (${unrelatedHumanId},${canvasId},'human','另一项人工决定','open',${sql.json({kind:'verification_blocker',finding_id:randomUUID()})})`;
      const concurrent = await Promise.all([patch(closeBody), patch({ ...closeBody, mutation_id: randomUUID() })]);
      assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [200,409]);
      const accepted = concurrent.find((r) => r.statusCode === 200)!.json();
      const acceptedBody = accepted.mutation_id === closeBody.mutation_id ? closeBody : { ...closeBody, mutation_id: accepted.mutation_id };
      const replay = await patch(acceptedBody);
      assert.equal(replay.statusCode, 200, replay.payload);
      assert.deepEqual(replay.json(), accepted);
      assert.equal((await patch({ ...acceptedBody, reason: "另一决定" })).json().error_code, "FINDING_MUTATION_CONFLICT");
      const [finalFinding] = await sql`SELECT verify_status,disposition,raw_json FROM findings WHERE id=${findingId}`;
      assert.equal(finalFinding.verify_status, "inconclusive");
      assert.equal(finalFinding.disposition, "open");
      assert.equal(finalFinding.raw_json.verification_state.operator_round_id, accepted.round_id);
      assert.deepEqual((await sql`SELECT * FROM jobs WHERE id=${hubJobId}`)[0], hubBeforeClose,
        "Finding 收口不能复活 Hub 或重置其执行时钟");
      const allRounds = await sql`SELECT id,attempt,status,final_outcome,verify_job_id FROM finding_verification_rounds WHERE finding_id=${findingId} ORDER BY attempt`;
      assert.equal(allRounds.length, 2);
      assert.equal(allRounds[0].status, "needs_human", "旧轮次保持其原始结论");
      assert.equal(allRounds[1].attempt, 2);
      assert.equal(allRounds[1].verify_job_id, null);
      assert.equal(allRounds[1].final_outcome, "inconclusive");
      const [auditRow] = await sql`SELECT actor_type,actor_id,request_id,after_json FROM audit_logs WHERE action='finding.verify_status.inconclusive' AND resource_id=${findingId}`;
      assert.equal(auditRow.actor_type, "api_token");
      assert.equal(auditRow.after_json.round_id, accepted.round_id);
      assert.ok(auditRow.request_id);
      assert.equal((await sql`SELECT count(*)::int AS n FROM audit_logs WHERE action='finding.verify_status.inconclusive' AND resource_id=${findingId}`)[0].n, 1);
      assert.equal((await sql`SELECT status FROM canvas_nodes WHERE id=${unrelatedHumanId}`)[0].status, "open");
      const { canvasFindingsConverged } = await import("./verify.js");
      assert.equal((await canvasFindingsConverged(sql, canvasId)).ok, true);
      await sql`UPDATE jobs SET status='pending' WHERE id=${hubJobId}`;

      const confirmedFindingId = randomUUID();
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, verify_status)
        VALUES (${confirmedFindingId}, ${projectId}, ${sourceJobId}, ${`confirmed-${confirmedFindingId}`}, '已确认 Finding', 'high', 'confirmed')`;
      const confirmedResponse = await app.inject({
        method: "PATCH",
        url: `/findings/${confirmedFindingId}/verify-status`,
        headers,
        payload: { verify_status: "needs_human" },
      });
      assert.equal(confirmedResponse.statusCode, 409);
      const [confirmedState] = await sql`SELECT verify_status FROM findings WHERE id = ${confirmedFindingId}`;
      assert.equal(confirmedState.verify_status, "confirmed");
      const confirmedClose = await patch({ ...closeBody, mutation_id: randomUUID(), expected: { verify_status: "confirmed", subject_revision: null, latest_round_id: null } }, confirmedFindingId);
      assert.equal(confirmedClose.statusCode, 409);

      const noHubFindingId = randomUUID();
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, verify_status)
        VALUES (${noHubFindingId}, ${projectId}, ${sourceJobId}, ${`no-hub-${noHubFindingId}`}, '无 Hub Finding', 'high', 'verifying')`;
      const noHubResponse = await app.inject({
        method: "PATCH",
        url: `/findings/${noHubFindingId}/verify-status`,
        headers,
        payload: { verify_status: "needs_human" },
      });
      assert.equal(noHubResponse.statusCode, 409);
      const [noHubState] = await sql`SELECT verify_status FROM findings WHERE id = ${noHubFindingId}`;
      assert.equal(noHubState.verify_status, "verifying");

      const otherProjectId = randomUUID();
      const otherCanvasId = randomUUID();
      const otherSourceJobId = randomUUID();
      const otherFindingId = randomUUID();
      const otherHubJobId = randomUUID();
      await sql`INSERT INTO projects (id, name) VALUES (${otherProjectId}, '越权测试项目')`;
      await sql`INSERT INTO canvases (id, project_id, title) VALUES (${otherCanvasId}, ${otherProjectId}, '越权测试画布')`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES
          (${otherSourceJobId}, ${otherProjectId}, ${otherCanvasId}, 'audit', 'succeeded', ${sql.json({})}, ${sql.json({})}),
          (${otherHubJobId}, ${otherProjectId}, ${otherCanvasId}, 'hub_reason', 'waiting_human', ${sql.json({})}, ${sql.json({})})`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, verify_status)
        VALUES (${otherFindingId}, ${otherProjectId}, ${otherSourceJobId}, ${`other-${otherFindingId}`}, '其它项目 Finding', 'high', 'verifying')`;
      const scopeResponse = await app.inject({
        method: "PATCH",
        url: `/findings/${otherFindingId}/verify-status`,
        headers,
        payload: { verify_status: "needs_human" },
      });
      assert.equal(scopeResponse.statusCode, 403);
      const [scopeFinding] = await sql`SELECT verify_status FROM findings WHERE id = ${otherFindingId}`;
      const [scopeHub] = await sql`SELECT status FROM jobs WHERE id = ${otherHubJobId}`;
      assert.equal(scopeFinding.verify_status, "verifying");
      assert.equal(scopeHub.status, "waiting_human");
      assert.equal((await patch({ ...closeBody, mutation_id: randomUUID() }, otherFindingId)).statusCode, 403);

      // 没有关联画布的历史记录仍可读，人工结束则必须有有效画布。
      const detachedJobId = randomUUID();
      const detachedFindingId = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json)
        VALUES (${detachedJobId},${projectId},'audit','succeeded','{}')`;
      await sql`INSERT INTO findings(id,project_id,job_id,fingerprint,title,severity,verify_status)
        VALUES (${detachedFindingId},${projectId},${detachedJobId},${detachedFindingId},'无画布历史 Finding','medium','needs_human')`;
      const detachedDetail = await app.inject({ method: "GET", url: `/findings/${detachedFindingId}`, headers });
      assert.equal(detachedDetail.statusCode, 200, detachedDetail.payload);
      assert.equal(detachedDetail.json().verification_control, null);
      const detachedClose = await patch({ ...closeBody, mutation_id: randomUUID(),
        expected: { verify_status: "needs_human", subject_revision: null, latest_round_id: null } }, detachedFindingId);
      assert.equal(detachedClose.statusCode, 409, detachedClose.payload);
      assert.equal(detachedClose.json().error_code, "FINDING_CANVAS_INVALID");

      // #1264：人工证据按「单次处置」从审计记录给出，且只在有 tasks:read 时解析成目标；
      // 旧字段 evidence_refs_json 里人工追加的引用对无权限调用方不可见。
      const evidenceToken = generateToken();
      await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
        VALUES ('证据可读',${projectId},${evidenceToken.prefix},${evidenceToken.hash},${['findings:read','findings:write','tasks:read']})`;
      const [evidenceFinding] = await sql`SELECT job_id FROM findings WHERE id = ${findingId}`;
      const seedEvidence = async (label: string) => {
        const artifactId = randomUUID();
        const evidenceId = randomUUID();
        await sql`INSERT INTO artifacts(id,project_id,job_id,artifact_key,kind,source_operation)
          VALUES (${artifactId},${projectId},${String(evidenceFinding.job_id)},${`human-confirm-${label}`},'fact','emit_fact')`;
        await sql`INSERT INTO artifact_evidence(id,artifact_id,statement,kind)
          VALUES (${evidenceId},${artifactId},${`人工复现证据 ${label}`},'observation')`;
        return evidenceId;
      };
      const evidenceA = await seedEvidence("A");
      const firstConfirm = await app.inject({
        method: "PATCH", url: `/findings/${findingId}/disposition`, headers,
        payload: { disposition: "confirmed_vuln", note: "人工确认 A", evidence_refs: [evidenceA] },
      });
      assert.equal(firstConfirm.statusCode, 200, firstConfirm.payload);
      const withEvidence = await app.inject({
        method: "GET", url: `/findings/${findingId}`,
        headers: { authorization: `Bearer ${evidenceToken.plaintext}` },
      });
      assert.equal(withEvidence.statusCode, 200, withEvidence.payload);
      const firstHistory = withEvidence.json().disposition_history;
      assert.equal(Array.isArray(firstHistory) && firstHistory.length, 1, "有 tasks:read 时必须给出逐次处置历史");
      assert.equal(firstHistory[0].disposition, "confirmed_vuln");
      assert.equal(firstHistory[0].evidence[0].evidence_id, evidenceA);
      assert.equal(firstHistory[0].evidence[0].canvas_id, canvasId);
      assert.equal(firstHistory[0].evidence[0].statement, "人工复现证据 A");
      assert.equal("uri" in firstHistory[0].evidence[0], false, "不把原始 uri 当可点击目标下发");

      // 改判：每条决定各自保留自己的证据，旧决定仍可核查。
      const evidenceB = await seedEvidence("B");
      const rejudge = await app.inject({
        method: "PATCH", url: `/findings/${findingId}/disposition`, headers,
        payload: { disposition: "resolved", note: "改判 B", evidence_refs: [evidenceB] },
      });
      assert.equal(rejudge.statusCode, 200, rejudge.payload);
      const afterRejudge = await app.inject({
        method: "GET", url: `/findings/${findingId}`,
        headers: { authorization: `Bearer ${evidenceToken.plaintext}` },
      });
      const history = afterRejudge.json().disposition_history as Array<{
        disposition: string;
        note: string | null;
        evidence: Array<{ evidence_id: string }>;
      }>;
      assert.equal(history.length, 2, "两次处置各自留一条历史");
      assert.equal(history[0].disposition, "resolved");
      assert.deepEqual(history[0].evidence.map((item) => item.evidence_id), [evidenceB]);
      assert.equal(history[1].disposition, "confirmed_vuln");
      assert.deepEqual(history[1].evidence.map((item) => item.evidence_id), [evidenceA], "旧决定的证据仍可核查");

      const withoutTasksRead = await app.inject({ method: "GET", url: `/findings/${findingId}`, headers });
      assert.equal(withoutTasksRead.statusCode, 200, withoutTasksRead.payload);
      const masked = withoutTasksRead.json();
      assert.equal(masked.disposition_history, undefined, "没有 tasks:read 时不给逐次证据");
      assert.deepEqual(
        (masked.finding.evidence_refs_json as string[]).filter((ref) => ref === evidenceA || ref === evidenceB),
        [],
        "人工追加的证据引用不得顺着旧字段漏出",
      );

      // 同项目其他画布的证据也能点击（tasks:read 是项目级，不按画布收窄）。
      const otherCanvas = randomUUID();
      const otherCanvasJob = randomUUID();
      await sql`INSERT INTO canvases(id,project_id,title,status) VALUES (${otherCanvas},${projectId},'另一个画布','active')`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
        VALUES (${otherCanvasJob},${projectId},${otherCanvas},'explore','succeeded',${sql.json({})})`;
      const evidenceC = randomUUID();
      const artifactC = randomUUID();
      await sql`INSERT INTO artifacts(id,project_id,job_id,artifact_key,kind,source_operation)
        VALUES (${artifactC},${projectId},${otherCanvasJob},'human-confirm-C','fact','emit_fact')`;
      await sql`INSERT INTO artifact_evidence(id,artifact_id,statement,kind)
        VALUES (${evidenceC},${artifactC},'另一个画布上的证据 C','observation')`;
      const thirdDecision = await app.inject({
        method: "PATCH", url: `/findings/${findingId}/disposition`, headers,
        payload: { disposition: "accepted", note: "补充别的画布证据", evidence_refs: [evidenceC] },
      });
      assert.equal(thirdDecision.statusCode, 200, thirdDecision.payload);
      const crossCanvas = await app.inject({
        method: "GET", url: `/findings/${findingId}`,
        headers: { authorization: `Bearer ${evidenceToken.plaintext}` },
      });
      const crossCanvasHistory = crossCanvas.json().disposition_history as Array<{
        disposition: string;
        evidence: Array<{ evidence_id: string; canvas_id: string | null; job_id: string }>;
      }>;
      assert.equal(crossCanvasHistory[0].disposition, "accepted");
      assert.equal(crossCanvasHistory[0].evidence[0].evidence_id, evidenceC);
      assert.equal(crossCanvasHistory[0].evidence[0].canvas_id, otherCanvas, "同项目其他画布的证据也要给出来源画布");
      assert.equal(crossCanvasHistory[0].evidence[0].job_id, otherCanvasJob);

      // 跨项目令牌看不到这条 Finding。
      const otherProject = randomUUID();
      await sql`INSERT INTO projects(id,name) VALUES (${otherProject},'另一个项目')`;
      const otherToken = generateToken();
      await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
        VALUES ('别的项目',${otherProject},${otherToken.prefix},${otherToken.hash},${['findings:read','tasks:read']})`;
      const crossProject = await app.inject({
        method: "GET", url: `/findings/${findingId}`,
        headers: { authorization: `Bearer ${otherToken.plaintext}` },
      });
      assert.ok(crossProject.statusCode >= 400, `跨项目必须拒绝，实际 ${crossProject.statusCode}: ${crossProject.payload}`);
    } finally {
      if (stopListening) await stopListening().catch(() => undefined);
      if (closeApp) await closeApp().catch(() => undefined);
      if (endSql) await endSql().catch(() => undefined);
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
}
