import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeTaskContract } from "@deepsonar/shared-types";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  test("goal review integration requires isolated PostgreSQL", { skip: "TEST_DATABASE_URL unset; refusing default database" }, () => {});
} else {
  test("POST jobs scopes goal-review requests to the existing candidate Canvas", async (t) => {
    const adminUrl = new URL(databaseUrl); adminUrl.pathname = "/postgres"; adminUrl.search = "";
    const admin = (await import("postgres")).default(adminUrl.toString(), { max: 1 });
    const name = `goal_route_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const dbUrl = new URL(adminUrl); dbUrl.pathname = `/${name}`;
    const blobDir = await mkdtemp(path.join(os.tmpdir(), "goal-review-"));
    let closeApp: (() => Promise<unknown>) | undefined;
    let created = false; let close: (() => Promise<unknown>) | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
      process.env.DATABASE_URL = dbUrl.toString(); process.env.BLOB_DIR = blobDir;
      process.env.DEEPSONAR_AUTH_REQUIRED = "true"; process.env.AGENT_MODE = "fake"; process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      const [{ sql, migrate }, { ingestEvent }, { freezeGoalReviewAssignment, loadGoalReviewSource }, { loadTaskGoalReviews }, { taskContractDigest }] = await Promise.all([
        import("./db.js"), import("./core.js"), import("./task-goal-review-source.js"), import("./task-goal-review.js"), import("./task-outcome-snapshot.js"),
      ]);
      close = () => sql.end({ timeout: 5 }); await migrate();
      const contract = normalizeTaskContract({ schema_version: 1, template_id: "engineering", template_version: 1,
        objective: "Improve parser", targets: ["fixture-parser"], scope: ["Fixture parser"], evidence: ["Retained reproducible observations"],
        acceptance: ["Parser handles malformed input"], allowed_actions: ["read"], required_actions: ["read"] });
      const snapshot = { name: "audit", role_kind: "role", task_contract: contract, platform_tools: ["emit_fact", "emit_finding", "mark_job_done"], network_policy: { allow_egress: false } };
      const protocol = { mode: "hybrid", default_profile: "general", allowed_profiles: ["general", "security.vulnerability"],
        scoring: { default_standard: "CVSS", default_version: "3.1", accepted_versions: ["3.1", "4.0"], require_scoring_for_profiles: [] }, display_name: "fixture", source: "task" };
      const seedJob = async (projectId: string, canvasId: string, frozen: object = snapshot) => {
        const jobId = randomUUID(), attemptId = randomUUID();
        await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json)
          VALUES(${jobId},${projectId},${canvasId},'audit','running',${sql.json(frozen as never)},'{}'::jsonb)`;
        await sql`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase) VALUES(${attemptId},${jobId},1,'active','agent.ready')`;
        await sql`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status) VALUES(${canvasId},${jobId},'intent','fixture','running')`;
        return { projectId, canvasId, jobId, attemptId };
      };
      type Job = { projectId: string; canvasId: string; jobId: string; attemptId: string };
      const finish = async (job: Job) => {
        await sql`UPDATE job_attempts SET status='succeeded',phase='terminal' WHERE id=${job.attemptId}`;
        await sql`UPDATE jobs SET status='succeeded' WHERE id=${job.jobId}`;
      };
      const emitObservation = async (job: Job, artifact?: object) => {
        const eventId = randomUUID();
        await ingestEvent(job.jobId, { v: 1, event_id: eventId, type: "fact", payload: {
          title: "Observed parser fixture", description: "The parser fixture returned the measured behavior recorded by this isolated test.", ...(artifact ? { artifact } : {}),
        } } as never);
        const [row] = await sql`SELECT id,node_id FROM artifacts WHERE source_event_id=${eventId} AND job_id=${job.jobId}`;
        assert.ok(row?.node_id); return { factId: String(row.node_id), artifactId: String(row.id) };
      };
      const source = async (bounty = false) => {
        const taskContract = bounty ? normalizeTaskContract({ ...contract, outcome: { mode: "bounty_submission", rules_status: "supplied", rule_snapshot: {
          schema_version: 1, program_id: "fixture", version: "1", source: { provenance: "operator_supplied", reference: "attachment://fixture", sha256: `sha256:${"c".repeat(64)}` },
          targets: [{ id: "parser", type: "repository", reference: "fixture-parser", baseline: "fixture-v1" }],
          rules: [{ id: "scope", kind: "requirement", description: "Fixture-only behavior" }],
        } } }) : contract;
        const projectId = randomUUID(), canvasId = randomUUID();
        await sql`INSERT INTO projects(id,name,config_json) VALUES(${projectId},'goal review fixture',${sql.json({ rules: { hubEnabled: false }, enabled_credential_ids: [] })})`;
        await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${projectId},'fixture',${sql.json({ task_contract: taskContract, effective_finding_protocol: protocol, network_policy: { allow_egress: false } } as never)})`;
        await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status) VALUES(${canvasId},'root','fixture','active')`;
        const maker = await seedJob(projectId, canvasId, { ...snapshot, task_contract: taskContract }), observation = await emitObservation(maker);
        const claim = { schema_version: 1, task_contract_sha256: taskContractDigest(taskContract), target: "fixture-parser", ...(bounty ? { baseline: "fixture-v1", rule_assessments: [{ rule_id: "scope", result: "matches", evidence_refs: [observation.factId] }] } : {}), evidence_refs: [observation.factId],
          criterion_assessments: ["objective", "scope", "evidence", "acceptance:0"].map((criterion_id) => ({ criterion_id, result: "matches", evidence_refs: [observation.factId] })) };
        await ingestEvent(maker.jobId, { v: 1, event_id: randomUUID(), type: "finding", payload: { title: "Parser fixture candidate", summary: "The parser fixture returned a measurable response for malformed input in the isolated test.", profile: "general", outcome_claim: claim } } as never);
        await finish(maker);
        const [finding] = await sql`SELECT id,artifact_id FROM findings WHERE job_id=${maker.jobId}`;
        assert.ok(finding);
        const request = { schema_version: 1 as const, finding_id: String(finding.id), candidate_artifact_id: String(finding.artifact_id), task_contract_sha256: taskContractDigest(taskContract), criterion_ids: ["acceptance:0"] };
        return { ...maker, observation, request, taskContract };
      };

      const [{ default: Fastify }, { default: websocket }, { registerRoutes }, { generateToken }] = await Promise.all([
        import("fastify"), import("@fastify/websocket"), import("./routes.js"), import("./auth.js"),
      ]);
      const app = Fastify({ logger: false }); closeApp = () => app.close();
      await app.register(websocket); registerRoutes(app); await app.ready();
      const candidate = await source(), other = await source();
      const token = generateToken();
      await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
        VALUES('goal reviewer',${candidate.projectId},${token.prefix},${token.hash},${["tasks:write", "tasks:read", "jobs:control"]})`;
      const headers = { authorization: `Bearer ${token.plaintext}` };
      const post = (request: unknown = candidate.request, type = "audit", projectId = candidate.projectId) => app.inject({
        method: "POST", url: "/jobs", headers, payload: { project_id: projectId, type,
          payload: { goal_review: request, prompt: "Independently compare the entire frozen criterion using retained evidence." } },
      });
      const counts = async () => (await sql`SELECT (SELECT count(*)::int FROM canvases) AS canvases,(SELECT count(*)::int FROM jobs) AS jobs`)[0];
      await t.test("invalid schema, cross-project references and absent candidates leave no Canvas or Job", async () => {
        for (const [request, status] of [[{ ...candidate.request, schema_version: 99 }, 400],
          [{ ...candidate.request, verified: true }, 400], [other.request, 404],
          [{ ...candidate.request, finding_id: randomUUID() }, 404],
          [{ ...candidate.request, candidate_artifact_id: randomUUID() }, 404]] as const) {
          const before = await counts(), response = await post(request);
          assert.equal(response.statusCode, status, response.payload); assert.deepEqual(await counts(), before);
          assert.ok(response.json().error_code); assert.equal(response.json().stack, undefined);
        }
        const before = await counts(); assert.equal((await post(other.request, "audit", other.projectId)).statusCode, 403);
        assert.deepEqual(await counts(), before);
      });
      await t.test("archived projects and system roles cannot create review Jobs", async () => {
        for (const type of ["hub_reason", "verify_finding", "report", "verify"]) {
          const before = await counts(); assert.equal((await post(candidate.request, type)).statusCode, 409);
          assert.deepEqual(await counts(), before);
        }
        await sql`UPDATE projects SET status='archived' WHERE id=${candidate.projectId}`;
        const before = await counts(); assert.equal((await post()).statusCode, 409); assert.deepEqual(await counts(), before);
        await sql`UPDATE projects SET status='active' WHERE id=${candidate.projectId}`;
      });
      await t.test("source validation errors are structured 409 without residual state", async () => {
        const before = await counts();
        const response = await post({ ...candidate.request, task_contract_sha256: `sha256:${"a".repeat(64)}` });
        assert.equal(response.statusCode, 409, response.payload);
        assert.equal(response.json().error_code, "invalid_payload");
        assert.equal(response.json().field, "goal_review");
        assert.equal(response.json().details.task_goal_review.code, "goal_review_contract_mismatch");
        assert.equal(response.json().stack, undefined); assert.deepEqual(await counts(), before);
      });
      const createReviewer = async (entry: "public" | "hub") => {
        if (entry === "public") {
          const response = await post(); assert.equal(response.statusCode, 201, response.payload);
          return String(response.json().id);
        }
        const hub = await seedJob(candidate.projectId, candidate.canvasId, { ...snapshot, name: "hub_reason", role_kind: "hub", platform_tools: ["submit_hub_decision"] });
        await sql`UPDATE jobs SET type='hub_reason' WHERE id=${hub.jobId}`;
        const [finding] = await sql`SELECT node_id FROM findings WHERE id=${candidate.request.finding_id}`;
        await ingestEvent(hub.jobId, { v: 1, event_id: randomUUID(), type: "hub_decision", payload: { intents: [{
          from: [String(finding.node_id)], role: "audit", description: `Independent parser review ${hub.jobId}`,
          prompt: "Compare the entire frozen parser criterion with independently retained test evidence.", goal_review: candidate.request,
        }] } });
        return String((await sql`SELECT id FROM jobs WHERE parent_job_id=${hub.jobId}`)[0].id);
      };
      const makeRecoverable = async (jobId: string, status: "failed" | "timeout" | "waiting_human") => {
        const { createAttempt } = await import("./domains/job-attempt/index.js");
        const attempt = await sql.begin((tx) => createAttempt(tx as unknown as typeof sql, jobId));
        await sql`UPDATE jobs SET status=${status} WHERE id=${jobId}`;
        if (status !== "waiting_human") await sql`UPDATE job_attempts SET status=${status} WHERE id=${String(attempt.id)}`;
        return String(attempt.id);
      };
      const rerun = (jobId: string) => app.inject({ method: "POST", url: `/jobs/${jobId}/rerun-current`, headers });
      for (const entry of ["public", "hub"] as const) {
        for (const status of ["failed", "timeout", "waiting_human"] as const) {
          await t.test(`${entry} ${status} rerun preserves validated assignment and accepts new-Attempt evidence`, async () => {
            const jobId = await createReviewer(entry), oldAttempt = await makeRecoverable(jobId, status);
            const [before] = await sql`SELECT agent_snapshot_json,payload_json FROM jobs WHERE id=${jobId}`;
            if (entry === "hub") assert.equal(before.payload_json.goal_review, undefined);
            const response = await rerun(jobId); assert.equal(response.statusCode, 200, response.payload);
            const [after] = await sql`SELECT status,agent_snapshot_json FROM jobs WHERE id=${jobId}`;
            assert.equal(after.status, "pending");
            assert.deepEqual(after.agent_snapshot_json.task_goal_review, before.agent_snapshot_json.task_goal_review);
            if (status === "waiting_human") assert.equal((await sql`SELECT status FROM job_attempts WHERE id=${oldAttempt}`)[0].status, "interrupted");
            const attemptId = randomUUID();
            await sql`UPDATE jobs SET status='running' WHERE id=${jobId}`;
            await sql`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase) VALUES(${attemptId},${jobId},2,'active','agent.ready')`;
            const relative = `attempts/${attemptId}/review.txt`, bytes = Buffer.from("independent parser regression passed\n");
            const hash = createHash("sha256").update(bytes).digest("hex"), directory = path.join(blobDir, "jobs", jobId);
            await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
            await writeFile(path.join(directory, relative), bytes);
            const job = { jobId, attemptId, projectId: candidate.projectId, canvasId: candidate.canvasId };
            const evidence = await emitObservation(job, { evidence: [{ kind: "runtime.result", statement: "Independent regression output", uri: `jobs/${jobId}/${relative}`, sha256: hash }] });
            await ingestEvent(jobId, { v: 1, event_id: randomUUID(), type: "fact", payload: {
              title: "Independent entire criterion review", description: "The new execution compares the whole parser criterion against retained output.",
              artifact: { goal_review: { schema_version: 1, assignment_sha256: after.agent_snapshot_json.task_goal_review.assignment_sha256,
                criteria: [{ criterion_id: "acceptance:0", scope: "entire_criterion", assessment: "satisfied", expected: "Malformed input handled",
                  actual: "Independent regression passed", rationale: "Retained execution covers the whole assigned criterion", limitations: [], evidence_refs: [evidence.factId] }] } },
            } });
            await finish(job);
            await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ v: 1, job_id: jobId, finalized_at: new Date().toISOString(), files: [{ path: relative, bytes: bytes.length, sha256: hash }] }));
            const loaded = await loadTaskGoalReviews(sql, candidate.projectId, candidate.canvasId, [candidate.request.finding_id]);
            const record = loaded.reviews.find((item) => item.jobId === jobId);
            assert.deepEqual(record?.blockedReasons, []); assert.equal(record?.criteria[0].assessment, "satisfied");
            assert.equal(record?.attemptId, attemptId);
          });
        }
        for (const mutation of ["source_changed", "revoked", "old_schema", "bad_digest", "contract_changed", "payload_changed", "role_unregistered"] as const) {
          await t.test(`${entry} rerun refuses ${mutation} without changing status or snapshot`, async () => {
            const jobId = await createReviewer(entry); await makeRecoverable(jobId, "failed");
            const [original] = await sql`SELECT agent_snapshot_json,payload_json FROM jobs WHERE id=${jobId}`;
            if (mutation === "role_unregistered") await sql`UPDATE agent_roles SET name='audit-disabled-fixture' WHERE name='audit'`;
            if (mutation === "source_changed") await sql`UPDATE artifacts SET revision=revision+1 WHERE id=${candidate.request.candidate_artifact_id}`;
            if (mutation === "revoked") await sql`UPDATE canvas_nodes SET verification_status='rejected' WHERE id=${candidate.observation.factId}`;
            if (mutation === "contract_changed") await sql`UPDATE canvases SET target_json=jsonb_set(target_json,'{task_contract,objective}','"Changed goal"'::jsonb) WHERE id=${candidate.canvasId}`;
            if (mutation === "old_schema") await sql`UPDATE jobs SET agent_snapshot_json=jsonb_set(agent_snapshot_json,'{task_goal_review,schema_version}','0'::jsonb) WHERE id=${jobId}`;
            if (mutation === "bad_digest") await sql`UPDATE jobs SET agent_snapshot_json=jsonb_set(agent_snapshot_json,'{task_goal_review,assignment_sha256}',${sql.json(`sha256:${"a".repeat(64)}`)}) WHERE id=${jobId}`;
            if (mutation === "payload_changed") await sql`UPDATE jobs SET payload_json=jsonb_set(payload_json,'{goal_review}',${sql.json({ ...candidate.request, criterion_ids: ["objective"] })}) WHERE id=${jobId}`;
            const [before] = await sql`SELECT status,agent_snapshot_json,payload_json FROM jobs WHERE id=${jobId}`;
            try {
              const response = await rerun(jobId); assert.equal(response.statusCode, 409, response.payload);
              assert.equal(response.json().error_code, "SNAPSHOT_STALE");
              assert.deepEqual((await sql`SELECT status,agent_snapshot_json,payload_json FROM jobs WHERE id=${jobId}`)[0], before);
            } finally {
              if (mutation === "role_unregistered") await sql`UPDATE agent_roles SET name='audit' WHERE name='audit-disabled-fixture'`;
              if (mutation === "source_changed") await sql`UPDATE artifacts SET revision=revision-1 WHERE id=${candidate.request.candidate_artifact_id}`;
              if (mutation === "revoked") await sql`UPDATE canvas_nodes SET verification_status='unverified' WHERE id=${candidate.observation.factId}`;
              if (mutation === "contract_changed") await sql`UPDATE canvases SET target_json=jsonb_set(target_json,'{task_contract}',${sql.json(candidate.taskContract as never)}) WHERE id=${candidate.canvasId}`;
              await sql`UPDATE jobs SET agent_snapshot_json=${sql.json(original.agent_snapshot_json)},payload_json=${sql.json(original.payload_json)} WHERE id=${jobId}`;
            }
          });
        }
      }
      await t.test("successful API review creation reuses the candidate Canvas and freezes assignment", async () => {
        const before = await counts(), response = await post();
        assert.equal(response.statusCode, 201, response.payload);
        const body = response.json();
        const [row] = await sql`SELECT canvas_id,status,agent_snapshot_json,payload_json FROM jobs WHERE id=${body.id}`;
        assert.equal(row.canvas_id, candidate.canvasId); assert.equal(row.status, "pending");
        assert.equal(row.agent_snapshot_json.task_goal_review.request.finding_id, candidate.request.finding_id);
        assert.equal(row.agent_snapshot_json.task_goal_review.request.candidate_artifact_id, candidate.request.candidate_artifact_id);
        assert.ok(row.agent_snapshot_json.task_goal_review.forbidden_job_ids.includes(candidate.jobId));
        assert.ok(row.payload_json.related_finding_ids.includes(candidate.request.finding_id));
        const after = await counts(); assert.equal(after.canvases, before.canvases); assert.equal(after.jobs, before.jobs + 1);
      });
    } finally {
      if (closeApp) await closeApp().catch(() => undefined);
      if (close) await close().catch(() => undefined);
      if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }); await rm(blobDir, { recursive: true, force: true });
    }
  });
}
