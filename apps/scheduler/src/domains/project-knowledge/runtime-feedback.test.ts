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

test("#1128 read_knowledge_input 四类失败各自可行动，hash 混淆有明确提示", async () => {
  const { readManifestInput } = await import("./inputs.js");
  const actor = { jobId: "job-1", projectId: "project-1", attemptId: "attempt-1", canvasId: null, snapshot: {} };
  const entry = (input_ref: string, content_hash: string, audience: string[]) => ({ input_ref, kind: "evaluation", project_id: actor.projectId,
    content_hash, bytes: 10, blob_hash: "b".repeat(64), audience });
  const assignment = (overrides: Record<string, unknown> = {}) => ({ work_id: "work-1", stage: "maker", governance_hash: "g".repeat(64),
    input_manifest_json: [entry("fact:case-1", "a".repeat(64), ["maker"]), entry("revision-feedback:p:2", "c".repeat(64), ["maker"])], ...overrides });
  const dbWith = (rows: unknown[]) => (async () => rows) as unknown as Parameters<typeof readManifestInput>[0];
  const expectRejected = async (run: Promise<unknown>, code: string, pattern: RegExp, path: string) => {
    await assert.rejects(run as Promise<never>, (error: unknown) => {
      assert.ok(error instanceof KnowledgeOperationError);
      assert.equal(error.error_code, code);
      assert.equal(error.category, "model_correctable", `${code} 必须让 Agent 能自行修正`);
      assert.equal(error.path, path);
      assert.match(error.message, pattern);
      return true;
    });
  };
  // ① work_ref 不属于本 Job：回显可用 work_ref 与 stage
  await expectRejected(readManifestInput(dbWith([assignment()]), actor, { work_ref: "work-other", input_ref: "fact:case-1", expected_hash: "a".repeat(64) }),
    "KNOWLEDGE_WORK_NOT_ASSIGNED", /assigned work_refs: work-1 \(stage=maker\)/, "work_ref");
  // ② input_ref 不在 manifest：回显可用 input_ref
  await expectRejected(readManifestInput(dbWith([assignment()]), actor, { work_ref: "work-1", input_ref: "fact:missing", expected_hash: "a".repeat(64) }),
    "KNOWLEDGE_INPUT_REF_UNKNOWN", /available input_refs: fact:case-1, revision-feedback:p:2/, "input_ref");
  // ③ hash 用成 input_ref 尾部的 hex：必须指出去取 manifest[].content_hash
  await expectRejected(readManifestInput(dbWith([assignment()]), actor, { work_ref: "work-1", input_ref: "revision-feedback:p:2", expected_hash: "d".repeat(64) }),
    "KNOWLEDGE_INPUT_HASH_MISMATCH", /must be manifest\[\]\.content_hash of revision-feedback:p:2, which starts with cccccccc[\s\S]*NOT the expected hash/, "expected_hash");
  // ④ audience 不含当前 stage：两侧都要回显
  const reviewerOnly = assignment({ input_manifest_json: [entry("fact:case-1", "a".repeat(64), ["reviewer"])] });
  await expectRejected(readManifestInput(dbWith([reviewerOnly]), actor, { work_ref: "work-1", input_ref: "fact:case-1", expected_hash: "a".repeat(64) }),
    "KNOWLEDGE_INPUT_AUDIENCE_DENIED", /visible to audience \[reviewer\], current stage is maker/, "input_ref");
});
