import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

// The governed CLI uses HTTP directly (deepsonar-control); these are the actual
// JSON tool responses, not a model-understanding or live-CLI acceptance test.
test("Knowledge feedback survives domain, runtime registry and real Control HTTP responses", async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl, "TEST_DATABASE_URL is required; refusing a business database");
  const url = new URL(databaseUrl); url.pathname = "/postgres";
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const name = `knowledge_feedback_${randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString(); process.env.AGENT_MODE = "fake";
  const [{ default: Fastify }, { sql, migrate }, api, { createKnowledgeRuntime }, support, catalog, blobs, store, types] = await Promise.all([
    import("fastify"), import("../../db.js"), import("../platform-api/index.js"), import("./runtime.js"),
    import("./test-support.js"), import("./catalog-snapshot.js"), import("./blobs.js"),
    import("../../blob-store/index.js"), import("./types.js"),
  ]);
  const app = Fastify(), registered: string[] = [];
  const bytes = new Map<string, Buffer>();
  store.setSharedAssetBlobStoreForTests({ kind: "fs",
    put: async (key, value) => { bytes.set(key, Buffer.from(value)); },
    exists: async key => bytes.has(key), get: async key => bytes.get(key)!,
    materializeLocal: async () => { throw new Error("unused"); },
  });
  try {
    await migrate(); api.registerPlatformControlRoutes(app); await app.ready();
    const owner = await support.seedKnowledgeJob(sql);
    const consumer = await support.seedKnowledgeJob(sql, undefined, ["pull_skill", "search_project_knowledge"]);
    const item = randomUUID(), version = randomUUID();
    const blob = await blobs.writeKnowledgeBlob(sql, { kind: "skill", logical_key: "feedback", title: "Feedback fixture",
      keywords: [], files: { "SKILL.md": "Use assigned inputs only." } });
    await blobs.registerKnowledgeBlob(sql, blob.hash, blob.bytes);
    await sql`INSERT INTO project_knowledge_items(id,project_id,kind,logical_key,title)
      VALUES(${item},${owner.projectId},'skill','feedback','Feedback fixture')`;
    await sql`INSERT INTO project_knowledge_versions(id,project_id,item_id,version,content_sha256,creator_job_id,creator_attempt_id,sources_json,governance_hash)
      VALUES(${version},${owner.projectId},${item},1,${blob.hash},${owner.jobId},${owner.attemptId},'[]',${blob.hash})`;
    await sql`UPDATE project_knowledge_items SET active_version_id=${version},status='active' WHERE id=${item}`;
    const [grant] = await sql`INSERT INTO project_knowledge_grants(owner_project_id,item_id,version_id,grantee_project_id,granted_by)
      VALUES(${owner.projectId},${item},${version},${consumer.projectId},'fixture') RETURNING id`;
    const frozen = await catalog.freezeProjectKnowledgeCatalog(sql, consumer.projectId);
    await sql`UPDATE jobs SET agent_snapshot_json=${sql.json({ platform_tools: ["pull_skill", "search_project_knowledge"], project_knowledge_catalog: frozen } as never)} WHERE id=${consumer.jobId}`;
    const token = await api.mintJobCapabilityToken(consumer.jobId);
    const runtime = createKnowledgeRuntime({ db: sql, governanceHash: blob.hash });
    let calls = 0;
    api.registerRuntimeHandler(consumer.jobId, context => { calls++; return runtime(context); }, ["pull_skill", "search_project_knowledge"]);
    registered.push(consumer.jobId);
    const post = (operation: string, input: unknown) => app.inject({ method: "POST",
      url: `/control/v1/jobs/${consumer.jobId}/operations/${operation}`,
      headers: { authorization: `Bearer ${token.token}`, "idempotency-key": randomUUID(), "content-type": "application/json" },
      payload: JSON.stringify(input),
    });
    const input = { selector: catalog.projectSkillSelector(frozen.entries[0]!), expected_content_hash: blob.hash };
    const check = (response: Awaited<ReturnType<typeof post>>, code: string, operation = "pull_skill") => {
      const body = response.json();
      const domain = new types.KnowledgeOperationError(code, "fixture");
      assert.equal(body.accepted, false, response.body);
      assert.equal(body.error_code, code, response.body);
      assert.equal(body.retryable, false, response.body);
      assert.equal(body.repair.code, code);
      assert.equal(body.repair.operation, operation);
      assert.equal(body.repair.category, domain.category);
      assert.equal(body.repair.next_action, domain.next_action, "domain action must not be replaced by a generic HTTP hint");
      return body;
    };
    const cursor = await post("search_project_knowledge", { cursor: "invalid-cursor" });
    assert.equal(cursor.statusCode, 422, cursor.body);
    assert.equal(check(cursor, "KNOWLEDGE_CURSOR_INVALID", "search_project_knowledge").repair.category, "model_correctable");
    const correctedSearch = await post("search_project_knowledge", {});
    assert.equal(correctedSearch.statusCode, 200, correctedSearch.body);
    assert.equal(correctedSearch.json().accepted, true);
    const invalid = await post("pull_skill", { ...input, expected_content_hash: "f".repeat(64) });
    assert.equal(invalid.statusCode, 422, invalid.body);
    assert.equal(check(invalid, "KNOWLEDGE_HASH_MISMATCH").repair.category, "model_correctable");
    assert.equal((await sql`SELECT count(*)::int AS n FROM project_knowledge_usages WHERE job_id=${consumer.jobId}`)[0].n, 0);
    const corrected = await post("pull_skill", input);
    assert.equal(corrected.statusCode, 200, corrected.body);
    assert.equal(corrected.json().accepted, true);
    assert.equal((await sql`SELECT count(*)::int AS n FROM project_knowledge_usages WHERE job_id=${consumer.jobId}`)[0].n, 1);

    await sql`UPDATE project_knowledge_grants SET revoked_at=now() WHERE id=${grant.id}`;
    const revoked = await post("pull_skill", input);
    assert.equal(check(revoked, "KNOWLEDGE_REVOKED").repair.category, "permanent_failure");
    assert.equal((await sql`SELECT count(*)::int AS n FROM project_knowledge_usages WHERE job_id=${consumer.jobId}`)[0].n, 1,
      "revoked pull cannot add usage or erase prior evidence");

    // Token admission currently checks Job status, not Attempt status/lease.
    // Both Knowledge application and Skill runtime must reject these reachable requests.
    for (const operation of ["pull_skill", "search_project_knowledge"]) {
      await sql`UPDATE job_attempts SET cancel_requested=true,cancel_requested_at=now() WHERE id=${consumer.attemptId}`;
      assert.equal(check(await post(operation, operation === "pull_skill" ? input : {}), "KNOWLEDGE_JOB_INACTIVE", operation).repair.category, "permanent_failure");
      await sql`UPDATE job_attempts SET cancel_requested=false,status='interrupted' WHERE id=${consumer.attemptId}`;
      check(await post(operation, operation === "pull_skill" ? input : {}), "KNOWLEDGE_JOB_INACTIVE", operation);
      await sql`UPDATE job_attempts SET status='active' WHERE id=${consumer.attemptId}`;
      await sql`UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=${consumer.jobId}`;
      check(await post(operation, operation === "pull_skill" ? input : {}), "KNOWLEDGE_JOB_INACTIVE", operation);
      await sql`UPDATE jobs SET lease_expires_at=now()+interval '1 hour' WHERE id=${consumer.jobId}`;
    }

    // Outer admission wins: these are not domain-to-runtime reachability claims.
    const before = calls;
    await sql`UPDATE jobs SET status='cancelled' WHERE id=${consumer.jobId}`;
    const terminal = await post("pull_skill", input);
    assert.equal(terminal.statusCode, 409, terminal.body);
    assert.equal(terminal.json().error_code, "CAPABILITY_JOB_NOT_ACTIVE");
    assert.equal(calls, before);
    await sql`UPDATE jobs SET status='running' WHERE id=${consumer.jobId}`;
    await api.revokeJobCapabilityTokens(consumer.jobId);
    const tokenRevoked = await post("pull_skill", input);
    assert.equal(tokenRevoked.statusCode, 401, tokenRevoked.body);
    assert.equal(tokenRevoked.json().error_code, "CAPABILITY_TOKEN_REVOKED");
    assert.equal(calls, before);
  } finally {
    for (const id of registered) api.unregisterRuntimeHandler(id);
    store.setSharedAssetBlobStoreForTests(null);
    await app.close(); await sql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end({ timeout: 5 });
  }
});
