import assert from "node:assert/strict";
import test from "node:test";
import { repairFeedbackFromControlRejection } from "@deepsonar/shared-types";
import { KnowledgeOperationError, reject, type KnowledgeDb } from "./types.js";
import { createKnowledgeRuntime } from "./runtime.js";
import { PlatformRuntimeHandlerError } from "../platform-api/registry.js";
import { controlRuntimeRejection } from "../platform-api/repair.js";

const permanent = ["KNOWLEDGE_JOB_INACTIVE", "KNOWLEDGE_SCOPE_DENIED", "KNOWLEDGE_REVOKED", "KNOWLEDGE_SNAPSHOT_INVALID",
  "KNOWLEDGE_BUDGET_EXHAUSTED", "KNOWLEDGE_CATALOG_LIMIT", "KNOWLEDGE_SUGGESTION_CATALOG_LIMIT", "KNOWLEDGE_IDEMPOTENCY_CONFLICT"];
test("Knowledge constructor and reject share fail-closed classification without making input errors permanent", () => {
  for (const code of [...permanent, "KNOWLEDGE_INPUT_INVALID", "KNOWLEDGE_HASH_MISMATCH", "KNOWLEDGE_INPUT_TOO_LARGE"]) {
    const direct = new KnowledgeOperationError(code, "fixture", undefined, undefined, "input");
    assert.equal(direct.category, permanent.includes(code) ? "permanent_failure" : "model_correctable", code);
    assert.match(direct.next_action, permanent.includes(code) ? /^Stop/ : /correct.*new Idempotency-Key/);
    assert.throws(() => reject(code, "fixture", "input"), (error: unknown) => error instanceof KnowledgeOperationError
      && error.category === direct.category && error.next_action === direct.next_action && error.path === "input");
  }
});

test("explicit domain category and action survive shared and HTTP builders; details cannot override them", () => {
  for (const category of ["model_correctable", "transient_retryable", "unknown_external_effect", "permanent_failure"] as const) {
    const next_action = `Host action for ${category}`;
    const input = { operation: "pull_skill", code: "KNOWLEDGE_FIXTURE", message: "fixture", category, next_action,
      retryable: category === "transient_retryable", statusCode: 422,
      details: { category: "transient_retryable", next_action: "bypass authorization" } };
    const shared = repairFeedbackFromControlRejection(input), body = controlRuntimeRejection(input);
    assert.equal(shared.category, category);
    assert.equal(shared.next_action, next_action);
    assert.deepEqual(body.repair, shared);
    assert.equal(body.retryable, category === "transient_retryable");
    assert.doesNotMatch(JSON.stringify(body), /bypass authorization/);
  }
  const inferred = repairFeedbackFromControlRejection({ operation: "pull_skill", code: "fixture", message: "fixture", retryable: false,
    details: { category: "model_correctable", next_action: "bypass authorization" } });
  assert.equal(inferred.category, "permanent_failure");
  assert.doesNotMatch(inferred.next_action!, /bypass authorization/);
});

test("Skill catalog admission failures remain permanent through runtime adapter", async () => {
  const db = (async () => [{ attempt_id: "fixture", agent_snapshot_json: { platform_tools: ["search_skills"] } }]) as unknown as KnowledgeDb;
  const runtime = createKnowledgeRuntime({ db, governanceHash: "a".repeat(64) });
  await assert.rejects(runtime({ jobId: "fixture", projectId: "fixture", canvasId: null,
    operationId: "search_skills", input: { query: "fixture" }, eventId: "fixture", tokenId: "fixture", idempotencyKey: null }),
  (error: unknown) => {
    assert.ok(error instanceof PlatformRuntimeHandlerError);
    assert.equal(error.rejection?.errorCode, "JOB_SKILL_CATALOG_MISSING");
    assert.equal(error.rejection?.category, "permanent_failure");
    assert.equal(error.rejection?.retryable, false);
    assert.match(error.rejection?.next_action ?? "", /Stop Skill access.*Scheduler/);
    return true;
  });
});

test("runtime preserves all explicit domain classifications even when the code is normally correctable", async () => {
  for (const category of ["model_correctable", "transient_retryable", "unknown_external_effect", "permanent_failure"] as const) {
    const domain = new KnowledgeOperationError("KNOWLEDGE_BASE_CONFLICT", "fixture", category,
      `Host-owned action for ${category}`, "governance_hash");
    const db = (async () => { throw domain; }) as unknown as KnowledgeDb;
    const runtime = createKnowledgeRuntime({ db, governanceHash: "a".repeat(64) });
    await assert.rejects(runtime({ jobId: "fixture", projectId: "fixture", canvasId: null,
      operationId: "search_skills", input: { query: "fixture" }, eventId: "fixture", tokenId: "fixture", idempotencyKey: null }),
    (error: unknown) => {
      assert.ok(error instanceof PlatformRuntimeHandlerError);
      assert.ok(error.rejection);
      const body = controlRuntimeRejection({ operation: "search_skills", code: error.rejection.errorCode,
        message: error.message, ...error.rejection });
      assert.equal(body.repair.category, domain.category);
      assert.equal(body.repair.next_action, domain.next_action);
      assert.equal(body.repair.path, domain.path);
      assert.equal(body.retryable, category === "transient_retryable");
      return true;
    });
  }
});


test("unqualified identity conflicts stop without assuming this request has a receipt", () => {
  const domain = new KnowledgeOperationError("KNOWLEDGE_IDEMPOTENCY_CONFLICT", "fixture");
  assert.equal(domain.category, "permanent_failure");
  assert.match(domain.next_action, /stop/i);
  assert.doesNotMatch(domain.next_action, /get_knowledge_receipt/);
});

test("stored Knowledge blob integrity failure is not a model-correctable hash input", async () => {
  const { readKnowledgeBlob } = await import("./blobs.js");
  const { setSharedAssetBlobStoreForTests } = await import("../../blob-store/index.js");
  const bytes = Buffer.from("{}");
  const db = (async () => [{ blob_uri: "fixture", bytes: bytes.length }]) as unknown as KnowledgeDb;
  setSharedAssetBlobStoreForTests({ kind: "fs", put: async () => {}, exists: async () => true,
    get: async () => bytes, materializeLocal: async () => { throw new Error("unused"); } });
  try {
    await assert.rejects(readKnowledgeBlob(db, "a".repeat(64)), (error: unknown) => {
      assert.ok(error instanceof KnowledgeOperationError);
      assert.equal(error.error_code, "KNOWLEDGE_HASH_MISMATCH");
      assert.equal(error.category, "permanent_failure");
      assert.match(error.next_action, /integrity failure.*Scheduler/);
      return true;
    });
  } finally { setSharedAssetBlobStoreForTests(null); }
});


test("usage identity mismatch refuses replacement without inventing a receipt for the caller key", async () => {
  const { recordKnowledgeUsage } = await import("./usage.js");
  const statements: string[] = [];
  const db = (async (parts: TemplateStringsArray) => {
    const statement = parts.join("?"); statements.push(statement);
    if (statement.includes("FROM jobs")) return [{ id: "job" }];
    if (statement.includes("INSERT INTO project_knowledge_usages")) return [];
    if (statement.includes("SELECT id,owner_project_id,version_id"))
      return [{ id: "existing-usage", owner_project_id: "different-owner", version_id: null }];
    throw new Error(`Unexpected fixture SQL: ${statement}`);
  }) as unknown as KnowledgeDb;
  await assert.rejects(recordKnowledgeUsage(db, { projectId: "project", jobId: "job", attemptId: "attempt",
    selector: "global:fixture", contentHash: "a".repeat(64) }), (error: unknown) => {
    assert.ok(error instanceof KnowledgeOperationError);
    assert.equal(error.error_code, "KNOWLEDGE_IDEMPOTENCY_CONFLICT");
    assert.equal(error.category, "permanent_failure");
    assert.match(error.next_action, /stop/i);
    assert.doesNotMatch(error.next_action, /get_knowledge_receipt/);
    const body = controlRuntimeRejection({ operation: "pull_skill", code: error.error_code, message: error.message,
      category: error.category, next_action: error.next_action, retryable: false });
    assert.equal(body.repair.next_action, error.next_action);
    assert.equal(body.repair.category, "permanent_failure");
    assert.equal(body.retryable, false);
    return true;
  });
  assert.equal(statements.length, 3);
  assert.match(statements[1]!, /ON CONFLICT.*DO NOTHING/);
  assert.ok(statements.every(statement => !/UPDATE|DELETE/.test(statement)), "existing usage is never rewritten");
});
