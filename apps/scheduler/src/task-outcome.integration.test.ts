import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  normalizeTaskContract, normalizeTaskOutcomeSpec, normalizeCandidateOutcomeClaim,
  type CandidateOutcomeClaim, type TaskOutcomeSpec,
} from "@deepsonar/shared-types";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("task outcome admission requires isolated PostgreSQL", { skip: "TEST_DATABASE_URL is not set; refusing default database" }, () => {});
} else {
  test("candidate outcome admission preserves observations and admits only supported scoped claims", async (t) => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = (await import("postgres")).default(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_outcome_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(adminUrl);
    targetUrl.pathname = `/${databaseName}`;
    let created = false;
    let endSql: (() => Promise<unknown>) | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      created = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      const [{ sql, migrate }, { ingestEvent }, { ControlInputError }, { taskContractDigest }] = await Promise.all([
        import("./db.js"), import("./core.js"), import("./control-input.js"), import("./task-outcome-snapshot.js"),
      ]);
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      const outcome = normalizeTaskOutcomeSpec({
        mode: "bounty_submission", rules_status: "supplied", rule_snapshot: {
          schema_version: 1, program_id: "fixture", version: "1",
          source: { provenance: "operator_supplied", reference: "attachment://authorized-rules", sha256: `sha256:${"a".repeat(64)}` },
          targets: [{ id: "api", type: "api", reference: "http://127.0.0.1:8080", baseline: "fixture-v1" }],
          rules: [
            { id: "impact", kind: "requirement", description: "Impact another test account" },
            { id: "self", kind: "exclusion", description: "Affects actor-owned data only" },
          ],
        },
      });
      assert.equal(outcome.mode, "bounty_submission");
      if (outcome.mode !== "bounty_submission" || !outcome.rule_snapshot) throw new Error("invalid fixture");
      const protocol = {
        mode: "hybrid", default_profile: "security.vulnerability", allowed_profiles: ["security.vulnerability", "general"],
        scoring: { default_standard: "CVSS", default_version: "3.1", accepted_versions: ["3.1", "4.0"], require_scoring_for_profiles: [] },
        display_name: "outcome fixture", source: "task",
      };
      const createContext = async (policy: TaskOutcomeSpec | null | "omitted" = outcome, existingProjectId?: string) => {
        const projectId = existingProjectId ?? randomUUID();
        if (!existingProjectId) await sql`INSERT INTO projects (id, name, config_json)
          VALUES (${projectId}, 'outcome fixture', ${sql.json({ rules: { hubEnabled: false }, enabled_credential_ids: [] })})`;
        const canvasId = randomUUID();
        const jobId = randomUUID();
        const contract = policy ? normalizeTaskContract({
          schema_version: 1, template_id: "blackbox", template_version: 1,
          objective: "Research fixture behavior", targets: ["http://127.0.0.1:8080"],
          scope: ["Fixture only"], acceptance: ["A supported research contribution", "Z additional independent contribution"],
          evidence: ["Durable observations"], baseline: "fixture-v1",
          allowed_actions: ["read"], required_actions: ["read"], ...(policy === "omitted" ? {} : { outcome: policy }),
        }) : undefined;
        const target = { effective_finding_protocol: protocol, network_policy: { allow_egress: false }, ...(contract ? { task_contract: contract } : {}) };
        const snapshot = { name: "audit", role_kind: "role", platform_tools: ["emit_fact", "emit_finding", "mark_job_done"],
          network_policy: { allow_egress: false }, ...(contract ? { task_contract: contract } : {}) };
        await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, 'outcome fixture', ${sql.json(target as never)})`;
        await sql`INSERT INTO canvas_nodes (canvas_id, node_type, title, status) VALUES (${canvasId}, 'root', 'root', 'active')`;
        await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
          VALUES (${jobId}, ${projectId}, ${canvasId}, 'audit', 'running', ${sql.json(snapshot as never)}, '{}'::jsonb)`;
        await sql`INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status) VALUES (${canvasId}, ${jobId}, 'intent', 'audit', 'running')`;
        return { projectId, canvasId, jobId, contract };
      };
      type Context = Awaited<ReturnType<typeof createContext>>;
      const emitFact = async (context: Context) => {
        const eventId = randomUUID();
        await ingestEvent(context.jobId, { v: 1, event_id: eventId, type: "fact", payload: {
          title: "Observed fixture response", description: "The isolated fixture returned another test account resource; candidate eligibility remains unreviewed.",
          artifact: { artifact_key: `observation-${eventId}`, kind: "quality.observation" },
        } });
        const [row] = await sql`SELECT id, node_id FROM artifacts WHERE source_event_id = ${eventId} AND source_operation = 'emit_fact'`;
        assert.ok(row?.node_id);
        return { id: String(row.node_id), artifactId: String(row.id) };
      };
      const claim = (context: Context, factId: string) => normalizeCandidateOutcomeClaim({
        schema_version: 1, task_contract_sha256: taskContractDigest(context.contract!), target: "http://127.0.0.1:8080", baseline: "fixture-v1",
        evidence_refs: [factId],
        criterion_assessments: ["objective", "scope", "evidence", "acceptance:0"].map((criterion_id) => ({ criterion_id, result: "matches", evidence_refs: [factId] })),
        ...(context.contract?.outcome?.mode === "bounty_submission" ? { rule_assessments: [
          { rule_id: "impact", result: "matches", evidence_refs: [factId] },
          { rule_id: "self", result: "does_not_match", evidence_refs: [factId] },
        ] } : {}),
      });
      const finding = (proposal?: CandidateOutcomeClaim) => ({
        title: "Cross-account fixture response", summary: "The isolated fixture exposes a second test account resource through the observed response; this is a technical candidate only.",
        location: "fixture/api.ts:42", severity: "high" as const, evidence_refs: proposal?.evidence_refs ?? [],
        ...(proposal ? { outcome_claim: proposal } : {}),
      });
      const counts = async (context: Context) => {
        const [row] = await sql`SELECT
          (SELECT count(*)::int FROM findings WHERE job_id = ${context.jobId}) AS findings,
          (SELECT count(*)::int FROM artifacts WHERE job_id = ${context.jobId} AND source_operation = 'emit_finding') AS candidates,
          (SELECT count(*)::int FROM jobs WHERE canvas_id = ${context.canvasId} AND type = 'verify_finding') AS verify_jobs,
          (SELECT count(*)::int FROM artifacts WHERE job_id = ${context.jobId} AND source_operation = 'emit_fact') AS observations`;
        return { findings: row.findings, candidates: row.candidates, verify_jobs: row.verify_jobs, observations: row.observations };
      };
      const expectRejected = async (context: Context, proposal: CandidateOutcomeClaim | undefined, status: string, code: string) => {
        const before = await counts(context);
        await assert.rejects(ingestEvent(context.jobId, { v: 1, event_id: randomUUID(), type: "finding", payload: finding(proposal) }), (error: unknown) => {
          assert.ok(error instanceof ControlInputError);
          assert.equal(error.code, "invalid_payload");
          const details = error.details?.task_outcome_admission as { status?: string; code?: string } | undefined;
          assert.equal(details?.status, status);
          assert.equal(details?.code, code);
          return true;
        });
        assert.deepEqual(await counts(context), before, "rejection must not create Finding, candidate Artifact or Verify job, or remove observations");
      };

      await t.test("unknown rules and missing claim block candidates without rolling back observations", async () => {
        const unknown = await createContext({ mode: "bounty_submission", rules_status: "unknown" });
        const fact = await emitFact(unknown);
        await expectRejected(unknown, claim(unknown, fact.id), "blocked", "outcome_rules_unknown");
        const missing = await createContext();
        await emitFact(missing);
        await expectRejected(missing, undefined, "blocked", "outcome_claim_missing");
        assert.equal((await counts(missing)).observations, 1);
      });
      await t.test("explicit exclusion and unmet requirements retain observations but cannot create Findings", async () => {
        for (const [id, result, code] of [["self", "matches", "outcome_rule_excluded"], ["impact", "does_not_match", "outcome_requirement_not_met"]] as const) {
          const context = await createContext();
          const fact = await emitFact(context);
          const proposal = claim(context, fact.id);
          proposal.rule_assessments!.find((item) => item.rule_id === id)!.result = result;
          await expectRejected(context, proposal, "observation_only", code);
        }
      });
      await t.test("unknown assessment and old snapshot digest cannot be admitted", async () => {
        const context = await createContext();
        const fact = await emitFact(context);
        const unknown = claim(context, fact.id);
        unknown.rule_assessments![0].result = "unknown";
        await expectRejected(context, unknown, "blocked", "outcome_rule_unresolved");
        await expectRejected(context, { ...claim(context, fact.id), task_contract_sha256: `sha256:${"b".repeat(64)}` }, "blocked", "outcome_contract_mismatch");
      });
      await t.test("cross-canvas, cross-project, nonexistent and rejected Fact references fail closed", async () => {
        const context = await createContext();
        await emitFact(context);
        const otherCanvas = await createContext(outcome, context.projectId);
        const otherProject = await createContext();
        for (const external of [otherCanvas, otherProject]) {
          const fact = await emitFact(external);
          await expectRejected(context, claim(context, fact.id), "blocked", "outcome_evidence_unavailable");
        }
        await expectRejected(context, claim(context, randomUUID()), "blocked", "outcome_evidence_unavailable");
        const rejected = await emitFact(context);
        await sql`UPDATE canvas_nodes SET verification_status = 'rejected' WHERE id = ${rejected.id}`;
        await expectRejected(context, claim(context, rejected.id), "blocked", "outcome_evidence_unavailable");
      });
      await t.test("superseded observation artifacts cannot support candidate admission", async () => {
        const context = await createContext();
        const fact = await emitFact(context);
        await sql`UPDATE artifacts SET status = 'superseded', superseded_at = now() WHERE id = ${fact.artifactId}`;
        await expectRejected(context, claim(context, fact.id), "blocked", "outcome_evidence_unavailable");
      });
      await t.test("admitted candidate preserves structured basis without certifying eligibility and replay is idempotent", async () => {
        const context = await createContext();
        const fact = await emitFact(context);
        const proposal = claim(context, fact.id);
        const event = { v: 1 as const, event_id: randomUUID(), type: "finding" as const, payload: finding(proposal) };
        await ingestEvent(context.jobId, event);
        const [row] = await sql`SELECT f.id, f.raw_json, f.verify_status, a.extensions_json FROM findings f
          JOIN artifacts a ON a.id = f.artifact_id WHERE f.job_id = ${context.jobId}`;
        assert.ok(row);
        const admission = row.raw_json.task_outcome_admission;
        assert.equal(admission.status, "admitted_for_research");
        assert.equal(admission.submission_eligibility, "not_assessed");
        assert.equal(admission.assessment_basis, "structured_goal_relevance_only");
        assert.equal(admission.task_contract_sha256, taskContractDigest(context.contract!));
        assert.deepEqual(admission.claim, proposal);
        assert.deepEqual(row.extensions_json.task_outcome_admission, admission);
        assert.notEqual(row.verify_status, "confirmed");
        const before = await counts(context);
        await ingestEvent(context.jobId, event);
        await ingestEvent(context.jobId, { ...event, event_id: randomUUID() });
        const reordered = { ...proposal, rule_assessments: [...proposal.rule_assessments!].reverse(),
          evidence_refs: [...proposal.evidence_refs, ...proposal.evidence_refs],
          criterion_assessments: [...proposal.criterion_assessments].reverse() };
        await ingestEvent(context.jobId, { ...event, event_id: randomUUID(), payload: {
          ...event.payload, outcome_claim: reordered,
        } });
        assert.deepEqual(await counts(context), before);
        assert.equal(before.findings, 1);
        assert.equal(before.candidates, 1);
        assert.equal(before.observations, 1);
      });
      await t.test("legacy contracts remain unassessed and cannot assert goal admission", async () => {
        const context = await createContext(null);
        await ingestEvent(context.jobId, { v: 1, event_id: randomUUID(), type: "finding", payload: {
          ...finding(), raw: { task_outcome_admission: { status: "admitted_for_research", submission_eligibility: "eligible" }, imported_note: "fixture" },
        } });
        const [row] = await sql`SELECT raw_json FROM findings WHERE job_id = ${context.jobId}`;
        assert.equal(row.raw_json.task_outcome_admission, undefined);
        assert.equal(row.raw_json.imported_note, "fixture");
        const supported = await createContext({ mode: "task_defined" });
        const fact = await emitFact(supported);
        const before = await counts(context);
        await assert.rejects(ingestEvent(context.jobId, { v: 1, event_id: randomUUID(), type: "finding", payload: finding(claim(supported, fact.id)) }), ControlInputError);
        assert.deepEqual(await counts(context), before);
      });
      await t.test("task-defined and omitted outcome both require supported goal contribution, not all acceptance criteria", async () => {
        for (const policy of [{ mode: "task_defined" } as const, "omitted" as const]) {
          const context = await createContext(policy);
          const fact = await emitFact(context);
          await expectRejected(context, undefined, "blocked", "outcome_claim_missing");
          const unrelated = claim(context, fact.id);
          unrelated.criterion_assessments.find((entry) => entry.criterion_id === "objective")!.result = "does_not_match";
          await expectRejected(context, unrelated, "observation_only", "outcome_goal_excluded");
          const unresolved = claim(context, fact.id);
          unresolved.criterion_assessments.find((entry) => entry.criterion_id === "scope")!.result = "unknown";
          await expectRejected(context, unresolved, "blocked", "outcome_criterion_unresolved");
          const proposal = claim(context, fact.id);
          assert.equal(proposal.rule_assessments, undefined);
          assert.equal(proposal.criterion_assessments.filter((entry) => entry.criterion_id.startsWith("acceptance:")).length, 1);
          assert.equal(context.contract!.acceptance!.length, 2);
          await ingestEvent(context.jobId, { v: 1, event_id: randomUUID(), type: "finding", payload: finding(proposal) });
          const [row] = await sql`SELECT raw_json FROM findings WHERE job_id = ${context.jobId}`;
          assert.equal(row.raw_json.task_outcome_admission.status, "admitted_for_research");
          assert.deepEqual(row.raw_json.task_outcome_admission.claim, proposal);
        }
      });
      await t.test("editing current canvas outcome does not replace the Job's frozen bounty rules", async () => {
        const context = await createContext();
        const fact = await emitFact(context);
        await sql`UPDATE canvases SET target_json = jsonb_set(target_json, '{task_contract,outcome}', ${sql.json({ mode: "task_defined" })}) WHERE id = ${context.canvasId}`;
        await expectRejected(context, undefined, "blocked", "outcome_claim_missing");
        await ingestEvent(context.jobId, { v: 1, event_id: randomUUID(), type: "finding", payload: finding(claim(context, fact.id)) });
        const [row] = await sql`SELECT raw_json FROM findings WHERE job_id = ${context.jobId}`;
        assert.equal(row.raw_json.task_outcome_admission.task_contract_sha256, taskContractDigest(context.contract!));
      });
    } finally {
      if (endSql) await endSql().catch(() => undefined);
      if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    }
  });
}
