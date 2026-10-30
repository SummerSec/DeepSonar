import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeTaskContract, deriveTaskGoalCriteria, type TaskResultProposal } from "@deepsonar/shared-types";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  test("task result review requires isolated PostgreSQL", { skip: "TEST_DATABASE_URL unset; refusing default database" }, () => {});
} else {
  test("Fact task results support independent delivery and negative-result review without Findings", async (t) => {
    const adminUrl = new URL(databaseUrl); adminUrl.pathname = "/postgres"; adminUrl.search = "";
    const admin = (await import("postgres")).default(adminUrl.toString(), { max: 1 });
    const name = `result_review_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const dbUrl = new URL(adminUrl); dbUrl.pathname = `/${name}`;
    const blobDir = await mkdtemp(path.join(os.tmpdir(), "task-result-review-"));
    let created = false; let close: (() => Promise<unknown>) | undefined; let closeApp: (() => Promise<unknown>) | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
      process.env.DATABASE_URL = dbUrl.toString(); process.env.BLOB_DIR = blobDir;
      process.env.DEEPSONAR_AUTH_REQUIRED = "true"; process.env.AGENT_MODE = "fake"; process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      const [{ sql, migrate }, { ingestEvent }, { freezeGoalReviewAssignment }, { prepareTaskGoalReview }, { taskContractDigest }, { loadTaskOutcomeReport }] = await Promise.all([
        import("./db.js"), import("./core.js"), import("./task-goal-review-source.js"), import("./task-goal-review.js"), import("./task-outcome-snapshot.js"), import("./task-outcome-report.js"),
      ]);
      close = () => sql.end({ timeout: 5 }); await migrate();
      const [{ default: Fastify }, { default: websocket }, { registerRoutes }, { generateToken }, { createAttempt }] = await Promise.all([
        import("fastify"), import("@fastify/websocket"), import("./routes.js"), import("./auth.js"), import("./domains/job-attempt/index.js"),
      ]);
      const app = Fastify({ logger: false }); closeApp = () => app.close(); await app.register(websocket); registerRoutes(app); await app.ready();
      const contract = normalizeTaskContract({ schema_version: 1, template_id: "engineering", template_version: 1,
        objective: "Deliver parser regression investigation", targets: ["fixture-parser"], scope: ["Local parser fixture"],
        evidence: ["Retained reproducible test output"], acceptance: ["Malformed input does not cause the specified crash"],
        required_actions: ["read"], allowed_actions: ["read"] });
      const criterionIds = deriveTaskGoalCriteria(contract).map((item) => item.id);
      const hash = taskContractDigest(contract);
      const snapshot = { name: "audit", role_kind: "role", task_contract: contract, platform_tools: ["emit_fact", "mark_job_done"], network_policy: { allow_egress: false } };
      type Job = { jobId: string; attemptId: string; projectId: string; canvasId: string };
      const start = async (jobId: string, projectId: string, canvasId: string): Promise<Job> => {
        await sql`UPDATE jobs SET status='running' WHERE id=${jobId}`;
        const attempt = await sql.begin((tx) => createAttempt(tx as unknown as typeof sql, jobId));
        return { jobId, attemptId: String(attempt.id), projectId, canvasId };
      };
      const finish = async (job: Job) => {
        await sql`UPDATE job_attempts SET status='succeeded',phase='terminal' WHERE id=${job.attemptId}`;
        await sql`UPDATE jobs SET status='succeeded' WHERE id=${job.jobId}`;
      };
      const emit = async (job: Job, artifact: object) => {
        const eventId = randomUUID();
        await ingestEvent(job.jobId, { v: 1, event_id: eventId, type: "fact", payload: {
          title: "Parser investigation observation", description: "This scoped parser observation is backed by the declared method and retained execution evidence.", artifact,
        } } as never);
        const [row] = await sql`SELECT id,node_id FROM artifacts WHERE job_id=${job.jobId} AND source_event_id=${eventId}`;
        return { artifactId: String(row.id), factId: String(row.node_id) };
      };
      const proof = async (job: Job) => {
        const relative = `attempts/${job.attemptId}/proof.txt`, bytes = Buffer.from("Fixture matrix executed: specified crash was not observed.\n");
        const sha256 = createHash("sha256").update(bytes).digest("hex"), directory = path.join(blobDir, "jobs", job.jobId);
        const file = path.join(directory, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
        await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ v: 1, job_id: job.jobId, finalized_at: new Date().toISOString(), files: [{ path: relative, bytes: bytes.length, sha256 }] }));
        const fact = await emit(job, { evidence: [{ kind: "runtime.result", statement: "Scoped parser test matrix output", uri: `jobs/${job.jobId}/${relative}`, sha256 }] });
        return { ...fact, file, bytes };
      };
      const source = async (kind: TaskResultProposal["kind"] = "delivery", limitations?: string[]) => {
        const projectId = randomUUID(), canvasId = randomUUID(), jobId = randomUUID();
        await sql`INSERT INTO projects(id,name,config_json) VALUES(${projectId},'task result fixture',${sql.json({ rules: { hubEnabled: false }, enabled_credential_ids: [] })})`;
        await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${projectId},'Task result fixture',${sql.json({ task_contract: contract, network_policy: { allow_egress: false } } as never)})`;
        await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status) VALUES(${canvasId},'root','fixture','active')`;
        await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json) VALUES(${jobId},${projectId},${canvasId},'audit','pending',${sql.json(snapshot as never)},'{}'::jsonb)`;
        await sql`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status) VALUES(${canvasId},${jobId},'intent','fixture','pending')`;
        const maker = await start(jobId, projectId, canvasId);
        const executed = kind === "delivery" || kind === "negative_result";
        const evidence = executed ? await proof(maker) : undefined;
        const proposal: TaskResultProposal = { schema_version: 1, kind, task_contract_sha256: hash, target: "fixture-parser", criterion_ids: criterionIds,
          method: executed ? "Execute the declared malformed-input matrix" : "Execution could not start", observed: executed ? "No specified crash observed in the scoped test matrix" : "No test execution occurred",
          limitations: limitations ?? (executed ? [] : ["Required fixture unavailable"]), evidence_refs: evidence ? [evidence.factId] : [] };
        const result = await emit(maker, { task_result: proposal }); await finish(maker);
        const token = generateToken(); await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
          VALUES('result reviewer',${projectId},${token.prefix},${token.hash},${["tasks:write", "tasks:read", "jobs:control"]})`;
        const request = { schema_version: 1, fact_id: result.factId, candidate_artifact_id: result.artifactId, task_contract_sha256: hash, criterion_ids: criterionIds };
        return { ...maker, ...result, proposal, evidence, request, headers: { authorization: `Bearer ${token.plaintext}` } };
      };
      type Source = Awaited<ReturnType<typeof source>>;
      const createReviewer = (candidate: Source, request: unknown = candidate.request) => app.inject({ method: "POST", url: "/jobs", headers: candidate.headers,
        payload: { project_id: candidate.projectId, type: "audit", payload: { goal_review: request, prompt: "Independently execute the scoped parser matrix and judge every assigned criterion." } } });
      const evaluate = async (candidate: Source, rerun = false, existingJobId?: string) => {
        const response = existingJobId ? undefined : await createReviewer(candidate);
        if (response) assert.equal(response.statusCode, 201, response.payload);
        const jobId = existingJobId ?? String(response!.json().id);
        const [initial] = await sql`SELECT agent_snapshot_json,payload_json FROM jobs WHERE id=${jobId}`;
        assert.equal(initial.payload_json.related_finding_ids, undefined);
        assert.equal(initial.agent_snapshot_json.task_goal_review.request.fact_id, candidate.factId);
        if (rerun) {
          const attempt = await sql.begin((tx) => createAttempt(tx as unknown as typeof sql, jobId));
          await sql`UPDATE job_attempts SET status='failed' WHERE id=${String(attempt.id)}`;
          await sql`UPDATE jobs SET status='failed' WHERE id=${jobId}`;
          const replay = await app.inject({ method: "POST", url: `/jobs/${jobId}/rerun-current`, headers: candidate.headers });
          assert.equal(replay.statusCode, 200, replay.payload);
          assert.deepEqual((await sql`SELECT agent_snapshot_json->'task_goal_review' AS assignment FROM jobs WHERE id=${jobId}`)[0].assignment, initial.agent_snapshot_json.task_goal_review);
        }
        const reviewer = await start(jobId, candidate.projectId, candidate.canvasId), evidence = await proof(reviewer);
        await emit(reviewer, { goal_review: { schema_version: 1, assignment_sha256: initial.agent_snapshot_json.task_goal_review.assignment_sha256,
          criteria: criterionIds.map((criterion_id) => ({ criterion_id, scope: "entire_criterion", assessment: "satisfied", expected: "Scoped parser task criterion is met",
            actual: "Independent scoped matrix completed", rationale: "The retained output covers the entire assigned criterion", limitations: [], evidence_refs: [evidence.factId] })) } });
        await finish(reviewer); return { ...reviewer, evidence };
      };
      for (const kind of ["delivery", "negative_result"] as const) await t.test(`${kind} reaches independent criteria satisfaction with zero Findings`, async () => {
        const candidate = await source(kind);
        assert.equal((await loadTaskOutcomeReport(sql, candidate.canvasId, candidate.projectId)).goal_assessment, "blocked");
        await evaluate(candidate, true);
        const report = await loadTaskOutcomeReport(sql, candidate.canvasId, candidate.projectId);
        assert.equal(report.findings.length, 0); assert.equal(report.task_results?.length, 1);
        assert.equal(report.task_results?.[0].kind, kind); assert.equal(report.task_results?.[0].assessment, "criteria_satisfied");
        assert.equal(report.goal_assessment, "criteria_satisfied"); assert.ok(report.gaps.includes("overall_completion_owned_by_plan"));
        assert.equal((await sql`SELECT count(*)::int AS count FROM findings WHERE project_id=${candidate.projectId}`)[0].count, 0);
        const scoped = await loadTaskOutcomeReport(sql, candidate.canvasId, candidate.projectId, [randomUUID()]);
        assert.deepEqual(scoped.task_results, []); assert.deepEqual(scoped.review_records, []);
      });
      await t.test("Hub dispatches a Fact-source reviewer without fabricating Finding associations", async () => {
        const candidate = await source(), hubId = randomUUID();
        await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json)
          VALUES(${hubId},${candidate.projectId},${candidate.canvasId},'hub_reason','pending',${sql.json({ ...snapshot, name: "hub_reason", role_kind: "hub", platform_tools: ["submit_hub_decision"] } as never)},'{}'::jsonb)`;
        await sql`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status) VALUES(${candidate.canvasId},${hubId},'intent','Hub review proposal','pending')`;
        await start(hubId, candidate.projectId, candidate.canvasId);
        await ingestEvent(hubId, { v: 1, event_id: randomUUID(), type: "hub_decision", payload: { intents: [{
          from: [candidate.factId], role: "audit", description: "Independent Fact source evaluation",
          prompt: "Independently execute the scoped matrix and evaluate the entire assigned criterion.", goal_review: candidate.request,
        }] } });
        const [child] = await sql`SELECT id,finding_id,payload_json FROM jobs WHERE parent_job_id=${hubId}`;
        assert.ok(child); assert.equal(child.finding_id, null); assert.equal(child.payload_json.related_finding_ids, undefined);
        await evaluate(candidate, true, String(child.id));
        assert.equal((await loadTaskOutcomeReport(sql, candidate.canvasId, candidate.projectId)).goal_assessment, "criteria_satisfied");
      });
      for (const kind of ["blocked", "not_executed"] as const) await t.test(`${kind} remains a visible gap and cannot receive positive review`, async () => {
        const candidate = await source(kind), response = await createReviewer(candidate);
        assert.equal(response.statusCode, 409, response.payload);
        const report = await loadTaskOutcomeReport(sql, candidate.canvasId, candidate.projectId);
        assert.equal(report.task_results?.[0].kind, kind); assert.equal(report.task_results?.[0].assessment, "blocked");
        assert.ok(report.task_results?.[0].gaps.includes("task_result_not_reviewable")); assert.equal(report.goal_assessment, "blocked");
      });
      for (const kind of ["blocked", "not_executed"] as const) await t.test(`failed ${kind} declaration retains bounded limitations and execution provenance`, async () => {
        const candidate = await source(kind, ["Required fixture unavailable: " + "x".repeat(300)]);
        await sql`UPDATE jobs SET status='failed' WHERE id=${candidate.jobId}`;
        await sql`UPDATE job_attempts SET status='failed' WHERE id=${candidate.attemptId}`;
        const report = await loadTaskOutcomeReport(sql, candidate.canvasId, candidate.projectId), item = report.task_results![0];
        assert.equal(item.kind, kind); assert.equal(item.assessment, "blocked");
        assert.equal(item.source_job_id, candidate.jobId); assert.equal(item.source_attempt_id, candidate.attemptId);
        assert.equal(item.artifact_id, candidate.artifactId); assert.equal(item.artifact_revision, 1);
        assert.ok(item.gaps.includes("task_result_execution_not_succeeded")); assert.ok(item.gaps.includes("task_result_not_reviewable"));
        assert.equal(item.limitations[0].length, 200); assert.equal(item.limitations_truncated, true);
      });
      for (const mutation of ["extension", "node", "event"] as const) await t.test(`forged ${mutation} cannot be displayed as a trusted task-result declaration`, async () => {
        const candidate = await source("blocked");
        if (mutation === "extension") await sql`UPDATE artifacts SET extensions_json=jsonb_set(extensions_json,'{task_result,proposal,observed}','"Forged statement"'::jsonb) WHERE id=${candidate.artifactId}`;
        if (mutation === "node") await sql`UPDATE canvas_nodes SET body_json=jsonb_set(body_json,'{task_result}','{}'::jsonb) WHERE id=${candidate.factId}`;
        if (mutation === "event") await sql`UPDATE events SET payload_json=jsonb_set(payload_json,'{artifact,task_result,observed}','"Forged statement"'::jsonb)
          WHERE job_id=${candidate.jobId} AND event_id=(SELECT source_event_id FROM artifacts WHERE id=${candidate.artifactId})`;
        const report = await loadTaskOutcomeReport(sql, candidate.canvasId, candidate.projectId), item = report.task_results![0];
        assert.equal(item.kind, "unknown"); assert.equal(item.task_contract_sha256, null); assert.equal(item.assessment, "blocked");
        assert.deepEqual(item.limitations, []); assert.equal(item.source_attempt_id, null); assert.ok(item.gaps.length);
        assert.equal(report.goal_assessment, "blocked");
      });
      await t.test("review declarations with retained-file metadata cannot masquerade as raw reviewer proof", async () => {
        const candidate = await source(), response = await createReviewer(candidate);
        assert.equal(response.statusCode, 201, response.payload);
        const reviewer = await start(String(response.json().id), candidate.projectId, candidate.canvasId);
        const raw = await proof(reviewer);
        const declaration = await emit(reviewer, { task_result: { ...candidate.proposal, evidence_refs: [raw.factId] }, evidence: [{
          kind: "runtime.result", statement: "Retained file attached to a result declaration",
          uri: `jobs/${reviewer.jobId}/attempts/${reviewer.attemptId}/proof.txt`, sha256: createHash("sha256").update(raw.bytes).digest("hex"),
        }] });
        const [job] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id=${reviewer.jobId}`;
        const review = (factId: string) => ({ goal_review: { schema_version: 1,
          assignment_sha256: job.agent_snapshot_json.task_goal_review.assignment_sha256,
          criteria: criterionIds.map((criterion_id) => ({ criterion_id, scope: "entire_criterion", assessment: "satisfied",
            expected: "Entire parser criterion is met", actual: "Independent matrix completed", rationale: "Retained output covers the assigned criterion",
            limitations: [], evidence_refs: [factId] })) } });
        await assert.rejects(emit(reviewer, review(declaration.factId)), /goal_review_evidence_not_owned_or_unavailable/);
        assert.equal((await sql`SELECT count(*)::int AS count FROM artifacts WHERE job_id=${reviewer.jobId} AND kind='task.goal_evaluation'`)[0].count, 0);
        await emit(reviewer, review(raw.factId)); await finish(reviewer);
        assert.equal((await loadTaskOutcomeReport(sql, candidate.canvasId, candidate.projectId)).goal_assessment, "criteria_satisfied");
        const [original] = await sql`SELECT kind,extensions_json FROM artifacts WHERE id=${raw.artifactId}`;
        for (const mutation of ["task.result", "task.goal_evaluation", "task_result", "task_goal_review"]) {
          try {
            if (mutation.includes(".")) await sql`UPDATE artifacts SET kind=${mutation} WHERE id=${raw.artifactId}`;
            else await sql`UPDATE artifacts SET extensions_json=extensions_json || ${sql.json({ [mutation]: {} })} WHERE id=${raw.artifactId}`;
            const report = await loadTaskOutcomeReport(sql, candidate.canvasId, candidate.projectId);
            assert.notEqual(report.goal_assessment, "criteria_satisfied");
            assert.ok(report.review_records?.some((item) => item.gaps?.includes("goal_review_evidence_not_owned_or_unavailable")), mutation);
          } finally {
            await sql`UPDATE artifacts SET kind=${String(original.kind)},extensions_json=${sql.json(original.extensions_json)} WHERE id=${raw.artifactId}`;
          }
        }
      });
      await t.test("cross-scope, wrong Artifact and maker self-review cannot acquire authority", async () => {
        const candidate = await source(), other = await source();
        for (const request of [other.request, { ...candidate.request, candidate_artifact_id: other.artifactId }]) {
          const response = await createReviewer(candidate, request); assert.equal(response.statusCode, 404, response.payload);
        }
        const frozen = await freezeGoalReviewAssignment(sql, candidate.projectId, candidate.canvasId, snapshot, candidate.request);
        await assert.rejects(prepareTaskGoalReview(sql, { id: candidate.jobId, project_id: candidate.projectId, canvas_id: candidate.canvasId,
          status: "running", agent_snapshot_json: frozen }, candidate.attemptId, {}), /self_review_forbidden/);
      });
      await t.test("truncated task-result source scan cannot retain an otherwise positive task assessment", async () => {
        const candidate = await source(); await evaluate(candidate);
        await sql`UPDATE jobs SET status='running' WHERE id=${candidate.jobId}`;
        await sql`UPDATE job_attempts SET status='active' WHERE id=${candidate.attemptId}`;
        for (let index = 0; index < 100; index++) await emit(candidate, { task_result: { ...candidate.proposal, observed: `Additional scoped observation ${index}` } });
        await finish(candidate);
        const report = await loadTaskOutcomeReport(sql, candidate.canvasId, candidate.projectId);
        assert.equal(report.truncated, true); assert.equal(report.task_results?.length, 100);
        assert.ok(report.gaps.includes("task_result_projection_truncated"));
        assert.equal(report.goal_assessment, "blocked"); assert.ok(report.criteria.every((item) => item.assessment === "insufficient"));
      });
      await t.test("changed source revision and tampered retained bytes revoke positive report projection", async () => {
        const candidate = await source(); await evaluate(candidate);
        await sql`UPDATE artifacts SET revision=revision+1 WHERE id=${candidate.artifactId}`;
        let report = await loadTaskOutcomeReport(sql, candidate.canvasId, candidate.projectId);
        assert.notEqual(report.goal_assessment, "criteria_satisfied"); assert.ok(report.review_records?.some((item) => item.gaps?.includes("goal_review_source_changed")));
        await sql`UPDATE artifacts SET revision=revision-1 WHERE id=${candidate.artifactId}`;
        await writeFile(candidate.evidence!.file, "tampered output");
        report = await loadTaskOutcomeReport(sql, candidate.canvasId, candidate.projectId);
        assert.notEqual(report.goal_assessment, "criteria_satisfied"); assert.equal(report.task_results?.[0].assessment, "blocked");
      });
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (close) await close().catch(() => undefined);
      if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }); await rm(blobDir, { recursive: true, force: true });
    }
  });
}
