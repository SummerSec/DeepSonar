import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import postgres from "postgres";
import { RETIRED_RUNTIME_IMAGE_KEYS, RuntimeImageRetiredError } from "@deepsonar/shared-types";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  test("runtime retirement HTTP/PG requires TEST_DATABASE_URL", { skip: "refusing scheduler default database" }, () => {});
} else {
  test("old catalog and DB cannot resurrect retired products through market, admission or direct IDs; history stays immutable", async () => {
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const database = `deepsonar_retirement_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const target = new URL(databaseUrl);
    target.pathname = `/${database}`;
    target.search = "";
    let created = false;
    let closeApp: (() => Promise<unknown>) | undefined;
    let closeSql: (() => Promise<unknown>) | undefined;
    const originalFetch = globalThis.fetch;
    try {
      await admin.unsafe(`CREATE DATABASE "${database}"`);
      created = true;
      process.env.DATABASE_URL = target.toString();
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_ALLOWED_IMAGE_REGISTRIES = "ghcr.io";
      const [{ sql, migrate }, runtime, { registerRuntimeImageRoutes }, { default: Fastify }] = await Promise.all([
        import("./db.js"), import("./runtime-images.js"), import("./domains/runtime-image/routes.js"), import("fastify"),
      ]);
      closeSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = Fastify({ logger: false });
      registerRuntimeImageRoutes(app);
      await app.ready();
      closeApp = () => app.close();
      const digest = `sha256:${"a".repeat(64)}`;
      const imageRef = `ghcr.io/example/retirement-fixture@${digest}`;
      const projectId = randomUUID();
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'retirement fixture')`;
      const raw = JSON.parse(await readFile(new URL("../../../deploy/runtime-image-registry.json", import.meta.url), "utf8"));
      raw.images.push(...RETIRED_RUNTIME_IMAGE_KEYS.map((image_key) => ({ ...structuredClone(raw.images[0]), image_key, versions: [] })));
      globalThis.fetch = async () => new Response(JSON.stringify(raw), { status: 200 });
      runtime.resetRemoteRuntimeImageRegistryCacheForTests();
      const loaded = await runtime.loadRuntimeImageRegistry({ refreshRemote: true });
      assert.equal(loaded.images.length, 11);
      // Exercise apply independently with an old already-validated catalog, not only the loader projection.
      const old = runtime.parseRegistry(raw);
      const applied = await runtime.applyOfficialRuntimeCatalog({ ...old, source: "bundled", fallback: true }, { applyEnvOverrides: false });
      assert.deepEqual(applied.registry.excluded_retired_image_keys, [...RETIRED_RUNTIME_IMAGE_KEYS]);
      assert.equal((await sql`SELECT id FROM runtime_images WHERE image_key = ANY(${[...RETIRED_RUNTIME_IMAGE_KEYS]}::text[])`).length, 0);

      const ids: Array<{ imageKey: string; imageId: string; versionId: string }> = [];
      for (const imageKey of RETIRED_RUNTIME_IMAGE_KEYS) {
        const imageId = randomUUID();
        const versionId = randomUUID();
        await sql`INSERT INTO runtime_images (id, image_key, name, description, publisher, source_kind, official, enabled)
          VALUES (${imageId}, ${imageKey}, ${imageKey}, 'old deployment', 'fixture', 'official', true, true)`;
        await sql`INSERT INTO runtime_image_versions (id, runtime_image_id, version, image_ref, resolved_ref, digest, trust_status, platforms_json)
          VALUES (${versionId}, ${imageId}, '0.1.0', ${imageRef}, ${imageRef}, ${digest}, 'trusted', ${sql.json([runtime.hostRuntimePlatform()])})`;
        await sql`INSERT INTO runtime_image_version_refs (version_id, channel, image_ref, resolved_ref, digest)
          VALUES (${versionId}, 'github', ${imageRef}, ${imageRef}, ${digest})`;
        ids.push({ imageKey, imageId, versionId });
      }
      const jobId = randomUUID();
      const snapshot = { runtime_image: { image_key: ids[0]!.imageKey, runtime_image_version_id: ids[0]!.versionId, image_ref: imageRef }, evidence: ["evidence://immutable-fixture"] };
      await sql`INSERT INTO jobs (id, project_id, type, status, agent_snapshot_json)
        VALUES (${jobId}, ${projectId}, 'audit', 'succeeded', ${sql.json(snapshot)})`;
      await sql`INSERT INTO events (job_id, event_id, job_seq, type, payload_json)
        VALUES (${jobId}, 'retirement-history', 1, 'progress', ${sql.json({ evidence_ref: "evidence://immutable-fixture" })})`;
      const [audit] = await sql`INSERT INTO audit_logs (actor_type, actor_id, action, resource_type, resource_id, after_json)
        VALUES ('system', 'fixture', 'retirement.history', 'job', ${jobId}, ${sql.json(snapshot)}) RETURNING id`;
      const history = async () => ({
        jobs: await sql`SELECT * FROM jobs WHERE id = ${jobId}`,
        events: await sql`SELECT * FROM events WHERE job_id = ${jobId}`,
        audit: await sql`SELECT * FROM audit_logs WHERE id = ${audit!.id}`,
        versions: await sql`SELECT * FROM runtime_image_versions WHERE id = ANY(${ids.map((id) => id.versionId)}::uuid[]) ORDER BY id`,
      });
      const before = await history();
      const market = (await app.inject({ method: "GET", url: "/runtime-images" })).json();
      assert.equal(market.some((row: { image_key: string }) => RETIRED_RUNTIME_IMAGE_KEYS.includes(row.image_key as typeof RETIRED_RUNTIME_IMAGE_KEYS[number])), false);
      const overrides = await runtime.runtimeImageRegistryWithOverrides();
      assert.equal(overrides.images.length, 11, "trusted old official DB rows cannot refill the catalog");
      assert.equal((await runtime.listHubRuntimeImageCatalog(sql, projectId)).some((row) => row.image_key === ids[0]!.imageKey), false);
      for (const { imageKey, imageId, versionId } of ids) {
        const payload = { image_key: imageKey, name: imageKey, publisher: "fixture", image_ref: imageRef };
        for (const request of [
          { method: "POST" as const, url: "/runtime-images/manual-digest", payload },
          { method: "POST" as const, url: "/runtime-images/import", payload },
          { method: "POST" as const, url: `/runtime-images/${imageId}/official-digest`, payload: { image_ref: imageRef } },
          { method: "POST" as const, url: `/runtime-images/${imageId}/adopt-local`, payload: { image_ref: imageRef, expected_image_id: digest } },
          { method: "POST" as const, url: `/runtime-image-versions/${versionId}/rescan` },
          { method: "POST" as const, url: `/runtime-image-versions/${versionId}/status`, payload: { status: "trusted" } },
          { method: "PUT" as const, url: `/projects/${projectId}/runtime-images/${imageId}`, payload: { enabled: true } },
          { method: "POST" as const, url: "/runtime-images/registry/pull", payload: { items: [{ image_key: imageKey, image_ref: imageRef }] } },
        ]) {
          const response = await app.inject(request);
          assert.equal(response.statusCode, 410, `${request.url}: ${response.payload}`);
          assert.equal(response.json().error_code, "RUNTIME_IMAGE_RETIRED");
        }
        await assert.rejects(runtime.resolveRuntimeImageForJob(sql, projectId, "audit", imageKey), RuntimeImageRetiredError);
        await assert.rejects(runtime.resolveRuntimeImageForProjectBinding(sql, imageId, versionId), RuntimeImageRetiredError);
      }
      assert.equal((await sql`SELECT s.id FROM runtime_image_scans s JOIN runtime_image_versions v ON v.id = s.runtime_image_version_id
        WHERE v.runtime_image_id = ANY(${ids.map((id) => id.imageId)}::uuid[])`).length, 0);
      assert.deepEqual(await history(), before, "no historical Job, evidence ref, audit or version rebinding");
      // Old enabled bindings/role selections cannot veto a channel change for current products.
      const currentId = randomUUID();
      const currentVersionId = randomUUID();
      const currentKey = "deepsonar-channel-current";
      const currentDigest = `sha256:${"b".repeat(64)}`;
      const currentRef = `ghcr.io/example/${currentKey}@${currentDigest}`;
      const targetRef = `docker.io/example/${currentKey}@${currentDigest}`;
      await sql`INSERT INTO runtime_images (id, image_key, name, publisher, source_kind, official)
        VALUES (${currentId}, ${currentKey}, 'current channel fixture', 'fixture', 'official', true)`;
      await sql`INSERT INTO runtime_image_versions (id, runtime_image_id, version, image_ref, resolved_ref, digest, trust_status, platforms_json, scan_summary_json)
        VALUES (${currentVersionId}, ${currentId}, '999.0.0', ${currentRef}, ${currentRef}, ${currentDigest}, 'trusted',
          ${sql.json([runtime.hostRuntimePlatform()])}, ${sql.json({ manual: raw.images[0].versions[0].manual })})`;
      await sql`INSERT INTO runtime_image_version_refs (version_id, channel, image_ref, resolved_ref, digest)
        VALUES (${currentVersionId}, 'github', ${currentRef}, ${currentRef}, ${currentDigest}),
               (${currentVersionId}, 'dockerhub', ${targetRef}, ${targetRef}, ${currentDigest})`;
      for (const imageId of [...ids.map((id) => id.imageId), currentId]) {
        await sql`INSERT INTO project_runtime_images (project_id, runtime_image_id, enabled) VALUES (${projectId}, ${imageId}, true)`;
      }
      await sql`UPDATE role_configs SET runtime_image_key = ${ids[0]!.imageKey} WHERE project_id IS NULL`;
      await sql`UPDATE role_configs rc SET runtime_image_key = ${currentKey} FROM agent_roles r
        WHERE rc.role_id = r.id AND rc.project_id IS NULL AND r.name = 'audit'`;
      const rolesBefore = await sql`SELECT * FROM role_configs ORDER BY id`;
      const historyBeforeChannel = await history();
      const { config } = await import("./config.js");
      const { activateRuntimeImageConfiguration } = await import("./runtime-image-config-activation.js");
      const previousRuntime = { agentMode: config.runtime.agentMode, provider: config.runtime.provider };
      Reflect.set(config.runtime, "agentMode", "real");
      Reflect.set(config.runtime, "provider", "opensandbox");
      try {
        const snapshots = await runtime.resolveConfiguredRuntimeImagesForChannel(sql, "dockerhub");
        assert.deepEqual(snapshots.map((snapshot) => [snapshot.image_key, snapshot.image_ref]), [[currentKey, targetRef]]);
        await assert.rejects(runtime.resolveConfiguredRuntimeImagesForChannel(sql, "aliyun-acr"), runtime.RuntimeImageChannelUnavailableError,
          "current products still enforce the selected-channel contract");
        const activation = await activateRuntimeImageConfiguration({
          refs: snapshots.map((snapshot) => ({ image_key: snapshot.image_key, image_ref: snapshot.image_ref })),
          purpose: "retirement-channel-fixture",
          requestPreparation: async (refs) => {
            assert.deepEqual(refs, [{ image_key: currentKey, image_ref: targetRef }]);
            return { ready: true }; // Inject readiness: no Docker inspection/pull in this PG contract test.
          },
          persist: () => sql.begin(async (tx) => runtime.updateRuntimeRegistryChannel(tx as unknown as typeof sql, "dockerhub")),
        });
        assert.equal(activation.status, "saved");
        assert.equal(await runtime.readRuntimeRegistryChannel(sql), "dockerhub");
        for (const { imageId } of ids) {
          const url = `/projects/${projectId}/runtime-images/${imageId}`;
          const disabled = await app.inject({ method: "PUT", url, payload: { enabled: false } });
          assert.equal(disabled.statusCode, 200, disabled.payload);
          assert.equal(disabled.json().enabled, false);
          const enabled = await app.inject({ method: "PUT", url, payload: { enabled: true } });
          assert.equal(enabled.statusCode, 410);
          assert.equal(enabled.json().error_code, "RUNTIME_IMAGE_RETIRED");
          const [binding] = await sql`SELECT enabled FROM project_runtime_images WHERE project_id = ${projectId} AND runtime_image_id = ${imageId}`;
          assert.equal(binding!.enabled, false, "failed re-enable must not undo the user's restriction");
        }
      } finally {
        Object.assign(config.runtime, previousRuntime);
      }
      assert.deepEqual(await sql`SELECT * FROM role_configs ORDER BY id`, rolesBefore, "channel preparation does not replace retired role selections with base");
      assert.deepEqual(await history(), historyBeforeChannel, "channel change and binding disable preserve historical facts/versions");
      // Removed official identity and even an absent DB row cannot permit third-party re-registration.
      await sql`UPDATE runtime_images SET official = false, source_kind = 'third_party' WHERE id = ${ids[1]!.imageId}`;
      await sql`DELETE FROM runtime_images WHERE id = ${ids[2]!.imageId}`;
      for (const { imageKey } of ids) {
        for (const url of ["/runtime-images/manual-digest", "/runtime-images/import"]) {
          const response = await app.inject({ method: "POST", url, payload: { image_key: imageKey, name: "fixture", publisher: "fixture", image_ref: imageRef } });
          assert.equal(response.statusCode, 410);
          assert.equal(response.json().error_code, "RUNTIME_IMAGE_RETIRED");
        }
      }
      const legitimate = await app.inject({ method: "POST", url: "/runtime-images/manual-digest", payload: {
        image_key: "deepsonar-clickhouse-audit-custom", name: "legitimate lookalike", publisher: "fixture", image_ref: imageRef,
      } });
      assert.equal(legitimate.statusCode, 201, legitimate.payload);
    } finally {
      globalThis.fetch = originalFetch;
      await closeApp?.();
      await closeSql?.();
      if (created) await admin.unsafe(`DROP DATABASE "${database}"`);
      await admin.end();
    }
  });
}
