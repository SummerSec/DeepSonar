import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import type { Actor } from "./auth.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (testDatabaseUrl) {
  test("credential project references: visibility, validation and real two-session races", { timeout: 60_000 }, async (t) => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_cred_refs_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = `/${databaseName}`;
    targetUrl.search = "";
    let created = false;
    let closeApp: (() => Promise<unknown>) | undefined;
    let closeSql: (() => Promise<unknown>) | undefined;
    let observer: ReturnType<typeof postgres> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      created = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.DEEPSONAR_AUTH_REQUIRED = "false";
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_DB_POOL_MAX = "2";
      const [{ default: Fastify }, { sql, migrate }, { registerCredentialRoutes }, { registerSettingsRoutes }, { encryptSecret }, { listProjectSkillSourceBindings, setProjectSkillSourceEnabled }] = await Promise.all([
        import("fastify"), import("./db.js"), import("./domains/credential/routes.js"),
        import("./domains/settings/routes.js"), import("./credentials.js"), import("./domains/project-skill-allowlist/catalog.js"),
      ]);
      closeSql = () => sql.end({ timeout: 5 });
      await migrate();
      observer = postgres(targetUrl.toString(), { max: 2 });
      const app = Fastify({ logger: false });
      let actor: Actor = { type: "internal", id: null, name: "fixture admin", projectId: null, scopes: ["admin"] };
      app.addHook("onRequest", async (req) => { req.actor = actor; });
      registerCredentialRoutes(app);
      registerSettingsRoutes(app);
      await app.ready();
      closeApp = () => app.close();
      const patch = (id: string, payload: Record<string, unknown>) =>
        app.inject({ method: "PATCH", url: `/projects/${id}/settings`, payload });
      const remove = (id: string) => app.inject({ method: "DELETE", url: `/credentials/${id}` });
      const project = async (name: string, cfg: Record<string, unknown> = {}) => {
        const id = randomUUID();
        await sql`INSERT INTO projects(id, name, config_json) VALUES (${id}, ${name}, ${sql.json(cfg as never)})`;
        return id;
      };
      const credential = async (projectId: string | null = null, status = "active", kind = "llm_provider") => {
        const id = randomUUID();
        const encrypted = encryptSecret("reference-test-secret");
        await sql`INSERT INTO credentials(id, name, kind, provider, project_id, status, agent_cli,
          settings_config_json, ciphertext, nonce, auth_tag, fingerprint, last4)
          VALUES (${id}, 'reference fixture', ${kind}, 'openai', ${projectId}, ${status}, 'pi',
          ${sql.json({ models: [{ id: "model-a" }, { id: "model-b" }] })},
          ${encrypted.ciphertext}, ${encrypted.nonce}, ${encrypted.auth_tag}, 'fixture', 'cret')`;
        return id;
      };
      const config = async (id: string) => (await sql`SELECT config_json FROM projects WHERE id = ${id}`)[0].config_json;
      const withinDeadline = async <T>(pending: PromiseLike<T>, label: string): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            Promise.resolve(pending),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`${label} did not settle within 5 seconds`)), 5_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const waitForBlocked = async (queryText: string, event?: string) => {
        for (let i = 0; i < 200; i++) {
          const rows = await observer!`SELECT pid FROM pg_stat_activity
            WHERE datname = ${databaseName} AND pid <> pg_backend_pid()
              AND query LIKE ${`%${queryText}%`} AND wait_event_type = 'Lock'
              AND (${event ?? null}::text IS NULL OR wait_event = ${event ?? null})
              AND cardinality(pg_blocking_pids(pid)) > 0`;
          if (rows.length) return Number(rows[0].pid);
          await delay(10);
        }
        assert.fail(`did not observe blocked PostgreSQL session: ${queryText}`);
      };

      const shared = await credential();
      const a = await project("visible A", { enabled_credential_ids: [shared], default_credential_id: shared });
      const b = await project("private B", { enabled_credential_ids: [shared], default_credential_id: shared });
      for (const [index, projectId] of [a, b].entries()) {
        const jobId = randomUUID(), tokenId = randomUUID(), attemptId = randomUUID();
        await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json)
          VALUES(${jobId},${projectId},'scope-history','succeeded',${sql.json({ credential_id: shared })})`;
        await sql`INSERT INTO job_attempts(id,job_id,attempt_no,status,phase)
          VALUES(${attemptId},${jobId},1,'succeeded','terminal')`;
        await sql`INSERT INTO job_tokens(id,job_id,project_id,credential_id,token_prefix,token_hash,
          max_requests,request_total_limit,max_tokens,expected_provider,expected_model,expected_route,status,expires_at)
          VALUES(${tokenId},${jobId},${projectId},${shared},${tokenId.slice(0,8)},${tokenId.replaceAll('-','')},
            2,2,100,'openai','model-a','v1/chat/completions','expired',now())`;
        for (let requestNo = 1; requestNo <= (index === 0 ? 2 : 1); requestNo++) {
          await sql`INSERT INTO job_usage_ledger(job_id,project_id,attempt_id,job_token_id,effect_id,request_no,provider,model,
            input_tokens,output_tokens,total_tokens)
            VALUES(${jobId},${projectId},${attemptId},${tokenId},${`scope-history.${requestNo}`},${requestNo},'openai','model-a',1,1,2)`;
        }
      }
      for (const suffix of ["", "/impact"]) {
        await t.test(`scoped GET /credentials/:id${suffix} hides other project ids, names and counts`, async () => {
          actor = { type: "api_token", id: null, name: "project A reader", projectId: a, scopes: ["agents:read"] };
          const response = await app.inject({ method: "GET", url: `/credentials/${shared}${suffix}` });
          assert.equal(response.statusCode, 200, response.payload);
          const impact = suffix ? response.json() : response.json().impact;
          assert.equal(impact.project_references.count, 1);
          assert.deepEqual(impact.usage_history, { token_generations: 1, ledger_entries: 2 });
          assert.deepEqual(impact.project_references.items, [{ project_id: a, project_name: "visible A", enabled: true, default: true }]);
          assert.equal(response.payload.includes(b), false);
          assert.equal(response.payload.includes("private B"), false);
          const privateCredential = await credential(b);
          assert.equal((await app.inject({ method: "GET", url: `/credentials/${privateCredential}${suffix}` })).statusCode, 404);
        });
      }
      actor = { type: "internal", id: null, name: "fixture admin", projectId: null, scopes: ["admin"] };
      await t.test("global DELETE refuses hidden project references without changing configs or secrets", async () => {
        const detail = await app.inject({ method: "GET", url: `/credentials/${shared}/impact` });
        assert.equal(detail.json().project_references.count, 2);
        assert.deepEqual(detail.json().usage_history, { token_generations: 2, ledger_entries: 3 });
        const before = await config(b);
        const response = await remove(shared);
        assert.equal(response.statusCode, 409, response.payload);
        assert.equal(response.json().error_code, "CREDENTIAL_PROJECT_REFERENCE");
        assert.ok(response.json().next_action);
        assert.deepEqual(await config(b), before);
        assert.equal((await sql`SELECT id FROM credentials WHERE id = ${shared}`).length, 1);
        assert.equal(response.payload.includes("reference-test-secret"), false);
        assert.equal(response.payload.includes("ciphertext"), false);
        // Even an invalid cross-project historical config must block a scoped owner's delete,
        // but must not leak that foreign config in the refusal impact.
        const owned = await credential(a);
        await sql`UPDATE projects SET config_json = config_json || ${sql.json({ enabled_credential_ids: [owned] })} WHERE id = ${b}`;
        actor = { type: "api_token", id: null, name: "project A owner", projectId: a, scopes: ["agents:write"] };
        const scoped = await remove(owned);
        assert.equal(scoped.statusCode, 409, scoped.payload);
        assert.equal(scoped.json().error_code, "CREDENTIAL_PROJECT_REFERENCE");
        assert.deepEqual(scoped.json().impact.project_references, { count: 0, items: [] });
        assert.equal(scoped.payload.includes(b), false);
        assert.equal(scoped.payload.includes("private B"), false);
        actor = { type: "internal", id: null, name: "fixture admin", projectId: null, scopes: ["admin"] };
      });

      await t.test("PATCH rejects missing, inactive, foreign and non-LLM references even without model fields", async () => {
        const p = await project("validation", { enabled_credential_ids: [] });
        for (const id of [randomUUID(), await credential(null, "disabled"), await credential(b), await credential(null, "active", "git")]) {
          for (const payload of [{ enabled_credential_ids: [id] }, { enabled_credential_ids: [id], default_credential_id: id }]) {
            const response = await patch(p, payload);
            assert.equal(response.statusCode, 400, response.payload);
            assert.equal(response.json().error_code, "provider_credential_allowlist_stale");
            assert.deepEqual(await config(p), { enabled_credential_ids: [] });
          }
        }
        const pUnrestricted = await project("missing default only");
        const missingDefault = await patch(pUnrestricted, { default_credential_id: randomUUID() });
        assert.equal(missingDefault.statusCode, 400);
        assert.equal(missingDefault.json().error_code, "provider_credential_allowlist_stale");
        assert.deepEqual(await config(pUnrestricted), {});
        const stale = randomUUID();
        const stored = { enabled_credential_ids: [stale], default_credential_id: stale };
        await sql`UPDATE projects SET config_json = ${sql.json(stored)} WHERE id = ${p}`;
        const omitted = await patch(p, { device_access_enabled: true });
        assert.equal(omitted.statusCode, 400, omitted.payload);
        assert.equal(omitted.json().error_code, "provider_credential_allowlist_stale");
        assert.deepEqual(await config(p), stored, "rejection must not auto-repair or widen the whitelist");
        const fixed = await patch(p, { enabled_credential_ids: [], default_credential_id: null });
        assert.equal(fixed.statusCode, 200, fixed.payload);
        assert.deepEqual(await config(p), { enabled_credential_ids: [] });
      });

      await t.test("omitted fields cannot hide a default outside the whitelist or unpaired stored models", async () => {
        const id = await credential();
        for (const cfg of [
          { enabled_credential_ids: [], default_credential_id: id },
          { default_model_ref: "model-a", fallback_model_refs: ["model-b"] },
        ]) {
          const p = await project("invalid retained defaults", cfg);
          const response = await patch(p, { device_access_enabled: true });
          assert.equal(response.statusCode, 400, response.payload);
          assert.deepEqual(await config(p), cfg);
        }
      });

      await t.test("absent and empty whitelist remain distinct; default/fallback pairing validates replacements", async () => {
        const id = await credential();
        const replacement = await credential();
        await sql`UPDATE credentials SET settings_config_json = ${sql.json({ models: [{ id: "other" }] })} WHERE id = ${replacement}`;
        const p = await project("model pairing");
        const selected = await patch(p, { default_credential_id: id, default_model_ref: "model-a", fallback_model_refs: ["model-b"] });
        assert.equal(selected.statusCode, 200, selected.payload);
        assert.equal(selected.json().credential_ids_configured, false);
        assert.equal(Object.hasOwn(await config(p), "enabled_credential_ids"), false);
        const before = await config(p);
        const wrong = await patch(p, { default_credential_id: replacement });
        assert.equal(wrong.statusCode, 400, wrong.payload);
        assert.equal(wrong.json().error_code, "model_not_in_catalog");
        assert.deepEqual(await config(p), before);
        const empty = await patch(p, { enabled_credential_ids: [] });
        assert.equal(empty.statusCode, 200, empty.payload);
        assert.equal(empty.json().credential_ids_configured, true);
        assert.deepEqual(await config(p), { enabled_credential_ids: [] });
        const unpaired = await patch(p, { default_model_ref: "model-a", fallback_model_refs: ["model-b"] });
        assert.equal(unpaired.statusCode, 400, unpaired.payload);
        assert.deepEqual(await config(p), { enabled_credential_ids: [] });
        const deleted = await remove(id);
        assert.equal(deleted.statusCode, 200, deleted.payload);
        assert.deepEqual(await config(p), { enabled_credential_ids: [] }, "deletion never removes the deny-all key");
      });

      await t.test("UUID case does not evade deletion protection or model validation; bounded items keep full count", async () => {
        const id = await credential();
        const p = await project("UUID case");
        const selected = await patch(p, { enabled_credential_ids: [id.toUpperCase()], default_credential_id: id.toUpperCase(), default_model_ref: "model-a" });
        assert.equal(selected.statusCode, 200, selected.payload);
        assert.equal((await config(p)).default_credential_id, id);
        // Preserve and recognize existing config bytes rather than rewriting historical data.
        await sql`UPDATE projects SET config_json = ${sql.json({ enabled_credential_ids: [id.toUpperCase()], default_credential_id: id.toUpperCase() })} WHERE id = ${p}`;
        for (let i = 0; i < 50; i++) await project(`bounded ${i}`, { enabled_credential_ids: [id] });
        const response = await app.inject({ method: "GET", url: `/credentials/${id}/impact` });
        assert.equal(response.json().project_references.count, 51);
        assert.equal(response.json().project_references.items.length, 50);
        const refused = await remove(id);
        assert.equal(refused.statusCode, 409, refused.payload);
        assert.equal(refused.json().error_code, "CREDENTIAL_PROJECT_REFERENCE");
        assert.equal((await config(p)).default_credential_id, id.toUpperCase());
      });

      for (const operation of ["listProjectSkillSourceBindings", "setProjectSkillSourceEnabled"] as const) {
        await t.test(`${operation} stamps only the Skill flag after a concurrent credential replacement/delete`, { timeout: 10_000 }, async () => {
          const original = await credential();
          const replacement = await credential();
          const initial = {
            enabled_credential_ids: [original], default_credential_id: original,
            default_model_ref: "model-a", fallback_model_refs: ["model-b"],
            unrelated: { nested: ["retain"] }, rules: { hubEnabled: false },
          };
          const p = await project(`Skill stamp ${operation}`, initial);
          const sourceId = randomUUID();
          await sql`INSERT INTO skill_sources(id, name, repo_url, branch, trust_status, enabled)
            VALUES (${sourceId}, ${`reference-race-${sourceId}`}, 'http://127.0.0.1/skills.git', 'main', 'trusted', true)`;
          if (operation === "listProjectSkillSourceBindings") {
            await sql`INSERT INTO project_skill_sources(project_id, skill_source_id, enabled) VALUES (${p}, ${sourceId}, false)`;
          }
          const skillClient = postgres(targetUrl.toString(), { max: 1, connection: { statement_timeout: 5_000 } });
          let announceRead!: () => void;
          let releaseStamp!: () => void;
          const read = new Promise<void>((resolve) => { announceRead = resolve; });
          const hold = new Promise<void>((resolve) => { releaseStamp = resolve; });
          let paused = false;
          // SAFETY: the proxy forwards the real postgres query/helper interface and returns its unchanged rows.
          const pausedDb = new Proxy(skillClient, {
            apply(target, thisArg, args) {
              const pending = Reflect.apply(target, thisArg, args);
              if (paused || !Array.isArray(args[0]) || !args[0].join("").includes("SELECT config_json FROM projects")) return pending;
              return (async () => {
                const rows = await pending;
                assert.deepEqual(rows[0].config_json, initial, "pause only after SELECT actually read the old config");
                paused = true;
                announceRead();
                await hold;
                return rows;
              })();
            },
          }) as unknown as Parameters<typeof listProjectSkillSourceBindings>[0];
          const stamp: Promise<Awaited<ReturnType<typeof listProjectSkillSourceBindings>> | Awaited<ReturnType<typeof setProjectSkillSourceEnabled>>> = operation === "listProjectSkillSourceBindings"
            ? listProjectSkillSourceBindings(pausedDb, p)
            : setProjectSkillSourceEnabled(pausedDb, p, sourceId, false);
          try {
            await withinDeadline(Promise.race([read, stamp.then(() => assert.fail("Skill write completed without its SELECT barrier"))]), "Skill config read");
            const response = await withinDeadline(patch(p, {
              enabled_credential_ids: [replacement], default_credential_id: replacement, device_access_enabled: true,
            }), "credential replacement settings PATCH");
            assert.equal(response.statusCode, 200, response.payload);
            const expected = { ...initial, enabled_credential_ids: [replacement], default_credential_id: replacement, device_access_enabled: true };
            assert.deepEqual(await config(p), expected);
            const deleted = await withinDeadline(remove(original), "DELETE replaced credential");
            assert.equal(deleted.statusCode, 200, deleted.payload);
            assert.equal((await sql`SELECT id FROM credentials WHERE id = ${original}`).length, 0);
            releaseStamp();
            const result = await withinDeadline(stamp, "Skill flag stamp");
            if ("sources" in result) {
              assert.equal(result.configured, true);
              assert.equal(result.sources.find((source) => source.skill_source_id === sourceId)?.project_enabled, false);
            } else {
              assert.equal(result.project_enabled, false);
            }
            const current = await config(p);
            assert.deepEqual(current, { ...expected, skill_source_allowlist_configured: true });
            assert.equal(JSON.stringify(current).includes(original), false, "a deleted credential UUID must not resurrect");
            assert.equal((await sql`SELECT id FROM credentials WHERE id = ${replacement}`).length, 1);
            assert.equal((await sql`SELECT enabled FROM project_skill_sources WHERE project_id = ${p} AND skill_source_id = ${sourceId}`)[0].enabled, false);
          } finally {
            releaseStamp();
            try {
              await withinDeadline(Promise.allSettled([stamp]), "Skill writer cleanup");
            } finally {
              await skillClient.end({ timeout: 5 });
            }
          }
        });
      }

      await t.test("settings project lock permits concurrent global Credential PATCH to attach to that project", { timeout: 10_000 }, async () => {
        const id = await credential();
        const p = await project("credential FK lock race", { unrelated: { retained: true } });
        const gate = 925;
        const control = await observer!.reserve();
        let gateLocked = false;
        let moving: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined;
        let settings: typeof moving;
        try {
          await control`SELECT pg_advisory_lock(${gate})`;
          gateLocked = true;
          // Pause after Credential PATCH owns C, but before its project FK takes KEY SHARE on P.
          await observer!.unsafe(`CREATE FUNCTION credential_project_fk_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_advisory_xact_lock(${gate}); RETURN NEW; END $$`);
          await observer!.unsafe(`CREATE TRIGGER credential_project_fk_race BEFORE UPDATE OF project_id ON credentials
            FOR EACH ROW WHEN (OLD.id = '${id}'::uuid) EXECUTE FUNCTION credential_project_fk_barrier()`);
          moving = Promise.resolve(app.inject({ method: "PATCH", url: `/credentials/${id}`, payload: { project_id: p } }));
          const movingPid = await waitForBlocked("UPDATE credentials SET", "advisory");
          settings = Promise.resolve(patch(p, { enabled_credential_ids: [id], default_credential_id: id, device_access_enabled: true }));
          const settingsPid = await waitForBlocked("SELECT id FROM credentials");
          assert.notEqual(movingPid, settingsPid, "must be two independent scheduler PG sessions");
          const [blocked] = await observer!`SELECT pg_blocking_pids(${settingsPid}) AS blockers`;
          assert.ok(blocked.blockers.includes(movingPid), "settings must wait on the credential held by its actual PATCH");
          await assert.rejects(observer!`SELECT id FROM projects WHERE id = ${p} FOR NO KEY UPDATE NOWAIT`,
            (error: unknown) => (error as { code?: string }).code === "55P03", "settings must already own the project config lock");
          await control`SELECT pg_advisory_unlock(${gate})`;
          gateLocked = false;
          const [moved, configured] = await withinDeadline(Promise.all([moving, settings]), "Credential FK/settings lock race");
          assert.equal(moved.statusCode, 200, moved.payload);
          assert.equal(configured.statusCode, 200, configured.payload);
          assert.equal(moved.json().project_id, p);
          assert.deepEqual(await config(p), {
            unrelated: { retained: true }, enabled_credential_ids: [id], default_credential_id: id, device_access_enabled: true,
          });
          assert.equal((await sql`SELECT project_id FROM credentials WHERE id = ${id}`)[0].project_id, p);
        } finally {
          if (gateLocked) await control`SELECT pg_advisory_unlock(${gate})`;
          try {
            await withinDeadline(Promise.allSettled([moving, settings].filter((pending) => pending !== undefined)), "FK race request cleanup");
          } finally {
            control.release();
            await observer!.unsafe("DROP TRIGGER IF EXISTS credential_project_fk_race ON credentials");
            await observer!.unsafe("DROP FUNCTION IF EXISTS credential_project_fk_barrier()");
          }
        }
      });

      await t.test("GET legacy cleanup cannot restore credential references replaced concurrently", { timeout: 10_000 }, async () => {
        const original = await credential();
        const replacement = await credential();
        const p = await project("GET cleanup CAS", { image_strategy: "legacy", enabled_credential_ids: [original] });
        let announceLocked!: () => void;
        let releaseWriter!: () => void;
        const locked = new Promise<void>((resolve) => { announceLocked = resolve; });
        const hold = new Promise<void>((resolve) => { releaseWriter = resolve; });
        const writer = observer!.begin(async (tx) => {
          await tx`SELECT id FROM projects WHERE id = ${p} FOR UPDATE`;
          announceLocked();
          await hold;
          await tx`UPDATE projects SET config_json = ${tx.json({ enabled_credential_ids: [replacement] })} WHERE id = ${p}`;
        });
        let request: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined;
        try {
          await locked;
          request = Promise.resolve(app.inject({ method: "GET", url: `/projects/${p}/settings` }));
          let blocked = false;
          for (let i = 0; i < 200; i++) {
            const waiting = await observer!`SELECT pid FROM pg_stat_activity
              WHERE datname = ${databaseName} AND query LIKE '%UPDATE projects SET config_json%'
                AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0`;
            if (waiting.length > 0) { blocked = true; break; }
            await delay(10);
          }
          assert.equal(blocked, true, "GET must read its old config before waiting for the concurrent writer");
          releaseWriter();
          await writer;
          const response = await request;
          assert.equal(response.statusCode, 200, response.payload);
          assert.deepEqual(response.json().enabled_credential_ids, [replacement]);
          assert.deepEqual(await config(p), { enabled_credential_ids: [replacement] });
          assert.equal((await remove(original)).statusCode, 200, "GET must not recreate the removed reference");
        } finally {
          releaseWriter();
          await writer;
          if (request) await request;
        }
      });

      // Test-only triggers pause after the route's validation/zero-reference scan,
      // while its real transaction still holds the credential row lock.
      for (const direction of ["delete-first", "write-first"] as const) {
        for (const refKind of ["enabled", "default", "both"] as const) {
          await t.test(`${direction} race (${refKind}, no model fields) cannot leave a dangling UUID`, { timeout: 10_000 }, async () => {
            const id = await credential();
            const p = await project(`race ${direction} ${refKind}`);
            const payload = {
              ...(refKind !== "default" ? { enabled_credential_ids: [id] } : {}),
              ...(refKind !== "enabled" ? { default_credential_id: id } : {}),
            };
            const gate = 914;
            const control = await observer!.reserve();
            let gateLocked = false;
            let first: Promise<Awaited<ReturnType<typeof remove>>> | undefined;
            let second: typeof first;
            try {
              await control`SELECT pg_advisory_lock(${gate})`;
              gateLocked = true;
              await observer!.unsafe(`CREATE OR REPLACE FUNCTION reference_race_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN PERFORM pg_advisory_xact_lock(${gate}); RETURN ${direction === "delete-first" ? "OLD" : "NEW"}; END $$`);
              const table = direction === "delete-first" ? "credentials" : "projects";
              const operation = direction === "delete-first" ? "DELETE" : "UPDATE";
              const target = direction === "delete-first" ? id : p;
              await observer!.unsafe(`CREATE TRIGGER reference_race BEFORE ${operation} ON ${table}
                FOR EACH ROW WHEN (OLD.id = '${target}'::uuid) EXECUTE FUNCTION reference_race_barrier()`);
              first = Promise.resolve(direction === "delete-first" ? remove(id) : patch(p, payload));
              const firstPid = await waitForBlocked(direction === "delete-first" ? "DELETE FROM credentials" : "UPDATE projects SET config_json", "advisory");
              second = Promise.resolve(direction === "delete-first" ? patch(p, payload) : remove(id));
              const secondPid = await waitForBlocked("SELECT id FROM credentials");
              assert.notEqual(firstPid, secondPid, "race must use two real PG sessions, not pool serialization");
              await control`SELECT pg_advisory_unlock(${gate})`;
              gateLocked = false;
              const [firstResult, secondResult] = await Promise.all([first, second]);
              assert.equal(firstResult.statusCode, 200, firstResult.payload);
              assert.equal(secondResult.statusCode, direction === "delete-first" ? 400 : 409, secondResult.payload);
              assert.equal(secondResult.json().error_code, direction === "delete-first" ? "provider_credential_allowlist_stale" : "CREDENTIAL_PROJECT_REFERENCE");
              const remaining = await sql`SELECT id FROM credentials WHERE id = ${id}`;
              assert.deepEqual(await config(p), direction === "delete-first" ? {} : payload);
              assert.equal(remaining.length, direction === "delete-first" ? 0 : 1);
            } finally {
              if (gateLocked) await control`SELECT pg_advisory_unlock(${gate})`;
              await Promise.allSettled([first, second].filter((pending) => pending !== undefined));
              control.release();
              await observer!.unsafe(`DROP TRIGGER IF EXISTS reference_race ON ${direction === "delete-first" ? "credentials" : "projects"}`);
            }
          });
        }
      }
    } finally {
      if (closeApp) await closeApp();
      if (closeSql) await closeSql();
      if (observer) await observer.end({ timeout: 5 });
      if (created) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end({ timeout: 5 });
    }
  });
} else {
  test("credential project references integration", { skip: "TEST_DATABASE_URL is required; no default database" }, () => {});
}
