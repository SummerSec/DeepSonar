import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Fastify from "fastify";
import type { Actor } from "../../auth.js";
import { registerProgramEligibilityRoutes } from "./routes.js";
import { loadProgramMaterials } from "./store.js";

const findingId = "00000000-0000-4000-8000-000000000001";
const materialId = "00000000-0000-4000-8000-000000000002";
const digest = `sha256:${"a".repeat(64)}`;
const sourceDigest = `v1:${"b".repeat(64)}`;
const projectId = "00000000-0000-4000-8000-000000000003";

const materialRequest = {
  schema_version: 1, scope: { kind: "platform" }, program_id: "fixture", version: "1",
  authority: { kind: "platform_curated", name: "Fixture", reference: "fixture://rules", source_sha256: digest },
  targets: [{ id: "target", type: "repository", reference: "fixture/repo", baseline: "v1" }],
  rules: [{ id: "proof", kind: "requirement", description: "Retained proof" }],
  idempotency_key: materialId,
};

const reviewRequest = {
  schema_version: 1, finding_id: findingId, finding_artifact_id: materialId, finding_artifact_revision: 1, finding_source_digest: sourceDigest,
  program_material_id: materialId, program_id: "fixture", program_version: "1", program_source_sha256: digest,
  target_id: "target", target_reference: "fixture/repo", baseline: "v1", decision: "approve",
  rule_assessments: [{ rule_id: "proof", result: "satisfied", evidence_refs: [materialId] }], evidence_refs: [materialId],
  reason: "Independent fixture review", idempotency_key: projectId,
};

const dbMustNotBeTouched = new Proxy(() => undefined, {
  apply() { throw new Error("database must not be touched"); },
  get() { throw new Error("database must not be touched"); },
}) as never;

async function withActor(actor: Actor, run: (app: ReturnType<typeof Fastify>) => Promise<void>): Promise<void> {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => { req.actor = actor; });
  registerProgramEligibilityRoutes(app, dbMustNotBeTouched);
  await app.ready();
  try { await run(app); } finally { await app.close(); }
}

test("Agent/internal actors cannot register trusted material or approve eligibility", async () => {
  await withActor({ type: "internal", id: null, name: "internal", projectId: null, scopes: ["admin", "findings:write"] }, async (app) => {
    const material = await app.inject({ method: "POST", url: "/program-materials", payload: materialRequest });
    assert.equal(material.statusCode, 403);
    assert.equal(material.json().error_code, "PROGRAM_MATERIAL_PERMISSION_REQUIRED");
    const review = await app.inject({ method: "POST", url: `/findings/${findingId}/program-eligibility/reviews`, payload: reviewRequest });
    assert.equal(review.statusCode, 403);
    assert.equal(review.json().error_code, "PROGRAM_ELIGIBILITY_REVIEW_PERMISSION_REQUIRED");
  });
});

test("viewer reviewers are rejected before any SQL is executed", async () => {
  await withActor({ type: "user", id: "viewer-1", name: "viewer", projectId: projectId, role: "viewer", scopes: ["findings:write"] }, async (app) => {
    const response = await app.inject({ method: "POST", url: `/findings/${findingId}/program-eligibility/reviews`, payload: reviewRequest });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error_code, "PROGRAM_ELIGIBILITY_REVIEW_PERMISSION_REQUIRED");
  });
});

test("reviewer identity and permission cannot be supplied in the request body", async () => {
  await withActor({ type: "user", id: "operator-1", name: "operator", projectId: projectId, role: "operator", scopes: ["findings:write"] }, async (app) => {
    const response = await app.inject({ method: "POST", url: `/findings/${findingId}/program-eligibility/reviews`, payload: { ...reviewRequest, reviewer: { actor_id: "spoofed", permission: "admin" } } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error_code, "PROGRAM_ELIGIBILITY_INVALID_PAYLOAD");
  });
});

test("the SQL store is append-only and does not create a second execution channel", () => {
  const source = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
  assert.match(source, /FROM audit_logs/);
  assert.match(source, /INSERT INTO audit_logs/);
  assert.match(source, /pg_advisory_xact_lock\(hashtext/);
  assert.doesNotMatch(source, /INSERT INTO (?:jobs|artifacts|events|job_attempts)/i);
  assert.doesNotMatch(source, /fetch\(|axios|child_process/);
});

test("malformed material audit timestamps fail closed instead of throwing", async () => {
  const db = (async () => [{
    action: "program_material.register", resource_id: materialId, after_json: {}, payload_bytes: 2, at: "not-a-timestamp",
  }]) as never;
  const result = await loadProgramMaterials(db);
  assert.equal(result.incomplete, true);
  assert.equal(result.materials.length, 0);
});
