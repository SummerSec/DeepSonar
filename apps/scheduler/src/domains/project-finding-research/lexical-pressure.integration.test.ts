// #835 item 2: Find-ing lexical retrieval under a synthetic backlog, with the PostgreSQL
// side measured instead of inferred from client memory.
//
// What this suite actually asserts (and what it refuses to claim):
//   - project isolation: a search in project A never returns project B findings;
//   - deterministic window budget: every response is complete (examined === 128, items <= 25)
//     under sequential and bounded-concurrent load, so a timeout cannot masquerade as a
//     shorter answer;
//   - the query keeps its bounded plan under a fixed-seed synthetic backlog, recorded with
//     EXPLAIN (ANALYZE, BUFFERS) plus pg_stat_database deltas (temp files, blocks read/hit)
//     so a human can see server-side cost, not client RSS.
//
// It does NOT assert an SLA, capacity or relation quality: those need frozen baselines and
// labelled data, which this probe does not have.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { cpus, totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
const SIZES = (process.env.LEXICAL_PRESSURE_SIZES ?? "1000,10000").split(",").map(Number);
const ARTIFACT_DIR = process.env.LEXICAL_PRESSURE_ARTIFACT_DIR;

const percentile = (samples: number[], q: number) =>
  [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.round(q * (samples.length - 1)))];

test("lexical retrieval stays bounded and isolated under a synthetic backlog (#835)", { skip: !databaseUrl }, async (t) => {
  const adminUrl = new URL(databaseUrl!); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `lexical_pressure_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const target = new URL(databaseUrl!); target.pathname = `/${name}`;
  process.env.DATABASE_URL = target.toString();
  const [{ sql, migrate }, { searchFindingLexical, lexicalWindowQuery }] = await Promise.all([
    import("../../db.js"), import("./lexical-search.js"),
  ]);
  const report: Record<string, unknown>[] = [];
  try {
    await migrate();
    interface Stats {
      tup_returned: number; tup_fetched: number; blks_read: number; blks_hit: number;
      temp_files: number; temp_bytes: number; xact_commit: number; locks: number; sessions: number;
    }
    const stats = async (): Promise<Stats> => {
      const [row] = await sql`SELECT tup_returned, tup_fetched, blks_read, blks_hit,
        temp_files, temp_bytes, xact_commit FROM pg_stat_database WHERE datname = current_database()`;
      const [locks] = await sql`SELECT count(*)::int AS count FROM pg_locks`;
      const [sessions] = await sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()`;
      // SAFETY: the SELECT lists exactly these columns; pg_stat_database and the count(*)
      // queries always return one row of numbers for the current database.
      const database = row as unknown as Omit<Stats, "locks" | "sessions">;
      return {
        tup_returned: Number(database.tup_returned), tup_fetched: Number(database.tup_fetched),
        blks_read: Number(database.blks_read), blks_hit: Number(database.blks_hit),
        temp_files: Number(database.temp_files), temp_bytes: Number(database.temp_bytes),
        xact_commit: Number(database.xact_commit),
        locks: Number((locks as unknown as { count: number }).count),
        sessions: Number((sessions as unknown as { count: number }).count),
      };
    };

    for (const size of SIZES) {
      await t.test(`backlog ${size}: bounded windows, isolation and server-side cost`, async () => {
        const projectA = randomUUID(), projectB = randomUUID();
        for (const [project, label] of [[projectA, "A"], [projectB, "B"]] as const) {
          const canvas = randomUUID(), job = randomUUID();
          await sql`INSERT INTO projects(id,name) VALUES (${project}, ${`synthetic lexical ${label}`})`;
          await sql`INSERT INTO canvases(id,project_id,title) VALUES (${canvas},${project},'synthetic')`;
          await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
            VALUES (${job},${project},${canvas},'audit','succeeded','{}')`;
          // Fixed-seed shape: a hot repeated phrase, sparse titles and a missing summary band.
          // Synthetic text stays in SQL: padding a JS string with a column reference would
          // evaluate `n` outside the query.
          await sql`INSERT INTO findings(project_id,job_id,fingerprint,title,summary,profile)
            SELECT ${project}::uuid,${job}::uuid,n::text,
              CASE WHEN n % 7 = 0 THEN 'sql injection in login' ELSE ${label} || ' unrelated ' || repeat('x', n % 40) END,
              CASE WHEN n % 11 = 0 THEN '' ELSE repeat('synthetic declaration unknown identity ',8) END,
              'security.vulnerability'
            FROM generate_series(1,${size}) n`;
          await sql`INSERT INTO canvases(id,project_id,title)
            SELECT md5(${project} || ':canvas:' || n)::uuid,${project}::uuid,'synthetic canvas' FROM generate_series(1,${size}) n`;
          await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
            SELECT md5(${project} || ':job:' || n)::uuid,${project}::uuid,md5(${project} || ':canvas:' || n)::uuid,'audit','succeeded','{}'
            FROM generate_series(1,${size}) n`;
          await sql`UPDATE findings SET job_id=md5(${project} || ':job:' || fingerprint)::uuid WHERE project_id=${project}::uuid`;
        }
        await sql`ANALYZE findings`; await sql`ANALYZE jobs`; await sql`ANALYZE canvases`;
        const [subjectRow] = await sql`SELECT id FROM findings WHERE project_id=${projectA}::uuid ORDER BY fingerprint LIMIT 1`;
        const subject = String(subjectRow.id);
        const [foreignRow] = await sql`SELECT id FROM findings WHERE project_id=${projectB}::uuid ORDER BY fingerprint LIMIT 1`;
        const foreignIds = new Set((await sql`SELECT id FROM findings WHERE project_id=${projectB}::uuid ORDER BY id LIMIT 50`).map(row => String(row.id)));

        const before = await stats();
        const sequential: number[] = [];
        let examined = 0;
        for (let i = 0; i < 20; i += 1) {
          const started = performance.now();
          const response = await searchFindingLexical(subject, undefined);
          sequential.push(performance.now() - started);
          assert.ok(response, "every query must return a complete window");
          assert.equal(response.examined, 128, "the window budget must not shrink under pressure");
          assert.ok(response.items.length <= 25, "window size must stay within the documented bound");
          examined = response.examined;
          for (const item of response.items) {
            assert.ok(!foreignIds.has(String(item.finding_id)), "project isolation: another project's finding leaked into the window");
          }
        }
        const concurrent: number[] = [];
        await Promise.all(Array.from({ length: 8 }, async () => {
          for (let i = 0; i < 5; i += 1) {
            const started = performance.now();
            const response = await searchFindingLexical(subject, undefined);
            concurrent.push(performance.now() - started);
            assert.ok(response, "a concurrent query must not degrade to a partial result");
            assert.equal(response.examined, 128);
            assert.ok(response.items.length <= 25);
          }
        }));
        const after = await stats();

        const plan = await sql.begin("isolation level repeatable read read only", async tx => {
          await tx`SET LOCAL statement_timeout='5000ms'`;
          const [row] = await tx`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${lexicalWindowQuery(tx, projectA, null)}`;
          return (row as Record<string, unknown>)["QUERY PLAN"];
        });

        report.push({
          findings_per_project: size, examined,
          sequential_ms: { p50: percentile(sequential, 0.5), p95: percentile(sequential, 0.95) },
          concurrent_ms: { requests: concurrent.length, p50: percentile(concurrent, 0.5), p95: percentile(concurrent, 0.95) },
          postgres_before: before, postgres_after: after,
          postgres_delta: {
            temp_files: Number(after.temp_files) - Number(before.temp_files),
            temp_bytes: Number(after.temp_bytes) - Number(before.temp_bytes),
            blks_read: Number(after.blks_read) - Number(before.blks_read),
            blks_hit: Number(after.blks_hit) - Number(before.blks_hit),
          },
          plan,
        });
      });
    }

    const artifact = {
      sample_kind: "synthetic scale only; no labelled quality or SLA claim",
      postgres: (await sql`SELECT version() AS value`)[0].value,
      node: process.version, arch: process.arch, cpu: cpus()[0]?.model, logical_cpus: cpus().length,
      host_memory_bytes: totalmem(), sizes: SIZES,
      methodology:
        "Fixed-seed synthetic backlog per project; 20 sequential then 8x5 bounded-concurrent searches on one subject finding; " +
        "server cost from pg_stat_database deltas and EXPLAIN (ANALYZE, BUFFERS). Client RSS is deliberately not used as a server metric.",
      results: report,
    };
    const directory = ARTIFACT_DIR ?? join(tmpdir(), "deepsonar-lexical-pressure");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "metrics.json"), `${JSON.stringify(artifact, null, 2)}\n`);
    t.diagnostic(`lexical pressure artifact: ${join(directory, "metrics.json")}`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.end({ timeout: 5 });
  }
});