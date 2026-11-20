import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { sql } from "./db.js";
import { deleteProjectsLeavingAuditShells } from "./test-project-teardown.js";

type Claim = () => Promise<{ id: string }[]>;

/** Uses the public SQL claim entry point, including attempts, quotas and locks. */
export async function runDispatchFairnessFixture(db: typeof sql, claim: Claim, credentialId: string): Promise<void> {
  const projects = Array.from({ length: 37 }, () => randomUUID()).sort();
  const wrapCanvasId = `fairness-wrap-${randomUUID()}`;
  const snapshot = { agent_cli: "claude-code", credential_provider: "anthropic", credential_id: credentialId, model: "fairness-model" };
  const childClaim = async () => {
    const source = `const {claimPendingJobs}=await import(${JSON.stringify(new URL("./dispatcher.ts", import.meta.url).href)});
      const {sql}=await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
      try { console.log('FAIR_RESULT='+JSON.stringify(await claimPendingJobs())); } finally { await sql.end({timeout:5}); }`;
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      { env: process.env, timeout: 30_000 });
    return JSON.parse(stdout.split("\n").find(line => line.startsWith("FAIR_RESULT="))!.slice(12)) as { id: string }[];
  };
  const rules = async (slots: number) => {
    await db`UPDATE global_settings SET rules_json = ${db.json({ maxGlobalJobs: slots,
      maxJobsPerProject: slots, maxConcurrentProvisioning: slots, maxConcurrentByAgentCli: { "claude-code": slots, pi: 0 } })},
      dispatch_scan_served = NULL, dispatch_scan_project_id = NULL WHERE id = 'global'`;
  };
  const pending = async (projectId: string, priority: number, count = 1, valid = true) => {
    const rows = Array.from({ length: count }, () => ({ id: randomUUID(), project_id: projectId,
      type: "audit", status: "pending", priority,
      agent_snapshot_json: { ...snapshot, ...(valid ? {} : { agent_cli: "pi" }) } }));
    await db`INSERT INTO jobs ${db(rows, "id", "project_id", "type", "status", "priority", "agent_snapshot_json")}`;
    return rows.map(row => row.id);
  };
  const clear = async () => {
    await db`DELETE FROM jobs WHERE project_id = ANY(${projects}::uuid[])`;
    await db`UPDATE projects SET dispatch_last_served = 0, dispatch_scan_priority = NULL,
      dispatch_scan_created_at = NULL, dispatch_scan_job_id = NULL, config_json = '{}' WHERE id = ANY(${projects}::uuid[])`;
    await db`UPDATE global_settings SET dispatch_scan_served = NULL, dispatch_scan_project_id = NULL WHERE id = 'global'`;
  };
  const release = async () => {
    await db`DELETE FROM jobs WHERE project_id = ANY(${projects}::uuid[]) AND status = 'claimed'`;
  };
  try {
    for (const id of projects) await db`INSERT INTO projects (id, name) VALUES (${id}, ${`fairness-${id}`})`;

    // Five projects compete for two slots. Every tick replenishes the first
    // project's high-priority work. Service must still reach all five projects.
    await rules(2);
    for (const [index, id] of projects.slice(0, 5).entries()) await pending(id, index === 0 ? 1000 : -1000, 5);
    const served: string[] = [];
    for (let tick = 0; tick < 3; tick += 1) {
      await pending(projects[0]!, 1000);
      const rows = tick === 1 ? await childClaim() : await claim();
      assert.equal(rows.length, 2);
      const owners = await db`SELECT id::text, project_id::text FROM jobs WHERE id = ANY(${rows.map(row => row.id)}::uuid[])`;
      const ownerByJob = new Map(owners.map(row => [String(row.id), String(row.project_id)]));
      served.push(...rows.map(row => ownerByJob.get(row.id)!));
      if (tick < 2) assert.equal(new Set(served).size, served.length, "no second service before four distinct projects");
      await release();
    }
    assert.equal(new Set(served.slice(0, 5)).size, 5, "project count exceeds slots across three ticks and process restart");

    await clear();
    await rules(2);
    const firstLow = (await pending(projects[0]!, -10))[0]!;
    const firstHigh = (await pending(projects[0]!, 1000))[0]!;
    const otherLow = (await pending(projects[1]!, -1000))[0]!;
    assert.deepEqual(new Set((await claim()).map(row => row.id)), new Set([firstHigh, otherLow]));
    assert.equal((await db`SELECT status FROM jobs WHERE id = ${firstLow}`)[0]!.status, "pending", "priority stays project-local");

    // Eligibility pages are bounded at 64. More than 500 invalid high-priority
    // rows cannot hide a different low-priority project or a later valid row.
    await clear();
    await rules(1);
    await pending(projects[0]!, 1000, 513, false);
    const eligibleTail = (await pending(projects[0]!, -1000))[0]!;
    const otherTail = (await pending(projects[1]!, -1000))[0]!;
    assert.deepEqual((await claim()).map(row => row.id), [otherTail]);
    await release();
    const initialService = (await db`SELECT dispatch_last_served::text AS value FROM projects WHERE id = ${projects[0]!}`)[0]!.value;
    assert.equal(initialService, "0", "rejected candidates do not consume a service turn");
    const [cursor] = await db`SELECT dispatch_scan_job_id FROM projects WHERE id = ${projects[0]!}`;
    assert.ok(cursor!.dispatch_scan_job_id, "page cursor is durable");
    let tailClaimed = false;
    for (let tick = 0; tick < 10; tick += 1) {
      const rows = tick === 0 ? await childClaim() : await claim();
      if (rows.some(row => row.id === eligibleTail)) { tailClaimed = true; break; }
    }
    assert.ok(tailClaimed, "in-project page progress survives process replacement and reaches the eligible tail");

    // Circular priority scan deliberately completes its current bounded pass.
    // A prefix that becomes eligible mid-pass is reconsidered after wrap.
    await clear();
    await rules(1);
    const blockedPrefix = await pending(projects[0]!, 1000, 64, false);
    const lowAfterCursor = (await pending(projects[0]!, -1000))[0]!;
    assert.deepEqual(await claim(), []);
    await db`UPDATE jobs SET agent_snapshot_json = ${db.json(snapshot)} WHERE id = ${blockedPrefix[0]!}`;
    assert.deepEqual((await claim()).map(row => row.id), [lowAfterCursor], "current pass advances before prefix reconsideration");
    await release();
    assert.deepEqual((await claim()).map(row => row.id), [blockedPrefix[0]!], "successful visit resets the scan and rechecks the high-priority prefix");

    // Tail exhaustion also wraps without a successful claim. A replacement
    // scheduler must clear the persisted scan before reconsidering the prefix.
    await clear();
    await rules(1);
    const wrapPrefix = await pending(projects[0]!, 1000, 64, false);
    assert.deepEqual(await claim(), []);
    await db`UPDATE jobs SET agent_snapshot_json = ${db.json(snapshot)} WHERE id = ${wrapPrefix[0]!}`;
    assert.deepEqual(await childClaim(), [], "bounded tail visit does not jump backwards mid-pass");
    const [wrapped] = await db`SELECT dispatch_scan_job_id, dispatch_last_served::text AS served
      FROM projects WHERE id = ${projects[0]!}`;
    assert.equal(wrapped!.dispatch_scan_job_id, null, "exhausted tail clears the durable scan");
    assert.equal(wrapped!.served, "0", "empty tail consumes no service turn");
    assert.deepEqual((await claim()).map(row => row.id), [wrapPrefix[0]!], "next pass claims the newly eligible prefix after process replacement");

    // More projects than the visit budget. Persisted project cursor advances
    // past 32 paused projects, even when the next call is another scheduler.
    await clear();
    await rules(1);
    for (const id of projects.slice(0, 36)) {
      await db`UPDATE projects SET config_json = '{"rules":{"maxConcurrentJobs":0}}' WHERE id = ${id}`;
      await pending(id, 1000);
    }
    const lastProjectJob = (await pending(projects[36]!, -1000))[0]!;
    assert.deepEqual(await claim(), []);
    assert.deepEqual((await childClaim()).map(row => row.id), [lastProjectJob]);
    await release();
    await db`UPDATE projects SET config_json = '{}' WHERE id = ${projects[0]!}`;
    const resumed = await claim();
    assert.equal(resumed.length, 1, "newly eligible project is revisited after durable cursor wrap");
    assert.equal((await db`SELECT project_id::text FROM jobs WHERE id = ${resumed[0]!.id}`)[0]!.project_id, projects[0]);

    // Separate processes concurrently enter the real advisory-locked claim.
    // Global cap=1 admits exactly one, and the next service goes to the other project.
    await clear();
    await rules(1);
    const a = (await pending(projects[0]!, 1000))[0]!;
    const b = (await pending(projects[1]!, -1000))[0]!;
    const concurrent = await Promise.all([childClaim(), claim()]);
    assert.deepEqual(concurrent.flat().map(row => row.id), [a]);
    await release();
    assert.deepEqual((await childClaim()).map(row => row.id), [b]);

    // Exactly one full page is skipped by a real Canvas lock. Its empty tail
    // must schedule a wrapped scan without a manual claim or a Job notification.
    await clear();
    await rules(1);
    await db`INSERT INTO canvases (id, project_id, title)
      VALUES (${wrapCanvasId}, ${projects[0]!}, 'Fairness wrapped wake')`;
    const lockedJobs = await pending(projects[0]!, 1000, 64);
    await db`UPDATE jobs SET canvas_id = ${wrapCanvasId} WHERE id = ANY(${lockedJobs}::uuid[])`;
    const [beforeWake] = await db`SELECT dispatch_service_sequence::text AS sequence FROM global_settings WHERE id = 'global'`;
    const { bindScheduleWake, unbindScheduleWake } = await import("./schedule-wake.js");
    const wakeResults: { id: string }[][] = [];
    let wakeRun = Promise.resolve();
    let wakeError: unknown;
    let allowWake!: () => void;
    // A slow CI database may fire the timer before the initial assertions finish.
    const unlocked = new Promise<void>(resolve => { allowWake = resolve; });
    const blocker = await db.reserve();
    let lockHeld = false;
    try {
      await blocker`BEGIN`;
      lockHeld = true;
      await blocker`SELECT id FROM canvases WHERE id = ${wrapCanvasId} FOR UPDATE`;
      bindScheduleWake(() => {
        wakeRun = wakeRun.then(async () => {
          await unlocked;
          wakeResults.push(await claim());
        }).catch(error => { wakeError = error; });
      });
      assert.deepEqual(await claim(), [], "the locked Canvas skips all 64 candidates");
      const [blocked] = await db`SELECT dispatch_scan_job_id, dispatch_last_served::text AS served
        FROM projects WHERE id = ${projects[0]!}`;
      assert.ok(blocked!.dispatch_scan_job_id, "the full skipped page persists its cursor");
      assert.equal(blocked!.served, "0", "a skipped page consumes no service turn");
      await blocker`ROLLBACK`;
      lockHeld = false;
      allowWake();
      // After unlock, only the real merged timer callback can claim. The test
      // reads state and waits, without writing Jobs, issuing NOTIFY or calling claim.
      const deadline = Date.now() + 5_000;
      while (!wakeResults.some(rows => rows.length > 0) && !wakeError && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ifError(wakeError);
      assert.ok(wakeResults.length >= 2, "empty-tail wake must be followed by a wrapped automatic scan");
      assert.deepEqual(wakeResults[0], [], "the first automatic visit only clears the exhausted cursor");
      const claimed = wakeResults.flat();
      assert.equal(claimed.length, 1, "automatic wrapped claim preserves the global/project/provision cap");
      assert.ok(lockedJobs.includes(claimed[0]!.id));
      const [persisted] = await db`SELECT count(*)::int AS count FROM jobs
        WHERE id = ANY(${lockedJobs}::uuid[]) AND status = 'claimed'`;
      assert.equal(persisted!.count, 1, "the automatic claim is durable");
      const [afterWake] = await db`SELECT dispatch_service_sequence::text AS sequence FROM global_settings WHERE id = 'global'`;
      assert.equal(BigInt(afterWake!.sequence) - BigInt(beforeWake!.sequence), 1n,
        "skipped pages and empty-tail wrap consume no service turns; only the real claim does");
    } finally {
      unbindScheduleWake();
      if (lockHeld) await blocker`ROLLBACK`;
      blocker.release();
      allowWake();
      await wakeRun;
    }
  } finally {
    await clear();
    await db`DELETE FROM canvases WHERE id = ${wrapCanvasId}`;
    await deleteProjectsLeavingAuditShells(db, projects);
  }
}
