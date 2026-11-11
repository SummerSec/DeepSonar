/** Exact schema68 -> current baseline: preserve token/ledger history and a real backup. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import postgres from "postgres";
import { SCHEMA_FILE, type MigrationConnection } from "./migration-runner.js";
import { rebuildSchemaOnReservedSession } from "./schema-rebuild.js";
import { restoreFindingSourceBackup } from "./schema-rebuild-finding-fixture.js";
import { SCHEMA_VERSION } from "./schema-version.js";

const V68_COMMIT = "5bed5018cb8064cd67973efa8713eb2d344f7fb5";
function schemaV68(): string {
  let schema: string;
  try {
    schema = execFileSync("git", ["show", `${V68_COMMIT}:database/schema.sql`], {
      cwd: resolve(dirname(SCHEMA_FILE), ".."), encoding: "utf8", stdio: "pipe", timeout: 10_000,
    });
  } catch {
    throw new Error("Pinned schema68 unavailable; credential history rebuild requires full Git history without a current-schema fallback.");
  }
  assert.match(schema, /INSERT INTO schema_meta \(id, version\) VALUES \('global', 68\)/);
  assert.match(schema, /credential_id uuid NOT NULL REFERENCES credentials\(id\)/);
  assert.ok(!schema.includes("job_tokens_credential_check"));
  return schema;
}
async function capture(db: ReturnType<typeof postgres>) {
  const result: Record<string, unknown> = {};
  for (const table of ["projects", "canvases", "jobs", "job_attempts", "credentials", "job_tokens", "job_usage_ledger"]) {
    const rows = await db.unsafe(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
    result[table] = rows.map(row => table === 'jobs' ? { execution_deadline_at: null, ...row.row } : row.row);
  }
  return result;
}

export async function runCredentialSchemaRebuildFixture(testUrl: string): Promise<void> {
  const adminUrl = new URL(testUrl); adminUrl.pathname = "/postgres";
  const prefix = `credential_rebuild_${randomUUID().replaceAll("-", "")}`;
  const targetName = `${prefix}_target`, backupName = `${prefix}_backup`;
  const targetUrl = new URL(testUrl); targetUrl.pathname = `/${targetName}`;
  const backupUrl = new URL(testUrl); backupUrl.pathname = `/${backupName}`;
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const db = postgres(targetUrl.toString(), { max: 2 });
  const backup = postgres(backupUrl.toString(), { max: 1 });
  const dumpDir = mkdtempSync(join(tmpdir(), "deepsonar-1002-credential-rebuild-"));
  const previousUrl = process.env.DATABASE_URL;
  try {
    await admin.unsafe(`CREATE DATABASE "${targetName}"`);
    await admin.unsafe(`CREATE DATABASE "${backupName}"`);
    const bootstrap = await db.reserve();
    try { await bootstrap.unsafe(schemaV68()); } finally { bootstrap.release(); }
    const project = randomUUID(), canvas = randomUUID(), job = randomUUID(), attempt = randomUUID(), credential = randomUUID();
    await db`INSERT INTO projects(id,name) VALUES(${project},'credential history')`;
    await db`INSERT INTO canvases(id,project_id,title) VALUES(${canvas},${project},'credential history')`;
    await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
      VALUES(${job},${project},${canvas},'explore','succeeded',${db.json({ credential_id: credential, history: "frozen" })})`;
    await db`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase) VALUES(${attempt},${job},1,'succeeded','terminal')`;
    await db`INSERT INTO credentials(id,name,kind,provider,ciphertext,nonce,auth_tag,fingerprint,last4)
      VALUES(${credential},'historical account','llm_provider','openai','offline-encrypted-fixture','fixture','fixture','fixture','ture')`;
    for (const [index, workload] of ["main", "observational_memory"].entries()) {
      const token = randomUUID();
      await db`INSERT INTO job_tokens(id,job_id,project_id,credential_id,token_prefix,token_hash,max_requests,
        request_total_limit,used_requests,used_tokens,workload,expected_provider,expected_model,expected_route,status,expires_at)
        VALUES(${token},${job},${project},${credential},${token.slice(0, 8)},'hash',2,4,2,15,${workload},
          'openai','model-a','v1/chat/completions',${index === 0 ? 'active' : 'revoked'},now()+interval '1 hour')`;
      await db`INSERT INTO job_usage_ledger(job_id,project_id,attempt_id,job_token_id,effect_id,request_no,provider,
        model,input_tokens,output_tokens,total_tokens,workload)
        VALUES(${job},${project},${attempt},${token},${`credential.rebuild.${index}`},${index + 1},'openai','model-a',10,5,15,${workload})`;
    }
    const history = await capture(db);
    process.env.DATABASE_URL = targetUrl.toString();
    const reserve = () => db.reserve() as unknown as Promise<MigrationConnection & { release: () => void }>;
    const plan = await rebuildSchemaOnReservedSession(reserve, { mode: "plan", terminateScheduler: false });
    assert.equal(plan.plan.currentVersion, 68);
    assert.equal(plan.plan.targetVersion, SCHEMA_VERSION);
    assert.equal(plan.applied, false);
    assert.deepEqual(await capture(db), history, "plan cannot rewrite historical rows");
    const rebuilt = await rebuildSchemaOnReservedSession(reserve, { mode: "apply", dumpDir, keepStaging: true, terminateScheduler: false });
    assert.equal(rebuilt.applied, true);
    assert.ok(rebuilt.dumpPath, "a real pre-rebuild backup is mandatory");
    assert.equal(readFileSync(rebuilt.dumpPath).subarray(0, 5).toString(), "PGDMP");
    restoreFindingSourceBackup(backupUrl, rebuilt.dumpPath);
    assert.equal((await backup`SELECT version FROM schema_meta WHERE id='global'`)[0].version, 68);
    assert.deepEqual(await capture(backup), history, "restored schema68 backup retains exact token and ledger identities");
    assert.equal((await db`SELECT version FROM schema_meta WHERE id='global'`)[0].version, SCHEMA_VERSION);
    assert.deepEqual(await capture(db), history, "column-intersection refill preserves snapshots, token counts and ledger references");
    const [column] = await db`SELECT is_nullable FROM information_schema.columns WHERE table_schema='public'
      AND table_name='job_tokens' AND column_name='credential_id'`;
    assert.equal(column.is_nullable, "YES");
    await assert.rejects(db`DELETE FROM credentials WHERE id=${credential}`, { code: "23514" });
    await db.begin(async tx => {
      await tx`UPDATE job_tokens SET status='revoked',revoked_at=now(),revoke_reason='credential_deleted' WHERE credential_id=${credential}`;
      await tx`DELETE FROM credentials WHERE id=${credential}`;
    });
    assert.deepEqual((await capture(db)).job_usage_ledger, history.job_usage_ledger);
    const retained = await db`SELECT credential_id,status,used_requests FROM job_tokens WHERE job_id=${job}`;
    assert.equal(retained.length, 2);
    assert.ok(retained.every(row => row.credential_id === null && row.status === "revoked" && row.used_requests === 2));
    await assert.rejects(db`UPDATE job_tokens SET status='active' WHERE job_id=${job}`, { code: "23514" });
  } finally {
    await db.end(); await backup.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${targetName}"`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${backupName}"`);
    await admin.end();
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    rmSync(dumpDir, { recursive: true, force: true });
  }
}
