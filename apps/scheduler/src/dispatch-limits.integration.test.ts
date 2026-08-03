import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("dispatcher claim integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("dispatcher claim enforces global/project caps and scans past an ineligible page", async () => {
    // This file intentionally has no static scheduler imports. The explicit
    // test URL must be installed before config.ts/db.ts are evaluated so a
    // local .env can never redirect the integration run to a default DB.
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("./db.js");
    const { claimPendingJobs } = await import("./dispatcher.js");
    await migrate();

    const projectIds = [randomUUID(), randomUUID()];
    const canvasIds = [`dispatch-limits-${randomUUID()}`, `dispatch-limits-${randomUUID()}`];
    type ProjectId = (typeof projectIds)[number];
    const credentialId = randomUUID();
    const jobIds: string[] = [];
    const rulesBefore = await sql`SELECT rules_json FROM global_settings WHERE id = 'global'`;
    const originalRules = rulesBefore[0]?.rules_json ?? {};

    const snapshot = {
      agent_cli: "claude-code",
      credential_provider: "anthropic",
      credential_id: credentialId,
      model: "dispatch-limits-test-model",
    };

    const insertJob = async (projectId: ProjectId, options: {
      status?: string;
      createdAt?: Date;
      priority?: number;
    } = {}): Promise<string> => {
      const id = randomUUID();
      await sql`
        INSERT INTO jobs (
          id, project_id, canvas_id, type, status, priority, agent_snapshot_json, created_at
        ) VALUES (
          ${id}, ${projectId}, ${canvasIds[projectIds.indexOf(projectId)]}, 'audit_module',
          ${options.status ?? "pending"}, ${options.priority ?? 0}, ${sql.json(snapshot as never)},
          ${options.createdAt ?? new Date()}
        )`;
      jobIds.push(id);
      return id;
    };

    const insertPendingBatch = async (projectId: ProjectId, count: number, firstCreatedAt: Date): Promise<string[]> => {
      const ids = Array.from({ length: count }, () => randomUUID());
      const rows = ids.map((id, index) => {
        jobIds.push(id);
        return sql`(
          ${id}, ${projectId}, ${canvasIds[projectIds.indexOf(projectId)]}, 'audit_module', 'pending', 0,
          ${sql.json(snapshot as never)}, ${new Date(firstCreatedAt.getTime() + index)}
        )`;
      });
      for (let offset = 0; offset < rows.length; offset += 100) {
        const batch = rows.slice(offset, offset + 100);
        let values = batch[0];
        for (const row of batch.slice(1)) values = sql`${values},${row}`;
        await sql`
          INSERT INTO jobs (
            id, project_id, canvas_id, type, status, priority, agent_snapshot_json, created_at
          ) VALUES ${values}`;
      }
      return ids;
    };

    const setRules = async (rules: Record<string, unknown>) => {
      await sql`
        UPDATE global_settings
        SET rules_json = ${sql.json(rules as never)}, updated_at = now()
        WHERE id = 'global'`;
    };

    try {
      for (let index = 0; index < projectIds.length; index += 1) {
        await sql`
          INSERT INTO projects (id, canvas_id, name)
          VALUES (${projectIds[index]}, ${canvasIds[index]}, ${`dispatch-limits-${index}-${randomUUID()}`})`;
        await sql`
          INSERT INTO canvases (id, project_id, title)
          VALUES (${canvasIds[index]}, ${projectIds[index]}, ${`Dispatch limits ${index}`})`;
      }
      await sql`
        INSERT INTO credentials (
          id, name, kind, provider, ciphertext, nonce, auth_tag,
          public_metadata_json, fingerprint, last4
        ) VALUES (
          ${credentialId}, 'dispatch-limits-test', 'llm_provider', 'anthropic',
          'ciphertext', 'nonce', 'auth-tag', ${sql.json({ max_concurrent: 100 } as never)},
          ${`dispatch-limits-${credentialId}`}, 'test'
        )`;

      // Effective global=4: four pending jobs must be claimed by the real SQL
      // transaction, rather than merely accepted by the pure quota helpers.
      await setRules({
        maxGlobalJobs: 4,
        maxJobsPerProject: 4,
        maxConcurrentByAgentCli: { "claude-code": 4 },
      });
      const firstIds = await Promise.all(Array.from({ length: 4 }, () => insertJob(projectIds[0])));
      const firstClaim = await claimPendingJobs();
      assert.deepEqual(new Set(firstClaim.map((job) => job.id)), new Set(firstIds));
      assert.equal(firstClaim.length, 4);
      const [firstStatus] = await sql`
        SELECT COUNT(*)::int AS count FROM jobs
        WHERE id = ANY(${firstIds}::uuid[]) AND status = 'claimed'`;
      assert.equal(Number(firstStatus.count), 4);

      // Project cap=2: with no active jobs left from the previous scenario,
      // only two of three same-project pending jobs may be claimed.
      await sql`DELETE FROM jobs WHERE id = ANY(${firstIds}::uuid[])`;
      await setRules({
        maxGlobalJobs: 4,
        maxJobsPerProject: 2,
        maxConcurrentByAgentCli: { "claude-code": 4 },
      });
      const secondIds = await Promise.all(Array.from({ length: 3 }, () => insertJob(projectIds[0])));
      const secondClaim = await claimPendingJobs();
      assert.equal(secondClaim.length, 2);
      const [secondStatus] = await sql`
        SELECT COUNT(*)::int AS count FROM jobs
        WHERE id = ANY(${secondIds}::uuid[]) AND status = 'claimed'`;
      assert.equal(Number(secondStatus.count), 2);

      // Remove the first scenarios before creating the paging fixture so
      // their claimed/pending rows cannot consume the global or project caps.
      await sql`DELETE FROM jobs WHERE id = ANY(${secondIds}::uuid[])`;

      // One active head-project job makes 501 pending head rows ineligible
      // under project cap=1. The tail project is eligible and must still be
      // claimed after the dispatcher advances past the first LIMIT 500 page.
      await setRules({
        maxGlobalJobs: 2,
        maxJobsPerProject: 1,
        maxConcurrentByAgentCli: { "claude-code": 4 },
      });
      await insertJob(projectIds[0], { status: "claimed" });
      const headIds = await insertPendingBatch(
        projectIds[0],
        501,
        new Date(Date.now() - 120_000),
      );
      const tailId = await insertJob(projectIds[1], { createdAt: new Date(Date.now() + 120_000) });
      const pagedClaim = await claimPendingJobs();
      assert.equal(pagedClaim.length, 1);
      assert.equal(pagedClaim[0]?.id, tailId);
      const [headStatus] = await sql`
        SELECT COUNT(*)::int AS count FROM jobs
        WHERE id = ANY(${headIds}::uuid[]) AND status = 'claimed'`;
      assert.equal(Number(headStatus.count), 0);
    } finally {
      await sql`UPDATE global_settings SET rules_json = ${sql.json(originalRules as never)}, updated_at = now() WHERE id = 'global'`;
      if (jobIds.length > 0) {
        await sql`DELETE FROM jobs WHERE id = ANY(${jobIds}::uuid[])`;
      }
      await sql`DELETE FROM credentials WHERE id = ${credentialId}`;
      await sql`DELETE FROM canvases WHERE id = ANY(${canvasIds})`;
      await sql`DELETE FROM projects WHERE id = ANY(${projectIds}::uuid[])`;
      await sql.end({ timeout: 5 });
    }
  });
}
