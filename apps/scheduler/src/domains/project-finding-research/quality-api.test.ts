import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Fastify from "fastify";
import type { Actor } from "../../auth.js";
import { registerFindingQualityRoutes } from "./quality-api.js";
import { bootFindingQualityAssets } from "./quality-assets.js";
import { appendQualityRecord } from "./quality-store.js";
import { advanceQualityHead, withQualityHead, type QualityStateDb } from "./quality-state-store.js";
import { computeQualityMetrics } from "./quality-metrics.js";
import { validateQualityRecord } from "./quality-ledger.js";
import { QUALITY_INPUT_BYTES, QualityProtocolBodySchema, qualityDatasetDigests, qualityDigest } from "./quality-contract.js";

// Real Fastify hooks, domain calls and SQL tag bindings; transactional rows are synthetic,
// not PostgreSQL, authenticated-session, natural-human or independent-quality evidence.
type Row = Record<string, unknown>;
const id = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const project = id(99), digest = qualityDigest("synthetic API data");
const principal: Actor = { type: "user", id: id(60), name: "synthetic operator", role: "admin", scopes: ["admin"], projectId: project };
const assets = bootFindingQualityAssets();
const dataset = { schema_version: 1, kind: "synthetic", sources: [1, 2, 3].map(n => ({
  id: id(n), source_digest: digest, identity_digest: digest, provenance_digest: digest,
  asset_group_digest: qualityDigest(n), family_group_digest: qualityDigest(n), split: n === 3 ? "tuning" : "holdout",
})), pairs: [{ left_id: id(1), right_id: id(2), label: "same_problem", label_evidence_digest: digest }] };
const assetNames = ["code_digest", "config_digest", "selector_digest", "normalization_digest", "strong_rule_digest",
  "extractor_version", "normalization_version", "strong_rule_version", "metric_version", "population_version", "label_mapping_version"] as const;
const protocolBody = QualityProtocolBodySchema.parse({ schema_version: 1,
  scope: { project_id: project, ...Object.fromEntries(assetNames.map(k => [k, assets[k]])), corpus_digest: digest, ...qualityDatasetDigests(dataset) },
  thresholds: { same_problem: { precision: 1, recall: 1 }, same_root_cause_different_instance: { precision: 1, recall: 1 } },
  valid_until: "2099-01-01T00:00:00Z" });
const clone = <T>(value: T): T => structuredClone(value);
function database() {
  let state = { protocols: [] as Row[], records: [] as Row[], heads: [] as Row[], currents: [] as Row[], work: [] as Row[] };
  const calls: Array<{ text: string; values: unknown[] }> = [], events: string[] = [];
  let clock = Date.now() - 60_000, failWork = false, isolation = "read committed";
  const transactionOptions: string[] = [];
  const query = async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const text = strings.join("?").replace(/\s+/gu, " ").trim();
    calls.push({ text, values: v });
    if (text === "SHOW transaction_isolation") return [{ transaction_isolation: isolation }];
    if (text === "SELECT clock_timestamp() AS now") return [{ now: new Date(Date.now()) }];
    if (text.startsWith("WITH protocols")) {
      assert.equal(v[0], v[2]); assert.equal(v[1], v[3]); assert.equal(v[4], QUALITY_INPUT_BYTES);
      return [{ protocol_rows: clone(state.protocols.filter(r => r.project_id === v[0]).slice(0, Number(v[1]))),
        records: clone(state.records.filter(r => r.project_id === v[2]).slice(0, Number(v[3]))), history_overflow: false }];
    }
    if (text.includes("FROM project_finding_quality_current")) return clone(state.currents.filter(r => r.project_id === v[0]));
    if (text.includes("FROM project_finding_quality_heads")) return clone(state.heads.filter(r => r.project_id === v[0] && r.protocol_id === v[1]));
    if (text.includes("FROM project_finding_quality_protocols")) return clone(state.protocols.filter(r => r.project_id === v[0]
      && (text.includes("AND protocol_digest=") ? r.protocol_digest === v[1] : r.id === v[1])));
    if (text.includes("FROM project_finding_quality_records")) return clone(state.records.filter(r => r.project_id === v[0]
      && r.protocol_id === v[1] && (text.includes("request_key=") ? r.kind === "holdout_access" && r.request_key === v[2] : r.id === v[2])));
    if (text.includes("FROM project_finding_quality_work")) return state.work.filter(r => r.project_id === v[0] && r.protocol_id === v[1])
      .map(r => Object.fromEntries(["status", "generation", "processed_generation", "evaluation_record_id", "last_error_code"].map(k => [k, r[k]])));
    if (text.startsWith("INSERT INTO project_finding_quality_protocols")) {
      if (state.protocols.some(r => r.project_id === v[0] && r.protocol_digest === v[1])) return [];
      const row = { id: id(100 + state.protocols.length), project_id: v[0], protocol_digest: v[1], body_json: v[2],
        created_by_actor_type: v[3], created_by_actor_id: v[4], created_by_actor_name: v[5], created_at: new Date(++clock) };
      state.protocols.push(row); return [clone(row)];
    }
    if (text.startsWith("INSERT INTO project_finding_quality_records")) {
      if (v[6] !== null && state.records.some(r => r.project_id === v[1] && r.protocol_id === v[2] && r.kind === v[3] && r.request_key === v[6])) throw new Error("duplicate request key");
      const row = { id: v[0], project_id: v[1], protocol_id: v[2], kind: v[3], record_digest: v[4],
        subject_record_id: v[5], request_key: v[6], actor_type: v[7], actor_id: v[8], actor_name: v[9], body_json: v[10], created_at: new Date(++clock) };
      state.records.push(row); return [clone(row)];
    }
    if (text.startsWith("INSERT INTO project_finding_quality_heads")) {
      state.heads.push({ project_id: v[0], protocol_id: v[1], version: "0", phase: "registered", latest_record_id: v[2],
        freeze_record_id: null, declaration_record_id: null, first_access_record_id: null, dataset_record_id: null,
        evaluation_record_id: null, review_record_id: null, revocation_record_id: null, updated_at: new Date(++clock) }); return [];
    }
    if (text.startsWith("INSERT INTO project_finding_quality_current")) {
      if (!state.currents.some(r => r.project_id === v[0])) state.currents.push({ project_id: v[0], version: "0", protocol_id: null, certificate_record_id: null, scope_digest: null });
      return [];
    }
    if (text.startsWith("UPDATE project_finding_quality_heads")) {
      assert.match(text, /WHERE project_id=\? AND protocol_id=\? AND version=\?::bigint RETURNING/u);
      const row = state.heads.find(r => r.project_id === v[9] && r.protocol_id === v[10] && r.version === v[11]);
      if (!row) return [];
      Object.assign(row, { version: (BigInt(String(row.version)) + 1n).toString(), phase: v[0], latest_record_id: v[1],
        freeze_record_id: v[2], declaration_record_id: v[3], first_access_record_id: row.first_access_record_id ?? v[4],
        dataset_record_id: v[5], evaluation_record_id: v[6], review_record_id: v[7], revocation_record_id: v[8], updated_at: new Date(++clock) });
      return [clone(row)];
    }
    if (text.startsWith("INSERT INTO project_finding_quality_work")) {
      if (failWork) throw new Error("synthetic work insertion failure");
      if (state.work.some(r => r.project_id === v[0] && r.protocol_id === v[1])) throw new Error("duplicate admitted work");
      state.work.push({ project_id: v[0], protocol_id: v[1], dataset_record_id: v[2], state_json: v[3], status: "pending",
        generation: "1", processed_generation: "0", evaluation_record_id: null, last_error_code: null }); return [];
    }
    if (text.startsWith("UPDATE project_finding_quality_work")) {
      state.work.filter(r => r.project_id === v[0] && r.protocol_id === v[1] && ["pending", "running"].includes(String(r.status)))
        .forEach(r => Object.assign(r, { status: "failed", last_error_code: "QUALITY_PROTOCOL_REVOKED" })); return [];
    }
    if (text.startsWith("UPDATE project_finding_quality_current")) {
      assert.match(text, /WHERE project_id=\? AND protocol_id=\?$/u);
      state.currents.filter(r => r.project_id === v[0] && r.protocol_id === v[1]).forEach(r => Object.assign(r,
        { version: (BigInt(String(r.version)) + 1n).toString(), protocol_id: null, certificate_record_id: null, scope_digest: null })); return [];
    }
    throw new Error(`unhandled SQL: ${text}`);
  };
  const db = Object.assign(query, { json: (v: unknown) => v,
    begin: async (value: string | ((tx: QualityStateDb) => Promise<unknown>), callback?: (tx: QualityStateDb) => Promise<unknown>) => {
      const run = typeof value === "string" ? callback : value; assert.ok(run);
      if (typeof value === "string") assert.ok(["isolation level repeatable read", "isolation level repeatable read read only"].includes(value));
      transactionOptions.push(typeof value === "string" ? value : "default");
      const before = clone(state), previousIsolation = isolation; events.push("begin");
      isolation = typeof value === "string" ? "repeatable read" : "read committed";
      const tx = Object.assign((s: TemplateStringsArray, ...v: unknown[]) => query(s, ...v), { json: (v: unknown) => v }) as unknown as QualityStateDb;
      try { const result = await run(tx); events.push(`commit:${state.records.slice(before.records.length).map(r => r.kind).join(",")}`); return result; }
      catch (error) { state = before; events.push("rollback"); throw error; }
      finally { isolation = previousIsolation; }
    } }) as unknown as QualityStateDb;
  return { db, calls, events, transactionOptions, get state() { return state; }, nextTime: () => new Date(clock + 1).toISOString(), failWork: () => { failWork = true; } };
}
async function harness(t: TestContext, prepare = true) {
  const m = database(), app = Fastify(); let actor: Actor | undefined = principal, protocolId = "", declarationId = "";
  app.decorateRequest("actor", undefined);
  app.addHook("onRequest", async req => { m.events.push("auth"); if (actor) req.actor = actor; });
  app.addHook("preValidation", async () => { m.events.push("decoded"); });
  app.addHook("onError", async () => { m.events.push("error"); });
  registerFindingQualityRoutes(app, m.db); t.after(() => app.close());
  const base = `/projects/${project}/finding-quality`;
  const post = (suffix: string, value: unknown) => app.inject({ method: "POST", url: base + suffix,
    headers: { "content-type": "application/json" }, payload: JSON.stringify(value) });
  const upload = (payload: string, key?: string, contentType = "application/json", declaration = declarationId) => app.inject({
    method: "POST", url: `${base}/protocols/${protocolId}/declarations/${declaration}/payload`,
    headers: { "content-type": contentType, ...(key === undefined ? {} : { "idempotency-key": key }) }, payload });
  const register = async () => { const r = await post("/protocols", protocolBody); assert.equal(r.statusCode, 200, r.body); protocolId = r.json().protocol.id; };
  const declare = async () => { const r = await post(`/protocols/${protocolId}/declarations`, { expected_version: String(m.state.heads[0]!.version) });
    assert.equal(r.statusCode, 200, r.body); declarationId = r.json().record.id; };
  if (prepare) { await register(); const r = await post(`/protocols/${protocolId}/freeze`, { expected_version: "0" }); assert.equal(r.statusCode, 200, r.body); await declare(); }
  m.calls.length = 0; m.events.length = 0;
  return { ...m, get state() { return m.state; }, app, base, post, upload, register, declare,
    get protocolId() { return protocolId; }, get declarationId() { return declarationId; },
    get head() { return m.state.heads[0]!; }, setActor: (value: Actor | undefined) => { actor = value; } };
}
const kinds = (f: Awaited<ReturnType<typeof harness>>) => f.state.records.map(r => r.kind);
function noCertificate(f: Awaited<ReturnType<typeof harness>>) {
  assert.ok(f.state.currents.every(r => r.protocol_id === null && r.certificate_record_id === null && r.scope_digest === null));
  assert.ok(!f.calls.some(c => /(?:INSERT|UPDATE).*certificate_record_id/u.test(c.text) && !c.text.includes("certificate_record_id=NULL")));
}
function unknownEvidence(value: Row) {
  assert.equal(value.quality_status, "not_evaluated");
  assert.deepEqual(value.blockers, ["INDEPENDENT_HUMAN_LABELS_UNVERIFIED", "NATURAL_HUMAN_ALIASES_UNVERIFIED",
    "EXTERNAL_SOURCE_PROVENANCE_UNVERIFIED", "PREACCESS_THRESHOLD_ADOPTION_UNVERIFIED"]);
}

test("actual captured 14-module assets and register/freeze/declaration/admission never certify quality", async t => {
  const f = await harness(t, false), asset = await f.app.inject(`${f.base}/assets`);
  assert.equal(asset.statusCode, 200); assert.equal(Object.keys(asset.json().assets.module_digests).length, 14);
  assert.equal(asset.json().assets.code_digest, assets.code_digest); unknownEvidence(asset.json());
  await f.register(); const replay = await f.post("/protocols", protocolBody); assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().protocol.id, f.protocolId); assert.equal(f.state.records.length, 1);
  assert.equal((await f.post(`/protocols/${f.protocolId}/freeze`, { expected_version: "0" })).statusCode, 200);
  await f.declare(); const admitted = await f.upload(JSON.stringify(dataset));
  assert.equal(admitted.statusCode, 200, admitted.body); unknownEvidence(admitted.json());
  assert.deepEqual(kinds(f), ["registered", "freeze", "dataset_declaration", "holdout_access", "holdout_payload", "dataset_admission"]);
  assert.equal(f.head.phase, "admitted"); assert.equal(f.state.work[0]!.status, "pending");
  assert.equal(f.state.work[0]!.dataset_record_id, f.head.dataset_record_id);
  assert.equal((f.state.work[0]!.state_json as Row).run_id, admitted.json().run_id);
  for (const row of f.state.records) validateQualityRecord(row);
  noCertificate(f);
});
const deniedActors: Array<[string, Actor | undefined]> = [
  ["missing", undefined], ["api token", { ...principal, type: "api_token" }], ["internal/Job", { ...principal, type: "internal" }],
  ["bootstrap", { ...principal, type: "bootstrap_admin" }], ["non-admin scope", { ...principal, scopes: ["findings:read"] }],
  ["viewer", { ...principal, role: "viewer" }], ["different project", { ...principal, projectId: id(98) }],
];
for (const [name, actor] of deniedActors) test(`actual onRequest denies ${name} before malformed body and exposure`, async t => {
  const f = await harness(t); f.setActor(actor); const before = clone(f.state);
  const r = await f.upload("{", "denied"); assert.equal(r.statusCode, 403, r.body); unknownEvidence(r.json());
  assert.deepEqual(f.state, before); assert.equal(f.calls.length, 0); assert.ok(!f.events.includes("decoded"));
  assert.equal(f.events[0], "auth"); assert.ok(!f.events.includes("begin"));
});
test("queries and invalid path IDs are rejected before body and SQL; successful metadata is no-store", async t => {
  const f = await harness(t), snapshot = clone(f.state);
  for (const url of [`${f.base}/protocols/${f.protocolId}/declarations/${f.declarationId}/payload?unknown=1`,
    `${f.base}/protocols/${f.protocolId}/declarations/not-a-uuid/payload`]) {
    f.events.length = 0; const r = await f.app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: "{" });
    assert.equal(r.statusCode, 400, r.body); assert.deepEqual(f.state, snapshot); assert.ok(!f.events.includes("decoded"));
    assert.ok(!f.events.includes("begin"));
  }
  const metadata = await f.app.inject(`${f.base}/assets`); assert.equal(metadata.headers["cache-control"], "no-store");
});
test("same-project operator with admin scope is allowed; scope mismatch registration never enters SQL", async t => {
  const f = await harness(t); f.setActor({ ...principal, role: "operator" });
  assert.equal((await f.upload(JSON.stringify(dataset))).statusCode, 200); noCertificate(f);
  for (const patch of [{ project_id: id(98) }, { code_digest: digest }]) {
    const before = f.calls.length, r = await f.post("/protocols", { ...protocolBody, scope: { ...protocolBody.scope, ...patch } });
    assert.equal(r.statusCode, patch.project_id ? 403 : 409, r.body); assert.equal(f.calls.length, before);
  }
});
for (const [name, payload, contentType, status] of [
  ["malformed JSON", "{", "application/json", 400], ["unsupported content", "raw", "application/x-quality-unknown", 400],
  ["strict schema", JSON.stringify({ ...dataset, verified: true }), "application/json", 400],
  ["bound dataset mismatch", JSON.stringify({ ...dataset, pairs: [] }), "application/json", 409],
] as const) test(`real Fastify ${name} preserves earlier committed exposure and linked rejection`, async t => {
  const f = await harness(t), r = await f.upload(payload, name, contentType);
  assert.equal(r.statusCode, status, r.body); unknownEvidence(r.json());
  assert.deepEqual(kinds(f), ["registered", "freeze", "dataset_declaration", "holdout_access", "rejection"]);
  const access = f.state.records[3]!, rejection = f.state.records[4]!;
  assert.equal(f.head.first_access_record_id, access.id); assert.equal(rejection.subject_record_id, access.id);
  validateQualityRecord(access); validateQualityRecord(rejection); noCertificate(f);
  assert.ok(f.events.indexOf("commit:holdout_access") < f.events.indexOf("error"), f.events.join(" -> "));
  assert.ok(f.events.indexOf("error") < f.events.indexOf("commit:rejection"));
  if (name === "malformed JSON" || name === "unsupported content") assert.ok(!f.events.includes("decoded"));
  else assert.ok(f.events.indexOf("commit:holdout_access") < f.events.indexOf("decoded"));
});
test("actual greater-than-16MiB request reaches body limit only AFTER independent access commit", async t => {
  const f = await harness(t), payload = JSON.stringify("x".repeat(QUALITY_INPUT_BYTES));
  assert.ok(Buffer.byteLength(payload) > 16 * 1024 * 1024);
  const r = await f.upload(payload, "oversize"); assert.equal(r.statusCode, 413, r.body);
  assert.deepEqual(kinds(f).slice(-2), ["holdout_access", "rejection"]); assert.ok(!f.events.includes("decoded"));
  assert.ok(f.events.indexOf("commit:holdout_access") < f.events.indexOf("error"));
  assert.equal(f.state.records.at(-1)!.subject_record_id, f.head.first_access_record_id); noCertificate(f);
});
test("work admission rollback cannot erase earlier exposure; rejection has its own commit", async t => {
  const f = await harness(t); f.failWork(); const r = await f.upload(JSON.stringify(dataset));
  assert.equal(r.statusCode, 500, r.body); assert.equal(f.state.work.length, 0); assert.equal(f.head.phase, "frozen");
  assert.deepEqual(kinds(f).slice(-2), ["holdout_access", "rejection"]);
  assert.deepEqual(f.events.filter(e => e === "rollback" || e.startsWith("commit:")), ["commit:holdout_access", "rollback", "commit:rejection"]);
  assert.equal(f.head.first_access_record_id, f.state.records[3]!.id); noCertificate(f);
});
test("every reused key conflicts before parsing even changed actor/declaration; new key preserves first access", async t => {
  const f = await harness(t), firstDeclaration = f.declarationId; await f.declare();
  assert.equal((await f.upload("{", "same", "application/json", firstDeclaration)).statusCode, 400);
  const before = clone(f.state), first = f.head.first_access_record_id;
  for (const [actor, declaration] of [[principal, firstDeclaration], [{ ...principal, id: id(61) }, firstDeclaration], [principal, f.declarationId]] as const) {
    f.setActor(actor); f.events.length = 0; const r = await f.upload("{", "same", "application/json", declaration);
    assert.equal(r.statusCode, 409, r.body); assert.equal(r.json().error_code, "QUALITY_EXPOSURE_REQUEST_CONFLICT");
    assert.ok(!f.events.includes("decoded")); assert.ok(!f.events.some(e => e.startsWith("commit:"))); assert.deepEqual(f.state, before);
  }
  f.setActor(principal); f.events.length = 0;
  assert.equal((await f.upload("{", "fresh", "application/json", firstDeclaration)).statusCode, 400);
  assert.equal(f.head.first_access_record_id, first); assert.equal(f.state.records.filter(r => r.kind === "holdout_access").length, 2);
  const access = f.state.records.filter(r => r.kind === "holdout_access").at(-1)!;
  assert.equal(f.state.records.at(-1)!.subject_record_id, access.id);
  const snapshot = clone(f.state); f.events.length = 0;
  assert.equal((await f.upload("{", "foreign", "application/json", id(900))).statusCode, 404);
  assert.deepEqual(f.state, snapshot); assert.ok(!f.events.includes("decoded")); noCertificate(f);
});
test("freeze/declaration after lifetime exposure cannot reset first access; exact bigint CAS rejects stale and numeric values", async t => {
  const f = await harness(t); f.head.version = "9007199254740993";
  const stale = await f.post(`/protocols/${f.protocolId}/declarations`, { expected_version: "9007199254740992" });
  assert.equal(stale.statusCode, 409); assert.equal(f.state.records.length, 3);
  await f.declare(); assert.equal(f.head.version, "9007199254740994");
  for (const version of [2, "02", "-1", "9223372036854775808"]) {
    const count = f.calls.length, r = await f.post(`/protocols/${f.protocolId}/declarations`, { expected_version: version });
    assert.equal(r.statusCode, 400, r.body); assert.equal(f.calls.length, count);
  }
  await f.upload("{"); const snapshot = clone(f.state);
  for (const suffix of ["freeze", "declarations"]) {
    const r = await f.post(`/protocols/${f.protocolId}/${suffix}`, { expected_version: f.head.version }); assert.equal(r.statusCode, 409, r.body);
    assert.deepEqual(f.state, snapshot);
  }
});
test("revoked protocol still commits upload exposure, retains revoked phase and rejects admission", async t => {
  const f = await harness(t), revoked = await f.post(`/protocols/${f.protocolId}/revoke`, { expected_version: f.head.version, reason: "synthetic revoke" });
  assert.equal(revoked.statusCode, 200, revoked.body); const revocation = f.head.revocation_record_id; f.events.length = 0;
  const r = await f.upload(JSON.stringify(dataset)); assert.equal(r.statusCode, 409, r.body); assert.equal(r.json().error_code, "QUALITY_PROTOCOL_INACTIVE");
  assert.equal(f.head.phase, "revoked"); assert.equal(f.head.revocation_record_id, revocation);
  assert.deepEqual(kinds(f).slice(-3), ["revoke", "holdout_access", "rejection"]); assert.equal(f.state.work.length, 0);
  assert.ok(f.events.indexOf("commit:holdout_access") < f.events.indexOf("decoded")); noCertificate(f);
});
test("digest-shaped fake evaluation cannot be reviewed or read as a completed cohort; scoped revoke retains history", async t => {
  const f = await harness(t); const admitted = await f.upload(JSON.stringify(dataset)); assert.equal(admitted.statusCode, 200);
  await withQualityHead(project, f.protocolId, String(f.head.version), async (tx, head) => {
    const binding = { protocol_id: f.protocolId, run_id: admitted.json().run_id, dataset_id: String(head.dataset_record_id),
      protocol_digest: qualityDigest(protocolBody), scope: protocolBody.scope, evaluated_at: f.nextTime() };
    const report = computeQualityMetrics({ binding, dataset, selections: [], decisions: [] });
    const row = await appendQualityRecord(tx, { projectId: project, protocolId: f.protocolId, kind: "evaluation", actor: principal,
      subjectId: String(head.dataset_record_id), body: { protocol_digest: binding.protocol_digest, scope_digest: qualityDigest(binding.scope), binding, report_digest: report.report_digest } });
    await advanceQualityHead(tx, head, row, "evaluated");
  }, f.db);
  const input = { expected_version: f.head.version, evidence_digest: null, expires_at: "2098-01-01T00:00:00Z" };
  const rejected = await f.post(`/protocols/${f.protocolId}/reviews`, { ...input, independent: true }); assert.equal(rejected.statusCode, 400);
  const beforeReview = clone(f.state), selfReview = await f.post(`/protocols/${f.protocolId}/reviews`, input);
  assert.equal(selfReview.statusCode, 409, selfReview.body); assert.equal(selfReview.json().error_code, "QUALITY_REVIEW_PRINCIPAL_CONFLICT"); assert.deepEqual(f.state, beforeReview);
  f.setActor({ ...principal, id: id(61), name: "synthetic separate principal" });
  const review = await f.post(`/protocols/${f.protocolId}/reviews`, input);
  assert.equal(review.statusCode, 400, review.body); assert.equal(review.json().error_code, "QUALITY_REPORT_UNAVAILABLE");
  unknownEvidence(review.json()); assert.deepEqual(f.state, beforeReview);
  assert.equal(f.transactionOptions.at(-1), "isolation level repeatable read");
  const report = await f.app.inject(`${f.base}/protocols/${f.protocolId}/report`);
  assert.equal(report.statusCode, 400, report.body); assert.equal(report.json().error_code, "QUALITY_REPORT_UNAVAILABLE");
  assert.equal(f.transactionOptions.at(-1), "isolation level repeatable read read only");
  assert.ok(!/"(?:input|pairs|sources|selections|decisions)":/u.test(report.body));
  const read = await f.app.inject(`${f.base}/protocols/${f.protocolId}`); assert.equal(read.statusCode, 200, read.body); unknownEvidence(read.json());
  assert.equal(read.json().head.phase, "evaluated"); assert.ok(!/"(?:pairs|sources|selections|decisions|state_json)":/u.test(read.body)); noCertificate(f);
  // Opaque pre-existing current tuples are scope/CAS fixtures, not certificates issued by these APIs.
  Object.assign(f.state.currents[0]!, { protocol_id: id(88), certificate_record_id: id(87), scope_digest: digest });
  f.state.currents.push({ project_id: id(98), version: "4", protocol_id: f.protocolId, certificate_record_id: id(86), scope_digest: digest });
  const tuples = clone(f.state.currents), history = clone(f.state.records), first = f.head.first_access_record_id;
  const revoke = await f.post(`/protocols/${f.protocolId}/revoke`, { expected_version: f.head.version, reason: "scope-only invalidation" });
  assert.equal(revoke.statusCode, 200, revoke.body); assert.deepEqual(f.state.currents, tuples);
  assert.deepEqual(f.state.records.slice(0, history.length), history); assert.equal(f.head.first_access_record_id, first);
  assert.deepEqual(f.calls.filter(c => c.text.startsWith("UPDATE project_finding_quality_current")).at(-1)!.values, [project, f.protocolId]);
  Object.assign(f.state.currents[0]!, { protocol_id: f.protocolId });
  assert.equal((await f.post(`/protocols/${f.protocolId}/revoke`, { expected_version: f.head.version, reason: "own tuple" })).statusCode, 200);
  assert.equal(f.state.currents[0]!.certificate_record_id, null); assert.deepEqual(f.state.currents[1], tuples[1]);
});
test("fresh process without boot/source manifest fails actual API closed before SQL, no caller hash fallback", () => {
  const script = `import assert from 'node:assert/strict'; import Fastify from 'fastify';
    import {registerFindingQualityRoutes} from './src/domains/project-finding-research/quality-api.ts';
    import {bootFindingQualityAssets} from './src/domains/project-finding-research/quality-assets.ts';
    const app=Fastify(); let calls=0; app.decorateRequest('actor',undefined);
    app.addHook('onRequest',async req=>{req.actor=${JSON.stringify(principal)}});
    registerFindingQualityRoutes(app,()=>{calls++;throw Error('must not reach SQL')});
    const assets=await app.inject('/projects/${project}/finding-quality/assets'); assert.equal(assets.statusCode,503);
    const register=await app.inject({method:'POST',url:'/projects/${project}/finding-quality/protocols',headers:{'content-type':'application/json'},payload:${JSON.stringify(JSON.stringify(protocolBody))}});
    assert.equal(register.statusCode,503); assert.equal(calls,0);
    assert.throws(()=>bootFindingQualityAssets(),e=>e.code==='QUALITY_SOURCE_CAPTURE_NOT_INSTALLED'); await app.close();`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: process.cwd(), encoding: "utf8", timeout: 20_000, env: { ...process.env, TSX_DISABLE_CACHE: "1" } });
  assert.equal(child.status, 0, `${child.error?.message ?? ""}\n${child.stderr}\n${child.stdout}`);
});
