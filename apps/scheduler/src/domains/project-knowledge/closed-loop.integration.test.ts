import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { KNOWLEDGE_CASE_KINDS, type KnowledgeJobAssignment } from "@deepsonar/shared-types";
import { createKnowledgeRuntime } from "./runtime.js";
import { createKnowledgeWorkScheduler } from "./work.js";
import { collectProjectKnowledgeSources } from "./collector.js";
import { registerKnowledgeSourceAfterTerminal } from "./automatic.js";
import { freezeProjectKnowledgeCatalog } from "./catalog-snapshot.js";
import { registerKnowledgeBlob, writeKnowledgeBlob } from "./blobs.js";
import { canonical, sha256 } from "./types.js";
import { KNOWLEDGE_FIXED_CASES } from "./case-policy.js";
import { seedKnowledgeJob, withKnowledgeDatabase, type TestSql } from "./test-support.js";
import { persistPreparedJob } from "../../job-creation.js";
import { freezeAgentRuntimeProfile } from "../../agent-runtime-profile.js";
import type { AgentRuntimeSnapshot } from "../role-runtime-snapshot/index.js";
import { injectKnowledgePlatformSkills, PROJECT_KNOWLEDGE_GOVERNANCE_HASH } from "./platform-skills.js";

const GOVERNANCE = PROJECT_KNOWLEDGE_GOVERNANCE_HASH;
const tools = ["read_knowledge_input", "propose_project_knowledge", "submit_knowledge_evaluation", "review_project_knowledge",
  "publish_shared_asset", "emit_fact", "emit_progress", "mark_job_done"];

async function invoke(db: TestSql, runtime: ReturnType<typeof createKnowledgeRuntime>, jobId: string, operationId: string, input: unknown) {
  const [job] = await db`SELECT project_id,canvas_id FROM jobs WHERE id=${jobId}`;
  return (await runtime({ jobId, projectId: String(job!.project_id), canvasId: String(job!.canvas_id),
    operationId, input, eventId: randomUUID(), tokenId: randomUUID(), idempotencyKey: randomUUID() }))!;
}

function scheduler(db: TestSql) {
  return createKnowledgeWorkScheduler({ db, governanceHash: GOVERNANCE,
    ensureCanvasForTaskInTransaction: async (tx, input) => {
      const [canvas] = await tx`INSERT INTO canvases(project_id,title,target_json)
        VALUES(${input.projectId},${input.title},${tx.json(input.target as never)}) RETURNING id`;
      return String(canvas!.id);
    },
    createJobInTransaction: async (tx, input, assignment?: KnowledgeJobAssignment) => {
      const snapshot = { agent_cli: "claude-code", runtime_image: { image_key: "deepsonar-base" },
        settings_config_json: {}, config_files: [], pi_extensions: [], platform_tools: tools,
        shared_assets: [], skills: [], commands: [], mcps: [], subagents: [],
        job_skill_catalog: { project_id: input.projectId, sources: [], extensions: [] },
        runtime_profile: freezeAgentRuntimeProfile({ schema: "deepsonar.agent-runtime-profile/v1", profile_version: 1,
          agent_cli: "claude-code", provider_ref: null, model_ref: null, reasoning_effort: null, context_window_tokens: null,
          extensions: [], system_prompt_ref: null, env_refs: [],
          native_options: { claude_code: { model_env: null, effort_level: null }, pi: null, dsh: null },
          resolution_order: ["global", "project", "role", "task", "job"] }),
      } as unknown as AgentRuntimeSnapshot;
      return persistPreparedJob(tx, input, { snapshot, payload: input.payload ?? {}, priority: 0, assignment });
    },
  });
}

async function start(db: TestSql, jobId: string) {
  const [attempt] = await db`INSERT INTO job_attempts(job_id,attempt_no,status,phase,session_id,started_at)
    VALUES(${jobId},1,'active','agent.ready',${`session:${jobId}`},now()) RETURNING id`;
  await db`UPDATE jobs SET status='running',sandbox_id='fixture',lease_expires_at=now()+interval '1 hour',started_at=now() WHERE id=${jobId}`;
  return String(attempt!.id);
}

async function finish(db: TestSql, runner: ReturnType<typeof scheduler>, jobId: string) {
  await db.begin(async tx => {
    const [job] = await tx`SELECT canvas_id FROM jobs WHERE id=${jobId}`;
    await tx`SELECT id FROM canvases WHERE id=${String(job!.canvas_id)} FOR UPDATE`;
    await tx`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${jobId}`;
    await tx`UPDATE job_attempts SET status='succeeded',phase='terminal',finished_at=now() WHERE job_id=${jobId}`;
    const [settled] = await tx`SELECT id,project_id,canvas_id,started_at,finished_at FROM jobs WHERE id=${jobId}`;
    await runner.onTerminal(tx as never, settled as { id: unknown }, "succeeded");
  });
}

/** Synthetic trial execution bytes; production domain checks still validate every identity and hash. */
async function trialEvidence(db: TestSql, jobId: string, attemptId: string, projectId: string, caseId: string,
  arm: string, outcome: string) {
  const bytes = await writeKnowledgeBlob(db, { case_id: caseId, arm, outcome, observations: "fixture executed the frozen task" });
  await registerKnowledgeBlob(db, bytes.hash, bytes.bytes);
  const [asset] = await db`INSERT INTO shared_assets(scope_type,project_id,logical_key,origin,created_by_job_id)
    VALUES('project',${projectId},${`trial:${jobId}`},'system',${jobId}) RETURNING id`;
  const [version] = await db`INSERT INTO shared_asset_versions(asset_id,version,content_sha256,bytes,content_type,origin,created_by_job_id)
    VALUES(${String(asset!.id)},1,${bytes.hash},${bytes.bytes},'application/json','system',${jobId}) RETURNING id`;
  const eventId = randomUUID();
  await db`INSERT INTO events(job_id,event_id,job_seq,attempt_id,type,payload_json)
    VALUES(${jobId},${eventId},1,${attemptId},'fact','{"title":"executed trial"}'::jsonb)`;
  const [artifact] = await db`INSERT INTO artifacts(project_id,job_id,artifact_key,kind,source_event_id,source_operation)
    VALUES(${projectId},${jobId},${`trial:${jobId}`},'observation',${eventId},'emit_fact') RETURNING id`;
  const [evidence] = await db`INSERT INTO artifact_evidence(artifact_id,statement,uri,sha256)
    VALUES(${String(artifact!.id)},'executed trial',${`asset:${version!.id}`},${bytes.hash}) RETURNING id`;
  return String(evidence!.id);
}

for (const kind of ["memory", "skill"] as const) test(`registered source activates ${kind}, a later Job reads its exact version and feedback stays attributable`, async () => {
  await withKnowledgeDatabase(async db => {
    const origin = await seedKnowledgeJob(db, undefined, ["request_project_knowledge"]);
    await db`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status,body_json)
      VALUES(${origin.canvasId},${origin.jobId},'fact','raw input','succeeded','{"input":"raw fixture"}'::jsonb)`;
    await db`UPDATE jobs SET status='succeeded' WHERE id=${origin.jobId}`;
    await db`UPDATE job_attempts SET status='succeeded',phase='terminal' WHERE id=${origin.attemptId}`;
    await db.begin(tx => registerKnowledgeSourceAfterTerminal(tx as never, origin.jobId, "succeeded"));
    assert.equal(await collectProjectKnowledgeSources(db, GOVERNANCE), 1);
    const [work] = await db`SELECT id,input_manifest_json FROM project_knowledge_work WHERE project_id=${origin.projectId}`;
    const workId = String(work!.id);
    const first = (work!.input_manifest_json as Array<{ input_ref: string; content_hash: string }>)[0]!;
    const ref = { kind: "fact", ref: first.input_ref.slice(5), content_hash: first.content_hash };
    const runner = scheduler(db), runtime = createKnowledgeRuntime({ db, governanceHash: GOVERNANCE });
    await runner.tick();
    const [maker] = await db`SELECT job_id FROM project_knowledge_job_assignments WHERE work_id=${workId} AND stage='maker'`;
    const makerId = String(maker!.job_id);
    await start(db, makerId);
    const plan = KNOWLEDGE_CASE_KINDS.map(kind => ({ id: kind, kind, critical: true,
      ...(kind === "target" ? { prompt: "Perform the raw fixture task", expected: "candidate solves the fixture" } : KNOWLEDGE_FIXED_CASES[kind]),
      task_inputs: kind === "target" ? [ref] : [],
    }));
    const proposed = await invoke(db, runtime, makerId, "propose_project_knowledge", {
      work_ref: workId, action: "create", revision: 1, base_refs: [], source_refs: [ref], reason: "fixture grounded in registered source",
      candidate: { kind, logical_key: "fixture/closed-loop", title: "Reusable knowledge",
        ...(kind === "memory" ? { content: "fixture guidance" } : { files: { "SKILL.md": "# Fixture guidance\nUse for the fixture task; keep unsupported inputs unknown." } }) }, evaluation_plan: plan,
    });
    await finish(db, runner, makerId);
    const results: Array<Record<string, unknown>> = [];
    let reviewerId = "";
    for (let step = 0; step < 18; step++) {
      await runner.tick();
      const [current] = await db`SELECT active_job_id FROM project_knowledge_work WHERE id=${workId}`;
      assert.ok(current!.active_job_id);
      const jobId = String(current!.active_job_id);
      const attemptId = await start(db, jobId);
      const [assignment] = await db`SELECT * FROM project_knowledge_job_assignments WHERE job_id=${jobId}`;
      if (assignment!.stage === "reviewer") { reviewerId = jobId; break; }
      if (assignment!.stage === "evaluator") {
        const rubric = (assignment!.input_manifest_json as Array<{input_ref: string}>).find(entry => entry.input_ref.startsWith("evaluation:proposal:"));
        assert.ok(rubric, "only evaluator/reviewer receive the frozen scoring rubric");
        await invoke(db, runtime, jobId, "submit_knowledge_evaluation", { proposal_ref: proposed.proposal_ref,
          revision: 1, input_digest: proposed.input_digest, case_results: results });
      } else {
        assert.equal(assignment!.stage, "trial");
        const [job] = await db`SELECT agent_snapshot_json FROM jobs WHERE id=${jobId}`;
        const snapshot = job!.agent_snapshot_json as AgentRuntimeSnapshot;
        assert.equal(snapshot.network_policy!.allow_egress, false);
        assert.ok(!snapshot.platform_tools.includes("search_skills"));
        const injected = injectKnowledgePlatformSkills(snapshot.skills, snapshot.knowledge_assignment);
        assert.ok(injected.some(skill => skill.name === "deepsonar-control"));
        assert.ok(!injected.some(skill => skill.name === "deepsonar-project-knowledge"));
        const inputs = assignment!.input_manifest_json as Array<{ input_ref: string; content_hash: string }>;
        assert.ok(!inputs.some(entry => entry.input_ref.startsWith("evaluation:")));
        if (assignment!.case_id === "target") assert.ok(inputs.some(entry => entry.input_ref === first.input_ref));
        if (assignment!.arm === "without") assert.ok(!inputs.some(entry => entry.input_ref.startsWith("candidate:")));
        if (assignment!.case_id === "coexistence") {
          const unrelated = inputs.find(entry => entry.input_ref === "trial-context:coexistence");
          assert.ok(unrelated, "each arm receives the same independently authorized neutral memory");
          const read = await invoke(db, runtime, jobId, "read_knowledge_input", {
            work_ref: workId, input_ref: unrelated.input_ref, expected_hash: unrelated.content_hash,
          });
          assert.match(String(read.content_fragment), /trace_tag=knowledge-coexistence/);
        }
        const probe = inputs.find(entry => entry.input_ref.startsWith("platform-probe:"));
        if (probe) await assert.rejects(invoke(db, runtime, jobId, "read_knowledge_input", {
          work_ref: workId, input_ref: probe.input_ref, expected_hash: probe.content_hash,
        }), /outside|revoked/i);
        const outcome = assignment!.case_id === "target" && assignment!.arm === "without" ? "fail" : "pass";
        const evidence = await trialEvidence(db, jobId, attemptId, origin.projectId, String(assignment!.case_id), String(assignment!.arm), outcome);
        results.push({ case_id: assignment!.case_id, arm: assignment!.arm, outcome,
          trial_job_ref: jobId, trial_attempt_ref: attemptId, evidence_refs: [evidence], reason: "actual fixture observation" });
      }
      await finish(db, runner, jobId);
    }
    assert.equal(results.length, 12);
    assert.ok(reviewerId);
    // Comparator target failure is allowed, but a failed candidate or safety case must still block.
    await invoke(db, runtime, reviewerId, "review_project_knowledge", { proposal_ref: proposed.proposal_ref,
      revision: 1, input_digest: proposed.input_digest, decision: "approve", reason: "independent fixture review",
      evidence_refs: [], remaining_checks: [] });
    await finish(db, runner, reviewerId);
    assert.equal((await db`SELECT state FROM project_knowledge_work WHERE id=${workId}`)[0]!.state, "completed");
    const readOperation = kind === "memory" ? "read_project_memory" : "pull_skill";
    const consumer = await seedKnowledgeJob(db, origin.projectId, [readOperation, "record_knowledge_feedback"]);
    const catalog = await freezeProjectKnowledgeCatalog(db, origin.projectId);
    await db`UPDATE jobs SET agent_snapshot_json=${db.json({ platform_tools: [readOperation, "record_knowledge_feedback"], project_knowledge_catalog: catalog } as never)}
      WHERE id=${consumer.jobId}`;
    const [item] = await db`SELECT id FROM project_knowledge_items WHERE active_version_id=${String(proposed.candidate_version_ref)}`;
    const version = await db`SELECT version,content_sha256 FROM project_knowledge_versions WHERE id=${String(proposed.candidate_version_ref)}`;
    const read = await invoke(db, runtime, consumer.jobId, readOperation, kind === "memory" ? {
      item_ref: item!.id, version: version[0]!.version, expected_hash: version[0]!.content_sha256,
    } : { selector: `project:${item!.id}@${version[0]!.version}`, expected_content_hash: version[0]!.content_sha256 });
    if (kind === "memory") assert.equal(read.content, "fixture guidance");
    else assert.match(JSON.stringify(read.skill), /Fixture guidance/);
    assert.ok(read.usage_ref);
    const [fact] = await db`INSERT INTO canvas_nodes(canvas_id,job_id,node_type,title,status,body_json)
      VALUES(${consumer.canvasId},${consumer.jobId},'fact','reuse observation','succeeded','{"reuse":"observed"}'::jsonb)
      RETURNING id,body_json,verification_status`;
    const feedbackRef = { kind: "fact", ref: fact!.id, content_hash: sha256(canonical({ kind: "fact",
      id: fact!.id, body: fact!.body_json, verification_status: fact!.verification_status })) };
    await invoke(db, runtime, consumer.jobId, "record_knowledge_feedback", { usage_ref: read.usage_ref,
      outcome: "success", evidence_refs: [feedbackRef], next_action: "reuse", reason: "fixture confirms the exact version was read" });
    const [usage] = await db`SELECT version_id,job_id,feedback_json FROM project_knowledge_usages WHERE id=${String(read.usage_ref)}`;
    assert.equal(usage!.version_id, proposed.candidate_version_ref);
    assert.equal(usage!.job_id, consumer.jobId);
    assert.equal((usage!.feedback_json as { outcome: string }).outcome, "success");
  });
});
