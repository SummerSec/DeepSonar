import { bootFindingQualityAssets } from "./quality-assets.js";
import { qualityDatasetDigests } from "./quality-contract.js";
import { processFindingQualityWork, loadStoredFindingQualityReport, startFindingQualityWorker } from "./quality-worker.js";
import { withQualityHead } from "./quality-state-store.js";
import test from "node:test";
import assert from "node:assert/strict";
import type { sql } from "../../db.js";
import { STRONG_IDENTITY_FIELDS } from "./identity.js";
import { qualityDigest, QualityContractError } from "./quality-contract.js";
import { observeFindingQualitySubject, appendFindingQualityObservation, loadFindingQualityObservations } from "./quality-worker.js";

type Db = typeof sql;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const project = id(1), subject = id(2), protocol = id(3), dataset = id(4);
const at = "2026-11-01T00:00:00Z", fresh = "2036-11-01T00:00:00Z";
function fixture(peerIds: string[] = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [], rows: Record<string, unknown>[] = [];
  const sourceReads = new Map<string, number>();
  const state = { drift: false, missing: false, truncated: false, mismatch: false, write: true, peers: peerIds };
  const db = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/gu, " ").trim();
    calls.push({ text, values });
    if (text.includes("SELECT f.id")) {
      const finding = String(values[0]);
      assert.deepEqual(values, [finding, project, project]);
      const count = (sourceReads.get(finding) ?? 0) + 1;
      sourceReads.set(finding, count);
      if (state.missing) return [];
      return [{ id: finding, project_id: state.mismatch ? id(999) : project, canvas_id: id(90),
        source_fingerprint: qualityDigest([finding, state.drift && count > 1 ? 1 : 0]) }];
    }
    if (text.startsWith("WITH fields(field)")) {
      const finding = String(values[1]);
      assert.deepEqual(values, [project, finding, 65]);
      return STRONG_IDENTITY_FIELDS.flatMap((field, fieldIndex) => Array.from({ length: state.truncated && field === "root_cause" ? 65 : 1 }, (_, i) => ({
        id: id(1000 + fieldIndex * 100 + i), project_id: project, finding_id: finding, field,
        source_id: id(500), source_revision: 1, mapping_version: i + 1, revoked_at: null,
        source_current_revision: 1, source_revoked_at: null, source_freshness_until: fresh,
        authority_version: "test-platform/v1", source_kind: "platform_inventory", source_ref: "sealed-fixture",
        source_digest: qualityDigest("synthetic-source"), identity_digest: qualityDigest(field),
        authorized_by: id(60), created_at: at, updated_at: at,
      })));
    }
    if (text.startsWith("SELECT DISTINCT m.finding_id")) {
      assert.deepEqual(values, [project, qualityDigest("root_cause"), subject, 257]);
      assert.ok(text.includes("r.finding_id = m.finding_id"));
      assert.ok(text.includes("s.current_revision = m.source_revision"));
      assert.ok(text.includes("m.finding_id > ?::uuid ORDER BY m.finding_id LIMIT ?"));
      assert.ok(!/split|label|job_id/iu.test(text));
      return state.peers.map((finding_id) => ({ finding_id }));
    }
    if (text.startsWith("INSERT INTO project_finding_quality_observations")) {
      assert.ok(text.includes("d.kind='dataset_admission'"));
      assert.ok(text.includes("w.claimed_generation=w.generation AND w.status='running'"));
      assert.deepEqual(values.slice(10), [project, protocol, dataset, "1"]);
      if (!state.write) return [];
      const row = { id: values[0], project_id: values[1], protocol_id: values[2], work_generation: values[3],
        dataset_record_id: values[4], subject_finding_id: values[5], ordinal: values[6],
        input_digest: values[7], record_digest: values[8], body_json: values[9], observed_at: new Date(at) };
      rows.push(row); return [row];
    }
    if (text.startsWith("SELECT * FROM project_finding_quality_observations")) {
      assert.deepEqual(values, [project, protocol, "1", dataset, 1001]); return rows;
    }
    throw new Error(`unclassified SQL: ${text}`);
  }, { json: (value: unknown) => value }) as unknown as Db;
  return { db, rows, calls, state };
}
const scope = { project_id: project, protocol_id: protocol, generation: "1", dataset_record_id: dataset,
  subject_finding_id: subject, ordinal: 0 };
const run = { project_id: project, protocol_id: protocol, generation: "1", dataset_record_id: dataset };

test("actual deployed helper calls retain raw greater-UUID peers with no labels/split/Job filter", async () => {
  const f = fixture([id(5), id(6)]), observation = await observeFindingQualitySubject(f.db, project, subject);
  assert.deepEqual(observation.selection.peerIds, [id(5), id(6)]);
  assert.deepEqual(observation.decisions.map((v) => v.prediction), ["same_problem", "same_problem"]);
  assert.deepEqual(observation.blockers, []);
  assert.equal(f.calls.filter((c) => c.text.startsWith("SELECT DISTINCT")).length, 1);
});
test("257 sentinel compares first256 once and reports lower bound, never doubles pairs", async () => {
  const peers = Array.from({ length: 257 }, (_, i) => id(i + 5)), f = fixture(peers);
  const observation = await observeFindingQualitySubject(f.db, project, subject);
  assert.equal(observation.selection.observedCount, 257);
  assert.equal(observation.selection.countKind, "lower_bound");
  assert.equal(observation.decisions.length, 256);
  assert.deepEqual(observation.selection.peerIds, peers.slice(0, 256));
});
for (const [flag, code] of [["missing", "QUALITY_SOURCE_UNAVAILABLE"], ["mismatch", "QUALITY_SOURCE_SCOPE_MISMATCH"],
  ["truncated", "QUALITY_IDENTITY_HISTORY_INCOMPLETE"], ["drift", "QUALITY_SOURCE_CHANGED"]] as const) {
  test(`${flag} actual source cannot become a usable partial observation`, async () => {
    const f = fixture([id(5)]); f.state[flag] = true;
    await assert.rejects(observeFindingQualitySubject(f.db, project, subject), (e: unknown) => e instanceof QualityContractError && e.code === code);
  });
}
test("immutable observation binds exact scope and actual source/decision bytes on load", async () => {
  const f = fixture([id(5)]), body = await observeFindingQualitySubject(f.db, project, subject);
  await appendFindingQualityObservation(f.db, scope, body);
  assert.deepEqual(await loadFindingQualityObservations(f.db, run), [body]);
  (f.rows[0]!.body_json as typeof body).decisions[0]!.prediction = "distinct";
  await assert.rejects(loadFindingQualityObservations(f.db, run), QualityContractError);
});
test("wrong generation/subject/caller prediction cannot enter SQL", async () => {
  const f = fixture(), body = await observeFindingQualitySubject(f.db, project, subject);
  for (const changed of [{ ...scope, generation: "0" }, { ...scope, generation: "01" }, { ...scope, subject_finding_id: id(10) }]) {
    await assert.rejects(appendFindingQualityObservation(f.db, changed, body));
  }
  await assert.rejects(appendFindingQualityObservation(f.db, scope, { ...body, pass: true }));
  assert.equal(f.calls.filter((c) => c.text.startsWith("INSERT")).length, 0);
});
test("stale/non-running work cannot write even a structurally valid observation", async () => {
  const f = fixture(), body = await observeFindingQualitySubject(f.db, project, subject); f.state.write = false;
  await assert.rejects(appendFindingQualityObservation(f.db, scope, body), QualityContractError);
});
test("missing ordinal and overflow cannot be presented as complete history", async () => {
  const f = fixture(), body = await observeFindingQualitySubject(f.db, project, subject);
  await appendFindingQualityObservation(f.db, scope, body);
  f.rows[0]!.ordinal = 1;
  await assert.rejects(loadFindingQualityObservations(f.db, run));
  f.rows.splice(0, 1, ...Array.from({ length: 1001 }, () => ({})));
  await assert.rejects(loadFindingQualityObservations(f.db, run), QualityContractError);
});

type Row = Record<string, any>;
const rr = { isolationLevel: "repeatable_read" as const };
const codeIs = (code: string) => (error: unknown) => error instanceof QualityContractError && error.code === code;
function signedReceipt(kind: string, n: number, parent: string | null, common: Row, body: Row, when: string): Row {
  const row: Row = { id: id(n), project_id: project, protocol_id: protocol, kind, subject_record_id: parent, request_key: null, actor_type: "user", actor_id: id(60), actor_name: "synthetic", body_json: { ...common, ...body }, created_at: new Date(when) };
  row.record_digest = qualityDigest({ id: row.id, project_id: project, protocol_id: protocol, kind, subject_record_id: parent, actor: { type: row.actor_type, id: row.actor_id, name: row.actor_name }, body: row.body_json });
  return row;
}
async function workFixture() {
  const base = fixture([id(5)]), observed = await observeFindingQualitySubject(base.db, project, subject);
  const loaded = bootFindingQualityAssets(), digest = qualityDigest("synthetic");
  const datasetBody = { schema_version: 1, kind: "synthetic", sources: [{ id: subject, source_digest: observed.source.source_digest, identity_digest: observed.source.identity_digest, provenance_digest: digest, asset_group_digest: digest, family_group_digest: digest, split: "holdout" }], pairs: [] };
  const qualityScope = { corpus_digest: digest, project_id: project, code_digest: loaded.code_digest, config_digest: loaded.config_digest, selector_digest: loaded.selector_digest, normalization_digest: loaded.normalization_digest, strong_rule_digest: loaded.strong_rule_digest, extractor_version: loaded.extractor_version, normalization_version: loaded.normalization_version, strong_rule_version: loaded.strong_rule_version, metric_version: loaded.metric_version, population_version: loaded.population_version, label_mapping_version: loaded.label_mapping_version, ...qualityDatasetDigests(datasetBody) };
  const body = { schema_version: 1, scope: qualityScope, thresholds: { same_problem: { precision: 1, recall: 1 }, same_root_cause_different_instance: { precision: 1, recall: 1 } }, valid_until: "2099-01-01T00:00:00Z" };
  const common = { protocol_digest: qualityDigest(body), scope_digest: qualityDigest(qualityScope) };
  const receipts = [signedReceipt("registered", 16, null, common, { maker_ids: [id(60)], tuner_ids: [] }, "2010-01-01T00:00:00Z"), signedReceipt("freeze", 17, id(16), common, { thresholds_digest: qualityDigest(body.thresholds) }, "2011-01-01T00:00:00Z"), signedReceipt("dataset_declaration", 18, id(17), common, { dataset_digest: qualityScope.dataset_digest }, "2011-06-01T00:00:00Z"), signedReceipt("holdout_access", 19, id(18), common, { dataset_digest: qualityScope.dataset_digest }, "2012-01-01T00:00:00Z"), signedReceipt("holdout_payload", 20, id(19), common, { dataset: datasetBody }, "2012-06-01T00:00:00Z"), signedReceipt("dataset_admission", 4, id(20), common, { dataset_digest: qualityScope.dataset_digest }, "2013-01-01T00:00:00Z")];
  const protocolRow: Row = { id: protocol, project_id: project, protocol_digest: common.protocol_digest, body_json: body, created_by_actor_type: "user", created_by_actor_id: id(60), created_by_actor_name: "synthetic", created_at: new Date("2009-01-01T00:00:00Z") };
  const head: Row = { project_id: project, protocol_id: protocol, version: "7", phase: "admitted", latest_record_id: dataset, freeze_record_id: id(17), declaration_record_id: id(18), first_access_record_id: id(19), dataset_record_id: dataset, evaluation_record_id: null, review_record_id: null, revocation_record_id: null, updated_at: new Date(at) };
  const work: Row = { project_id: project, protocol_id: protocol, generation: "1", processed_generation: "0", claimed_generation: null, status: "pending", dataset_record_id: dataset, evaluation_record_id: null, state_json: { run_id: id(77), next_ordinal: 0 }, last_error_code: null };
  const calls: Array<{
    text: string;
    values: unknown[];
  }> = [], events: string[] = [];
  const control = { hint: "7", skip: false, cas: false, exception: "", replace: false, isolation: "repeatable read" };
  const tag = async (strings: TemplateStringsArray, ...v: any[]) => {
    const text = strings.join("?").replace(/\s+/gu, " ").trim();
    calls.push({ text, values: v });
    if (text.startsWith("SELECT w.project_id")) return ["pending", "running"].includes(work.status) ? [{ project_id: project, protocol_id: protocol, generation: work.generation, head_version: control.hint }] : [];
    if (text.startsWith("SHOW transaction_isolation")) return [{ transaction_isolation: control.isolation }];
    if (text.includes("FROM project_finding_quality_current")) return [{ project_id: project, version: "0" }];
    if (text.includes("FROM project_finding_quality_heads")) return [structuredClone(head)];
    if (text.startsWith("SELECT") && text.includes("FROM project_finding_quality_work")) {
      if (text.includes("FOR UPDATE") && (control.skip || v[2] !== work.generation)) return [];
      if (text.startsWith("SELECT project_id") && (v[3] !== work.dataset_record_id || qualityDigest(v[4]) !== qualityDigest(work.state_json))) return [];
      return [structuredClone(work)];
    }
    if (!text.startsWith("WITH protocols") && text.includes("FROM project_finding_quality_protocols")) return v[0] === project && v[1] === protocol ? [structuredClone(protocolRow)] : [];
    if (text.startsWith("WITH protocols")) {
      assert.deepEqual(v, [project, 1001, project, 1001, 16 * 1024 * 1024]);
      return [{ protocol_rows: [structuredClone(protocolRow)], records: structuredClone(receipts), history_overflow: false }];
    }
    if (text.startsWith("SELECT") && text.includes("FROM project_finding_quality_records")) return receipts.filter(r => r.project_id === v[0] && r.protocol_id === v[1] && r.id === v[2]).map(r => structuredClone(r));
    if (text.startsWith("SELECT clock_timestamp")) return [{ quality_now: new Date(at) }];
    if (text.startsWith("UPDATE project_finding_quality_work")) {
      if (control.exception) throw Object.assign(new Error("not logged"), { code: control.exception });
      if (text.includes("SET status='running'"))
        Object.assign(work, { status: "running", claimed_generation: work.generation, last_error_code: null });
      else if (text.includes("SET state_json")) {
        if (control.cas) return [];
        work.state_json = structuredClone(v[0]);
      }
      else if (text.includes("SET status='completed'"))
        Object.assign(work, { status: "completed", evaluation_record_id: v[0], processed_generation: work.generation, last_error_code: null });
      else if (text.includes("SET status='failed'")) {
        if (v[3] !== work.generation || v[4] !== work.dataset_record_id || qualityDigest(v[5]) !== qualityDigest(work.state_json)) return [];
        Object.assign(work, { status: "failed", last_error_code: v[0] });
      }
      else
        throw new Error("unknown work update");
      return [{ project_id: project }];
    }
    if (text.startsWith("INSERT INTO project_finding_quality_records")) {
      const row = { id: v[0], project_id: v[1], protocol_id: v[2], kind: v[3], record_digest: v[4], subject_record_id: v[5], request_key: v[6], actor_type: v[7], actor_id: v[8], actor_name: v[9], body_json: v[10], created_at: new Date(at) };
      receipts.push(row);
      return [structuredClone(row)];
    }
    if (text.startsWith("UPDATE project_finding_quality_heads")) {
      if (v[11] !== head.version) return [];
      Object.assign(head, { version: (BigInt(head.version) + 1n).toString(), phase: v[0], latest_record_id: v[1], freeze_record_id: v[2], declaration_record_id: v[3], first_access_record_id: head.first_access_record_id ?? v[4], dataset_record_id: v[5], evaluation_record_id: v[6], review_record_id: v[7], revocation_record_id: v[8] });
      return [structuredClone(head)];
    }
    return base.db(strings, ...v as never[]);
  };
  const db = Object.assign(tag, { json: (v: unknown) => v, begin: async (options: string, callback: (tx: Db) => Promise<unknown>) => {
      assert.equal(options, "isolation level repeatable read");
      events.push("begin");
      const snapshot = structuredClone({ head, work, receipts, rows: base.rows });
      try {
        const result = await callback(db as unknown as Db);
        events.push("commit");
        return result;
      }
      catch (error) {
        Object.assign(head, snapshot.head);
        Object.assign(work, snapshot.work);
        receipts.splice(0, receipts.length, ...snapshot.receipts);
        base.rows.splice(0, base.rows.length, ...snapshot.rows);
        events.push("rollback");
        if (control.replace) {
          work.generation = "2";
          work.claimed_generation = null;
          work.state_json = { run_id: id(78), next_ordinal: 0 };
        }
        throw error;
      }
    } }) as unknown as Db;
  return { db, base, head, work, receipts, protocolRow, calls, events, control };
}
async function stored(f: Awaited<ReturnType<typeof workFixture>>) {
  return withQualityHead(project, protocol, String(f.head.version), tx => loadStoredFindingQualityReport(tx, project, protocol), f.db, rr);
}
test("bounded work resumes ordinal then separately completes actual SQL-bound report without certificate", async () => {
  const f = await workFixture();
  assert.equal(await processFindingQualityWork(f.db), true);
  assert.equal(f.base.rows.length, 1);
  assert.equal(f.work.state_json.next_ordinal, 1);
  assert.equal(f.head.phase, "admitted");
  const first = f.base.rows[0]!.id;
  assert.equal(await processFindingQualityWork(f.db), true);
  assert.equal(f.base.rows.length, 1);
  assert.equal(f.base.rows[0]!.id, first);
  assert.equal(f.head.phase, "evaluated");
  assert.equal(f.work.processed_generation, "1");
  assert.equal(f.work.state_json.run_id, id(77));
  assert.equal(f.work.status, "completed");
  const loaded = await stored(f);
  assert.equal(loaded.quality_status, "not_evaluated");
  assert.equal(loaded.generation, "1");
  assert.equal(loaded.report.binding.run_id, id(77));
  assert.equal(loaded.report.binding.dataset_id, dataset);
  assert.equal(loaded.report.binding.evaluated_at, new Date(at).toISOString());
  assert.equal(loaded.report.unknown_selected_pairs, 1);
  assert.equal(loaded.report.compared_pairs, 1);
  assert.ok(loaded.report.blockers.includes("SYNTHETIC_DATA"));
  assert.equal(f.calls.filter(c => c.text.includes("UPDATE project_finding_quality_current")).length, 0);
  const locks = f.calls.filter(c => c.text.includes("FOR UPDATE")).slice(0, 3).map(c => c.text);
  assert.ok(locks[0]!.includes("quality_current"));
  assert.ok(locks[1]!.includes("quality_heads"));
  assert.ok(locks[2]!.includes("quality_work") && locks[2]!.includes("SKIP LOCKED"));
  assert.equal(await processFindingQualityWork(f.db), false);
});
for (const mode of ["stale", "skip", "cas", "claimed", "40001", "40P01"] as const)
  test(`${mode} competition is no progress, never failed/replaced generation`, async () => {
    const f = await workFixture();
    if (mode === "stale")
      f.control.hint = "6";
    else if (mode === "skip")
      f.control.skip = true;
    else if (mode === "cas")
      f.control.cas = true;
    else if (mode === "claimed")
      Object.assign(f.work, { generation: "2", claimed_generation: "1" });
    else
      f.control.exception = mode;
    assert.equal(await processFindingQualityWork(f.db), false);
    assert.equal(f.work.status, "pending");
    assert.equal(f.work.generation, mode === "claimed" ? "2" : "1");
    assert.equal(f.work.state_json.next_ordinal, 0);
    assert.equal(f.base.rows.length, 0);
    assert.equal(f.calls.filter(c => c.text.includes("SET status='failed'")).length, 0);
  });
for (const mode of ["checkpoint", "history", "scope", "inactive", "source", "dataset"] as const)
  test(`${mode} invalid work fails stably without evaluation/reset/external effect`, async () => {
    const f = await workFixture();
    if (mode === "checkpoint")
      f.work.state_json.next_ordinal = 1;
    else if (mode === "history")
      f.receipts.splice(1, 1);
    else if (mode === "scope")
      f.head.dataset_record_id = id(999);
    else if (mode === "inactive")
      f.head.phase = "revoked";
    else if (mode === "dataset")
      f.work.dataset_record_id = null;
    else
      f.base.state.drift = true;
    assert.equal(await processFindingQualityWork(f.db), true);
    assert.equal(f.work.status, "failed");
    assert.match(f.work.last_error_code, /^QUALITY_[A-Z_]+$/);
    assert.equal(f.head.evaluation_record_id, null);
    assert.equal(f.work.generation, "1");
    assert.equal(f.base.rows.length, 0);
    assert.equal(await processFindingQualityWork(f.db), false);
  });
test("failure cannot mark a concurrently replaced generation", async () => {
  const f = await workFixture();
  f.work.state_json.next_ordinal = 1;
  f.control.replace = true;
  assert.equal(await processFindingQualityWork(f.db), false);
  assert.equal(f.work.generation, "2");
  assert.equal(f.work.status, "pending");
  assert.equal(f.work.state_json.run_id, id(78));
});
test("completion rejects new raw peers rather than filtering/replacing prior observations", async () => {
  const f = await workFixture();
  await processFindingQualityWork(f.db);
  const before = structuredClone(f.base.rows);
  f.base.state.peers.push(id(6));
  assert.equal(await processFindingQualityWork(f.db), true);
  assert.equal(f.work.status, "failed");
  assert.equal(f.work.last_error_code, "QUALITY_OBSERVATIONS_CHANGED");
  assert.deepEqual(f.base.rows, before);
  assert.equal(f.head.phase, "admitted");
});
for (const mode of ["cohort", "digest", "binding", "observations", "newpeer", "isolation"] as const)
  test(`stored report rejects ${mode}, no caller hash or disk replacement`, async () => {
    const f = await workFixture();
    await processFindingQualityWork(f.db);
    await processFindingQualityWork(f.db);
    if (mode === "cohort")
      f.work.processed_generation = "0";
    else if (mode === "observations")
      f.base.rows.splice(0, 1);
    else if (mode === "newpeer")
      f.base.state.peers.push(id(6));
    else if (mode === "isolation")
      f.control.isolation = "read committed";
    else {
      const row = f.receipts.find(r => r.kind === "evaluation")!;
      if (mode === "digest")
        row.body_json.report_digest = qualityDigest("not actual report");
      else
        row.body_json.binding.run_id = id(999);
      row.record_digest = qualityDigest({ id: row.id, project_id: project, protocol_id: protocol, kind: row.kind, subject_record_id: row.subject_record_id, actor: { type: row.actor_type, id: row.actor_id ?? null, name: row.actor_name }, body: row.body_json });
    }
    await assert.rejects(stored(f));
    assert.equal(f.work.status, "completed");
    assert.equal(f.base.rows.length, mode === "observations" ? 0 : 1);
  });
test("owned stop synchronously prevents reschedule and drains current tick", async () => {
  let resolve!: (value: [
  ]) => void, calls = 0;
  const wait = new Promise<[
  ]>(done => {
    resolve = done;
  });
  const db = Object.assign(async () => {
    calls++;
    return wait;
  }, { json: (v: unknown) => v }) as unknown as Db;
  const stop = startFindingQualityWorker(db), drain = stop();
  let finished = false;
  void drain.then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(calls, 1);
  resolve([]);
  await drain;
  assert.equal(finished, true);
  assert.equal(calls, 1);
  assert.equal(stop(), drain);
});
function rebindFixture(f: Awaited<ReturnType<typeof workFixture>>) {
  const body = f.protocolRow.body_json, payload = f.receipts.find(r => r.kind === "holdout_payload")!;
  Object.assign(body.scope, qualityDatasetDigests(payload.body_json.dataset));
  f.protocolRow.protocol_digest = qualityDigest(body);
  for (const row of f.receipts) {
    row.body_json.protocol_digest = f.protocolRow.protocol_digest;
    row.body_json.scope_digest = qualityDigest(body.scope);
    if (["dataset_declaration", "holdout_access", "dataset_admission"].includes(row.kind))
      row.body_json.dataset_digest = body.scope.dataset_digest;
    row.record_digest = qualityDigest({ id: row.id, project_id: project, protocol_id: protocol, kind: row.kind, subject_record_id: row.subject_record_id, actor: { type: row.actor_type, id: row.actor_id ?? null, name: row.actor_name }, body: row.body_json });
  }
}
for (const mode of ["expired", "assets", "empty", "first"] as const)
  test(`governed worker rejects ${mode} rather than a usable quality report`, async () => {
    const f = await workFixture();
    if (mode === "expired")
      f.protocolRow.body_json.valid_until = "2020-01-01T00:00:00Z";
    else if (mode === "assets")
      f.protocolRow.body_json.scope.code_digest = qualityDigest("foreigncode");
    else if (mode === "empty")
      f.receipts.find(r => r.kind === "holdout_payload")!.body_json.dataset.sources = [];
    else
      f.head.first_access_record_id = null;
    rebindFixture(f);
    assert.equal(await processFindingQualityWork(f.db), true);
    assert.equal(f.work.status, "failed");
    assert.equal(f.work.last_error_code, { expired: "QUALITY_PROTOCOL_EXPIRED", assets: "QUALITY_LOADED_SCOPE_MISMATCH", empty: "QUALITY_EMPTY_HOLDOUT", first: "QUALITY_ADMITTED_CHAIN_INVALID" }[mode]);
    assert.equal(f.base.rows.length, 0);
    assert.equal(f.head.evaluation_record_id, null);
  });
