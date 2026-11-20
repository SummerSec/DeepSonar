import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { deleteProjectsLeavingAuditShells } from "./test-project-teardown.js";

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
    let databaseClosed = false;
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
          ${id}, ${projectId}, ${canvasIds[projectIds.indexOf(projectId)]}, 'audit',
          ${options.status ?? "pending"}, ${options.priority ?? 0}, ${sql.json(snapshot as never)},
          ${options.createdAt ?? new Date()}
        )`;
      jobIds.push(id);
      return id;
    };

    const insertPendingBatch = async (
      projectId: ProjectId,
      count: number,
      firstCreatedAt: Date,
      options: { samePreciseCreatedAt?: boolean } = {},
    ): Promise<string[]> => {
      const ids = Array.from({ length: count }, () => randomUUID());
      const rows = ids.map((id, index) => {
        jobIds.push(id);
        const createdAt = options.samePreciseCreatedAt
          ? sql`statement_timestamp() - interval '120 seconds'`
          : sql`${new Date(firstCreatedAt.getTime() + index)}`;
        return sql`(
          ${id}, ${projectId}, ${canvasIds[projectIds.indexOf(projectId)]}, 'audit', 'pending', 0,
          ${sql.json(snapshot as never)}, ${createdAt}
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

    const claimWithTimeout = async (timeoutMs: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const claim = claimPendingJobs();
      try {
        return await Promise.race([
          claim,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error(`claimPendingJobs exceeded ${timeoutMs}ms`));
            }, timeoutMs);
          }),
        ]);
      } catch (error) {
        if (timedOut) {
          // The pre-fix cursor loop never resolves; close the explicit test
          // pool so the timed-out transaction cannot keep the test process
          // alive or block cleanup. The rejection is observed to avoid an
          // unhandled promise after the connection closes.
          claim.catch(() => undefined);
          databaseClosed = true;
          await sql.end({ timeout: 1 }).catch(() => undefined);
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      for (let index = 0; index < projectIds.length; index += 1) {
        await sql`
          INSERT INTO projects (id, name)
          VALUES (${projectIds[index]}, ${`dispatch-limits-${index}-${randomUUID()}`})`;
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

      // Management HTTP writes and the normal SQL dispatcher share the null
      // contract. Synthetic Jobs only replace sandbox work, never claim.
      const app = (await import("fastify")).default();
      const { registerSettingsRoutes } = await import("./domains/settings/routes.js");
      registerSettingsRoutes(app);
      const { registerSystemRoutes } = await import("./domains/system/routes.js");
      registerSystemRoutes(app, {
        officialImageWarnings: () => [],
        openSandboxStatus: () => ({ level: "skipped", domain: "", checkedAt: null, error: null }),
      });
      try {
        const patch = async (url: string, rules: Record<string, unknown>) => {
          const response = await app.inject({ method: "PATCH", url, payload: { rules } });
          assert.equal(response.statusCode, 200, response.body);
          return response.json();
        };
        const unlimited = { maxGlobalJobs: null, maxJobsPerProject: null, maxConcurrentProvisioning: null };
        const saved = await patch("/global-settings", unlimited);
        for (const key of Object.keys(unlimited)) {
          assert.equal(saved.rules[key], null);
          assert.equal(saved.effective_rules[key], null);
        }
        const health = await app.inject({ method: "GET", url: "/health" });
        assert.equal(health.statusCode, 200, health.body);
        assert.deepEqual(health.json().concurrency_limits, unlimited);
        for (const key of Object.keys(unlimited)) {
          const rejected = await app.inject({ method: "PATCH", url: "/global-settings", payload: { rules: { [key]: 0 } } });
          assert.equal(rejected.statusCode, 400, rejected.body);
        }
        const read = await app.inject({ method: "GET", url: "/global-settings" });
        for (const key of Object.keys(unlimited)) assert.equal(read.json().rules[key], null);
        await patch(`/projects/${projectIds[0]}/settings`, { maxConcurrentJobs: 3 });
        const ids = await Promise.all(Array.from({ length: 4 }, () => insertJob(projectIds[0])));
        const limited = await claimPendingJobs();
        assert.equal(limited.filter(job => ids.includes(job.id)).length, 3);
        await sql`DELETE FROM jobs WHERE id = ANY(${ids}::uuid[])`;
        const paused = await patch(`/projects/${projectIds[0]}/settings`, { maxConcurrentJobs: 0 });
        assert.equal(paused.effective_rules.maxConcurrentJobs, 0);
        const resumeIds = await Promise.all(Array.from({ length: 6 }, () => insertJob(projectIds[0])));
        assert.equal((await claimPendingJobs()).length, 0);
        const inherited = await patch(`/projects/${projectIds[0]}/settings`, { maxConcurrentJobs: null });
        assert.equal(inherited.effective_rules.maxConcurrentJobs, null);
        assert.equal((await claimPendingJobs()).filter(job => resumeIds.includes(job.id)).length, 6,
          "null removes both former per-project and provisioning defaults");
        await sql`DELETE FROM jobs WHERE id = ANY(${resumeIds}::uuid[])`;
        await patch("/global-settings", { ...unlimited, maxConcurrentProvisioning: 1 });
        const provisionIds = await Promise.all(Array.from({ length: 2 }, () => insertJob(projectIds[0])));
        assert.equal((await claimPendingJobs()).filter(job => provisionIds.includes(job.id)).length, 1);
        await patch("/global-settings", unlimited);
        assert.equal((await claimPendingJobs()).filter(job => provisionIds.includes(job.id)).length, 1);
        await sql`DELETE FROM jobs WHERE id = ANY(${provisionIds}::uuid[])`;
        await patch("/global-settings", { ...unlimited, maxConcurrentByAgentCli: { "claude-code": 1 } });
        const cliIds = await Promise.all(Array.from({ length: 2 }, () => insertJob(projectIds[0])));
        assert.equal((await claimPendingJobs()).filter(job => cliIds.includes(job.id)).length, 1,
          "global unlimited still enforces CLI admission");
        await sql`DELETE FROM jobs WHERE id = ANY(${cliIds}::uuid[])`;
      } finally { await app.close(); }

      // Effective global=4: four pending jobs must be claimed by the real SQL
      // transaction, rather than merely accepted by the pure quota helpers.
      await setRules({
        maxGlobalJobs: 4,
        maxJobsPerProject: 4,
        maxConcurrentProvisioning: 4,
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
        maxConcurrentProvisioning: 4,
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
        maxGlobalJobs: 3,
        maxJobsPerProject: 1,
        maxConcurrentProvisioning: 3,
        maxConcurrentByAgentCli: { "claude-code": 4 },
      });
      await insertJob(projectIds[0], { status: "claimed" });
      const headIds = await insertPendingBatch(
        projectIds[0],
        501,
        new Date(Date.now() - 120_000),
        { samePreciseCreatedAt: true },
      );
      const tailId = await insertJob(projectIds[1], { createdAt: new Date(Date.now() + 120_000) });
      const pagedClaim = await claimPendingJobs();
      assert.equal(pagedClaim.length, 1);
      assert.equal(pagedClaim[0]?.id, tailId);
      const [headStatus] = await sql`
        SELECT COUNT(*)::int AS count FROM jobs
        WHERE id = ANY(${headIds}::uuid[]) AND status = 'claimed'`;
      assert.equal(Number(headStatus.count), 0);

      // The head project remains at its cap while one global slot is free.
      // This forces a second keyset scan over an entirely ineligible tail and
      // guards the timestamp+id cursor, including equal created_at values.
      const noEligibleClaim = await claimWithTimeout(2_000);
      assert.deepEqual(noEligibleClaim, []);

      // Provisioning admission 独立于活跃总量上限，同时统计 claimed 和
      // provisioning 行。槽位已满时 pending Job 保持不变，避免等待期间
      // 消耗 claimed_at 租约。
      await sql`DELETE FROM jobs WHERE id = ANY(${[...jobIds]}::uuid[])`;
      jobIds.length = 0;
      await setRules({
        maxGlobalJobs: 8,
        maxJobsPerProject: 8,
        maxConcurrentProvisioning: 2,
        maxConcurrentByAgentCli: { "claude-code": 8 },
      });
      await insertJob(projectIds[0], { status: "claimed" });
      await insertJob(projectIds[0], { status: "provisioning" });
      const blockedPendingId = await insertJob(projectIds[0]);
      const blockedClaim = await claimPendingJobs();
      assert.deepEqual(blockedClaim, []);
      const [blockedStatus] = await sql`
        SELECT status, claimed_at FROM jobs WHERE id = ${blockedPendingId}`;
      assert.equal(blockedStatus.status, "pending");
      assert.equal(blockedStatus.claimed_at, null);

      await sql`DELETE FROM jobs WHERE id = ANY(${[...jobIds]}::uuid[])`;
      jobIds.length = 0;
      await setRules({
        maxGlobalJobs: 8,
        maxJobsPerProject: 4,
        maxConcurrentProvisioning: 8,
        maxConcurrentByAgentCli: { "claude-code": 8 },
      });
      await sql`
        UPDATE projects
        SET config_json = ${sql.json({ rules: { maxConcurrentJobs: 1 } } as never)}
        WHERE id = ${projectIds[0]}`;
      const tightIds = await Promise.all(Array.from({ length: 3 }, () => insertJob(projectIds[0])));
      const inheritedIds = await Promise.all(Array.from({ length: 2 }, () => insertJob(projectIds[1])));
      const isolatedClaim = await claimPendingJobs();
      assert.equal(isolatedClaim.filter((job) => tightIds.includes(job.id)).length, 1);
      assert.equal(isolatedClaim.filter((job) => inheritedIds.includes(job.id)).length, 2);

      const { rulesForProject } = await import("./core.js");
      const tightRules = await rulesForProject(sql, projectIds[0]);
      const inheritedRules = await rulesForProject(sql, projectIds[1]);
      assert.equal(tightRules.maxJobsPerProject, 4);
      assert.equal(tightRules.maxConcurrentJobs, 1);
      assert.equal(tightRules.maxConcurrentJobsSource, "project");
      assert.equal(inheritedRules.maxConcurrentJobs, 4);
      assert.equal(inheritedRules.maxConcurrentJobsSource, "global");

      await sql`
        UPDATE projects
        SET config_json = ${sql.json({ rules: { maxConcurrentJobs: 0 } } as never)}
        WHERE id = ${projectIds[0]}`;
      const pausedId = await insertJob(projectIds[0]);
      const pausedClaim = await claimPendingJobs();
      assert.equal(pausedClaim.some((job) => job.id === pausedId), false);
      const [pausedStatus] = await sql`SELECT status FROM jobs WHERE id = ${pausedId}`;
      assert.equal(pausedStatus.status, "pending");
      const [stillRunning] = await sql`
        SELECT COUNT(*)::int AS count FROM jobs
        WHERE id = ANY(${tightIds}::uuid[]) AND status = 'claimed'`;
      assert.equal(Number(stillRunning.count), 1);

      await sql`UPDATE projects SET config_json = '{}'::jsonb WHERE id = ${projectIds[0]}`;
      const clearedClaim = await claimPendingJobs();
      assert.equal(clearedClaim.some((job) => job.id === pausedId), true);

      await sql`DELETE FROM jobs WHERE id = ANY(${jobIds}::uuid[])`;
      jobIds.length = 0;
      const { bindScheduleWake, unbindScheduleWake } = await import("./schedule-wake.js");
      // Old pending time is not execution time. Each quota gate retries without cancelling.
      for (const gate of ["provider", "credential", "model"] as const) {
        await setRules({ maxGlobalJobs: 8, maxJobsPerProject: 8, maxConcurrentProvisioning: 8,
          maxConcurrentByAgentCli: { "claude-code": 8 },
          maxConcurrentByProvider: gate === "provider" ? { anthropic: 0 } : {} });
        await sql`UPDATE credentials SET public_metadata_json=${sql.json(gate === "credential"
          ? { max_concurrent: 0 } : gate === "model"
            ? { model_concurrency: { "dispatch-limits-test-model": 0 } } : {})} WHERE id=${credentialId}`;
        const pendingId = await insertJob(projectIds[0], { createdAt: new Date("2020-01-01T00:00:00Z") });
        const decision = { schema: "deepsonar.credential-selection/v1", reason: "capacity_wait",
          error_code: "provider_credential_all_at_capacity", selected_credential_id: credentialId };
        await sql`UPDATE jobs SET timeout_sec=1,
          agent_snapshot_json=agent_snapshot_json || ${sql.json({ credential_selection: decision })} WHERE id=${pendingId}`;
        const retries: Promise<unknown>[] = [];
        let awakened = false;
        let retryError: unknown;
        bindScheduleWake(() => {
          retries.push(claimPendingJobs().then(rows => {
            awakened ||= rows.some(row => row.id === pendingId);
          }).catch(error => { retryError = error; }));
        });
        try {
          assert.deepEqual(await claimPendingJobs(), [], `${gate} capacity blocks claim`);
          const [waiting] = await sql`SELECT status,started_at,claimed_at,agent_snapshot_json FROM jobs WHERE id=${pendingId}`;
          assert.equal(waiting.status, "pending");
          assert.equal(waiting.started_at, null);
          assert.equal(waiting.claimed_at, null);
          assert.deepEqual(waiting.agent_snapshot_json.credential_selection, decision);
          // No jobs UPDATE/NOTIFY: only the quota changes. The observed wait must re-read it.
          await setRules({ maxGlobalJobs: 8, maxJobsPerProject: 8, maxConcurrentProvisioning: 8 });
          await sql`UPDATE credentials SET public_metadata_json='{}'::jsonb WHERE id=${credentialId}`;
          const deadline = Date.now() + 8_000;
          while (!awakened && !retryError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
          assert.ifError(retryError);
          assert.ok(awakened, `${gate} release wakes the old pending Job without a jobs notification`);
          const [claimed] = await sql`SELECT status,agent_snapshot_json FROM jobs WHERE id=${pendingId}`;
          assert.equal(claimed.status, "claimed");
          assert.deepEqual(claimed.agent_snapshot_json.credential_selection, decision, "claim preserves the historical observation");
        } finally {
          unbindScheduleWake();
          await Promise.all(retries);
          await sql`DELETE FROM jobs WHERE id=${pendingId}`;
        }
      }
      // Two independent claim calls serialize on the existing advisory lock.
      await setRules({ maxGlobalJobs: 8, maxJobsPerProject: 8, maxConcurrentProvisioning: 8,
        maxConcurrentByProvider: { anthropic: 1 } });
      const competingIds = await Promise.all([insertJob(projectIds[0]), insertJob(projectIds[1])]);
      const competingClaims = await Promise.all([claimPendingJobs(), claimPendingJobs()]);
      assert.equal(competingClaims.flat().length, 1, "Provider capacity cannot be oversubscribed by concurrent claimers");
      await sql`DELETE FROM jobs WHERE id=ANY(${competingIds}::uuid[])`;
      await setRules({ maxGlobalJobs: 8, maxJobsPerProject: 8, maxConcurrentProvisioning: 8 });
      for (const lockTarget of ["canvas", "job"] as const) {
        const lockedId = await insertJob(projectIds[0]);
        const unrelatedId = await insertJob(projectIds[1]);
        let release!: () => void;
        let locked!: () => void;
        const holding = new Promise<void>(resolve => { release = resolve; });
        const ready = new Promise<void>(resolve => { locked = resolve; });
        // Independent transaction: releasing a read-only row lock emits no jobs NOTIFY.
        const locker = sql.begin(async tx => {
          if (lockTarget === "canvas") await tx`SELECT id FROM canvases WHERE id=${canvasIds[0]} FOR UPDATE`;
          else await tx`SELECT id FROM jobs WHERE id=${lockedId} FOR UPDATE`;
          locked();
          await holding;
        });
        const retries: Promise<unknown>[] = [];
        const automaticallyClaimed = new Set<string>();
        let retryError: unknown;
        bindScheduleWake(() => {
          retries.push(claimPendingJobs().then(rows => {
            for (const row of rows) automaticallyClaimed.add(row.id);
          }).catch(error => { retryError = error; }));
        });
        try {
          await ready;
          const first = await claimPendingJobs();
          assert.deepEqual(first.map(row => row.id), [unrelatedId], `${lockTarget} lock must not block another canvas`);
          release();
          await locker;
          const deadline = Date.now() + 3_000;
          while (!automaticallyClaimed.has(lockedId) && !retryError && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.ifError(retryError);
          assert.ok(automaticallyClaimed.has(lockedId), `${lockTarget} lock released without NOTIFY: skipped pending Job must wake automatically`);
          const [claimed] = await sql`SELECT status FROM jobs WHERE id=${lockedId}`;
          assert.equal(claimed.status, "claimed");
        } finally {
          release();
          await locker;
          unbindScheduleWake();
          await Promise.all(retries);
          await sql`DELETE FROM jobs WHERE id = ANY(${[lockedId, unrelatedId]}::uuid[])`;
        }
      }
      await sql`DELETE FROM jobs WHERE id = ANY(${jobIds}::uuid[])`;
      const { runDispatchFairnessFixture } = await import("./dispatch-fairness.fixture.js");
      await runDispatchFairnessFixture(sql, claimPendingJobs, credentialId);

      await setRules({ maxGlobalJobs: null, maxJobsPerProject: null, maxConcurrentProvisioning: null });
      const recoveryPending = await Promise.all(Array.from({ length: 6 }, () => insertJob(projectIds[0])));
      const { runUnlimitedCreateCircuitFixture } = await import("./dispatch-create-circuit.fixture.js");
      await runUnlimitedCreateCircuitFixture(sql, claimPendingJobs, recoveryPending);
    } finally {
      if (!databaseClosed) {
        await sql`UPDATE global_settings SET rules_json = ${sql.json(originalRules as never)}, updated_at = now() WHERE id = 'global'`;
        if (jobIds.length > 0) {
          await sql`DELETE FROM jobs WHERE id = ANY(${jobIds}::uuid[])`;
        }
        await sql`DELETE FROM credentials WHERE id = ${credentialId}`;
        await sql`DELETE FROM canvases WHERE id = ANY(${canvasIds})`;
        await deleteProjectsLeavingAuditShells(sql, projectIds);
        await sql.end({ timeout: 5 });
      }
    }
  });
}
