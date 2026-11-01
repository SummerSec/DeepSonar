import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

// No domain/config/db import before isolation: an unset URL must really skip,
// and source capture must see the graph loaded against this disposable DB.
const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
test("genuine PostgreSQL/root HTTP: stored sessions admit, execute and review a synthetic quality chain", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not set; no default/production DB is contacted",
  timeout: 120_000,
}, async t => {
  assert.ok(databaseUrl);
  const name = `quality_api_http_${randomUUID().replaceAll("-", "")}`;
  assert.match(name, /^quality_api_http_[a-f0-9]{32}$/u);
  const adminUrl = new URL(databaseUrl), target = new URL(databaseUrl);
  adminUrl.pathname = "/postgres"; adminUrl.search = "";
  target.pathname = `/${name}`; target.search = "";
  assert.equal(target.host, adminUrl.host); assert.notEqual(target.pathname, adminUrl.pathname);
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const changes = {
    DATABASE_URL: target.toString(), AGENT_MODE: "fake", DEEPSONAR_AUTH_REQUIRED: "true",
    DEEPSONAR_MASTER_KEY: randomBytes(32).toString("hex"), DEEPSONAR_MASTER_KEY_FILE: "",
  };
  const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  let created = false, closeApp: (() => Promise<unknown>) | undefined, closeSql: (() => Promise<unknown>) | undefined;
  try {
    assert.match(name, /^quality_api_http_[a-f0-9]{32}$/u);
    await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
    Object.assign(process.env, changes);
    const [{ default: Fastify }, { default: websocket }, { sql }, { runMigrations }, { registerRoutes }, users,
      auth, identity, mappings, computation, contract, assets, worker, ledger] = await Promise.all([
      import("fastify"), import("@fastify/websocket"), import("../../db.js"), import("../../migration-runner.js"),
      import("../../routes.js"), import("../../users.js"), import("../../auth.js"), import("./identity.js"),
      import("./identity-mapping-store.js"), import("./relation-computation.js"), import("./quality-contract.js"),
      import("./quality-assets.js"), import("./quality-worker.js"), import("./quality-ledger.js"),
    ]);
    closeSql = () => sql.end({ timeout: 5 });
    const [connected] = await sql`SELECT current_database() AS name`;
    assert.equal(connected!.name, name);
    const migration = await sql.reserve();
    try { await runMigrations(migration as unknown as import("../../migration-runner.js").MigrationConnection); } finally { migration.release(); }
    const loaded = assets.bootFindingQualityAssets(); assert.equal(Object.keys(loaded.module_digests).length, 14);
    const project = randomUUID(), foreign = randomUUID(), findings = [randomUUID(), randomUUID()].sort();
    const app = Fastify({ logger: false }); closeApp = () => app.close();
    await app.register(websocket); registerRoutes(app);
    let watchedPayloadPath = "", decoded = 0; const errorAccessCounts: number[] = [];
    app.addHook("preValidation", async req => { if (req.url.startsWith(watchedPayloadPath + "/declarations/") && req.url.endsWith("/payload")) decoded++; });
    app.addHook("onError", async req => {
      if (req.url.startsWith(watchedPayloadPath + "/declarations/") && req.url.endsWith("/payload")) {
        const [row] = await sql`SELECT count(*)::int AS count FROM project_finding_quality_records WHERE project_id=${project} AND kind='holdout_access'`;
        errorAccessCounts.push(Number(row!.count));
      }
    });
    const canvases = [randomUUID(), randomUUID()], jobs = [randomUUID(), randomUUID()];
    await sql`INSERT INTO projects(id,name) VALUES(${project},'synthetic quality HTTP'),(${foreign},'foreign fixture')`;
    for (let i = 0; i < findings.length; i++) {
      await sql`INSERT INTO canvases(id,project_id,title) VALUES(${canvases[i]!},${project},'synthetic quality fixture')`;
      // Deployed selection has no Job-status filter; no illegal transition or Scheduler loop is needed.
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
        VALUES(${jobs[i]!},${project},${canvases[i]!},'audit','pending','{}')`;
      await sql`INSERT INTO findings(id,project_id,job_id,fingerprint,source_digest,title,summary)
        VALUES(${findings[i]!},${project},${jobs[i]!},${`synthetic-${i}`},NULL,
        'synthetic same problem','synthetic finding; not human evidence')`;
    }
    const sessions: string[] = [], userIds: string[] = [];
    for (const username of ["synthetic-maker", "synthetic-reviewer"]) {
      const password = randomBytes(24).toString("hex"), hashed = users.hashPassword(password);
      const [user] = await sql`INSERT INTO users(username,password_hash,password_salt,role,status)
        VALUES(${username},${hashed.hash},${hashed.salt},'admin','active') RETURNING id`;
      userIds.push(String(user!.id));
      const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password } });
      assert.equal(login.statusCode, 200); // Never print a login response/token.
      const token = String(login.json().token); assert.match(token, /^deepsonar_user_/u); sessions.push(token);
      const [stored] = await sql`SELECT user_id,token_hash FROM user_sessions WHERE token_hash=${users.hashSessionToken(token)}`;
      assert.equal(stored!.user_id, user!.id); assert.notEqual(stored!.token_hash, token);
    }
    const request = (method: "GET" | "POST", url: string, body?: unknown, bearer = sessions[0]!, extra: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { authorization: `Bearer ${bearer}`, ...extra },
        ...(body === undefined ? {} : { payload: body as string | object }) });
    const ok = async (method: "GET" | "POST", url: string, body?: unknown, bearer = sessions[0]!, status = 200) => {
      const response = await request(method, url, body, bearer); assert.equal(response.statusCode, status, response.body);
      return response.json();
    };
    const sourceBody = {
      authority_version: "synthetic-fixture/v1", source_kind: "platform_inventory",
      source_ref: "attestation://synthetic/current", freshness_until: "2099-01-01T00:00:00.000Z",
      identity_fields: Object.fromEntries(identity.STRONG_IDENTITY_FIELDS.map(field => [field, identity.digestIdentityValue(`same-${field}`)])),
    };
    for (const finding of findings) {
      const source = await ok("POST", `/findings/${finding}/identity-sources`, sourceBody, sessions[0]!, 201);
      assert.equal(source.registered_by, userIds[0]);
      for (const field of identity.STRONG_IDENTITY_FIELDS)
        await ok("POST", `/findings/${finding}/identity-mappings`, { source_id: source.source_id, field, expected_mapping_version: null }, sessions[0]!, 201);
    }
    const sources = [];
    for (const finding of findings) {
      const envelope = await computation.loadFindingEnvelope(sql, finding, project); assert.ok(envelope);
      const snapshot = await mappings.loadCurrentIdentitySnapshot(finding, project, sql);
      assert.equal(snapshot.history_truncated, false);
      for (const field of identity.STRONG_IDENTITY_FIELDS) assert.equal(snapshot.fields[field].status, "valid");
      sources.push({ id: finding, source_digest: envelope.source_fingerprint, identity_digest: snapshot.fingerprint,
        provenance_digest: contract.qualityDigest("synthetic provenance"), asset_group_digest: contract.qualityDigest("synthetic asset"),
        family_group_digest: contract.qualityDigest("synthetic family"), split: "holdout" as const });
    }
    const dataset = contract.QualityDatasetBodySchema.parse({ schema_version: 1, kind: "synthetic", sources,
      pairs: [{ left_id: findings[0], right_id: findings[1], label: "same_problem", label_evidence_digest: contract.qualityDigest("synthetic label") }] });
    const codeScope = Object.fromEntries(["code_digest", "config_digest", "selector_digest", "normalization_digest", "strong_rule_digest",
      "extractor_version", "normalization_version", "strong_rule_version", "metric_version", "population_version", "label_mapping_version"]
      .map(key => [key, loaded[key as keyof typeof loaded]]));
    const protocolBody = contract.QualityProtocolBodySchema.parse({ schema_version: 1,
      scope: { ...codeScope, project_id: project, corpus_digest: contract.qualityDigest(sources), ...contract.qualityDatasetDigests(dataset) },
      thresholds: { same_problem: { precision: 1, recall: 1 }, same_root_cause_different_instance: { precision: 1, recall: 1 } },
      valid_until: "2099-01-01T00:00:00.000Z" });
    const base = `/projects/${project}/finding-quality`, foreignBase = `/projects/${foreign}/finding-quality`;
    const registered = await ok("POST", base + "/protocols", protocolBody), protocol = String(registered.protocol.id);
    const path = `${base}/protocols/${protocol}`;
    assert.equal((await ok("POST", base + "/protocols", protocolBody)).protocol.id, protocol);
    const head = async () => {
      const [row] = await sql`SELECT *,version::text AS version FROM project_finding_quality_heads WHERE project_id=${project} AND protocol_id=${protocol}`;
      assert.ok(row); return row;
    };
    await ok("POST", path + "/freeze", { expected_version: (await head()).version });
    const declared = await ok("POST", path + "/declarations", { expected_version: (await head()).version });
    const declaration = String(declared.record.id), payloadPath = `${path}/declarations/${declaration}/payload`;
    watchedPayloadPath = path;
    const rows = () => sql`SELECT * FROM project_finding_quality_records WHERE project_id=${project} AND protocol_id=${protocol} ORDER BY created_at,id`;
    const upload = (body: string, key = randomUUID(), bearer = sessions[0]!, url = payloadPath) =>
      request("POST", url, body, bearer, { "content-type": "application/json", "idempotency-key": key });
    await t.test("stored API/Job tokens and foreign declarations fail before raw body exposure", async () => {
      const api = auth.generateToken();
      await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
        VALUES('synthetic API admin',${project},${api.prefix},${api.hash},${["admin"]})`;
      const controlJob = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,started_at,timeout_sec,agent_snapshot_json)
        VALUES(${controlJob},${project},${canvases[0]!},'audit','running',clock_timestamp(),600,
        ${sql.json({ platform_tools: ["emit_progress"], role_name: "audit" })})`;
      const capability = await import("../platform-api/tokens.js"), grant = await capability.mintJobCapabilityToken(controlJob);
      assert.equal((await request("GET", `/control/v1/jobs/${controlJob}/capabilities`, undefined, grant.token)).statusCode, 200);
      const before = await rows(), count = decoded;
      assert.equal((await upload(JSON.stringify(dataset), randomUUID(), api.plaintext)).statusCode, 403);
      assert.equal((await upload(JSON.stringify(dataset), randomUUID(), grant.token)).statusCode, 401);
      const foreignProtocol = await ok("POST", foreignBase + "/protocols", { ...protocolBody, scope: { ...protocolBody.scope, project_id: foreign } });
      const fp = `${foreignBase}/protocols/${foreignProtocol.protocol.id}`;
      await ok("POST", fp + "/freeze", { expected_version: "0" });
      const fd = await ok("POST", fp + "/declarations", { expected_version: "1" });
      assert.equal((await upload(JSON.stringify(dataset), randomUUID(), sessions[0]!, `${path}/declarations/${fd.record.id}/payload`)).statusCode, 404);
      assert.equal(decoded, count); assert.deepEqual(await rows(), before);
    });
    const failedKey = randomUUID(); let firstAccess = "";
    await t.test("actual malformed/size failures and real SQL admission rollback retain committed access and linked rejection", async () => {
      for (const [body, key, status] of [["{", failedKey, 400], [JSON.stringify("x".repeat(contract.QUALITY_INPUT_BYTES)), randomUUID(), 413]] as const) {
        const before = await rows(), count = decoded;
        assert.equal((await upload(body, key)).statusCode, status);
        const added = (await rows()).filter(row => !before.some(old => old.id === row.id));
        assert.deepEqual(added.map(row => row.kind), ["holdout_access", "rejection"]);
        assert.equal(added[1]!.subject_record_id, added[0]!.id); assert.equal(decoded, count);
        assert.equal(errorAccessCounts.at(-1), (await rows()).filter(row => row.kind === "holdout_access").length);
        firstAccess ||= String(added[0]!.id); assert.equal((await head()).first_access_record_id, firstAccess);
      }
      const before = await rows();
      await sql`ALTER TABLE project_finding_quality_work ADD CONSTRAINT quality_api_fixture_admission_failure CHECK(false) NOT VALID`;
      try {
        const response = await upload(JSON.stringify(dataset)); assert.equal(response.statusCode, 500, response.body);
        assert.equal(response.json().error_code, "QUALITY_REQUEST_FAILED");
      } finally { await sql`ALTER TABLE project_finding_quality_work DROP CONSTRAINT quality_api_fixture_admission_failure`; }
      const added = (await rows()).filter(row => !before.some(old => old.id === row.id));
      assert.deepEqual(added.map(row => row.kind), ["holdout_access", "rejection"]);
      assert.equal(added[1]!.subject_record_id, added[0]!.id);
      assert.equal((await sql`SELECT count(*)::int AS count FROM project_finding_quality_work WHERE project_id=${project}`)[0]!.count, 0);
      assert.equal((await head()).first_access_record_id, firstAccess);
      const count = decoded, preserved = await rows();
      assert.equal((await upload(JSON.stringify(dataset), failedKey)).statusCode, 409);
      assert.equal(decoded, count); assert.deepEqual(await rows(), preserved);
      const alternate = await ok("POST", base + "/protocols", { ...protocolBody,
        thresholds: { ...protocolBody.thresholds, same_problem: { precision: 0.99, recall: 1 } } });
      const freeze = await request("POST", `${base}/protocols/${alternate.protocol.id}/freeze`, { expected_version: "0" });
      assert.equal(freeze.statusCode, 409); assert.equal(freeze.json().error_code, "QUALITY_HOLDOUT_ALREADY_EXPOSED_OR_UNKNOWN");
    });
    const current = () => sql`SELECT project_id,protocol_id,certificate_record_id,scope_digest,version::text AS version FROM project_finding_quality_current ORDER BY project_id`;
    const baselineCurrent = await current();
    assert.ok(baselineCurrent.every(row => row.protocol_id === null && row.certificate_record_id === null && row.scope_digest === null));
    const readReport = () => sql.begin("isolation level repeatable read read only", tx => worker.loadStoredFindingQualityReport(tx as unknown as typeof sql, project, protocol));
    await t.test("real admission, two immutable subject observations and a completion tick produce the exact stored report", async () => {
      const admitted = await upload(JSON.stringify(dataset)); assert.equal(admitted.statusCode, 200, admitted.body);
      assert.equal(admitted.json().quality_status, "not_evaluated");
      for (let tick = 0; tick < 3; tick++) {
        assert.equal(await worker.processFindingQualityWork(), true);
        const [work] = await sql`SELECT status,last_error_code,state_json FROM project_finding_quality_work WHERE project_id=${project} AND protocol_id=${protocol}`;
        assert.equal(work!.status, tick === 2 ? "completed" : "running", String(work!.last_error_code));
        assert.equal(work!.state_json.next_ordinal, Math.min(tick + 1, 2));
      }
      assert.equal(await worker.processFindingQualityWork(), false);
      const observations = await sql`SELECT * FROM project_finding_quality_observations WHERE project_id=${project} AND protocol_id=${protocol} ORDER BY ordinal`;
      assert.deepEqual(observations.map(row => row.subject_finding_id), findings);
      assert.deepEqual(observations.map(row => row.ordinal), [0, 1]);
      assert.deepEqual(observations.map(row => row.body_json.selection.peerIds), [[findings[1]], []]);
      assert.equal(observations[0]!.body_json.decisions[0].prediction, "same_problem");
      await assert.rejects(sql`UPDATE project_finding_quality_observations SET body_json=body_json WHERE id=${observations[0]!.id}`);
      const [work] = await sql`SELECT *,generation::text AS generation,processed_generation::text AS processed_generation FROM project_finding_quality_work WHERE project_id=${project} AND protocol_id=${protocol}`;
      const validated = await worker.loadFindingQualityObservations(sql, { project_id: project, protocol_id: protocol,
        generation: String(work!.generation), dataset_record_id: String(work!.dataset_record_id) });
      assert.deepEqual(validated, observations.map(row => row.body_json));
      assert.equal(work!.generation, work!.processed_generation); assert.equal(work!.evaluation_record_id, (await head()).evaluation_record_id);
      assert.equal((await rows()).filter(row => row.kind === "evaluation").length, 1);
      await assert.rejects(sql.begin(async tx => worker.loadStoredFindingQualityReport(tx as unknown as typeof sql, project, protocol)),
        (error: unknown) => error instanceof contract.QualityContractError && error.code === "QUALITY_REPORT_SNAPSHOT_REQUIRED");
      const stored = await readReport();
      assert.equal(stored.quality_status, "not_evaluated"); assert.equal(stored.source_validation, "repeatable_read_mvcc_snapshot");
      assert.equal(stored.report.dataset_kind, "synthetic"); assert.equal(stored.report.selected_pairs, 1); assert.equal(stored.report.compared_pairs, 1);
      const evaluation = ledger.validateQualityRecord((await rows()).find(row => row.kind === "evaluation"));
      assert.equal(evaluation.kind, "evaluation");
      assert.equal("report_digest" in evaluation.body ? evaluation.body.report_digest : undefined, stored.report.report_digest);
      assert.equal(stored.report.binding.run_id, admitted.json().run_id);
      assert.deepEqual(await current(), baselineCurrent); assert.equal((await head()).first_access_record_id, firstAccess);
    });
    await t.test("actual RR source drift rolls back review; a separate stored synthetic user persists only an unknown candidate", async () => {
      const body = { expected_version: (await head()).version, evidence_digest: null, expires_at: "2098-01-01T00:00:00.000Z" };
      const before = await rows(), version = (await head()).version;
      const conflict = await request("POST", path + "/reviews", body);
      assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error_code, "QUALITY_REVIEW_PRINCIPAL_CONFLICT");
      assert.deepEqual(await rows(), before); assert.equal((await head()).version, version);
      const [originalSource] = await sql`SELECT summary,updated_at::text AS updated_at FROM findings WHERE id=${findings[0]!}`;
      assert.ok(originalSource);
      try {
        await sql`UPDATE findings SET summary='synthetic drift before review',updated_at=clock_timestamp() WHERE id=${findings[0]!}`;
        const driftReview = await request("POST", path + "/reviews", body, sessions[1]!);
        assert.equal(driftReview.statusCode, 400, driftReview.body);
        assert.equal(driftReview.json().error_code, "QUALITY_ADMITTED_SOURCE_CHANGED");
        assert.deepEqual(await rows(), before); assert.equal((await head()).version, version);
      } finally {
        // Restore this disposable Finding exactly, including SQL microseconds; no history/Job rewrites.
        await sql`UPDATE findings SET summary=${originalSource.summary},updated_at=${originalSource.updated_at}::timestamptz WHERE id=${findings[0]!}`;
      }
      const review = await ok("POST", path + "/reviews", body, sessions[1]!);
      assert.equal(review.quality_status, "not_evaluated"); assert.equal(review.chain.integrity_status, "structurally_valid");
      assert.equal(review.record.actor_id, userIds[1]); assert.notEqual(review.record.actor_id, userIds[0]);
      assert.equal((await head()).phase, "reviewed"); assert.deepEqual(await current(), baselineCurrent);
      const metadata = await request("GET", path); assert.equal(metadata.statusCode, 200, metadata.body);
      assert.equal(metadata.headers["cache-control"], "no-store");
      assert.ok(!/"(?:pairs|sources|selections|decisions|state_json)":/u.test(metadata.body));
      assert.equal(metadata.json().quality_status, "not_evaluated");
      const publicReport = await request("GET", path + "/report"); assert.equal(publicReport.statusCode, 200, publicReport.body);
      assert.equal(publicReport.headers["cache-control"], "no-store");
      assert.equal(publicReport.json().source_validation, "repeatable_read_mvcc_snapshot");
      assert.equal(publicReport.json().quality_status, "not_evaluated");
      assert.equal(publicReport.json().report.report_digest, (await readReport()).report.report_digest);
      assert.ok(!/"(?:input|pairs|sources|selections|selection|decisions)":/u.test(publicReport.body));
    });
    await t.test("current source drift fails RR report loading; revoke preserves history/first access and other current tuples", async () => {
      const history = await rows();
      await sql`UPDATE findings SET summary='changed synthetic source',updated_at=clock_timestamp() WHERE id=${findings[0]!}`;
      await assert.rejects(sql.begin("isolation level repeatable read read only", tx => worker.loadStoredFindingQualityReport(tx as unknown as typeof sql, project, protocol)),
        (error: unknown) => error instanceof contract.QualityContractError && error.code === "QUALITY_ADMITTED_SOURCE_CHANGED");
      const rejectedReport = await request("GET", path + "/report"); assert.equal(rejectedReport.statusCode, 400);
      assert.equal(rejectedReport.json().error_code, "QUALITY_ADMITTED_SOURCE_CHANGED");
      const version = (await head()).version;
      const duplicateReview = await request("POST", path + "/reviews", { expected_version: version, evidence_digest: null,
        expires_at: "2098-01-01T00:00:00.000Z" }, sessions[1]!);
      assert.equal(duplicateReview.statusCode, 409); assert.equal(duplicateReview.json().error_code, "QUALITY_HEAD_TRANSITION_INVALID");
      assert.deepEqual(await rows(), history); assert.equal((await head()).version, version);
      const revoke = await ok("POST", path + "/revoke", { expected_version: (await head()).version, reason: "synthetic source drift" }, sessions[1]!);
      assert.equal(revoke.quality_status, "not_evaluated"); assert.equal((await head()).phase, "revoked");
      assert.equal((await head()).first_access_record_id, firstAccess); assert.deepEqual((await rows()).slice(0, history.length), history);
      assert.deepEqual(await current(), baselineCurrent);
      const before = await rows(), refused = await upload(JSON.stringify(dataset)); assert.equal(refused.statusCode, 409);
      const added = (await rows()).filter(row => !before.some(old => old.id === row.id));
      assert.deepEqual(added.map(row => row.kind), ["holdout_access", "rejection"]);
      assert.equal(added[1]!.subject_record_id, added[0]!.id); assert.equal((await head()).phase, "revoked");
      assert.equal((await head()).first_access_record_id, firstAccess); assert.deepEqual(await current(), baselineCurrent);
    });
  } finally {
    try { await closeApp?.(); } finally {
      try { await closeSql?.(); } finally {
        try {
          if (created) {
            assert.equal(target.pathname, `/${name}`); assert.equal(target.host, adminUrl.host);
            assert.match(name, /^quality_api_http_[a-f0-9]{32}$/u);
            await admin.unsafe(`DROP DATABASE "${name}"`);
          }
        } finally {
          await admin.end({ timeout: 5 });
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
          }
        }
      }
    }
  }
});
