import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeCandidateOutcomeClaim, normalizeTaskContract } from "@deepsonar/shared-types";
import { taskContractDigest } from "../../task-outcome-snapshot.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!databaseUrl) {
  test("program eligibility route/SQL integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("program eligibility binds trusted material, current evidence and independent review history", async (t) => {
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const postgres = (await import("postgres")).default;
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const name = `eligibility_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(adminUrl);
    targetUrl.pathname = `/${name}`;
    let created = false;
    let closeDb: (() => Promise<unknown>) | undefined;
    let app: { inject: (options: unknown) => Promise<{ statusCode: number; payload: string; json: <T>() => T }>; close: () => Promise<unknown> } | undefined;

    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      created = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);

      const [{ migrate, sql }, { default: Fastify }, { registerProgramEligibilityRoutes }] = await Promise.all([
        import("../../db.js"), import("fastify"), import("./routes.js"),
      ]);
      await migrate();
      closeDb = () => sql.end({ timeout: 5 });

      const projectId = randomUUID();
      const canvasId = `eligibility-${randomUUID()}`;
      const findingId = randomUUID();
      const sourceJobId = randomUUID();
      const sourceAttemptId = randomUUID();
      const sourceEventId = `finding-${randomUUID()}`;
      const findingNodeId = randomUUID();
      const findingArtifactId = randomUUID();
      const evidenceId = randomUUID();
      const verifyJobId = randomUUID();
      const verifyAttemptId = randomUUID();
      const sourceDigest = `v1:${"1".repeat(64)}`;
      const evidenceSha = "2".repeat(64);
      const contract = normalizeTaskContract({
        schema_version: 1, template_id: "whitebox", template_version: 1,
        objective: "Review the fixture submission", outcome: {
          mode: "bounty_submission", rules_status: "supplied", rule_snapshot: {
            schema_version: 1, program_id: "fixture-program", version: "2026.10",
            source: { provenance: "operator_supplied", reference: "fixture://operator-rules", sha256: `sha256:${"3".repeat(64)}` },
            targets: [{ id: "repo", type: "repository", reference: "fixture/repo", baseline: "v1" }],
            rules: [{ id: "proof", kind: "requirement", description: "Current retained proof" }],
          },
        },
        targets: ["fixture/repo"], baseline: "v1", scope: ["fixture"], exclusions: [], acceptance: ["proof"],
        evidence: ["Current retained fixture evidence"], stop_conditions: [], cleanup: [], materials: [], hypotheses: [],
        allowed_actions: ["read"], required_actions: [], forbidden_actions: ["write", "egress"], credential_refs: [], prerequisites: [],
      });
      const claim = normalizeCandidateOutcomeClaim({
        schema_version: 1, task_contract_sha256: taskContractDigest(contract), target: "fixture/repo", baseline: "v1",
        criterion_assessments: [{ criterion_id: "acceptance:0", result: "matches", evidence_refs: [evidenceId] }],
        evidence_refs: [evidenceId], rule_assessments: [{ rule_id: "proof", result: "matches", evidence_refs: [evidenceId] }],
      });
      const admission = {
        status: "admitted_for_research", task_contract_sha256: taskContractDigest(contract), claim,
        submission_eligibility: "not_assessed", assessment_basis: "structured_goal_relevance_only",
      };
      const snapshot = { name: "audit", role_kind: "role", network_policy: { allow_egress: false }, task_contract: contract };

      await sql`INSERT INTO projects (id,name,config_json) VALUES (${projectId},'Eligibility fixture','{}'::jsonb)`;
      await sql`INSERT INTO canvases (id,project_id,title,target_json) VALUES (${canvasId},${projectId},'Eligibility fixture','{}'::jsonb)`;
      await sql`INSERT INTO canvas_nodes (id,canvas_id,node_type,title,status,body_json) VALUES (${randomUUID()},${canvasId},'root','root','active','{}'::jsonb)`;
      await sql`INSERT INTO jobs (id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json)
        VALUES (${sourceJobId},${projectId},${canvasId},'audit','succeeded',${sql.json(snapshot)},'{}'::jsonb)`;
      await sql`INSERT INTO job_attempts (id,job_id,attempt_no,status,phase)
        VALUES (${sourceAttemptId},${sourceJobId},1,'succeeded','terminal')`;
      await sql`INSERT INTO canvas_nodes (id,canvas_id,job_id,node_type,title,status,body_json)
        VALUES (${findingNodeId},${canvasId},${sourceJobId},'finding','Fixture finding','succeeded','{}'::jsonb)`;
      await sql`INSERT INTO events (job_id,event_id,job_seq,attempt_id,type,payload_json)
        VALUES (${sourceJobId},${sourceEventId},1,${sourceAttemptId},'finding','{}'::jsonb)`;
      await sql`INSERT INTO artifacts (id,project_id,canvas_id,job_id,node_id,artifact_key,revision,kind,schema_version,status,source_event_id,source_operation,extensions_json,body_json)
        VALUES (${findingArtifactId},${projectId},${canvasId},${sourceJobId},${findingNodeId},${`finding:${findingId}`},1,'security.vulnerability','1','submitted',${sourceEventId},'emit_finding',${sql.json({ task_outcome_admission: admission })},${sql.json({ title: "Fixture finding" })})`;
      await sql`INSERT INTO findings (id,project_id,job_id,artifact_id,node_id,fingerprint,title,severity,summary,source_digest,verify_status,raw_json)
        VALUES (${findingId},${projectId},${sourceJobId},${findingArtifactId},${findingNodeId},${`fixture:${findingId}`},'Fixture finding','high','Technical fixture',${sourceDigest},'confirmed',${sql.json({ task_outcome_admission: admission })})`;
      await sql`INSERT INTO artifact_evidence (id,artifact_id,ordinal,kind,statement,polarity,sha256,payload_json)
        VALUES (${evidenceId},${findingArtifactId},1,'reproduction','Current retained fixture evidence','supports',${evidenceSha},${sql.json({ finding_id: findingId })})`;
      await sql`INSERT INTO jobs (id,project_id,canvas_id,finding_id,type,status,agent_snapshot_json,payload_json)
        VALUES (${verifyJobId},${projectId},${canvasId},${findingId},'verify_finding','succeeded',${sql.json(snapshot)},'{}'::jsonb)`;
      await sql`INSERT INTO job_attempts (id,job_id,attempt_no,status,phase)
        VALUES (${verifyAttemptId},${verifyJobId},1,'succeeded','terminal')`;
      await sql`INSERT INTO finding_verification_rounds (id,finding_id,attempt,verify_job_id,status,final_outcome,requirements_json,evidence_snapshot_json,finished_at)
        VALUES (${randomUUID()},${findingId},1,${verifyJobId},'confirmed','confirmed','{}'::jsonb,${sql.json({ evidence: [evidenceId] })},now())`;

      type Actor = import("../../auth.js").Actor;
      let actor: Actor = { type: "bootstrap_admin", id: null, name: "bootstrap_admin", projectId: null, scopes: ["admin"] };
      const fastify = Fastify({ logger: false });
      fastify.addHook("onRequest", async (req) => { req.actor = actor; });
      registerProgramEligibilityRoutes(fastify, sql as never);
      await fastify.ready();
      app = fastify as never;

      const material = (id: string, version: string, supersedes_material_id?: string) => ({
        schema_version: 1, scope: { kind: "platform" }, program_id: "fixture-program", version,
        authority: { kind: "platform_curated", name: "Fixture authority", reference: "fixture://authority", source_sha256: `sha256:${"3".repeat(64)}` },
        targets: [{ id: "repo", type: "repository", reference: "fixture/repo", baseline: "v1" }],
        rules: [{ id: "proof", kind: "requirement", description: "Current retained proof" }],
        ...(supersedes_material_id ? { supersedes_material_id } : {}), idempotency_key: id,
      });
      const register = async (request: object) => app!.inject({ method: "POST", url: "/program-materials", payload: request });
      await t.test("project-scoped admin cannot admit platform or foreign project material", async () => {
        actor = { type: "api_token", id: "scoped-admin", name: "scoped admin", projectId, scopes: ["admin"] };
        const platform = await register(material(randomUUID(), "2026.10"));
        assert.equal(platform.statusCode, 403, platform.payload);
        const foreign = await register({ ...material(randomUUID(), "2026.10"), scope: { kind: "project", project_id: randomUUID() } });
        assert.equal(foreign.statusCode, 403, foreign.payload);
        actor = { type: "bootstrap_admin", id: null, name: "bootstrap_admin", projectId: null, scopes: ["admin"] };
      });
      const firstMaterialKey = randomUUID();
      const materialResponse = await register(material(firstMaterialKey, "2026.10"));
      assert.equal(materialResponse.statusCode, 201, materialResponse.payload);
      const firstMaterial = materialResponse.json<{ material: { material_id: string; status: string } }>().material;
      const firstMaterialId = firstMaterial.material_id;
      assert.equal(firstMaterial.status, "active");
      assert.notEqual(firstMaterialId, firstMaterialKey, "Material identity is issued by the Scheduler");
      const duplicateMaterial = await register(material(firstMaterialKey, "2026.10"));
      assert.equal(duplicateMaterial.statusCode, 200, duplicateMaterial.payload);
      assert.equal(duplicateMaterial.json<{ duplicate: boolean }>().duplicate, true);
      const [{ material_count }] = await sql`SELECT count(*)::int AS material_count FROM audit_logs WHERE action='program_material.register'`;
      assert.equal(material_count, 1);

      const review = (materialId: string, idempotencyKey = randomUUID(), overrides: Record<string, unknown> = {}) => ({
        schema_version: 1, finding_id: findingId, finding_artifact_id: findingArtifactId, finding_artifact_revision: 1, finding_source_digest: sourceDigest,
        program_material_id: materialId, program_id: "fixture-program", program_version: "2026.10", program_source_sha256: `sha256:${"3".repeat(64)}`,
        target_id: "repo", target_reference: "fixture/repo", baseline: "v1", decision: "approve",
        rule_assessments: [{ rule_id: "proof", result: "satisfied", evidence_refs: [evidenceId] }], evidence_refs: [evidenceId],
        reason: "Independent operator review with retained evidence", idempotency_key: idempotencyKey, ...overrides,
      });
      const postReview = (payload: object) => app!.inject({ method: "POST", url: `/findings/${findingId}/program-eligibility/reviews`, payload });

      await t.test("missing evidence, wrong version, target and program are blocked", async () => {
        actor = { type: "user", id: "operator-1", name: "operator", projectId, role: "operator", scopes: ["findings:write"] };
        const missingEvidence = randomUUID();
        const cases = [
          review(firstMaterialId, randomUUID(), { evidence_refs: [missingEvidence], rule_assessments: [{ rule_id: "proof", result: "satisfied", evidence_refs: [missingEvidence] }] }),
          review(firstMaterialId, randomUUID(), { program_version: "2026.11" }),
          review(firstMaterialId, randomUUID(), { target_reference: "fixture/other-repo" }),
          review(firstMaterialId, randomUUID(), { program_id: "other-program" }),
        ];
        for (const payload of cases) {
          const response = await postReview(payload);
          assert.equal(response.statusCode, 409, response.payload);
          assert.equal(response.json<{ error_code: string }>().error_code, "PROGRAM_ELIGIBILITY_BLOCKED");
          assert.equal(response.json<{ record: { status: string } }>().record.status, "blocked");
        }
      });

      await t.test("unauthorized and cross-project reviewers are rejected", async () => {
        actor = { type: "user", id: "viewer-1", name: "viewer", projectId, role: "viewer", scopes: ["findings:write"] };
        const viewer = await postReview(review(firstMaterialId));
        assert.equal(viewer.statusCode, 403);
        actor = { type: "api_token", id: "other-token", name: "other-project", projectId: randomUUID(), scopes: ["findings:write"] };
        const crossProject = await postReview(review(firstMaterialId));
        assert.equal(crossProject.statusCode, 403);
        assert.equal(crossProject.json<{ error_code: string }>().error_code, "PROJECT_SCOPE_FORBIDDEN");
        actor = { type: "user", id: sourceJobId, name: "maker", projectId, role: "operator", scopes: ["findings:write"] };
        const selfApproval = await postReview(review(firstMaterialId));
        assert.equal(selfApproval.statusCode, 403);
        assert.equal(selfApproval.json<{ error_code: string }>().error_code, "PROGRAM_ELIGIBILITY_MAKER_SELF_APPROVAL");
      });

      await t.test("independent approval is durable, idempotent and serialized", async () => {
        actor = { type: "user", id: "operator-1", name: "operator", projectId, role: "operator", scopes: ["findings:write"] };
        const validPayload = review(firstMaterialId, randomUUID());
        const responses = await Promise.all([postReview(validPayload), postReview(validPayload)]);
        assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 201]);
        const records = responses.map((response) => response.json<{ record: { status: string; reviewer: { actor_id: string; permission: string } }; duplicate: boolean }>().record);
        assert.ok(records.every((record) => record.status === "eligible"));
        assert.ok(records.every((record) => record.reviewer.actor_id === "operator-1" && record.reviewer.permission === "findings:write"));
        const [{ review_count }] = await sql`SELECT count(*)::int AS review_count FROM audit_logs WHERE action='program_eligibility.review' AND after_json->'request'->>'idempotency_key'=${validPayload.idempotency_key}`;
        assert.equal(review_count, 1);
        const current = await app!.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        assert.equal(current.statusCode, 200, current.payload);
        assert.equal(current.json<{ status: string; technical_status: string; current_review_id: string | null }>().status, "eligible");
        assert.equal(current.json<{ technical_status: string }>().technical_status, "confirmed");
        actor = { type: "api_token", id: "other-token", name: "other-project", projectId: randomUUID(), scopes: ["findings:write"] };
        const foreignReplay = await postReview(validPayload);
        assert.equal(foreignReplay.statusCode, 403, foreignReplay.payload);
        assert.equal(foreignReplay.json<{ error_code: string }>().error_code, "PROJECT_SCOPE_FORBIDDEN");
        actor = { type: "user", id: "operator-1", name: "operator", projectId, role: "operator", scopes: ["findings:write"] };
      });

      const secondMaterialKey = randomUUID();
      let secondMaterialId = "";
      await t.test("material supersede invalidates old approval until a new version is independently reviewed", async () => {
        actor = { type: "bootstrap_admin", id: null, name: "bootstrap_admin", projectId: null, scopes: ["admin"] };
        const second = await register(material(secondMaterialKey, "2026.11", firstMaterialId));
        assert.equal(second.statusCode, 201, second.payload);
        secondMaterialId = second.json<{ material: { material_id: string } }>().material.material_id;
        actor = { type: "user", id: "operator-1", name: "operator", projectId, role: "operator", scopes: ["findings:write"] };
        const stale = await app!.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        assert.equal(stale.json<{ status: string }>().status, "blocked");
        assert.ok(stale.json<{ gaps: string[] }>().gaps.includes("program_material_not_current"));
        const replacement = await postReview(review(secondMaterialId, randomUUID(), { program_version: "2026.11" }));
        assert.equal(replacement.statusCode, 201, replacement.payload);
        const current = await app!.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        assert.equal(current.json<{ status: string }>().status, "eligible");
      });

      await t.test("multiple current approvals retain eligibility and a new Verify Attempt invalidates old approvals", async () => {
        actor = { type: "user", id: "operator-2", name: "second operator", projectId, role: "operator", scopes: ["findings:write"] };
        const secondApproval = await postReview(review(secondMaterialId, randomUUID(), { program_version: "2026.11" }));
        assert.equal(secondApproval.statusCode, 201, secondApproval.payload);
        let current = await app!.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        assert.equal(current.json<{ status: string }>().status, "eligible");
        const prior = await sql`SELECT id,after_json FROM audit_logs WHERE action='program_eligibility.review' ORDER BY id`;
        const nextAttemptId = randomUUID();
        await sql`INSERT INTO job_attempts (id,job_id,attempt_no,status,phase) VALUES (${nextAttemptId},${verifyJobId},2,'succeeded','terminal')`;
        current = await app!.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        assert.equal(current.json<{ status: string }>().status, "blocked");
        assert.ok(current.json<{ gaps: string[] }>().gaps.includes("eligibility_review_stale_or_invalid"));
        const refreshed = await postReview(review(secondMaterialId, randomUUID(), { program_version: "2026.11" }));
        assert.equal(refreshed.statusCode, 201, refreshed.payload);
        current = await app!.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        assert.equal(current.json<{ status: string }>().status, "eligible");
        const history = await sql`SELECT id,after_json FROM audit_logs WHERE action='program_eligibility.review' ORDER BY id`;
        assert.deepEqual([...history].slice(0, prior.length), [...prior], "Re-review cannot rewrite historical approvals");
        await sql`INSERT INTO job_attempt_effects (attempt_id,job_id,effect_id,effect_kind,status)
          VALUES (${nextAttemptId},${verifyJobId},'eligibility-uncertainty','execution','unknown')`;
        current = await app!.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        assert.ok(current.json<{ gaps: string[] }>().gaps.includes("finding_confirmation_effect_unknown"));
        await sql`UPDATE job_attempt_effects SET status='settled' WHERE attempt_id=${nextAttemptId} AND effect_id='eligibility-uncertainty'`;
        current = await app!.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        assert.equal(current.json<{ status: string }>().status, "eligible");
      });

      await t.test("registered management hooks enforce real tokens, scopes and Job capability separation", async () => {
        const [{ default: websocket }, { registerRoutes }, { generateToken }, capability, { createAttempt }] = await Promise.all([
          import("@fastify/websocket"), import("../../routes.js"), import("../../auth.js"),
          import("../platform-api/index.js"), import("../job-attempt/application.js"),
        ]);
        const management = Fastify({ logger: false });
        await management.register(websocket);
        registerRoutes(management);
        await management.ready();
        try {
          const token = async (scopes: string[], scopeProjectId: string) => {
            const generated = generateToken();
            await sql`INSERT INTO api_tokens (name,project_id,token_prefix,token_hash,scopes)
              VALUES ('eligibility boundary',${scopeProjectId},${generated.prefix},${generated.hash},${scopes})`;
            return { authorization: `Bearer ${generated.plaintext}` };
          };
          const reader = await token(["projects:read", "findings:read"], projectId);
          const scopedAdmin = await token(["admin"], projectId);
          const own = await management.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility`, headers: reader });
          assert.equal(own.statusCode, 200, own.payload);
          assert.equal(own.json().status, "eligible");
          const readOnlyWrite = await management.inject({ method: "POST", url: `/findings/${findingId}/program-eligibility/reviews`, headers: reader,
            payload: review(secondMaterialId, randomUUID(), { program_version: "2026.11" }) });
          assert.equal(readOnlyWrite.statusCode, 403, readOnlyWrite.payload);
          const platform = await management.inject({ method: "POST", url: "/program-materials", headers: scopedAdmin, payload: material(randomUUID(), "2026.12") });
          assert.equal(platform.statusCode, 403, platform.payload);
          const foreignProject = randomUUID();
          await sql`INSERT INTO projects(id,name) VALUES (${foreignProject},'Foreign eligibility token')`;
          const foreign = await token(["admin"], foreignProject);
          const outside = await management.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility`, headers: foreign });
          assert.equal(outside.statusCode, 403, outside.payload);
          const agentJob = randomUUID();
          await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json)
            VALUES (${agentJob},${projectId},${canvasId},'audit','provisioning',${sql.json({ name: "audit", role_kind: "role", platform_tools: ["emit_progress"] })},'{}'::jsonb)`;
          await createAttempt(sql, agentJob);
          const grant = await capability.mintJobCapabilityToken(agentJob);
          await sql`UPDATE jobs SET status='running',lease_expires_at=now()+interval '5 minutes' WHERE id=${agentJob}`;
          await capability.activateProvisionedJobCapabilityTokens(agentJob);
          const agentHeaders = { authorization: `Bearer ${grant.token}` };
          const permitted = await management.inject({ method: "GET", url: `/control/v1/jobs/${agentJob}/capabilities`, headers: agentHeaders });
          assert.equal(permitted.statusCode, 200, permitted.payload);
          const escaped = await management.inject({ method: "POST", url: `/findings/${findingId}/program-eligibility/reviews`, headers: agentHeaders,
            payload: review(secondMaterialId, randomUUID(), { program_version: "2026.11" }) });
          assert.equal(escaped.statusCode, 401, escaped.payload);
        } finally {
          await management.close();
        }
      });

      await t.test("bounded report projection explicitly blocks entries beyond its lookup budget", async () => {
        const { loadProgramEligibilityProjections } = await import("./store.js");
        const projections = await loadProgramEligibilityProjections(sql, projectId, [...Array.from({ length: 100 }, () => randomUUID()), findingId]);
        assert.equal(projections.get(findingId)?.status, "blocked");
        assert.deepEqual(projections.get(findingId)?.gaps, ["eligibility_projection_limit_exceeded"]);
      });

      await t.test("review waits for the Canvas transaction and rechecks its committed Verify state", async () => {
        const held = await sql.reserve();
        let pending: ReturnType<typeof postReview> | undefined;
        let committed = false;
        try {
          await held`BEGIN`;
          const [backend] = await held`SELECT pg_backend_pid() AS pid`;
          await held`SELECT id FROM canvases WHERE id=${canvasId} FOR UPDATE`;
          pending = postReview(review(secondMaterialId, randomUUID(), { program_version: "2026.11" }));
          let blocked = false;
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const [waiter] = await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
              WHERE pg_blocking_pids(pid) @> ARRAY[${Number(backend.pid)}]::int[]) AS blocked`;
            if (waiter.blocked) { blocked = true; break; }
            await delay(10);
          }
          assert.equal(blocked, true, "Review must serialize behind the live Canvas transaction");
          await held`UPDATE finding_verification_rounds SET status='pending' WHERE finding_id=${findingId}`;
          await held`COMMIT`;
          committed = true;
          const response = await pending;
          assert.equal(response.statusCode, 409, response.payload);
          assert.ok(response.json<{ record: { reason_codes: string[] } }>().record.reason_codes.includes("finding_confirmation_round_missing_or_stale"));
        } finally {
          if (!committed) await held`ROLLBACK`;
          await held.release();
          if (pending) await pending;
          await sql`UPDATE finding_verification_rounds SET status='confirmed' WHERE finding_id=${findingId}`;
        }
      });

      await t.test("evidence mutation and revocation invalidate the current review without deleting history", async () => {
        await sql`UPDATE artifact_evidence SET statement='mutated retained fixture evidence' WHERE id=${evidenceId}`;
        let current = await app!.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        assert.equal(current.json<{ status: string }>().status, "blocked");
        await sql`UPDATE artifact_evidence SET statement='Current retained fixture evidence' WHERE id=${evidenceId}`;
        current = await app!.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        assert.equal(current.json<{ status: string }>().status, "eligible");

        const conflicting = await postReview(review(secondMaterialId, randomUUID(), { program_version: "2026.11", decision: "reject", reason: "Independent review found a program exclusion" }));
        assert.equal(conflicting.statusCode, 201, conflicting.payload);
        current = await app!.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        assert.equal(current.json<{ status: string }>().status, "blocked");
        assert.ok(current.json<{ gaps: string[] }>().gaps.includes("eligibility_review_conflict"));

        actor = { type: "bootstrap_admin", id: null, name: "bootstrap_admin", projectId: null, scopes: ["admin"] };
        const revoked = await app!.inject({ method: "POST", url: `/program-materials/${secondMaterialId}/revoke`, payload: { schema_version: 1, reason: "Fixture authority withdrawn", idempotency_key: randomUUID() } });
        assert.equal(revoked.statusCode, 201, revoked.payload);
        actor = { type: "user", id: "operator-1", name: "operator", projectId, role: "operator", scopes: ["findings:write"] };
        current = await app!.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        const body = current.json<{ status: string; reviews: unknown[]; invalid_history_count: number }>();
        assert.equal(body.status, "blocked");
        assert.ok(body.reviews.length >= 2);
        assert.equal(body.invalid_history_count, 0);
      });

      await t.test("history is reread after app restart and malformed history blocks current eligibility", async () => {
        await app!.close();
        const { default: Fastify } = await import("fastify");
        const restarted = Fastify({ logger: false });
        restarted.addHook("onRequest", async (req) => { req.actor = actor; });
        registerProgramEligibilityRoutes(restarted, sql as never);
        await restarted.ready();
        const afterRestart = await restarted.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        assert.equal(afterRestart.statusCode, 200);
        assert.equal(afterRestart.json<{ status: string }>().status, "blocked");
        await sql`INSERT INTO audit_logs (actor_type,actor_id,action,project_id,resource_type,resource_id,after_json,result)
          VALUES ('user','fixture','program_material.register',${projectId},'program_material',${randomUUID()},'{}'::jsonb,'ok')`;
        const malformed = await restarted.inject({ method: "GET", url: `/findings/${findingId}/program-eligibility` });
        const malformedBody = malformed.json<{ status: string; invalid_history_count: number; gaps: string[] }>();
        assert.equal(malformedBody.status, "blocked");
        assert.ok(malformedBody.invalid_history_count > 0);
        assert.ok(malformedBody.gaps.includes("eligibility_history_invalid"));
        await restarted.close();
      });
    } finally {
      if (app) await app.close().catch(() => undefined);
      await closeDb?.().catch(() => undefined);
      if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 });
    }
  });
}
