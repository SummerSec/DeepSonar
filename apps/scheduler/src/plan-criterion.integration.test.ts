import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Plan, mergePlanAudit } from "@deepsonar/shared-types";

const databaseUrl = process.env.TEST_DATABASE_URL;
test("operator criterion bindings are scoped, versioned, atomic and rebuilt from durable sources", { skip: !databaseUrl }, async () => {
  const postgres = (await import("postgres")).default;
  const adminUrl = new URL(databaseUrl!); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const dbName = `criterion_${process.pid}_${Date.now()}`;
  const target = new URL(databaseUrl!); target.pathname = `/${dbName}`;
  const blob = await mkdtemp(path.join(os.tmpdir(), "criterion-db-"));
  let close: (() => Promise<unknown>) | undefined, end: (() => Promise<unknown>) | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    process.env.DATABASE_URL = target.toString(); process.env.BLOB_DIR = blob;
    process.env.DEEPSONAR_AUTH_REQUIRED = "true"; process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32); process.env.AGENT_MODE = "fake";
    const [{ default: Fastify }, { default: websocket }, { migrate, sql }, { registerRoutes }, { generateToken }, model, projection] = await Promise.all([
      import("fastify"), import("@fastify/websocket"), import("./db.js"), import("./routes.js"), import("./auth.js"),
      import("./domains/plan-protocol/criterion-model.js"), import("./domains/plan-protocol/criterion-projection.js"),
    ]);
    end = () => sql.end({ timeout: 5 }); await migrate();
    const app = Fastify({ logger: false }); await app.register(websocket); registerRoutes(app); await app.ready(); close = () => app.close();
    const project = randomUUID(), canvas = randomUUID(), planJob = randomUUID(), sourceJob = randomUUID(), attempt = randomUUID();
    const plan = Plan.parse({ v: 1, goal: "Verify scoped behavior", tasks: [{ id: "sample", title: "Collect evidence", role: "test", description: "Scoped execution", prompt: "Execute within the authorized scope and retain evidence.", expected_outputs: ["Execution record"] }], completion: { mode: "explicit_result", description: "Scoped execution retained", required_outputs: ["Execution record"] } });
    await sql`INSERT INTO projects (id,name,config_json) VALUES (${project},'Criterion fixtures',${sql.json({ rules: { hubEnabled: false } })})`;
    await sql`INSERT INTO canvases (id,project_id,title) VALUES (${canvas},${project},'Criterion sample')`;
    await sql`INSERT INTO jobs (id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json) VALUES
      (${planJob},${project},${canvas},'hub','succeeded','{}',${sql.json({ plan_protocol: mergePlanAudit(null,{ source: "submit_plan", raw: plan, trimmed: plan }) } as never)}),
      (${sourceJob},${project},${canvas},'test','succeeded','{}','{}')`;
    await sql`INSERT INTO job_attempts (id,job_id,attempt_no,status,phase) VALUES (${attempt},${sourceJob},1,'succeeded','terminal')`;
    const reader = generateToken(), operator = generateToken();
    await sql`INSERT INTO api_tokens (name,token_prefix,token_hash,scopes) VALUES
      ('reader',${reader.prefix},${reader.hash},${["tasks:read","jobs:read"]}),
      ('operator',${operator.prefix},${operator.hash},${["tasks:read","jobs:read","jobs:control"]})`;
    const auth = (token = operator.plaintext) => ({ authorization: `Bearer ${token}` });
    const files: { path: string; bytes: number; sha256: string }[] = [];
    let seq = 0;
    async function factFixture() {
      const fact = randomUUID(), artifact = randomUUID(), evidence = randomUUID(), event = randomUUID();
      const uri = `attempts/${attempt}/${fact}.txt`, bytes = Buffer.from(`Scoped execution ${fact}`);
      const sha = createHash("sha256").update(bytes).digest("hex");
      await mkdir(path.dirname(path.join(blob, "jobs", sourceJob, uri)), { recursive: true });
      await writeFile(path.join(blob, "jobs", sourceJob, uri), bytes);
      files.push({ path: uri, bytes: bytes.length, sha256: sha });
      await writeFile(path.join(blob, "jobs", sourceJob, "manifest.json"), JSON.stringify({ job_id: sourceJob, finalized_at: new Date().toISOString(), files }));
      await sql`INSERT INTO events (job_id,event_id,job_seq,attempt_id,type) VALUES (${sourceJob},${event},${++seq},${attempt},'fact')`;
      await sql`INSERT INTO artifacts (id,project_id,canvas_id,job_id,node_id,artifact_key,kind,source_event_id,source_operation)
        VALUES (${artifact},${project},${canvas},${sourceJob},${fact},${`fact-${fact}`},'fact',${event},'emit_fact')`;
      // emit_fact's real projection can have a null node.job_id; provenance must follow Artifact.
      await sql`INSERT INTO canvas_nodes (id,canvas_id,node_type,title,verification_status,body_json) VALUES (${fact},${canvas},'fact','Scoped evidence','unverified',${sql.json({ artifact_id: artifact, description: "Observed scoped execution" })})`;
      await sql`INSERT INTO artifact_evidence (id,artifact_id,statement,uri,sha256) VALUES (${evidence},${artifact},'Execution record',${uri},${sha})`;
      return { fact, artifact, uri, bytes };
    }
    const first = await factFixture(), second = await factFixture();
    const detail = async (fact: string) => {
      const response = await app.inject({ method: "GET", url: `/canvases/${canvas}/facts/${fact}`, headers: auth() });
      assert.equal(response.statusCode,200,response.payload); return response.json();
    };
    const patch = (fact: string, body: unknown, token = operator.plaintext) => app.inject({ method: "PATCH", url: `/canvases/${canvas}/facts/${fact}/verification`, headers: auth(token), payload: body as never });
    const request = async (fact: string, extra = {}) => ({ status: "verified", note: "Operator reviewed scoped execution and criterion", plan_binding: {
      plan_job_id: planJob, plan_sha256: model.contentSha256(plan), criterion_id: "completion",
      expected_source_sha256: (await detail(fact)).plan_criterion_source.source_sha256, expected_binding_id: null,
      assessment: "satisfies", observation: "negative", ...extra,
    } });
    const criteria = () => projection.loadPlanCriteria(sql,canvas,project,planJob,plan);
    const jobDetail = await app.inject({ method: "GET", url: `/jobs/${planJob}`, headers: auth() });
    assert.equal(jobDetail.statusCode,200,jobDetail.payload);
    assert.ok(JSON.stringify(jobDetail.json()).includes(model.contentSha256(plan)));
    assert.equal((await criteria())[0]?.state,"unbound");
    const body = await request(first.fact);
    assert.equal((await detail(first.fact)).plan_criterion_source.eligible,true);
    assert.equal((await patch(first.fact,body,reader.plaintext)).statusCode,403);
    assert.equal((await patch(first.fact,{ ...body, plan_binding: { ...body.plan_binding, plan_sha256: "a".repeat(64) } })).statusCode,409);
    assert.equal((await detail(first.fact)).fact.verification_status,"unverified");
    const accept = await patch(first.fact,body); assert.equal(accept.statusCode,200,accept.payload);
    assert.equal((await criteria())[0]?.state,"satisfied");
    const original = JSON.parse(JSON.stringify(await criteria()));
    const { buildReportInput } = await import("./report.js");
    const frozenInput = await buildReportInput(canvas,sql);
    const frozenHash = model.contentSha256(frozenInput);
    assert.equal(model.contentSha256(await buildReportInput(canvas,sql)),frozenHash,"same source yields stable frozen report input");
    assert.deepEqual(await criteria(),original,"reload reconstructs durable binding");
    const repeat = await patch(first.fact,body); assert.equal(repeat.statusCode,200,repeat.payload);
    assert.equal((await detail(first.fact)).plan_bindings.records.length,1,"retry creates no duplicate binding");
    const binding = (await detail(first.fact)).plan_bindings.records[0].after_json;
    assert.equal((await patch(first.fact,await request(first.fact,{ assessment: "contradicts" }))).statusCode,409);
    // Compare-and-swap on the Fact lock serializes simultaneous changes.
    const concurrent = await Promise.all([
      patch(first.fact,await request(first.fact,{ assessment: "contradicts", expected_binding_id: binding.binding_id })),
      patch(first.fact,await request(first.fact,{ assessment: "inconclusive", expected_binding_id: binding.binding_id })),
    ]);
    assert.deepEqual(concurrent.map(r=>r.statusCode).sort(),[200,409]);
    const latestId = () => detail(first.fact).then(x=>x.plan_bindings.records[0].after_json.binding_id);
    assert.equal((await patch(first.fact,await request(first.fact,{ expected_binding_id: await latestId() }))).statusCode,200);
    assert.equal((await patch(second.fact,await request(second.fact,{ assessment: "contradicts", observation: "positive" }))).statusCode,200);
    assert.equal((await criteria())[0]?.state,"conflict");
    assert.notEqual(model.contentSha256(await buildReportInput(canvas,sql)),frozenHash,"new binding changes report input identity");
    assert.equal(model.contentSha256(frozenInput),frozenHash,"old report input remains frozen");
    // Revocation and re-verification do not silently reactivate an old attestation.
    assert.equal((await patch(second.fact,{status:"needs_human"})).statusCode,200);
    assert.equal((await patch(second.fact,{status:"verified"})).statusCode,200);
    assert.equal((await criteria())[0]?.state,"stale");
    assert.deepEqual(original[0].state,"satisfied","historical projection remains unchanged");
    const secondBinding = (await detail(second.fact)).plan_bindings.records[0].after_json.binding_id;
    assert.equal((await patch(second.fact,await request(second.fact,{expected_binding_id:secondBinding}))).statusCode,200);
    assert.equal((await criteria())[0]?.state,"satisfied");
    await writeFile(path.join(blob,"jobs",sourceJob,first.uri),"tampered");
    assert.equal((await criteria())[0]?.state,"blocked");
    await writeFile(path.join(blob,"jobs",sourceJob,first.uri),first.bytes);
    await sql`UPDATE artifacts SET status='superseded', superseded_at=now() WHERE id=${first.artifact}`;
    assert.equal((await criteria())[0]?.state,"blocked");
    await sql`UPDATE artifacts SET status='submitted', superseded_at=NULL WHERE id=${first.artifact}`;
    await sql`UPDATE job_attempts SET status='unknown' WHERE id=${attempt}`;
    assert.equal((await criteria())[0]?.state,"blocked");
    await sql`UPDATE job_attempts SET status='succeeded' WHERE id=${attempt}`;
    await sql`INSERT INTO job_attempt_effects (attempt_id,job_id,effect_id,effect_kind,status) VALUES (${attempt},${sourceJob},'unknown-fixture','execution','unknown')`;
    assert.equal((await criteria())[0]?.state,"blocked");
    await sql`UPDATE job_attempt_effects SET status='settled' WHERE attempt_id=${attempt}`;
    for (const status of ["cancelled","timeout","failed"]) {
      await sql`UPDATE jobs SET status=${status} WHERE id=${sourceJob}`;
      assert.equal((await criteria())[0]?.state,"blocked");
    }
    await sql`UPDATE jobs SET status='succeeded' WHERE id=${sourceJob}`;
    await sql`UPDATE artifact_evidence SET statement='Revised interpretation' WHERE artifact_id=${first.artifact}`;
    assert.equal((await criteria())[0]?.state,"stale");
    await sql`UPDATE artifact_evidence SET statement='Execution record' WHERE artifact_id=${first.artifact}`;
    const newPlan = {...plan,goal:"Changed scope"};
    assert.equal((await projection.loadPlanCriteria(sql,canvas,project,planJob,newPlan))[0]?.state,"stale");
    const foreignCanvas=randomUUID(),foreignPlan=randomUUID();
    await sql`INSERT INTO canvases (id,project_id,title) VALUES (${foreignCanvas},${project},'Other scope')`;
    await sql`INSERT INTO jobs (id,project_id,canvas_id,type,status,agent_snapshot_json,payload_json) VALUES (${foreignPlan},${project},${foreignCanvas},'hub','succeeded','{}',${sql.json({plan_protocol:mergePlanAudit(null,{source:"submit_plan",raw:plan})} as never)})`;
    assert.equal((await patch(first.fact,await request(first.fact,{plan_job_id:foreignPlan}))).statusCode,409);
    // Mandatory audit insert failure rolls back the accompanying Fact trust change.
    const third=await factFixture();
    await sql.unsafe(`CREATE FUNCTION reject_binding_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='canvas.fact.plan_binding' THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN NEW; END $$`);
    await sql.unsafe(`CREATE TRIGGER reject_binding_fixture BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_binding_fixture()`);
    assert.equal((await patch(third.fact,await request(third.fact))).statusCode,500);
    assert.equal((await detail(third.fact)).fact.verification_status,"unverified");
    assert.equal((await detail(third.fact)).plan_bindings.records.length,0);
  } finally {
    await close?.(); await end?.();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); await admin.end();
    await rm(blob,{recursive:true,force:true});
  }
});
