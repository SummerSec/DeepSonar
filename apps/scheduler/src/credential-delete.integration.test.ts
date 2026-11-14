import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("credential delete integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("DELETE /credentials/:id revokes tokens and refuses live jobs", async (t) => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_credential_delete_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";

    let databaseCreated = false;
    let closeApp: (() => Promise<unknown>) | null = null;
    let endSql: (() => Promise<unknown>) | null = null;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";
      process.env.DEEPSONAR_ALLOWED_IMAGE_REGISTRIES = "127.0.0.1:5000";
      // Cover the accepted DEEPSONAR_DB_POOL_MAX=1 config: impact queries must
      // reuse the DELETE transaction connection or this test deadlocks.
      process.env.DEEPSONAR_DB_POOL_MAX = "1";

      const [fastifyModule, websocketModule, dbModule, routesModule, credentialsModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
        import("./credentials.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { migrate, sql } = dbModule;
      const { registerRoutes } = routesModule;
      const { encryptSecret } = credentialsModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();

      const app = Fastify({ logger: false });
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      type InjectResponse = { statusCode: number; payload: string };
      const request = async (method: "GET" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>): Promise<InjectResponse> =>
        await (app.inject({ method, url, payload }) as unknown as Promise<InjectResponse>);
      const json = (response: InjectResponse) => JSON.parse(response.payload) as Record<string, unknown>;

      const insertCredential = async (
        name: string,
        opts: { projectId?: string; kind?: "llm_provider" | "oci_registry"; provider?: string } = {},
      ) => {
        const id = randomUUID();
        const encrypted = encryptSecret(`${name}-secret`);
        const kind = opts.kind ?? "llm_provider";
        const provider = opts.provider ?? (kind === "oci_registry" ? "ghcr.io" : "openai");
        await sql`
          INSERT INTO credentials (id, name, kind, provider, project_id, ciphertext, nonce, auth_tag, fingerprint, last4)
          VALUES (${id}, ${name}, ${kind}, ${provider}, ${opts.projectId ?? null}, ${encrypted.ciphertext},
            ${encrypted.nonce}, ${encrypted.auth_tag}, 'delete-fingerprint', 'cret')`;
        return id;
      };

      const unusedId = await insertCredential("unused-account");
      const unusedDelete = await request("DELETE", `/credentials/${unusedId}`);
      assert.equal(unusedDelete.statusCode, 200, unusedDelete.payload);
      assert.deepEqual(json(unusedDelete), {
        ok: true,
        id: unusedId,
        unbound_role_config_count: 0,
        revoked_job_token_count: 0,
      });
      const [gone] = await sql`SELECT id FROM credentials WHERE id = ${unusedId}`;
      assert.equal(gone, undefined);

      const projectId = randomUUID();
      const canvasId = `credential-delete-${randomUUID()}`;
      const roleId = randomUUID();
      const roleConfigId = randomUUID();
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'credential delete')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, 'credential delete', ${sql.json({})})`;
      await sql`
        INSERT INTO agent_roles (id, name, title, description, builtin, kind, ui_color)
        VALUES (${roleId}, 'delete_test', 'Delete Test', 'integration fixture', false, 'role', '#c084fc')`;
      await sql`
        INSERT INTO role_configs (id, role_id, project_id, agent_cli, model)
        VALUES (${roleConfigId}, ${roleId}, NULL, 'claude-code', 'model-a')`;

      const projectCredId = await insertCredential("project-account", { projectId });
      const projectDelete = await request("DELETE", `/credentials/${projectCredId}`);
      assert.equal(projectDelete.statusCode, 200, projectDelete.payload);
      const [projectAudit] = await sql<{ project_id: string | null }[]>`
        SELECT project_id FROM audit_logs
        WHERE action = 'credential.delete' AND resource_id = ${projectCredId}`;
      assert.equal(projectAudit?.project_id, projectId);

      // #690: RoleConfig credential bindings removed — idle credential deletes without unbind.
      const unboundIdleId = await insertCredential("unbound-idle-account");
      const unboundIdleDelete = await request("DELETE", `/credentials/${unboundIdleId}`);
      assert.equal(unboundIdleDelete.statusCode, 200, unboundIdleDelete.payload);

      const liveId = await insertCredential("live-account");
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES (${randomUUID()}, ${projectId}, ${canvasId}, 'delete_test', 'running',
          ${sql.json({ name: "delete_test", model: "model-a", credential_id: liveId })})`;
      const liveRefuse = await request("DELETE", `/credentials/${liveId}`);
      assert.equal(liveRefuse.statusCode, 409, liveRefuse.payload);
      assert.equal(json(liveRefuse).error_code, "CREDENTIAL_IN_USE");
      const [stillLive] = await sql`SELECT id FROM credentials WHERE id = ${liveId}`;
      assert.equal(String(stillLive?.id), liveId);

      const pendingId = await insertCredential("pending-account");
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES (${randomUUID()}, ${projectId}, ${canvasId}, 'delete_test', 'pending',
          ${sql.json({ name: "delete_test", model: "model-a", credential_id: pendingId })})`;
      const pendingRefuse = await request("DELETE", `/credentials/${pendingId}`);
      assert.equal(pendingRefuse.statusCode, 409, pendingRefuse.payload);
      assert.equal(json(pendingRefuse).error_code, "CREDENTIAL_IN_USE");
      const [stillPending] = await sql`SELECT id FROM credentials WHERE id = ${pendingId}`;
      assert.equal(String(stillPending?.id), pendingId);

      for (const status of ["failed", "timeout", "orphan"] as const) {
        const recoverableId = await insertCredential(`recoverable-${status}`);
        const recoverableJobId = randomUUID();
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
          VALUES (${recoverableJobId}, ${projectId}, ${canvasId}, 'delete_test', ${status},
            ${sql.json({ name: "delete_test", model: "model-a", credential_id: recoverableId })})`;
        const impactBefore = json(await request("GET", `/credentials/${recoverableId}/impact`)) as {
          jobs: { pending_unclaimed: { count: number }; active_frozen: { count: number }; recoverable: { count: number } };
        };
        assert.equal(impactBefore.jobs.pending_unclaimed.count, 0, status);
        assert.equal(impactBefore.jobs.active_frozen.count, 0, status);
        assert.equal(impactBefore.jobs.recoverable.count, 1, status);
        const recoverableOk = await request("DELETE", `/credentials/${recoverableId}`);
        assert.equal(recoverableOk.statusCode, 200, recoverableOk.payload);
        const [goneRecoverable] = await sql`SELECT id FROM credentials WHERE id = ${recoverableId}`;
        assert.equal(goneRecoverable, undefined);
        const [jobStill] = await sql<{ status: string; agent_snapshot_json: { credential_id: string } }[]>`
          SELECT status, agent_snapshot_json FROM jobs WHERE id = ${recoverableJobId}`;
        assert.equal(jobStill?.status, status);
        assert.equal(jobStill?.agent_snapshot_json.credential_id, recoverableId);
      }

      const manyRecoverableId = await insertCredential("many-recoverable");
      const manyStatuses = ["failed", "timeout", "orphan", "failed", "timeout", "orphan", "failed"] as const;
      assert.equal(manyStatuses.length, 7);
      for (const status of manyStatuses) {
        await sql`
          INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
          VALUES (${randomUUID()}, ${projectId}, ${canvasId}, 'delete_test', ${status},
            ${sql.json({ name: "delete_test", model: "model-a", credential_id: manyRecoverableId })})`;
      }
      const manyImpact = json(await request("GET", `/credentials/${manyRecoverableId}/impact`)) as {
        jobs: { pending_unclaimed: { count: number }; active_frozen: { count: number }; recoverable: { count: number } };
      };
      assert.equal(manyImpact.jobs.pending_unclaimed.count, 0);
      assert.equal(manyImpact.jobs.active_frozen.count, 0);
      assert.equal(manyImpact.jobs.recoverable.count, 7);
      const manyOk = await request("DELETE", `/credentials/${manyRecoverableId}`);
      assert.equal(manyOk.statusCode, 200, manyOk.payload);
      const [goneMany] = await sql`SELECT id FROM credentials WHERE id = ${manyRecoverableId}`;
      assert.equal(goneMany, undefined);

      const raceId = await insertCredential("race-account");
      const raceJobId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES (${raceJobId}, ${projectId}, ${canvasId}, 'delete_test', 'failed',
          ${sql.json({ name: "delete_test", model: "model-a", credential_id: raceId })})`;
      const [raceDelete, raceResume] = await Promise.all([
        request("DELETE", `/credentials/${raceId}`),
        request("POST", `/jobs/${raceJobId}/resume`),
      ]);
      const [raceStill] = await sql`SELECT id FROM credentials WHERE id = ${raceId}`;
      const [raceJob] = await sql<{ status: string; agent_snapshot_json: { credential_id: string } }[]>`
        SELECT status, agent_snapshot_json FROM jobs WHERE id = ${raceJobId}`;
      assert.ok(raceJob, "race job must remain");
      assert.equal(raceJob.agent_snapshot_json.credential_id, raceId);
      if (raceDelete.statusCode === 200) {
        assert.equal(raceStill, undefined);
        assert.ok([200, 409].includes(raceResume.statusCode), raceResume.payload);
        assert.ok(["failed", "pending"].includes(String(raceJob.status)), String(raceJob.status));
      } else {
        assert.equal(raceDelete.statusCode, 409, raceDelete.payload);
        assert.equal(json(raceDelete).error_code, "CREDENTIAL_IN_USE");
        assert.ok(raceStill, "pending/active after resume still blocks delete");
        assert.ok([200, 409].includes(raceResume.statusCode), raceResume.payload);
        assert.ok(["failed", "pending"].includes(String(raceJob.status)), String(raceJob.status));
      }

      const historicalId = await insertCredential("historical-account");
      const historicalJobId = randomUUID();
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES (${historicalJobId}, ${projectId}, ${canvasId}, 'delete_test', 'succeeded',
          ${sql.json({ name: "delete_test", model: "model-a", credential_id: historicalId })})`;
      const historicalAttempt = randomUUID();
      await sql`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase)
        VALUES(${historicalAttempt},${historicalJobId},1,'succeeded','terminal')`;
      const tokenIds: string[] = [], plaintexts: string[] = [];
      for (const [index, status] of ['active', 'expired', 'exhausted', 'revoked'].entries()) {
        const tokenId = randomUUID(), prefix = tokenId.slice(0, 8);
        const plaintext = `deepsonarjob_${prefix}_offline-test-secret`;
        const workload = index % 2 === 0 ? 'main' : 'observational_memory';
        tokenIds.push(tokenId); plaintexts.push(plaintext);
        await sql`INSERT INTO job_tokens(id,job_id,project_id,credential_id,token_prefix,token_hash,
          max_requests,request_total_limit,max_tokens,workload,expected_provider,expected_model,expected_route,
          used_requests,used_tokens,status,expires_at,revoked_at,revoke_reason)
          VALUES(${tokenId},${historicalJobId},${projectId},${historicalId},${prefix},
            ${createHash('sha256').update(plaintext).digest('hex')},${index % 2 === 0 ? 4 : 2},6,100,${workload},
            'openai','model-a','v1/chat/completions',${index % 2 === 0 ? 2 : 1},15,${status},now()+interval '1 hour',
            ${status === 'revoked' ? new Date('2026-01-01T00:00:00Z') : null},${status === 'revoked' ? 'job_succeeded' : null})`;
        await sql`INSERT INTO job_usage_ledger(job_id,project_id,attempt_id,job_token_id,effect_id,request_no,
          provider,model,input_tokens,output_tokens,total_tokens,cache_read_input_tokens,workload)
          VALUES(${historicalJobId},${projectId},${historicalAttempt},${tokenId},${`credential.delete.${index}`},
            ${index + 1},'openai','model-a',10,5,15,3,${workload})`;
      }
      // A second ledger reference must not multiply the token generation count.
      await sql`INSERT INTO job_usage_ledger(job_id,project_id,attempt_id,job_token_id,effect_id,request_no,
        provider,model,input_tokens,output_tokens,total_tokens,workload)
        VALUES(${historicalJobId},${projectId},${historicalAttempt},${tokenIds[0]},'credential.delete.extra',5,
          'openai','model-a',1,1,2,'main')`;
      for (const url of [`/credentials/${historicalId}/impact`, `/credentials/${historicalId}`]) {
        const response = await request("GET", url);
        assert.equal(response.statusCode, 200, response.payload);
        const value = json(response) as { impact?: { usage_history: unknown }; usage_history?: unknown };
        assert.deepEqual(value.impact?.usage_history ?? value.usage_history, { token_generations: 4, ledger_entries: 5 });
      }
      const tokenHistory = await sql`SELECT to_jsonb(t) AS row FROM job_tokens t WHERE job_id=${historicalJobId} ORDER BY id`;
      const usageHistory = await sql`SELECT to_jsonb(t) AS row FROM job_usage_ledger t WHERE job_id=${historicalJobId} ORDER BY id`;
      const { readHistoricalRequestBudget } = await import('./gateway-request-budget.js');
      const requestHistory = await readHistoricalRequestBudget(sql, historicalJobId, 'main');
      assert.deepEqual(requestHistory, { totalUsed: 6, workloadUsed: 4, totalLimit: 6, workloadLimit: 4, exhausted: true });
      const historicalDelete = await request("DELETE", `/credentials/${historicalId}`);
      assert.equal(historicalDelete.statusCode, 200, historicalDelete.payload);
      assert.equal(json(historicalDelete).revoked_job_token_count, 1);
      const [jobStill] = await sql`SELECT status, agent_snapshot_json FROM jobs WHERE id = ${historicalJobId}`;
      assert.equal(jobStill?.status, "succeeded");
      assert.equal((jobStill?.agent_snapshot_json as { credential_id: string }).credential_id, historicalId);
      const [credentialGone] = await sql`SELECT id FROM credentials WHERE id=${historicalId}`;
      assert.equal(credentialGone, undefined);
      const retainedTokens = await sql`SELECT to_jsonb(t) AS row FROM job_tokens t WHERE job_id=${historicalJobId} ORDER BY id`;
      assert.equal(retainedTokens.length, tokenHistory.length);
      for (const [index, retained] of retainedTokens.entries()) {
        const before = tokenHistory[index].row;
        assert.deepEqual({ ...retained.row, credential_id: before.credential_id, status: before.status,
          revoked_at: before.revoked_at, revoke_reason: before.revoke_reason }, before,
          'deletion must preserve token identity, workload, all used counts and finite ceilings');
        assert.equal(retained.row.credential_id, null);
        assert.equal(retained.row.status, 'revoked');
        assert.ok(retained.row.revoked_at);
        assert.equal(retained.row.revoke_reason, before.revoke_reason ?? 'credential_deleted');
        if (before.revoked_at) assert.equal(retained.row.revoked_at, before.revoked_at);
      }
      const retainedUsage = await sql`SELECT to_jsonb(t) AS row FROM job_usage_ledger t WHERE job_id=${historicalJobId} ORDER BY id`;
      assert.deepEqual(retainedUsage, usageHistory, 'ledger rows and token/Attempt/effect references are immutable');
      assert.deepEqual(await readHistoricalRequestBudget(sql, historicalJobId, 'main'), requestHistory,
        'credential deletion cannot refresh exhausted Job request quota');
      const background = await readHistoricalRequestBudget(sql, historicalJobId, 'observational_memory');
      assert.deepEqual(background, { totalUsed: 6, workloadUsed: 2, totalLimit: 6, workloadLimit: 2, exhausted: true });
      for (const status of ['active', 'expired', 'exhausted']) {
        await assert.rejects(sql`UPDATE job_tokens SET status=${status} WHERE id=${tokenIds[0]}`, { code: '23514' });
      }
      await assert.rejects(sql`DELETE FROM job_tokens WHERE id=${tokenIds[0]}`, { code: '23503' });
      for (const plaintext of plaintexts) {
        const denied = await app.inject({ method: 'POST', url: '/gateway/v1/chat/completions',
          headers: { authorization: `Bearer ${plaintext}` }, payload: { model: 'model-a', messages: [] } });
        assert.equal(denied.statusCode, 401, denied.payload);
      }
      const repeatDelete = await request('DELETE', `/credentials/${historicalId}`);
      assert.equal(repeatDelete.statusCode, 404, repeatDelete.payload);
      assert.deepEqual(await readHistoricalRequestBudget(sql, historicalJobId, 'main'), requestHistory);

      const ociId = await insertCredential("oci-account", { kind: "oci_registry", provider: "ghcr.io" });
      const imageId = randomUUID();
      const versionId = randomUUID();
      const scanId = randomUUID();
      const imageKey = `cred-del-${randomUUID().slice(0, 8)}`;
      await sql`
        INSERT INTO runtime_images (id, image_key, name, description, publisher, source_kind, official)
        VALUES (${imageId}, ${imageKey}, 'credential delete scan', 'fixture', 'SummerSec', 'third_party', false)`;
      await sql`
        INSERT INTO runtime_image_versions (id, runtime_image_id, version, image_ref, trust_status)
        VALUES (${versionId}, ${imageId}, '0.0.1', 'ghcr.io/summersec/fixture:test', 'quarantined')`;
      await sql`
        INSERT INTO runtime_image_scans (id, runtime_image_version_id, status, result_json)
        VALUES (${scanId}, ${versionId}, 'queued', ${sql.json({ registry_credential_id: ociId })})`;
      const scanRefuse = await request("DELETE", `/credentials/${ociId}`);
      assert.equal(scanRefuse.statusCode, 409, scanRefuse.payload);
      assert.equal(json(scanRefuse).error_code, "CREDENTIAL_SCAN_IN_USE");
      const scanImpact = json(scanRefuse).impact as { scans: { active: { count: number } } };
      assert.equal(scanImpact.scans.active.count, 1);
      const [ociStill] = await sql`SELECT id FROM credentials WHERE id = ${ociId}`;
      assert.equal(String(ociStill?.id), ociId);
      await sql`UPDATE runtime_image_scans SET status = 'succeeded' WHERE id = ${scanId}`;
      const scanOk = await request("DELETE", `/credentials/${ociId}`);
      assert.equal(scanOk.statusCode, 200, scanOk.payload);

      await t.test("OCI registry import and credential deletion serialize on the credential row", async (t) => {
        // Keep the preceding pool=1 regression. Only these concurrent transactions
        // use a separate real pool; route handlers, SQL and HTTP remain unchanged.
        const transactions = postgres(targetUrl.toString(), { max: 2, connection: {
          application_name: "credential-scan-race", statement_timeout: 5_000,
        } });
        const observer = postgres(targetUrl.toString(), { max: 2, connection: { statement_timeout: 5_000 } });
        const originalBegin = sql.begin;
        const withinDeadline = async <T>(pending: Promise<T>): Promise<T> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([pending, new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("registry scan race did not settle")), 10_000);
            })]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        };
        const waitForBlocked = async (fragment: string, blocker: number, pending: Promise<InjectResponse>) => {
          const outcome: { response?: InjectResponse; failure?: unknown } = {};
          void pending.then((response) => { outcome.response = response; }, (error: unknown) => { outcome.failure = error; });
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const rows = await observer<{ pid: number }[]>`SELECT pid FROM pg_stat_activity
              WHERE datname = ${databaseName} AND application_name = 'credential-scan-race'
                AND query LIKE ${`%${fragment}%`} AND wait_event_type = 'Lock'
                AND ${blocker}::int = ANY(pg_blocking_pids(pid))`;
            if (rows.length) return Number(rows[0].pid);
            if (outcome.failure) throw outcome.failure;
            assert.equal(outcome.response, undefined, `${fragment} completed before the lock barrier: ${outcome.response?.payload}`);
          }
          assert.fail(`did not observe ${fragment} blocked by backend ${blocker}`);
        };
        const importBody = (imageKey: string, credentialId?: string) => ({
          image_key: imageKey, name: "registry race fixture", publisher: "fixture",
          image_ref: "127.0.0.1:5000/fixture/image:scan-test", version: "0.0.1",
          ...(credentialId ? { registry_credential_id: credentialId } : {}),
        });
        const assertNoImport = async (imageKey: string, credentialId: string) => {
          const images = await sql`SELECT id FROM runtime_images WHERE image_key = ${imageKey}`;
          const versions = await sql`SELECT v.id FROM runtime_image_versions v
            JOIN runtime_images i ON i.id = v.runtime_image_id WHERE i.image_key = ${imageKey}`;
          const scans = await sql`SELECT id FROM runtime_image_scans
            WHERE result_json->>'registry_credential_id' = ${credentialId}`;
          assert.equal(images.length, 0, "failed import must not leave an image");
          assert.equal(versions.length, 0, "failed import must not leave a version");
          assert.equal(scans.length, 0, "failed import must not leave a dangling scan");
        };
        sql.begin = transactions.begin;
        try {
          for (const direction of ["import-first", "delete-first"] as const) {
            await t.test(direction, async () => {
              const credentialId = await insertCredential(`registry-${direction}`, { kind: "oci_registry" });
              const imageKey = `scan-race-${randomUUID().slice(0, 8)}`;
              const table = direction === "import-first" ? "runtime_image_scans" : "credentials";
              const control = await observer.reserve();
              const [backend] = await control<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
              const gate = 182;
              let held = false;
              let first: Promise<InjectResponse> | undefined;
              let second: Promise<InjectResponse> | undefined;
              try {
                await control`SELECT pg_advisory_lock(${gate})`;
                held = true;
                // Test-only database trigger: pause the actual route transaction
                // after credential admission (import) or zero-reference check (DELETE).
                await observer.unsafe(`CREATE FUNCTION registry_scan_race_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
                  BEGIN PERFORM pg_advisory_xact_lock(${gate}); RETURN ${direction === "import-first" ? "NEW" : "OLD"}; END $$`);
                await observer.unsafe(`CREATE TRIGGER registry_scan_race BEFORE ${direction === "import-first" ? "INSERT" : "DELETE"}
                  ON ${table} FOR EACH ROW WHEN (${direction === "import-first"
                    ? `NEW.result_json->>'registry_credential_id' = '${credentialId}'`
                    : `OLD.id = '${credentialId}'::uuid`}) EXECUTE FUNCTION registry_scan_race_barrier()`);
                const importImage = () => request("POST", "/runtime-images/import", importBody(imageKey, credentialId));
                const remove = () => request("DELETE", `/credentials/${credentialId}`);
                first = direction === "import-first" ? importImage() : remove();
                const firstPid = await waitForBlocked(direction === "import-first"
                  ? "INSERT INTO runtime_image_scans" : "DELETE FROM credentials", Number(backend.pid), first);
                second = direction === "import-first" ? remove() : importImage();
                const secondPid = await waitForBlocked("SELECT id FROM credentials", firstPid, second);
                assert.notEqual(firstPid, secondPid, "both HTTP requests must reach distinct PostgreSQL backends");
                await control`SELECT pg_advisory_unlock(${gate})`;
                held = false;
                const [firstResponse, secondResponse] = await withinDeadline(Promise.all([first, second]));
                if (direction === "import-first") {
                  assert.equal(firstResponse.statusCode, 202, firstResponse.payload);
                  assert.equal(secondResponse.statusCode, 409, secondResponse.payload);
                  assert.equal(json(secondResponse).error_code, "CREDENTIAL_SCAN_IN_USE");
                  const imported = json(firstResponse) as { scan: { id: string; status: string } };
                  assert.equal(imported.scan.status, "queued");
                  assert.equal((await sql`SELECT id FROM credentials WHERE id = ${credentialId}`).length, 1);
                  const [scan] = await sql`SELECT status, result_json FROM runtime_image_scans WHERE id = ${imported.scan.id}`;
                  assert.equal(scan.status, "queued");
                  assert.equal(scan.result_json.registry_credential_id, credentialId);
                } else {
                  assert.equal(firstResponse.statusCode, 200, firstResponse.payload);
                  assert.equal(secondResponse.statusCode, 400, secondResponse.payload);
                  assert.deepEqual(json(secondResponse), { error: "registry Credential 不存在或不可用" });
                  assert.equal((await sql`SELECT id FROM credentials WHERE id = ${credentialId}`).length, 0);
                  await assertNoImport(imageKey, credentialId);
                }
                for (const response of [firstResponse, secondResponse]) {
                  assert.equal(/ciphertext|nonce|auth_tag|-secret/.test(response.payload), false);
                }
              } finally {
                try {
                  if (held) await control`SELECT pg_advisory_unlock(${gate})`;
                  await withinDeadline(Promise.allSettled([first, second]));
                } finally {
                  control.release();
                  await observer.unsafe(`DROP TRIGGER IF EXISTS registry_scan_race ON ${table}`);
                  await observer.unsafe("DROP FUNCTION IF EXISTS registry_scan_race_barrier()");
                }
              }
            });
          }

          await t.test("invalid registry credentials keep the 400 response without creating import rows", async () => {
            const disabled = await insertCredential("disabled-registry", { kind: "oci_registry" });
            await sql`UPDATE credentials SET status = 'disabled' WHERE id = ${disabled}`;
            const wrongKind = await insertCredential("wrong-kind-registry");
            for (const credentialId of [randomUUID(), disabled, wrongKind]) {
              const imageKey = `scan-invalid-${randomUUID().slice(0, 8)}`;
              const response = await request("POST", "/runtime-images/import", importBody(imageKey, credentialId));
              assert.equal(response.statusCode, 400, response.payload);
              assert.deepEqual(json(response), { error: "registry Credential 不存在或不可用" });
              await assertNoImport(imageKey, credentialId);
            }
          });

          await t.test("scan insertion failure rolls back the imported image and version", async () => {
            const credentialId = await insertCredential("rollback-registry", { kind: "oci_registry" });
            const imageKey = `scan-rollback-${randomUUID().slice(0, 8)}`;
            try {
              await observer.unsafe(`CREATE FUNCTION registry_scan_failure() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN RAISE EXCEPTION 'scan insertion fixture failure' USING ERRCODE = '23514'; END $$`);
              await observer.unsafe(`CREATE TRIGGER registry_scan_failure BEFORE INSERT ON runtime_image_scans
                FOR EACH ROW WHEN (NEW.result_json->>'registry_credential_id' = '${credentialId}')
                EXECUTE FUNCTION registry_scan_failure()`);
              const response = await request("POST", "/runtime-images/import", importBody(imageKey, credentialId));
              assert.equal(response.statusCode, 500, response.payload);
              await assertNoImport(imageKey, credentialId);
              assert.equal((await sql`SELECT id FROM credentials WHERE id = ${credentialId}`).length, 1);
            } finally {
              await observer.unsafe("DROP TRIGGER IF EXISTS registry_scan_failure ON runtime_image_scans");
              await observer.unsafe("DROP FUNCTION IF EXISTS registry_scan_failure()");
            }
          });

          await t.test("import without a registry credential still queues a scan", async () => {
            const response = await request("POST", "/runtime-images/import", importBody(`scan-public-${randomUUID().slice(0, 8)}`));
            assert.equal(response.statusCode, 202, response.payload);
            const imported = json(response) as { scan: { status: string; result_json: unknown } };
            assert.equal(imported.scan.status, "queued");
            assert.deepEqual(imported.scan.result_json, {});
          });
        } finally {
          sql.begin = originalBegin;
          await transactions.end({ timeout: 5 });
          await observer.end({ timeout: 5 });
        }
      });

      const missing = await request("DELETE", `/credentials/${randomUUID()}`);
      assert.equal(missing.statusCode, 404, missing.payload);

      const audits = await sql<{ action: string; after_json: unknown }[]>`
        SELECT action, after_json FROM audit_logs WHERE action = 'credential.delete'`;
      assert.ok(audits.length >= 1);
      assert.equal(JSON.stringify(audits).includes("ciphertext"), false);
      assert.equal(JSON.stringify(audits).includes("-secret"), false);
    } finally {
      if (closeApp) await closeApp();
      if (endSql) await endSql();
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end({ timeout: 5 });
    }
  });
}
