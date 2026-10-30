import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeTaskContract, type TaskGoalReviewResult, type TaskGoalReviewAssignment } from "@deepsonar/shared-types";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  test("goal review integration requires isolated PostgreSQL", { skip: "TEST_DATABASE_URL unset; refusing default database" }, () => {});
} else {
  test("independent goal review uses existing Job, Attempt, Fact and Artifact pipeline", async (t) => {
    const adminUrl = new URL(databaseUrl); adminUrl.pathname = "/postgres"; adminUrl.search = "";
    const admin = (await import("postgres")).default(adminUrl.toString(), { max: 1 });
    const name = `goal_review_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const dbUrl = new URL(adminUrl); dbUrl.pathname = `/${name}`;
    const blobDir = await mkdtemp(path.join(os.tmpdir(), "goal-review-"));
    let created = false; let close: (() => Promise<unknown>) | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
      process.env.DATABASE_URL = dbUrl.toString(); process.env.BLOB_DIR = blobDir;
      process.env.AGENT_MODE = "fake"; process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
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
      type Job = Awaited<ReturnType<typeof seedJob>>;
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
          rules: [{ id: "scope", kind: "requirement", description: "Fixture-only behavior" },
            { id: "excluded", kind: "exclusion", description: "Reports requiring privileged setup are excluded" }],
        } } }) : contract;
        const projectId = randomUUID(), canvasId = randomUUID();
        await sql`INSERT INTO projects(id,name,config_json) VALUES(${projectId},'goal review fixture',${sql.json({ rules: { hubEnabled: false }, enabled_credential_ids: [] })})`;
        await sql`INSERT INTO canvases(id,project_id,title,target_json) VALUES(${canvasId},${projectId},'fixture',${sql.json({ task_contract: taskContract, effective_finding_protocol: protocol, network_policy: { allow_egress: false } } as never)})`;
        await sql`INSERT INTO canvas_nodes(canvas_id,node_type,title,status) VALUES(${canvasId},'root','fixture','active')`;
        const maker = await seedJob(projectId, canvasId, { ...snapshot, task_contract: taskContract }), observation = await emitObservation(maker);
        const claim = { schema_version: 1, task_contract_sha256: taskContractDigest(taskContract), target: "fixture-parser", ...(bounty ? { baseline: "fixture-v1", rule_assessments: [{ rule_id: "scope", result: "matches", evidence_refs: [observation.factId] }, { rule_id: "excluded", result: "does_not_match", evidence_refs: [observation.factId] }] } : {}), evidence_refs: [observation.factId],
          criterion_assessments: ["objective", "scope", "evidence", "acceptance:0"].map((criterion_id) => ({ criterion_id, result: "matches", evidence_refs: [observation.factId] })) };
        await ingestEvent(maker.jobId, { v: 1, event_id: randomUUID(), type: "finding", payload: { title: "Parser fixture candidate", summary: "The parser fixture returned a measurable response for malformed input in the isolated test.", profile: "general", outcome_claim: claim } } as never);
        await finish(maker);
        const [finding] = await sql`SELECT id,artifact_id FROM findings WHERE job_id=${maker.jobId}`;
        assert.ok(finding);
        const request = { schema_version: 1 as const, finding_id: String(finding.id), candidate_artifact_id: String(finding.artifact_id), task_contract_sha256: taskContractDigest(taskContract), criterion_ids: ["acceptance:0"] };
        return { ...maker, observation, request, taskContract };
      };
      type Source = Awaited<ReturnType<typeof source>>;
      const reviewer = async (candidate: Source, assigned = true, criterionIds?: string[]) => {
        const frozen = assigned ? await freezeGoalReviewAssignment(sql, candidate.projectId, candidate.canvasId, { ...snapshot, task_contract: candidate.taskContract }, { ...candidate.request, ...(criterionIds ? { criterion_ids: criterionIds } : {}) }) : snapshot;
        const job = await seedJob(candidate.projectId, candidate.canvasId, frozen);
        return { ...job, assignment: (frozen as { task_goal_review?: TaskGoalReviewAssignment }).task_goal_review };
      };
      type Reviewer = Awaited<ReturnType<typeof reviewer>>;
      const evidence = async (job: Job) => {
        const relative = `attempts/${job.attemptId}/result.txt`, bytes = Buffer.from("parser fixture independent result: malformed input is handled\n");
        const hash = createHash("sha256").update(bytes).digest("hex");
        const directory = path.join(blobDir, "jobs", job.jobId), file = path.join(directory, relative);
        await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
        await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ v: 1, job_id: job.jobId, finalized_at: new Date().toISOString(), files: [{ path: relative, bytes: bytes.length, sha256: hash }] }));
        const observation = await emitObservation(job, { evidence: [{ kind: "runtime.result", statement: "Retained independent parser output", uri: `jobs/${job.jobId}/${relative}`, sha256: hash }] });
        return { ...observation, file, bytes };
      };
      const result = (job: Reviewer, refs: string[], assessment: "satisfied" | "contradicted" | "insufficient" = "satisfied"): TaskGoalReviewResult => ({
        schema_version: 1, assignment_sha256: job.assignment?.assignment_sha256 ?? `sha256:${"a".repeat(64)}`,
        criteria: [{ criterion_id: "acceptance:0", scope: "entire_criterion", assessment, expected: "Malformed input handled", actual: "Retained parser fixture output", rationale: "Compared complete fixture criterion with the retained observation", limitations: [], evidence_refs: refs }],
      });
      const proposal = (value: TaskGoalReviewResult, eventId = randomUUID()) => ({ v: 1 as const, event_id: eventId, type: "fact" as const,
        payload: { title: "Independent criterion evaluation", description: "This independent evaluator compares the entire frozen criterion with its own retained evidence.", artifact: { goal_review: value } } });
      const reviews = (candidate: Source) => loadTaskGoalReviews(sql, candidate.projectId, candidate.canvasId, [candidate.request.finding_id]);
      const count = async (job: Job) => Number((await sql`SELECT count(*)::int AS count FROM artifacts WHERE job_id=${job.jobId} AND kind='task.goal_evaluation'`)[0].count);

      await t.test("ordinary core Job creation freezes a governed review assignment without starting execution", async () => {
        const candidate = await source();
        const { createJobInTransaction } = await import("./core.js");
        const createdJob = await sql.begin((tx) => createJobInTransaction(tx as unknown as typeof sql, {
          projectId: candidate.projectId, canvasId: candidate.canvasId, type: "audit",
          payload: { goal_review: candidate.request, prompt: "Independently compare the frozen parser criterion with retained evidence." },
        }));
        const [row] = await sql`SELECT status,agent_snapshot_json,payload_json FROM jobs WHERE id=${createdJob.created.id}`;
        assert.equal(row.status, "pending");
        assert.equal(row.agent_snapshot_json.task_goal_review.request.finding_id, candidate.request.finding_id);
        assert.equal(row.agent_snapshot_json.task_goal_review.request.task_contract_sha256, candidate.request.task_contract_sha256);
        assert.ok(row.agent_snapshot_json.task_goal_review.forbidden_job_ids.includes(candidate.jobId));
        assert.ok(row.payload_json.related_finding_ids.includes(candidate.request.finding_id));
      });
      await t.test("Hub intent dispatch freezes goal-review assignment on an ordinary child Job", async () => {
        const candidate = await source();
        const hub = await seedJob(candidate.projectId, candidate.canvasId, { ...snapshot, name: "hub_reason", role_kind: "hub", platform_tools: ["submit_hub_decision"] });
        await sql`UPDATE jobs SET type='hub_reason' WHERE id=${hub.jobId}`;
        const [node] = await sql`SELECT node_id FROM findings WHERE id=${candidate.request.finding_id}`;
        await ingestEvent(hub.jobId, { v: 1, event_id: randomUUID(), type: "hub_decision", payload: { intents: [{
          from: [String(node.node_id)], role: "audit", description: "Independently review parser criterion",
          prompt: "Compare the entire frozen parser acceptance criterion with independent retained evidence.", goal_review: candidate.request,
        }] } });
        const [child] = await sql`SELECT type,canvas_id,agent_snapshot_json FROM jobs WHERE parent_job_id=${hub.jobId}`;
        assert.ok(child); assert.equal(child.type, "audit"); assert.equal(child.canvas_id, candidate.canvasId);
        assert.equal(child.agent_snapshot_json.task_goal_review.request.finding_id, candidate.request.finding_id);
        assert.ok(child.agent_snapshot_json.task_goal_review.forbidden_job_ids.includes(candidate.jobId));
      });
      await t.test("successful independent pipeline is pending until terminal, canonical replay is idempotent", async () => {
        const candidate = await source(), job = await reviewer(candidate), proof = await evidence(job), value = result(job, [proof.factId]);
        const event = proposal(value); await ingestEvent(job.jobId, event);
        assert.equal((await reviews(candidate)).reviews[0].criteria.length, 0);
        await ingestEvent(job.jobId, event); await ingestEvent(job.jobId, proposal(value));
        assert.equal(await count(job), 1);
        await assert.rejects(ingestEvent(job.jobId, proposal({ ...value, criteria: [{ ...value.criteria[0], actual: "A different result" }] })));
        assert.equal(await count(job), 1);
        await finish(job);
        const loaded = await reviews(candidate); assert.equal(loaded.reviews.length, 1);
        assert.deepEqual(loaded.reviews[0].blockedReasons, []); assert.equal(loaded.reviews[0].criteria[0].assessment, "satisfied");
        const { buildReportInput } = await import("./report.js");
        const report = await buildReportInput(candidate.canvasId);
        assert.equal(report.task_outcome?.criteria.find((item) => item.id === "acceptance:0")?.assessment, "satisfied");
        assert.equal(report.task_outcome?.goal_assessment, "partially_satisfied");
        assert.ok(report.task_outcome?.criteria.filter((item) => item.id !== "acceptance:0").every((item) => item.assessment === "not_assessed"));
        assert.equal(report.task_outcome?.submission_eligibility, "not_applicable");
        await sql`UPDATE canvas_nodes SET verification_status='rejected' WHERE id=${candidate.observation.factId}`;
        const changed = await buildReportInput(candidate.canvasId);
        assert.notEqual(changed.task_outcome?.criteria.find((item) => item.id === "acceptance:0")?.assessment, "satisfied");
        assert.equal(report.task_outcome?.criteria.find((item) => item.id === "acceptance:0")?.assessment, "satisfied", "old input remains immutable history");
      });
      await t.test("unassigned job, wrong scope/hash/criterion and maker self-review cannot submit authority", async () => {
        const candidate = await source(), job = await reviewer(candidate), proof = await evidence(job);
        const unassigned = await reviewer(candidate, false);
        await assert.rejects(ingestEvent(unassigned.jobId, proposal(result(job, [proof.factId]))), /goal_review_assignment_missing_or_invalid/);
        await assert.rejects(freezeGoalReviewAssignment(sql, candidate.projectId, randomUUID(), snapshot, candidate.request));
        await assert.rejects(freezeGoalReviewAssignment(sql, randomUUID(), candidate.canvasId, snapshot, candidate.request));
        await assert.rejects(freezeGoalReviewAssignment(sql, candidate.projectId, candidate.canvasId, snapshot, { ...candidate.request, task_contract_sha256: `sha256:${"b".repeat(64)}` }));
        await assert.rejects(ingestEvent(job.jobId, proposal({ ...result(job, [proof.factId]), criteria: [{ ...result(job, [proof.factId]).criteria[0], criterion_id: "objective" }] })));
        await sql`UPDATE jobs SET status='running',agent_snapshot_json=${sql.json({ ...snapshot, task_goal_review: job.assignment } as never)} WHERE id=${candidate.jobId}`;
        await sql`UPDATE job_attempts SET status='active' WHERE id=${candidate.attemptId}`;
        await assert.rejects(ingestEvent(candidate.jobId, proposal(result(job, [proof.factId]))), /goal_review_self_review_forbidden/);
        assert.equal(await count(candidate), 0); assert.equal(await count(unassigned), 0);
      });
      await t.test("ordinary and assigned Jobs cannot forge reserved review artifact authority", async () => {
        const candidate = await source(), assigned = await reviewer(candidate), ordinary = await reviewer(candidate, false);
        const proof = await evidence(assigned);
        await ingestEvent(assigned.jobId, proposal(result(assigned, [proof.factId])));
        const [original] = await sql`SELECT id,extensions_json,revision,status FROM artifacts WHERE job_id=${assigned.jobId} AND kind='task.goal_evaluation'`;
        for (const job of [ordinary, assigned]) {
          for (const artifact of [
            { artifact_key: `goal-review:${assigned.jobId}:${assigned.attemptId}` },
            { kind: "task.goal_evaluation" },
            { extensions: { task_goal_review: { assignment_sha256: assigned.assignment!.assignment_sha256, result: result(assigned, [proof.factId]) } } },
          ]) {
            const [before] = await sql`SELECT (SELECT count(*)::int FROM artifacts) AS artifacts,(SELECT count(*)::int FROM canvas_nodes WHERE node_type='fact') AS facts`;
            await assert.rejects(emitObservation(job, artifact));
            const [after] = await sql`SELECT (SELECT count(*)::int FROM artifacts) AS artifacts,(SELECT count(*)::int FROM canvas_nodes WHERE node_type='fact') AS facts`;
            assert.deepEqual(after, before);
            const [preserved] = await sql`SELECT id,extensions_json,revision,status FROM artifacts WHERE id=${original.id}`;
            assert.deepEqual(preserved, original);
          }
        }
      });
      await t.test("cross-Job proof and evidence from an old Attempt are rejected", async () => {
        const candidate = await source(), job = await reviewer(candidate), other = await reviewer(candidate), foreign = await evidence(other);
        await assert.rejects(ingestEvent(job.jobId, proposal(result(job, [foreign.factId]))), /goal_review_evidence_not_owned_or_unavailable/);
        const own = await evidence(job); await sql`UPDATE job_attempts SET status='failed' WHERE id=${job.attemptId}`;
        const next = randomUUID(); await sql`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase) VALUES(${next},${job.jobId},2,'active','agent.ready')`;
        await assert.rejects(ingestEvent(job.jobId, proposal(result(job, [own.factId]))), /goal_review_evidence_not_owned_or_unavailable/);
        assert.equal(await count(job), 0);
      });
      await t.test("retained bytes tampering/deletion invalidates previously supported results", async () => {
        const candidate = await source(), job = await reviewer(candidate), proof = await evidence(job);
        await ingestEvent(job.jobId, proposal(result(job, [proof.factId]))); await finish(job);
        assert.deepEqual((await reviews(candidate)).reviews[0].blockedReasons, []);
        await writeFile(proof.file, "tampered"); assert.equal((await reviews(candidate)).reviews[0].criteria.length, 0);
        await writeFile(proof.file, proof.bytes); assert.deepEqual((await reviews(candidate)).reviews[0].blockedReasons, []);
        await rm(proof.file); assert.equal((await reviews(candidate)).reviews[0].criteria.length, 0);
      });
      await t.test("unknown effects block submission and completed review consumption", async () => {
        const candidate = await source(), job = await reviewer(candidate), proof = await evidence(job), effectId = randomUUID();
        await sql`INSERT INTO job_attempt_effects(id,attempt_id,job_id,effect_id,effect_kind,status) VALUES(${effectId},${job.attemptId},${job.jobId},'fixture','fixture','unknown')`;
        await assert.rejects(ingestEvent(job.jobId, proposal(result(job, [proof.factId]))));
        await sql`UPDATE job_attempt_effects SET status='settled' WHERE id=${effectId}`;
        await ingestEvent(job.jobId, proposal(result(job, [proof.factId]))); await finish(job);
        await sql`UPDATE job_attempt_effects SET status='unknown' WHERE id=${effectId}`;
        assert.equal((await reviews(candidate)).reviews[0].criteria.length, 0);
      });
      await t.test("source Fact revocation, artifact changes and new maker Attempt invalidate assignment", async () => {
        const candidate = await source(), job = await reviewer(candidate), proof = await evidence(job);
        await ingestEvent(job.jobId, proposal(result(job, [proof.factId]))); await finish(job);
        await sql`UPDATE canvas_nodes SET verification_status='rejected' WHERE id=${candidate.observation.factId}`;
        assert.equal((await reviews(candidate)).reviews[0].criteria.length, 0);
        await assert.rejects(loadGoalReviewSource(sql, candidate.projectId, candidate.canvasId, candidate.request));
        await sql`UPDATE canvas_nodes SET verification_status='unverified' WHERE id=${candidate.observation.factId}`;
        const [original] = await sql`SELECT body_json FROM artifacts WHERE id=${candidate.observation.artifactId}`;
        await sql`UPDATE artifacts SET body_json=body_json || '{"changed_fixture":true}'::jsonb WHERE id=${candidate.observation.artifactId}`;
        assert.equal((await reviews(candidate)).reviews[0].criteria.length, 0);
        await sql`UPDATE artifacts SET body_json=${sql.json(original.body_json)} WHERE id=${candidate.observation.artifactId}`;
        const next = randomUUID();
        await sql`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase) VALUES(${next},${candidate.jobId},2,'succeeded','terminal')`;
        assert.equal((await reviews(candidate)).reviews[0].criteria.length, 0);
      });
      await t.test("source unknown effects and superseded reviewer Attempt invalidate durable evaluations", async () => {
        const candidate = await source(), job = await reviewer(candidate), proof = await evidence(job);
        await ingestEvent(job.jobId, proposal(result(job, [proof.factId]))); await finish(job);
        const effectId = randomUUID();
        await sql`INSERT INTO job_attempt_effects(id,attempt_id,job_id,effect_id,effect_kind,status) VALUES(${effectId},${candidate.attemptId},${candidate.jobId},'fixture-source','fixture','unknown')`;
        assert.equal((await reviews(candidate)).reviews[0].criteria.length, 0);
        await sql`DELETE FROM job_attempt_effects WHERE id=${effectId}`;
        assert.deepEqual((await reviews(candidate)).reviews[0].blockedReasons, []);
        await sql`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase) VALUES(${randomUUID()},${job.jobId},2,'active','agent.ready')`;
        assert.equal((await reviews(candidate)).reviews[0].criteria.length, 0);
      });
      await t.test("parallel independent supporting and opposing evaluations remain separate valid records", async () => {
        const candidate = await source(), first = await reviewer(candidate), second = await reviewer(candidate);
        const a = await evidence(first), b = await evidence(second);
        await Promise.all([ingestEvent(first.jobId, proposal(result(first, [a.factId]))), ingestEvent(second.jobId, proposal(result(second, [b.factId], "contradicted")))]);
        await finish(first); await finish(second);
        const loaded = await reviews(candidate);
        assert.equal(loaded.reviews.length, 2); assert.ok(loaded.reviews.every((item) => item.blockedReasons.length === 0));
        assert.deepEqual(loaded.reviews.map((item) => item.criteria[0].assessment).sort(), ["contradicted", "satisfied"]);
        assert.equal(await count(first), 1); assert.equal(await count(second), 1);
        const { buildReportInput } = await import("./report.js");
        const report = await buildReportInput(candidate.canvasId);
        assert.equal(report.task_outcome?.criteria.find((item) => item.id === "acceptance:0")?.assessment, "conflict");
      });
      await t.test("shared evidence scan exhaustion blocks every criterion independent of review order", async () => {
        const candidate = await source(true), positive = await reviewer(candidate, true, ["acceptance:0", "scope", "program_rule:scope", "program_rule:excluded"]), negative = await reviewer(candidate);
        const largeProof = async (job: Job) => {
          const directory = path.join(blobDir, "jobs", job.jobId), entries = [];
          for (let index = 0; index < 3; index++) {
            const relative = `attempts/${job.attemptId}/large-${index}.txt`, bytes = Buffer.alloc(1536 * 1024, 65 + index);
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            await mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
            await writeFile(path.join(directory, relative), bytes);
            entries.push({ path: relative, bytes: bytes.length, sha256 });
          }
          await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ v: 1, job_id: job.jobId, finalized_at: new Date().toISOString(), files: entries }));
          return emitObservation(job, { evidence: entries.map((entry) => ({ kind: "runtime.result", statement: "Retained large fixture evidence", uri: `jobs/${job.jobId}/${entry.path}`, sha256: entry.sha256 })) });
        };
        const a = await largeProof(positive), b = await largeProof(negative), supported = result(positive, [a.factId]);
        for (const criterion_id of ["scope", "program_rule:scope", "program_rule:excluded"]) supported.criteria.push({ ...supported.criteria[0], criterion_id });
        await ingestEvent(positive.jobId, proposal(supported));
        await ingestEvent(negative.jobId, proposal(result(negative, [b.factId], "contradicted")));
        await finish(positive); await finish(negative);
        // Both orders exercise actual PostgreSQL rows and retained bytes; only the
        // result ordering is inverted to prove partial scanning cannot select a winner.
        const reversed = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const rows = await sql(strings, ...values as never[]);
          return /SELECT\s+a\.id,a\.artifact_key/.test(strings.join("")) ? [...rows].reverse() : rows;
        }) as unknown as typeof sql;
        const { buildReportInput } = await import("./report.js");
        let firstOrder: string[] | undefined;
        let firstAssessment: string | undefined;
        for (const database of [sql, reversed]) {
          const loaded = await loadTaskGoalReviews(database, candidate.projectId, candidate.canvasId, [candidate.request.finding_id]);
          const order = loaded.reviews.map((review) => review.artifactId);
          const leadingAssessment = loaded.reviews[0].result?.criteria[0].assessment;
          if (!firstOrder) { firstOrder = order; firstAssessment = leadingAssessment; }
          else {
            assert.deepEqual(order, [...firstOrder].reverse(), "real loaded Artifact order is reversed");
            assert.notEqual(leadingAssessment, firstAssessment, "both positive-first and negative-first scans are exercised");
          }
          assert.ok(loaded.blockedReasons.includes("goal_review_evidence_scan_incomplete"));
          assert.ok(loaded.reviews.some((review) => review.criteria.length > 0), "one review fit the shared budget");
          const report = await buildReportInput(candidate.canvasId, database);
          assert.ok(report.task_outcome?.criteria.every((criterion) => criterion.assessment === "insufficient"));
          assert.equal(report.task_outcome?.criteria.find((criterion) => criterion.id === "scope")?.assessment, "insufficient", "global conservative policy also blocks the independent criterion");
          assert.equal(report.task_outcome?.goal_assessment, "blocked");
          assert.equal(report.task_outcome?.findings[0].program_rule_review?.status, "blocked");
          assert.ok(report.task_outcome?.findings[0].program_rule_review?.criteria.every((criterion) => criterion.assessment === "insufficient"));
          assert.ok(report.task_outcome?.gaps.includes("goal_review_evidence_scan_incomplete"));
        }
      });
      await t.test("program rules use independently assigned proof, remain separate from goal completion and eligibility", async () => {
        const candidate = await source(true), ruleIds = ["program_rule:scope", "program_rule:excluded"];
        const { buildReportInput } = await import("./report.js");
        const projection = async () => (await buildReportInput(candidate.canvasId)).task_outcome!;
        const rules = async () => (await projection()).findings.find((item) => item.finding_id === candidate.request.finding_id)!.program_rule_review!;
        const submit = async (ids: string[], assessment: "satisfied" | "contradicted" = "satisfied") => {
          const job = await reviewer(candidate, true, ids), proof = await evidence(job), value = result(job, [proof.factId], assessment);
          value.criteria = ids.map((criterion_id) => ({ ...value.criteria[0], criterion_id,
            expected: criterion_id === "program_rule:excluded" ? "Privileged setup exclusion must not apply" : "Fixture-only requirement must hold",
            actual: criterion_id === "program_rule:excluded" ? (assessment === "satisfied" ? "No privileged setup required" : "Privileged setup required") : "Only fixture target exercised" }));
          await ingestEvent(job.jobId, proposal(value)); await finish(job); return { job, proof };
        };
        assert.equal((await rules()).status, "not_assessed", "maker rule claims are not independent reviews");
        await submit(["objective", "scope", "evidence", "acceptance:0"]);
        assert.equal((await projection()).goal_assessment, "criteria_satisfied");
        assert.equal((await rules()).status, "not_assessed", "generic goal success cannot satisfy program rules");
        await submit([ruleIds[0]]);
        assert.equal((await rules()).status, "partially_satisfied");
        const exclusion = await submit([ruleIds[1]]);
        const full = await rules();
        assert.equal(full.status, "rules_satisfied");
        assert.ok(full.criteria.every((item) => item.assessment === "satisfied"));
        assert.ok(full.gaps.includes("program_rule_material_not_authenticated"));
        assert.equal((await projection()).submission_eligibility, "not_assessed");
        await writeFile(exclusion.proof.file, "changed retained proof");
        assert.equal((await rules()).status, "blocked", "invalid retained evidence cannot preserve a rules-satisfied decision");
        await writeFile(exclusion.proof.file, exclusion.proof.bytes);
        assert.equal((await rules()).status, "rules_satisfied");
        const effectId = randomUUID();
        await sql`INSERT INTO job_attempt_effects(id,attempt_id,job_id,effect_id,effect_kind,status)
          VALUES(${effectId},${exclusion.job.attemptId},${exclusion.job.jobId},'rule-review-unknown','fixture','unknown')`;
        assert.equal((await rules()).status, "blocked", "unknown review effects invalidate rules satisfaction");
        await sql`DELETE FROM job_attempt_effects WHERE id=${effectId}`;
        assert.equal((await rules()).status, "rules_satisfied");
        const { loadPlanGoalReviewOptions } = await import("./domains/plan-protocol/goal-review-binding.js");
        const options = await loadPlanGoalReviewOptions(sql, candidate.projectId, candidate.canvasId, exclusion.proof.factId);
        assert.deepEqual(options.options, [], "program-only review cannot offer an invalid Plan criterion mapping");
        await writeFile(exclusion.proof.file, "revoked old proof");
        assert.equal((await rules()).status, "blocked");
        await submit([ruleIds[1]]);
        assert.equal((await rules()).status, "rules_satisfied", "fresh valid independent proof can replace unavailable historical evidence");
        await submit([ruleIds[1]], "contradicted");
        assert.equal((await rules()).status, "blocked");
        assert.equal((await rules()).criteria.find((item) => item.id === ruleIds[1])?.assessment, "conflict", "exclusion hit conflicts with independently reviewed non-hit");
        assert.equal(full.status, "rules_satisfied", "previous report is immutable history");
      });
      await t.test("program rule request rejects invented IDs, generic contracts and Fact sources; public route freezes valid rules", async () => {
        const generic = await source(), bounty = await source(true);
        for (const [candidate, id] of [[generic, "program_rule:scope"], [bounty, "program_rule:invented"]] as const) {
          await assert.rejects(reviewer(candidate, true, [id]), /goal_review_criterion_unknown/);
        }
        const { finding_id: _findingId, ...request } = bounty.request;
        await assert.rejects(freezeGoalReviewAssignment(sql, bounty.projectId, bounty.canvasId, snapshot,
          { ...request, fact_id: bounty.observation.factId, criterion_ids: ["program_rule:scope"] }));
        const [{ default: Fastify }, { default: websocket }, { registerRoutes }, { generateToken }] = await Promise.all([
          import("fastify"), import("@fastify/websocket"), import("./routes.js"), import("./auth.js"),
        ]);
        const app = Fastify({ logger: false });
        try {
          await app.register(websocket); registerRoutes(app); await app.ready();
          const token = generateToken();
          await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
            VALUES('program reviewer',${bounty.projectId},${token.prefix},${token.hash},${["tasks:write", "tasks:read", "jobs:control"]})`;
          const post = (goalReview: object) => app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${token.plaintext}` },
            payload: { project_id: bounty.projectId, type: "audit", payload: { goal_review: goalReview, prompt: "Independently compare supplied rules with retained proof." } } });
          const response = await post({ ...bounty.request, criterion_ids: ["program_rule:scope"] });
          assert.equal(response.statusCode, 201, response.payload);
          const [stored] = await sql`SELECT agent_snapshot_json FROM jobs WHERE project_id=${bounty.projectId} AND status='pending'`;
          assert.deepEqual(stored.agent_snapshot_json.task_goal_review.request.criterion_ids, ["program_rule:scope"]);
          const [before] = await sql`SELECT count(*)::int AS count FROM jobs WHERE project_id=${bounty.projectId}`;
          assert.ok((await post({ ...bounty.request, criterion_ids: ["program_rule:invented"] })).statusCode >= 400);
          assert.equal((await post({ ...request, fact_id: bounty.observation.factId, criterion_ids: ["program_rule:scope"] })).statusCode, 400);
          const [after] = await sql`SELECT count(*)::int AS count FROM jobs WHERE project_id=${bounty.projectId}`;
          assert.deepEqual(after, before, "rejected rule assignments do not create Jobs");
        } finally { await app.close(); }
      });
      await t.test("all reviewed criteria can be satisfied without declaring completion or bounty submission eligibility", async () => {
        for (const bounty of [false, true]) {
          const candidate = await source(bounty), ids = ["objective", "scope", "evidence", "acceptance:0"];
          const job = await reviewer(candidate, true, ids), proof = await evidence(job), value = result(job, [proof.factId]);
          value.criteria = ids.map((criterion_id) => ({ ...value.criteria[0], criterion_id }));
          await ingestEvent(job.jobId, proposal(value)); await finish(job);
          const { buildReportInput } = await import("./report.js");
          const report = await buildReportInput(candidate.canvasId);
          assert.ok(report.task_outcome?.criteria.every((item) => item.assessment === "satisfied"));
          assert.equal(report.task_outcome?.goal_assessment, "criteria_satisfied");
          assert.ok(report.task_outcome?.gaps.includes("overall_completion_owned_by_plan"));
          assert.equal(report.task_outcome?.submission_eligibility, bounty ? "not_assessed" : "not_applicable");
          assert.equal("task_completed" in report.task_outcome!, false);
          if (bounty) assert.equal(report.task_outcome!.findings[0].program_rule_review?.status, "not_assessed");
        }
      });
    } finally {
      if (close) await close().catch(() => undefined);
      if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }); await rm(blobDir, { recursive: true, force: true });
    }
  });
}
