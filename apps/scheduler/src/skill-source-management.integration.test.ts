import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  test("source management HTTP/PG requires an explicit test database", { skip: true }, () => {});
} else {
  test("global source management reuses identity and requires precise approval while project choices stay separate", async () => {
    const adminUrl = new URL(databaseUrl); adminUrl.pathname = "/postgres"; adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const name = `source_api_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(databaseUrl); target.pathname = `/${name}`; target.search = "";
    const blobDir = await mkdtemp(path.join(tmpdir(), "deepsonar-source-api-"));
    let created = false;
    let closeApp: (() => Promise<unknown>) | undefined;
    let closeSql: (() => Promise<unknown>) | undefined;
    const previous = { database: process.env.DATABASE_URL, blob: process.env.BLOB_DIR, mode: process.env.AGENT_MODE };
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`); created = true;
      process.env.DATABASE_URL = target.toString(); process.env.BLOB_DIR = blobDir; process.env.AGENT_MODE = "fake";
      const [{ sql, migrate }, { registerSkillSourceRoutes }, { validationHttpError }, { persistSkillSourceManifest },
        { contentHashOf }, { default: Fastify }] = await Promise.all([
        import("./db.js"), import("./domains/skill-source/routes.js"), import("./http-validation-error.js"),
        import("./job-skill-catalog.js"), import("./skill-sources.js"), import("fastify"),
      ]);
      closeSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = Fastify({ logger: false }); closeApp = () => app.close();
      let projectScope: string | null = null;
      app.addHook("onRequest", async (req) => {
        req.actor = { type: "api_token", id: null, name: "source-fixture", projectId: projectScope, scopes: ["skills:read", "skills:write"] };
      });
      app.setErrorHandler((error, _req, reply) => {
        const mapped = validationHttpError(error);
        reply.code(mapped?.statusCode ?? 500).send(mapped?.body ?? { error: "fixture unexpected error" });
      });
      registerSkillSourceRoutes(app); await app.ready();
      const requests = await Promise.all([
        app.inject({ method: "POST", url: "/skill-sources", payload: { name: `source-${randomUUID()}`, repo_url: "https://github.com/Fixture-Org/Source.git", branch: "main" } }),
        app.inject({ method: "POST", url: "/skill-sources", payload: { name: `source-${randomUUID()}`, repo_url: "https://github.com/fixture-org/source/", branch: "refs/heads/main" } }),
      ]);
      assert.deepEqual(requests.map((r) => r.statusCode).sort(), [200, 201]);
      const source = requests[0]!.json();
      assert.equal(source.id, requests[1]!.json().id);
      assert.equal(source.trust_status, "quarantined"); assert.equal(source.enabled, false);
      const conflict = await app.inject({ method: "POST", url: "/skill-sources", payload: { name: source.name, repo_url: "https://github.com/fixture-org/other.git" } });
      assert.equal(conflict.statusCode, 409); assert.equal(conflict.json().error_code, "SKILL_SOURCE_NAME_CONFLICT");
      const invalid = await app.inject({ method: "POST", url: "/skill-sources", payload: { name: "unsafe", repo_url: "https://github.com/fixture-org/source.git?token=synthetic-must-not-echo" } });
      assert.equal(invalid.statusCode, 400); assert.doesNotMatch(invalid.payload, /synthetic-must-not-echo/);
      const projectA = randomUUID(), projectB = randomUUID();
      await sql`INSERT INTO projects(id,name) VALUES(${projectA},'source project A'),(${projectB},'source project B')`;
      projectScope = projectA;
      for (const request of [
        { method: "POST" as const, url: "/skill-sources", payload: { name: "denied", repo_url: "https://github.com/fixture-org/denied.git" } },
        { method: "POST" as const, url: `/skill-sources/${source.id}/sync` },
        { method: "POST" as const, url: `/skill-sources/${source.id}/trust`, payload: { trust_status: "trusted" } },
        { method: "DELETE" as const, url: `/skill-sources/${source.id}` },
      ]) {
        const denied = await app.inject(request);
        assert.equal(denied.statusCode, 403, denied.payload); assert.equal(denied.json().error_code, "PLATFORM_SCOPE_REQUIRED");
      }
      const saved = await app.inject({ method: "PUT", url: `/projects/${projectA}/skill-sources/${source.id}`, payload: { enabled: false } });
      assert.equal(saved.statusCode, 200, saved.payload); assert.equal(saved.json().project_enabled, false);
      projectScope = null;
      const [current] = await sql`SELECT * FROM skill_sources WHERE id=${source.id}`;
      const catalog = [{ id: "skill:fixture/greet", kind: "skill" as const, plugin: "fixture", name: "greet", description: "fixture", files: { "SKILL.md": "# Greet\n" } }];
      const commit = "a".repeat(40);
      const hash = await persistSkillSourceManifest(sql as never, { sourceId: source.id, commitSha: commit, catalog });
      const candidate = { schema: "deepsonar.skill-source-candidate/v1", source_instance_id: current!.source_instance_id,
        repo_url: current!.repo_url, branch: current!.branch, revocation_epoch: String(current!.revocation_epoch),
        commit_sha: commit, content_hash: contentHashOf(catalog), module_count: 1, synced_at: new Date().toISOString(),
        synced_by: "fixture", files: { secret: "synthetic-candidate-body-must-not-leak" } };
      await sql`UPDATE skill_sources SET candidate_hash=${hash}, candidate_json=${sql.json(candidate)} WHERE id=${source.id}`;
      const detail = await app.inject({ method: "GET", url: `/skill-sources/${source.id}` });
      assert.equal(detail.json().candidate_hash, hash);
      assert.doesNotMatch(detail.payload, /synthetic-candidate-body-must-not-leak/);
      const nonce = { trust_status: "trusted", candidate_hash: hash, expected_epoch: String(current!.revocation_epoch), expected_instance_id: current!.source_instance_id };
      assert.equal((await app.inject({ method: "POST", url: `/skill-sources/${source.id}/trust`, payload: { trust_status: "trusted" } })).statusCode, 400);
      for (const patch of [{ candidate_hash: "f".repeat(64) }, { expected_instance_id: randomUUID() }, { expected_epoch: "999" }]) {
        const stale = await app.inject({ method: "POST", url: `/skill-sources/${source.id}/trust`, payload: { ...nonce, ...patch } });
        assert.equal(stale.statusCode, 409, stale.payload);
        const [unchanged] = await sql`SELECT catalog_snapshot_hash, trust_status, enabled FROM skill_sources WHERE id=${source.id}`;
        assert.equal(unchanged!.catalog_snapshot_hash, null); assert.equal(unchanged!.trust_status, "quarantined"); assert.equal(unchanged!.enabled, false);
      }
      const approved = await app.inject({ method: "POST", url: `/skill-sources/${source.id}/trust`, payload: nonce });
      assert.equal(approved.statusCode, 200, approved.payload); assert.equal(approved.json().catalog_snapshot_hash, hash);
      assert.equal(approved.json().candidate_hash, null); assert.equal(approved.json().enabled, true);
      for (const [id, expected] of [[projectA, false], [projectB, true]] as const) {
        const response = await app.inject({ method: "GET", url: `/projects/${id}/skill-sources` });
        assert.equal(response.statusCode, 200, response.payload);
        const bound = response.json().sources.find((s: { skill_source_id: string }) => s.skill_source_id === source.id);
        assert.equal(bound.project_enabled, expected); assert.equal(bound.catalog_snapshot_hash, hash);
        assert.equal(bound.source_instance_id, current!.source_instance_id);
      }
    } finally {
      await closeApp?.(); await closeSql?.();
      if (created) await admin.unsafe(`DROP DATABASE "${name}"`);
      await admin.end();
      for (const [key, value] of [["DATABASE_URL", previous.database], ["BLOB_DIR", previous.blob], ["AGENT_MODE", previous.mode]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      assert.equal(path.dirname(path.resolve(blobDir)), path.resolve(tmpdir()));
      assert.ok(path.basename(blobDir).startsWith("deepsonar-source-api-"));
      await rm(blobDir, { recursive: true, force: true });
    }
  });
}
