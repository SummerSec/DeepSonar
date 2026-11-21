import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { sql } from "./db.js";
import { deleteProjectsLeavingAuditShells } from "./test-project-teardown.js";

/** Exercise the production claim transaction across independent task canvases. */
export async function runMultiCanvasDispatchFixture(
  db: typeof sql,
  claim: () => Promise<{ id: string }[]>,
  credentialId: string,
): Promise<void> {
  const projects = [randomUUID(), randomUUID()];
  const canvases = Array.from({ length: 4 }, () => randomUUID());
  const jobIds: string[] = [];
  const snapshot = { agent_cli: "claude-code", credential_provider: "anthropic", credential_id: credentialId, model: "multi-canvas" };
  const [settings] = await db`SELECT rules_json FROM global_settings WHERE id='global'`;
  const [credential] = await db`SELECT public_metadata_json FROM credentials WHERE id=${credentialId}`;
  const limits = async (overrides: Record<string, unknown> = {}) => {
    await db`UPDATE global_settings SET rules_json=${db.json({
      maxGlobalJobs: 8, maxJobsPerProject: 8, maxConcurrentProvisioning: 8,
      ...overrides,
    })} WHERE id='global'`;
  };
  const insert = async (canvasIndex: number, projectIndex = 0, status = "pending"): Promise<string> => {
    const id = randomUUID();
    jobIds.push(id);
    await db`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
      VALUES(${id},${projects[projectIndex]},${canvases[canvasIndex]},'audit',${status},${db.json(snapshot)})`;
    return id;
  };
  const clear = async () => {
    await db`DELETE FROM jobs WHERE id=ANY(${jobIds}::uuid[])`;
    jobIds.length = 0;
  };
  const competingClaims = async () => (await Promise.all([claim(), claim(), claim()])).flat().map(row => row.id);
  try {
    for (const id of projects) await db`INSERT INTO projects(id,name) VALUES(${id},'multi-canvas dispatch')`;
    for (const id of canvases) await db`INSERT INTO canvases(id,project_id,title) VALUES(${id},${projects[0]},'Independent task')`;

    await limits({ maxJobsPerProject: 2 });
    const independent = await Promise.all(canvases.map((_, index) => insert(index)));
    const claimed = await competingClaims();
    assert.equal(claimed.length, 2, "two same-project canvases can run before either task completes");
    assert.equal(new Set(claimed).size, 2, "concurrent dispatchers cannot claim a Job twice");
    assert.ok(claimed.every(id => independent.includes(id)));
    const owners = await db`SELECT j.canvas_id,count(a.id)::int AS attempts FROM jobs j
      JOIN job_attempts a ON a.job_id=j.id AND a.status='active'
      WHERE j.id=ANY(${claimed}::uuid[]) AND j.status='claimed' GROUP BY j.canvas_id`;
    assert.equal(owners.length, 2);
    assert.ok(owners.every(row => row.attempts === 1), "each claimed canvas has exactly one active owner");
    assert.deepEqual(await competingClaims(), [], "a later claim cannot exceed the project cap");
    const [pending] = await db`SELECT count(*)::int AS n FROM jobs
      WHERE id=ANY(${independent}::uuid[]) AND status='pending' AND claimed_at IS NULL`;
    assert.equal(pending.n, 2);
    await db`UPDATE jobs SET status='succeeded',finished_at=now() WHERE id=${claimed[0]}`;
    await db`UPDATE job_attempts SET status='succeeded',finished_at=now() WHERE job_id=${claimed[0]} AND status='active'`;
    const refill = await competingClaims();
    assert.equal(refill.length, 1, "freeing one project slot admits exactly one other canvas");
    assert.ok(!claimed.includes(refill[0]!));
    await clear();

    // Global, provisioning and provider/CLI/credential/model caps still apply
    // when pending work belongs to different canvases in the same project.
    for (const gate of ["global", "provisioning", "provider", "cli", "credential", "model"] as const) {
      await limits({
        ...(gate === "global" ? { maxGlobalJobs: 1 } : {}),
        ...(gate === "provisioning" ? { maxConcurrentProvisioning: 1 } : {}),
        ...(gate === "provider" ? { maxConcurrentByProvider: { anthropic: 1 } } : {}),
        ...(gate === "cli" ? { maxConcurrentByAgentCli: { "claude-code": 1 } } : {}),
      });
      await db`UPDATE credentials SET public_metadata_json=${db.json(gate === "credential"
        ? { max_concurrent: 1 } : gate === "model" ? { model_concurrency: { "multi-canvas": 1 } } : {})}
        WHERE id=${credentialId}`;
      const ids = await Promise.all([insert(0), insert(1)]);
      const accepted = await competingClaims();
      assert.equal(accepted.length, 1, `${gate} cap applies across canvases and competing dispatchers`);
      assert.ok(ids.includes(accepted[0]!));
      const [waiting] = await db`SELECT count(*)::int AS n FROM jobs
        WHERE id=ANY(${ids}::uuid[]) AND status='pending' AND claimed_at IS NULL`;
      assert.equal(waiting.n, 1);
      await clear();
    }
    await db`UPDATE credentials SET public_metadata_json='{}'::jsonb WHERE id=${credentialId}`;

    await limits({ maxGlobalJobs: 2 });
    await db`UPDATE canvases SET project_id=${projects[1]} WHERE id IN (${canvases[2]},${canvases[3]})`;
    await Promise.all([insert(0), insert(1), insert(2, 1), insert(3, 1)]);
    assert.equal((await competingClaims()).length, 2, "the global cap is shared by all projects and canvases");
    assert.deepEqual(await competingClaims(), []);
    await clear();

    await limits({ maxJobsPerProject: 1 });
    const historical = await Promise.all([insert(0, 0, "waiting_human"), insert(0, 0, "failed"), insert(0, 0, "cancelled")]);
    const runnable = await insert(1);
    assert.deepEqual(await competingClaims(), [runnable], "waiting, failed and cancelled task history does not reserve a project seat");
    const history = await db`SELECT status FROM jobs WHERE id=ANY(${historical}::uuid[])`;
    assert.deepEqual(history.map(row => row.status).sort(), ["cancelled", "failed", "waiting_human"]);
    await clear();

    await limits();
    await db`UPDATE canvases SET target_json=${db.json({ execution_control: { paused: true } })} WHERE id=${canvases[0]}`;
    await db`UPDATE canvases SET target_json=${db.json({ schedule: { start_at: new Date(Date.now() + 3_600_000).toISOString() } })} WHERE id=${canvases[1]}`;
    await db`UPDATE canvases SET project_id=${projects[0]} WHERE id=${canvases[2]}`;
    const paused = await insert(0), scheduled = await insert(1), immediate = await insert(2);
    assert.deepEqual(await competingClaims(), [immediate], "task pause and future start only block their own canvas");
    const blocked = await db`SELECT status,claimed_at FROM jobs WHERE id IN (${paused},${scheduled})`;
    assert.ok(blocked.every(row => row.status === "pending" && row.claimed_at === null));
    await clear();

    await db`UPDATE canvases SET target_json='{}'::jsonb,status='archived',archived_at=now() WHERE id=${canvases[0]}`;
    const archived = await insert(0), active = await insert(2);
    assert.deepEqual(await competingClaims(), [active], "archived canvas cannot execute a pending or resumed Job");
    const [unclaimed] = await db`SELECT status,claimed_at FROM jobs WHERE id=${archived}`;
    assert.equal(unclaimed.status, "pending");
    assert.equal(unclaimed.claimed_at, null);
    assert.equal((await db`SELECT count(*)::int AS n FROM job_attempts WHERE job_id=${archived}`)[0].n, 0);
  } finally {
    await clear();
    await db`UPDATE global_settings SET rules_json=${db.json(settings.rules_json)} WHERE id='global'`;
    await db`UPDATE credentials SET public_metadata_json=${db.json(credential.public_metadata_json)} WHERE id=${credentialId}`;
    await db`DELETE FROM canvases WHERE id=ANY(${canvases})`;
    await deleteProjectsLeavingAuditShells(db, projects);
  }
}
