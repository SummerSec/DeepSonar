import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { runMigrations, type MigrationConnection } from "../../migration-runner.js";

type Sql = ReturnType<typeof postgres>;
const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const options = { skip: databaseUrl ? false : "TEST_DATABASE_URL is not set; no default or production database is used" };
const digest = `sha256:${"a".repeat(64)}`;
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function withDatabase(run: (db: Sql) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl);
  const adminUrl = new URL(databaseUrl); adminUrl.pathname = "/postgres"; adminUrl.search = "";
  const name = `quality_schema_${randomUUID().replaceAll("-", "")}`;
  assert.match(name, /^quality_schema_[a-f0-9]{32}$/);
  const target = new URL(databaseUrl); target.pathname = `/${name}`; target.search = "";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  let db: Sql | undefined;
  let created = false;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
    db = postgres(target.toString(), { max: 1 });
    const bootstrap = await db.reserve();
    try { await runMigrations(bootstrap as unknown as MigrationConnection); } finally { bootstrap.release(); }
    await run(db);
  } finally {
    await db?.end({ timeout: 5 });
    // Only the exact isolated database generated above can be removed.
    if (created) await admin.unsafe(`DROP DATABASE "${name}"`);
    await admin.end({ timeout: 5 });
  }
}
async function protocol(db: Sql, project: string): Promise<string> {
  const id = randomUUID();
  await db`INSERT INTO project_finding_quality_protocols(id,project_id,protocol_digest,body_json,created_by_actor_type,created_by_actor_id,created_by_actor_name,created_at)
    VALUES(${id},${project},${hash(id)},'{}','bootstrap_admin',NULL,'fixture','2000-01-01')`;
  return id;
}
async function record(db: Sql, project: string, protocolId: string, input: {
  kind?: string; subject?: string | null; requestKey?: string | null; digest?: string;
  actorType?: string; actorId?: string | null; actorName?: string;
  body?: Record<string, string | number | boolean>;
} = {}): Promise<string> {
  const id = randomUUID();
  await db`INSERT INTO project_finding_quality_records(id,project_id,protocol_id,kind,record_digest,subject_record_id,request_key,actor_type,actor_id,actor_name,body_json,created_at)
    VALUES(${id},${project},${protocolId},${input.kind ?? "registered"},${input.digest ?? digest},${input.subject ?? null},${input.requestKey ?? null},
      ${input.actorType ?? "internal"},${input.actorId ?? null},${input.actorName ?? "fixture"},${db.json(input.body ?? {})},'2000-01-01')`;
  return id;
}
async function fixture(db: Sql) {
  const a = randomUUID(), b = randomUUID(), canvasA = randomUUID(), canvasB = randomUUID(), jobA = randomUUID(), jobB = randomUUID();
  const [left, right] = [randomUUID(), randomUUID()].sort() as [string, string];
  const foreignFinding = randomUUID();
  await db`INSERT INTO projects(id,name) VALUES(${a},'quality fixture'),(${b},'foreign fixture')`;
  await db`INSERT INTO canvases(id,project_id,title) VALUES(${canvasA},${a},'quality fixture'),(${canvasB},${b},'foreign fixture')`;
  await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json) VALUES
    (${jobA},${a},${canvasA},'audit','succeeded','{}'),(${jobB},${b},${canvasB},'audit','succeeded','{}')`;
  await db`INSERT INTO findings(id,project_id,job_id,fingerprint,title,profile) VALUES
    (${left},${a},${jobA},'left','left','general'),(${right},${a},${jobA},'right','right','general'),
    (${foreignFinding},${b},${jobB},'foreign','foreign','general')`;
  const p = await protocol(db, a), other = await protocol(db, a), foreign = await protocol(db, b);
  const ownRecord = await record(db, a, p), otherRecord = await record(db, a, other), foreignRecord = await record(db, b, foreign);
  return { a, b, p, other, foreign, ownRecord, otherRecord, foreignRecord, left, right, foreignFinding };
}

test("quality immutable receipts enforce scope, actor/digest bounds, retries, aliases and malformed-access history", options, async () => {
  await withDatabase(async db => {
    const f = await fixture(db);
    await assert.rejects(db`INSERT INTO project_finding_quality_protocols(project_id,protocol_digest,body_json,created_by_actor_type,created_by_actor_name) VALUES(${f.a},${hash(f.p)},'{}','user','fixture')`, { code: "23505" });
    await db`INSERT INTO project_finding_quality_protocols(project_id,protocol_digest,body_json,created_by_actor_type,created_by_actor_name) VALUES(${f.b},${hash(f.p)},'{}','user','fixture')`;
    await assert.rejects(db`INSERT INTO project_finding_quality_protocols(project_id,protocol_digest,body_json,created_by_actor_type,created_by_actor_name) VALUES(${randomUUID()},${hash(randomUUID())},'{}','user','fixture')`, { code: "23503" });
    await assert.rejects(record(db, f.b, f.p), { code: "23503" });
    for (const subject of [f.otherRecord, f.foreignRecord]) await assert.rejects(record(db, f.a, f.p, { subject }), { code: "23503" });
    for (const input of [{ kind: "passed" }, { digest: "a".repeat(64) }, { digest: digest.toUpperCase() }, { requestKey: "x".repeat(201) }, { actorType: "agent" }, { actorId: "x".repeat(201) }, { actorName: "x".repeat(201) }, { actorName: "" }, { actorId: "" }, { requestKey: "" }]) {
      await assert.rejects(record(db, f.a, f.p, input), { code: "23514" });
    }
    const first = await record(db, f.a, f.p, { kind: "holdout_access", requestKey: "retry" });
    await assert.rejects(record(db, f.a, f.p, { kind: "holdout_access", requestKey: "retry" }), { code: "23505" });
    await record(db, f.a, f.p, { kind: "holdout_access" });
    await record(db, f.a, f.p, { kind: "holdout_access" });
    await record(db, f.a, f.p, { kind: "alias_resolution", subject: first, requestKey: "retry", body: { alias_status: "ambiguous" } });
    await assert.rejects(db`INSERT INTO project_finding_quality_records(project_id,protocol_id,kind,record_digest,actor_type,actor_name,body_json)
      VALUES(${f.a},${f.p},'holdout_payload',${digest},'internal','fixture',${"{"}::jsonb)`, { code: "22P02" });
    const rejection = await record(db, f.a, f.p, { kind: "rejection", subject: first, body: { error_code: "HOLDOUT_JSON_INVALID", raw_input_digest: digest } });
    assert.equal((await db`SELECT count(*)::int AS n FROM project_finding_quality_records WHERE protocol_id=${f.p} AND kind='holdout_access'`)[0].n, 3);
    assert.equal((await db`SELECT subject_record_id FROM project_finding_quality_records WHERE id=${rejection}`)[0].subject_record_id, first);
    for (const table of ["project_finding_quality_protocols", "project_finding_quality_records"]) {
      const id = table.endsWith("protocols") ? f.p : first;
      for (const query of [`UPDATE ${table} SET body_json='{}' WHERE id=$1`, `DELETE FROM ${table} WHERE id=$1`]) {
        await assert.rejects(db.unsafe(query, [id]), /finding_quality_history_append_only/);
      }
    }
    assert.equal((await db`SELECT created_at > '2000-01-02'::timestamptz AS server_time FROM project_finding_quality_protocols WHERE id=${f.p}`)[0].server_time, true);
    assert.equal((await db`SELECT created_at > '2000-01-02'::timestamptz AS server_time FROM project_finding_quality_records WHERE id=${first}`)[0].server_time, true);
  });
});

test("quality heads deny nullable phase claims, scope every pointer, and support stale-version CAS", options, async () => {
  await withDatabase(async db => {
    const f = await fixture(db);
    for (const phase of ["frozen", "admitted", "evaluated", "reviewed", "revoked"]) {
      await assert.rejects(db`INSERT INTO project_finding_quality_heads(project_id,protocol_id,phase,latest_record_id) VALUES(${f.a},${f.p},${phase},${f.ownRecord})`, { code: "23514" });
    }
    await assert.rejects(db`INSERT INTO project_finding_quality_heads(project_id,protocol_id,phase,latest_record_id) VALUES(${f.a},${f.p},'registered',NULL)`, { code: "23502" });
    await db`INSERT INTO project_finding_quality_heads(project_id,protocol_id,phase,latest_record_id) VALUES(${f.a},${f.p},'registered',${f.ownRecord})`;
    for (const pointer of ["latest_record_id", "freeze_record_id", "declaration_record_id", "first_access_record_id", "dataset_record_id", "evaluation_record_id", "review_record_id", "revocation_record_id"]) {
      for (const foreign of [f.otherRecord, f.foreignRecord]) await assert.rejects(db.unsafe(`UPDATE project_finding_quality_heads SET ${pointer}=$1 WHERE project_id=$2 AND protocol_id=$3`, [foreign, f.a, f.p]), { code: "23503" });
    }
    const freeze = await record(db, f.a, f.p, { kind: "freeze", subject: f.ownRecord });
    const access = await record(db, f.a, f.p, { kind: "holdout_access", subject: freeze });
    const retry = await record(db, f.a, f.p, { kind: "holdout_access", subject: freeze });
    const dataset = await record(db, f.a, f.p, { kind: "dataset_admission", subject: access });
    const evaluation = await record(db, f.a, f.p, { kind: "evaluation", subject: dataset });
    const review = await record(db, f.a, f.p, { kind: "review", subject: evaluation });
    assert.equal((await db`UPDATE project_finding_quality_heads SET version=version+1,phase='frozen',latest_record_id=${freeze},freeze_record_id=${freeze} WHERE project_id=${f.a} AND protocol_id=${f.p} AND version=0 RETURNING version`).length, 1);
    assert.equal((await db`UPDATE project_finding_quality_heads SET version=version+1,phase='blocked' WHERE project_id=${f.a} AND protocol_id=${f.p} AND version=0 RETURNING version`).length, 0);
    await assert.rejects(db`UPDATE project_finding_quality_heads SET phase='admitted',dataset_record_id=${dataset} WHERE project_id=${f.a} AND protocol_id=${f.p}`, { code: "23514" });
    await assert.rejects(db`UPDATE project_finding_quality_heads SET phase='admitted',first_access_record_id=${access} WHERE project_id=${f.a} AND protocol_id=${f.p}`, { code: "23514" });
    await db`UPDATE project_finding_quality_heads SET version=version+1,phase='admitted',latest_record_id=${dataset},first_access_record_id=${access},dataset_record_id=${dataset} WHERE project_id=${f.a} AND protocol_id=${f.p} AND version=1`;
    await assert.rejects(db`UPDATE project_finding_quality_heads SET phase='evaluated' WHERE project_id=${f.a} AND protocol_id=${f.p}`, { code: "23514" });
    await db`UPDATE project_finding_quality_heads SET version=version+1,phase='evaluated',latest_record_id=${evaluation},evaluation_record_id=${evaluation} WHERE project_id=${f.a} AND protocol_id=${f.p} AND version=2`;
    await assert.rejects(db`UPDATE project_finding_quality_heads SET phase='reviewed' WHERE project_id=${f.a} AND protocol_id=${f.p}`, { code: "23514" });
    await db`UPDATE project_finding_quality_heads SET version=version+1,phase='reviewed',latest_record_id=${review},review_record_id=${review} WHERE project_id=${f.a} AND protocol_id=${f.p} AND version=3`;
    const revoke = await record(db, f.a, f.p, { kind: "revoke", subject: review });
    await db`UPDATE project_finding_quality_heads SET version=version+1,phase='revoked',latest_record_id=${revoke},revocation_record_id=${revoke} WHERE project_id=${f.a} AND protocol_id=${f.p} AND version=4`;
    const [head] = await db`SELECT version,phase,first_access_record_id FROM project_finding_quality_heads WHERE project_id=${f.a} AND protocol_id=${f.p}`;
    assert.equal(Number(head.version), 5); assert.equal(head.phase, "revoked"); assert.equal(head.first_access_record_id, access);
    assert.equal((await db`SELECT count(*)::int AS n FROM project_finding_quality_records WHERE id IN (${access},${retry})`)[0].n, 2);
  });
});


test("quality current uses atomic nullable-deny tuples and revoke/reset CAS without erasing receipts", options, async () => {
  await withDatabase(async db => {
    const f = await fixture(db);
    const review = await record(db, f.a, f.p, { kind: "review" });
    await db`INSERT INTO project_finding_quality_current(project_id) VALUES(${f.a})`;
    for (let mask = 1; mask < 7; mask++) {
      await assert.rejects(db`UPDATE project_finding_quality_current SET protocol_id=${mask & 1 ? f.p : null},certificate_record_id=${mask & 2 ? review : null},scope_digest=${mask & 4 ? digest : null} WHERE project_id=${f.a}`, { code: "23514" });
    }
    for (const certificate of [f.otherRecord, f.foreignRecord]) await assert.rejects(db`UPDATE project_finding_quality_current SET protocol_id=${f.p},certificate_record_id=${certificate},scope_digest=${digest} WHERE project_id=${f.a}`, { code: "23503" });
    await assert.rejects(db`UPDATE project_finding_quality_current SET protocol_id=${f.foreign},certificate_record_id=${f.foreignRecord},scope_digest=${digest} WHERE project_id=${f.a}`, { code: "23503" });
    await assert.rejects(db`UPDATE project_finding_quality_current SET protocol_id=${f.p},certificate_record_id=${review},scope_digest='bad' WHERE project_id=${f.a}`, { code: "23514" });
    await assert.rejects(db`UPDATE project_finding_quality_current SET version=-1 WHERE project_id=${f.a}`, { code: "23514" });
    assert.equal((await db`UPDATE project_finding_quality_current SET version=version+1,protocol_id=${f.p},certificate_record_id=${review},scope_digest=${digest} WHERE project_id=${f.a} AND version=0 RETURNING version`).length, 1);
    assert.equal((await db`UPDATE project_finding_quality_current SET version=version+1,protocol_id=NULL,certificate_record_id=NULL,scope_digest=NULL WHERE project_id=${f.a} AND version=0 RETURNING version`).length, 0);
    const revoke = randomUUID();
    await db.begin(async tx => {
      await tx`INSERT INTO project_finding_quality_records(id,project_id,protocol_id,kind,record_digest,subject_record_id,actor_type,actor_name,body_json)
        VALUES(${revoke},${f.a},${f.p},'revoke',${digest},${review},'internal','fixture','{}')`;
      const reset = await tx`UPDATE project_finding_quality_current SET version=version+1,protocol_id=NULL,certificate_record_id=NULL,scope_digest=NULL WHERE project_id=${f.a} AND version=1 RETURNING version`;
      assert.equal(reset.length, 1);
    });
    const [current] = await db`SELECT * FROM project_finding_quality_current WHERE project_id=${f.a}`;
    assert.equal(Number(current.version), 2);
    assert.deepEqual([current.protocol_id, current.certificate_record_id, current.scope_digest], [null, null, null]);
    assert.equal((await db`SELECT count(*)::int AS n FROM project_finding_quality_records WHERE id IN (${review},${revoke})`)[0].n, 2);
  });
});

test("quality relation publication denies Boolean-only flips, every partial tuple and cross-scope certificates", options, async () => {
  await withDatabase(async db => {
    const f = await fixture(db), generation = randomUUID();
    await db`INSERT INTO project_finding_relations(project_id,generation,left_id,right_id,left_source_fingerprint,right_source_fingerprint,left_identity_fingerprint,right_identity_fingerprint,relation_kind,matched_fields,different_fields,root_cause_continuation,rule_version)
      VALUES(${f.a},${generation},${f.left},${f.right},${digest},${digest},${digest},${digest},'same_problem','{}','{}',false,'fixture')`;
    const [initial] = await db`SELECT quality_gate_status,published FROM project_finding_relations WHERE project_id=${f.a} AND generation=${generation}`;
    assert.equal(initial.quality_gate_status, "not_evaluated"); assert.equal(initial.published, false);
    await assert.rejects(db`UPDATE project_finding_relations SET published=true WHERE project_id=${f.a}`, { code: "23514" });
    await assert.rejects(db`UPDATE project_finding_relations SET quality_gate_status='passed' WHERE project_id=${f.a}`, { code: "23514" });
    await assert.rejects(db`UPDATE project_finding_relations SET quality_gate_status='passed',published=true WHERE project_id=${f.a}`, { code: "23514" });
    for (const status of ["not_evaluated", "failed", "passed"]) for (let mask = 1; mask < 7; mask++) {
      await assert.rejects(db`UPDATE project_finding_relations SET quality_gate_status=${status},quality_protocol_id=${mask & 1 ? f.p : null},quality_certificate_record_id=${mask & 2 ? f.ownRecord : null},quality_scope_digest=${mask & 4 ? digest : null} WHERE project_id=${f.a}`, { code: "23514" });
    }
    for (const certificate of [f.otherRecord, f.foreignRecord]) await assert.rejects(db`UPDATE project_finding_relations SET quality_protocol_id=${f.p},quality_certificate_record_id=${certificate},quality_scope_digest=${digest},quality_gate_status='passed',published=true WHERE project_id=${f.a}`, { code: "23503" });
    await assert.rejects(db`UPDATE project_finding_relations SET quality_protocol_id=${f.foreign},quality_certificate_record_id=${f.foreignRecord},quality_scope_digest=${digest} WHERE project_id=${f.a}`, { code: "23503" });
    await assert.rejects(db`UPDATE project_finding_relations SET quality_protocol_id=${f.p},quality_certificate_record_id=${f.ownRecord},quality_scope_digest='bad' WHERE project_id=${f.a}`, { code: "23514" });
    // Scope/Boolean guards are necessary but deliberately not a quality proof.
    // A reader must reject this registered (non-review) record as a certificate.
    await db`UPDATE project_finding_relations SET quality_protocol_id=${f.p},quality_certificate_record_id=${f.ownRecord},quality_scope_digest=${digest},quality_gate_status='passed',published=true WHERE project_id=${f.a}`;
    assert.equal((await db`SELECT kind FROM project_finding_quality_records WHERE id=${f.ownRecord}`)[0].kind, "registered");
    await db`UPDATE project_finding_relations SET quality_gate_status='failed',published=false WHERE project_id=${f.a}`;
    assert.equal((await db`SELECT quality_certificate_record_id FROM project_finding_relations WHERE project_id=${f.a}`)[0].quality_certificate_record_id, f.ownRecord);
  });
});

test("quality work uses generation-fenced SQL claims, bounded checkpoints and scoped dataset/evaluation pointers", options, async () => {
  await withDatabase(async db => {
    const f = await fixture(db);
    await db`INSERT INTO project_finding_quality_work(project_id,protocol_id) VALUES(${f.a},${f.p})`;
    for (const [column, value] of [["generation", 0], ["generation", -1], ["processed_generation", -1], ["processed_generation", 2], ["claimed_generation", 0], ["claimed_generation", -1], ["claimed_generation", 2]] as const) {
      await assert.rejects(db.unsafe(`UPDATE project_finding_quality_work SET ${column}=$1 WHERE project_id=$2 AND protocol_id=$3`, [value, f.a, f.p]), { code: "23514" });
    }
    for (const pointer of ["dataset_record_id", "evaluation_record_id"]) for (const value of [f.otherRecord, f.foreignRecord]) {
      await assert.rejects(db.unsafe(`UPDATE project_finding_quality_work SET ${pointer}=$1 WHERE project_id=$2 AND protocol_id=$3`, [value, f.a, f.p]), { code: "23503" });
    }
    await assert.rejects(db`UPDATE project_finding_quality_work SET status='orphan' WHERE project_id=${f.a}`, { code: "23514" });
    await assert.rejects(db`UPDATE project_finding_quality_work SET state_json='[]' WHERE project_id=${f.a}`, { code: "23514" });
    await assert.rejects(db`UPDATE project_finding_quality_work SET last_error_code=${"x".repeat(161)} WHERE project_id=${f.a}`, { code: "23514" });
    assert.equal((await db`UPDATE project_finding_quality_work SET claimed_generation=generation,status='running' WHERE project_id=${f.a} AND protocol_id=${f.p} AND generation=1 AND status='pending' RETURNING generation`).length, 1);
    assert.equal((await db`UPDATE project_finding_quality_work SET claimed_generation=generation,status='running' WHERE project_id=${f.a} AND protocol_id=${f.p} AND generation=1 AND status='pending' RETURNING generation`).length, 0);
    await db`UPDATE project_finding_quality_work SET generation=2,claimed_generation=NULL,status='pending',state_json='{"checkpoint":"new_generation"}' WHERE project_id=${f.a} AND protocol_id=${f.p} AND generation=1`;
    assert.equal((await db`UPDATE project_finding_quality_work SET processed_generation=1,status='completed' WHERE project_id=${f.a} AND protocol_id=${f.p} AND generation=1 AND claimed_generation=1 RETURNING generation`).length, 0);
    await db`UPDATE project_finding_quality_work SET claimed_generation=2,status='running' WHERE project_id=${f.a} AND protocol_id=${f.p} AND generation=2 AND status='pending'`;
    await db`UPDATE project_finding_quality_work SET processed_generation=2,claimed_generation=NULL,status='completed' WHERE project_id=${f.a} AND protocol_id=${f.p} AND generation=2 AND claimed_generation=2`;
    const [work] = await db`SELECT generation,processed_generation,status FROM project_finding_quality_work WHERE project_id=${f.a} AND protocol_id=${f.p}`;
    assert.deepEqual([Number(work.generation), Number(work.processed_generation), work.status], [2, 2, "completed"]);
  });
});


test("quality observations enforce scoped work/dataset/Finding uniqueness and retain immutable generations", options, async () => {
  await withDatabase(async db => {
    const f = await fixture(db);
    await db`INSERT INTO project_finding_quality_work(project_id,protocol_id) VALUES(${f.a},${f.p}),(${f.a},${f.other})`;
    const observe = async (finding: string | null, ordinal: number, generation = 1, dataset: string | null = f.ownRecord, project = f.a, protocolId = f.p) => {
      const id = randomUUID();
      await db`INSERT INTO project_finding_quality_observations(id,project_id,protocol_id,work_generation,dataset_record_id,subject_finding_id,ordinal,body_json,input_digest,record_digest,observed_at)
        VALUES(${id},${project},${protocolId},${generation},${dataset},${finding},${ordinal},'{"selector_trace":[],"raw_decisions":[]}',${digest},${digest},'2000-01-01')`;
      return id;
    };
    await assert.rejects(observe(f.foreignFinding, 0), { code: "23503" });
    for (const dataset of [f.otherRecord, f.foreignRecord]) await assert.rejects(observe(f.left, 0, 1, dataset), { code: "23503" });
    await assert.rejects(observe(f.left, 0, 1, f.ownRecord, f.a, f.other), { code: "23503" });
    await assert.rejects(observe(f.foreignFinding, 0, 1, f.foreignRecord, f.b, f.foreign), { code: "23503" });
    await assert.rejects(observe(f.left, 0, 1, null), { code: "23502" });
    await assert.rejects(observe(null, 0), { code: "23502" });
    await assert.rejects(observe(f.left, -1), { code: "23514" });
    await assert.rejects(observe(f.left, 0, 0), { code: "23514" });
    const first = await observe(f.left, 0);
    await assert.rejects(observe(f.left, 1), { code: "23505" });
    await assert.rejects(observe(f.right, 0), { code: "23505" });
    await observe(f.right, 1);
    await db`UPDATE project_finding_quality_work SET generation=2 WHERE project_id=${f.a} AND protocol_id=${f.p}`;
    await observe(f.left, 0, 2);
    assert.equal((await db`SELECT count(*)::int AS n FROM project_finding_quality_observations WHERE protocol_id=${f.p} AND work_generation=1`)[0].n, 2);
    for (const query of ["UPDATE project_finding_quality_observations SET body_json='{}' WHERE id=$1", "DELETE FROM project_finding_quality_observations WHERE id=$1"]) {
      await assert.rejects(db.unsafe(query, [first]), /finding_quality_history_append_only/);
    }
    assert.equal((await db`SELECT observed_at > '2000-01-02'::timestamptz AS server_time FROM project_finding_quality_observations WHERE id=${first}`)[0].server_time, true);
  });
});

test("quality byte limits reject compressible/UTF8 overflow and non-object JSON while preserving rejection receipts", options, async () => {
  await withDatabase(async db => {
    const f = await fixture(db);
    await db`INSERT INTO project_finding_quality_work(project_id,protocol_id) VALUES(${f.a},${f.p})`;
    const protocolBody = (body: string) => db`INSERT INTO project_finding_quality_protocols(project_id,protocol_digest,body_json,created_by_actor_type,created_by_actor_name) VALUES(${f.a},${hash(randomUUID())},${body}::jsonb,'user','fixture')`;
    for (const body of ["[]", "null", JSON.stringify("text"), "1"]) await assert.rejects(protocolBody(body), { code: "23514" });
    await db`INSERT INTO project_finding_quality_protocols(project_id,protocol_digest,body_json,created_by_actor_type,created_by_actor_name)
      VALUES(${f.a},${hash(randomUUID())},jsonb_build_object('x',repeat('x',65536-9)),'user','fixture')`;
    await assert.rejects(db`INSERT INTO project_finding_quality_protocols(project_id,protocol_digest,body_json,created_by_actor_type,created_by_actor_name)
      VALUES(${f.a},${hash(randomUUID())},jsonb_build_object('x',repeat(chr(20013),21846)),'user','fixture')`, { code: "23514" });
    const recordBody = (size: number) => db`INSERT INTO project_finding_quality_records(project_id,protocol_id,kind,record_digest,actor_type,actor_name,body_json)
      VALUES(${f.a},${f.p},'rejection',${digest},'internal','fixture',jsonb_build_object('x',repeat('x',${size})))`;
    for (const body of ["[]", "null", JSON.stringify("text")]) await assert.rejects(db`INSERT INTO project_finding_quality_records(project_id,protocol_id,kind,record_digest,actor_type,actor_name,body_json) VALUES(${f.a},${f.p},'rejection',${digest},'internal','fixture',${body}::jsonb)`, { code: "23514" });
    await recordBody(16777216-9);
    await assert.rejects(recordBody(16777216), { code: "23514" });
    await db`UPDATE project_finding_quality_work SET state_json=jsonb_build_object('x',repeat('x',16384-9)) WHERE project_id=${f.a} AND protocol_id=${f.p}`;
    await assert.rejects(db`UPDATE project_finding_quality_work SET state_json=jsonb_build_object('x',repeat('x',16384)) WHERE project_id=${f.a} AND protocol_id=${f.p}`, { code: "23514" });
    const observationBody = (size: number) => db`INSERT INTO project_finding_quality_observations(project_id,protocol_id,work_generation,dataset_record_id,subject_finding_id,ordinal,body_json,input_digest,record_digest)
      VALUES(${f.a},${f.p},1,${f.ownRecord},${size < 262144 ? f.left : f.right},${size < 262144 ? 0 : 1},jsonb_build_object('x',repeat('x',${size})),${digest},${digest})`;
    await observationBody(262144-9);
    await assert.rejects(observationBody(262144), { code: "23514" });
    const rejection = await record(db, f.a, f.p, { kind: "rejection", body: { error_code: "HOLDOUT_BODY_TOO_LARGE", raw_input_digest: digest } });
    assert.equal((await db`SELECT body_json->>'error_code' AS code FROM project_finding_quality_records WHERE id=${rejection}`)[0].code, "HOLDOUT_BODY_TOO_LARGE");
  });
});

test("quality restore witness proves re-enabling triggers does not revalidate trigger-disabled scoped FKs", options, async () => {
  await withDatabase(async db => {
    const f = await fixture(db);
    const invalid = randomUUID();
    await db.unsafe("SET session_replication_role = replica");
    try {
      await db`INSERT INTO project_finding_quality_records(id,project_id,protocol_id,kind,record_digest,actor_type,actor_name,body_json)
        VALUES(${invalid},${f.a},${f.foreign},'review',${digest},'internal','fixture','{}')`;
    } finally { await db.unsafe("SET session_replication_role = origin"); }
    assert.equal((await db`SELECT count(*)::int AS n FROM project_finding_quality_records WHERE id=${invalid}`)[0].n, 1, "re-enable alone leaves invalid restored history present");
    const keys = await db`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='public.project_finding_quality_records'::regclass AND confrelid='public.project_finding_quality_protocols'::regclass AND contype='f'`;
    assert.equal(keys.length, 1);
    const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
    const key = keys[0];
    await db.unsafe(`ALTER TABLE public.project_finding_quality_records DROP CONSTRAINT ${quote(key.conname)}, ADD CONSTRAINT ${quote(key.conname)} ${key.definition} NOT VALID`);
    await assert.rejects(db.unsafe(`ALTER TABLE public.project_finding_quality_records VALIDATE CONSTRAINT ${quote(key.conname)}`), { code: "23503" });
    await assert.rejects(db`DELETE FROM project_finding_quality_records WHERE id=${invalid}`, /finding_quality_history_append_only/);
    // No repair or permissive fallback: the isolated candidate is discarded.
  });
});
