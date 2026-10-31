import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import {
  CanvasRelationsResponse, FindingRelationsResponse, IdentityMappingResponse, IdentitySourceResponse,
} from "./relation-schemas.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!databaseUrl) {
  test("root relation HTTP authorization requires disposable PostgreSQL", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  test("root registered relation APIs enforce real Management and Job tokens over HTTP and SQL", { timeout: 120_000 }, async (t) => {
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = `relation_http_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(databaseUrl);
    target.pathname = `/${databaseName}`;
    target.search = "";
    let created = false;
    let closeApp: (() => Promise<unknown>) | undefined;
    let closeSql: (() => Promise<unknown>) | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      created = true;
      process.env.DATABASE_URL = target.toString();
      process.env.AGENT_MODE = "fake";
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = randomBytes(32).toString("hex");
      process.env.DEEPSONAR_MASTER_KEY_FILE = "";
      const [{ default: Fastify }, { default: websocket }, { migrate, sql }, { registerRoutes }, { generateToken }, capability, identity, store] = await Promise.all([
        import("fastify"), import("@fastify/websocket"), import("../../db.js"), import("../../routes.js"),
        import("../../auth.js"), import("../platform-api/tokens.js"), import("./identity.js"), import("./relation-store.js"),
      ]);
      closeSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = Fastify({ logger: false });
      closeApp = () => app.close();
      await app.register(websocket);
      registerRoutes(app);
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const project = randomUUID();
      const foreignProject = randomUUID();
      const canvas = randomUUID();
      const foreignCanvas = randomUUID();
      const jobs = [randomUUID(), randomUUID(), randomUUID()];
      const findings = [randomUUID(), randomUUID(), randomUUID()];
      const controlJob = randomUUID();
      await sql`INSERT INTO projects(id,name) VALUES (${project},'relation HTTP own'),(${foreignProject},'relation HTTP foreign')`;
      await sql`INSERT INTO canvases(id,project_id,title) VALUES
        (${canvas},${project},'relation HTTP own'),(${foreignCanvas},${foreignProject},'relation HTTP foreign')`;
      for (let index = 0; index < findings.length; index += 1) {
        const p = index === 2 ? foreignProject : project;
        const c = index === 2 ? foreignCanvas : canvas;
        await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
          VALUES (${jobs[index]},${p},${c},'audit','succeeded','{}')`;
        await sql`INSERT INTO findings(id,project_id,job_id,fingerprint,title,summary)
          VALUES (${findings[index]},${p},${jobs[index]},${`http-${index}`},'fixture declaration','fixture summary')`;
      }
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,started_at,timeout_sec,agent_snapshot_json)
        VALUES (${controlJob},${project},${canvas},'audit','running',now(),600,
          ${sql.json({ platform_tools: ["emit_progress"], role_name: "audit" })})`;
      const token = async (name: string, scopes: string[], projectId: string | null) => {
        const value = generateToken();
        const [row] = await sql`INSERT INTO api_tokens(name,project_id,token_prefix,token_hash,scopes)
          VALUES (${name},${projectId},${value.prefix},${value.hash},${scopes}) RETURNING id`;
        return { value: value.plaintext, id: String(row.id) };
      };
      const reader = await token("relation reader", ["findings:read"], project);
      const otherScope = await token("relation tasks only", ["tasks:read"], project);
      const ownAdmin = await token("relation project admin", ["admin"], project);
      const globalAdmin = await token("relation global admin", ["admin"], null);
      const grant = await capability.mintJobCapabilityToken(controlJob);
      const request = async (method: "GET" | "POST", path: string, bearer?: string, body?: unknown) => {
        const response = await fetch(address + path, {
          method,
          headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() as any, cache: response.headers.get("cache-control") };
      };
      const sourceBody = {
        authority_version: "operator-fixture/v1", source_kind: "platform_inventory",
        source_ref: "attestation://fixture/current", freshness_until: "2099-01-01T00:00:00.000Z",
        identity_fields: Object.fromEntries(identity.STRONG_IDENTITY_FIELDS.map((field) => [field, identity.digestIdentityValue(`http-${field}`)])),
      };
      const base = `/findings/${findings[0]}`;
      let sourceId = "";
      let foreignSourceId = "";

      await t.test("real Management authentication and findings:read scopes protect both read paths", async () => {
        for (const path of [base + "/relations", `/canvases/${canvas}/finding-relations`]) {
          assert.equal((await request("GET", path)).status, 401);
          assert.equal((await request("GET", path, otherScope.value)).status, 403);
          const own = await request("GET", path, reader.value);
          assert.equal(own.status, 200, JSON.stringify(own.body));
          assert.equal(own.cache, "no-store");
          assert.deepEqual(own.body.items, []);
          assert.equal(own.body.published, false);
          assert.equal(own.body.quality_gate_status, "not_evaluated");
          assert.equal(own.body.authority_basis, "platform_admin_attestation");
          assert.equal(own.body.independent_external_verification, false);
        }
        for (const path of [`/findings/${findings[2]}/relations`, `/canvases/${foreignCanvas}/finding-relations`]) {
          const denied = await request("GET", path, reader.value);
          assert.equal(denied.status, 403);
          assert.equal(denied.body.error_code, "PROJECT_MISMATCH");
        }
      });

      await t.test("a live Job capability token works on Control but cannot write any Management identity route", async () => {
        const accepted = await request("GET", `/control/v1/jobs/${controlJob}/capabilities`, grant.token);
        assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
        const paths = ["identity-sources", `identity-sources/${randomUUID()}/revisions`, `identity-sources/${randomUUID()}/revoke`, "identity-mappings", "identity-mappings/remap", "identity-mappings/revoke"];
        for (const path of paths) {
          assert.equal((await request("POST", base + "/" + path, grant.token, sourceBody)).status, 401);
          assert.equal((await request("POST", base + "/" + path, reader.value, sourceBody)).status, 403);
        }
        const [count] = await sql`SELECT count(*)::int AS n FROM project_finding_identity_sources`;
        assert.equal(count.n, 0);
      });

      await t.test("source registration uses the authenticated principal and strict typed manifests", async () => {
        for (const patch of [{ registered_by: "caller" }, { actor: { type: "internal" } }, { content_sha256: sourceBody.identity_fields.asset }, { identity_fields: {} }]) {
          const rejected = await request("POST", base + "/identity-sources", ownAdmin.value, { ...sourceBody, ...patch });
          assert.equal(rejected.status, 400);
          assert.equal(rejected.body.error_code, "INVALID_IDENTITY_SOURCE");
        }
        const createdSource = await request("POST", base + "/identity-sources", ownAdmin.value, sourceBody);
        assert.equal(createdSource.status, 201, JSON.stringify(createdSource.body));
        IdentitySourceResponse.parse(createdSource.body);
        assert.equal(createdSource.body.registered_by, ownAdmin.id);
        assert.equal(createdSource.body.current_revision, 1);
        sourceId = createdSource.body.source_id;
        const foreignSource = await request("POST", `/findings/${findings[2]}/identity-sources`, globalAdmin.value, sourceBody);
        assert.equal(foreignSource.status, 201);
        foreignSourceId = foreignSource.body.source_id;
        const ownSecond = await request("POST", `/findings/${findings[1]}/identity-sources`, ownAdmin.value, sourceBody);
        assert.equal(ownSecond.status, 201);
        for (const field of identity.STRONG_IDENTITY_FIELDS) {
          const mapped = await request("POST", `/findings/${findings[1]}/identity-mappings`, ownAdmin.value,
            { source_id: ownSecond.body.source_id, field, expected_mapping_version: null });
          assert.equal(mapped.status, 201, JSON.stringify(mapped.body));
        }
      });

      await t.test("project admin cannot write foreign Findings or select a foreign source under an own Finding", async () => {
        const foreignBase = `/findings/${findings[2]}`;
        for (const path of ["identity-sources", `identity-sources/${foreignSourceId}/revisions`, `identity-sources/${foreignSourceId}/revoke`, "identity-mappings", "identity-mappings/remap", "identity-mappings/revoke"]) {
          const denied = await request("POST", foreignBase + "/" + path, ownAdmin.value, sourceBody);
          assert.equal(denied.status, 403);
          assert.equal(denied.body.error_code, "PROJECT_MISMATCH");
        }
        const foreignSelection = await request("POST", base + "/identity-mappings", ownAdmin.value,
          { source_id: foreignSourceId, field: "asset", expected_mapping_version: null });
        assert.equal(foreignSelection.status, 404);
        assert.equal(foreignSelection.body.error_code, "IDENTITY_SOURCE_NOT_FOUND");
        const foreignRevision = await request("POST", base + `/identity-sources/${foreignSourceId}/revisions`, ownAdmin.value,
          { ...sourceBody, expected_source_revision: 1 });
        assert.equal(foreignRevision.status, 404);
        assert.equal(foreignRevision.body.error_code, "IDENTITY_SOURCE_NOT_FOUND");
        const [foreign] = await sql`SELECT current_revision,revoked_at FROM project_finding_identity_sources WHERE source_id=${foreignSourceId}`;
        assert.equal(foreign.current_revision, 1);
        assert.equal(foreign.revoked_at, null);
      });

      await t.test("mapping input cannot self-report source metadata; derived relations remain publicly suppressed", async () => {
        const mapping = { source_id: sourceId, field: "asset", expected_mapping_version: null };
        for (const patch of [{ identity_digest: sourceBody.identity_fields.asset }, { source_revision: 1 }, { source_kind: "platform_inventory" }, { source_ref: "caller" }, { source_digest: "caller" }]) {
          const rejected = await request("POST", base + "/identity-mappings", ownAdmin.value, { ...mapping, ...patch });
          assert.equal(rejected.status, 400);
          assert.equal(rejected.body.error_code, "INVALID_IDENTITY_MAPPING");
        }
        for (const field of identity.STRONG_IDENTITY_FIELDS) {
          const mapped = await request("POST", base + "/identity-mappings", ownAdmin.value, { ...mapping, field });
          assert.equal(mapped.status, 201, JSON.stringify(mapped.body));
          IdentityMappingResponse.parse(mapped.body);
          assert.equal(mapped.body.identity_digest, sourceBody.identity_fields[field]);
          assert.equal(mapped.body.source_revision, 1);
        }
        for (let index = 0; index < 12; index += 1) {
          await sql`UPDATE project_finding_relation_work SET next_run_at=now() WHERE project_id=${project}`;
          await store.processStrongRelationBatch(sql);
          const [work] = await sql`SELECT status FROM project_finding_relation_work WHERE project_id=${project}`;
          if (work?.status === "succeeded") break;
        }
        const [derived] = await sql`SELECT count(*)::int AS n FROM project_finding_relations WHERE project_id=${project}`;
        assert.ok(derived.n > 0, "the suppression check requires an actual derived relation");
        const page = await request("GET", base + "/relations", reader.value);
        assert.equal(page.status, 200, JSON.stringify(page.body));
        FindingRelationsResponse.parse(page.body);
        assert.equal(page.body.status, "succeeded");
        assert.equal(page.body.identity_status, "authoritative");
        assert.deepEqual(page.body.items, []);
        const map = await request("GET", `/canvases/${canvas}/finding-relations`, reader.value);
        assert.equal(map.status, 200);
        CanvasRelationsResponse.parse(map.body);
        assert.deepEqual(map.body.items, []);
        for (const path of [base + "/relations?includeSuppressed=true", `/canvases/${canvas}/finding-relations?includeSuppressed=true`]) {
          const rejected = await request("GET", path, reader.value);
          assert.equal(rejected.status, 400);
          assert.equal(rejected.body.error_code, "INVALID_QUERY");
        }
      });

      await t.test("source revision, mapping remap, and both revocations enforce CAS and invalidate current reads", async () => {
        const revisedBody = { ...sourceBody, source_ref: "attestation://fixture/revised", expected_source_revision: 1 };
        const revised = await request("POST", base + `/identity-sources/${sourceId}/revisions`, ownAdmin.value, revisedBody);
        assert.equal(revised.status, 201, JSON.stringify(revised.body));
        IdentitySourceResponse.parse(revised.body);
        assert.equal(revised.body.current_revision, 2);
        const staleRevision = await request("POST", base + `/identity-sources/${sourceId}/revisions`, ownAdmin.value, revisedBody);
        assert.equal(staleRevision.status, 409);
        assert.equal(staleRevision.body.error_code, "IDENTITY_SOURCE_CAS_CONFLICT");
        const stale = await request("GET", base + "/relations", reader.value);
        assert.equal(stale.body.identity_status, "insufficient_information");
        assert.deepEqual(stale.body.items, []);
        const remapBody = { field: "asset", source_id: sourceId, expected_mapping_version: 1, reason: "source revised" };
        const remapped = await request("POST", base + "/identity-mappings/remap", ownAdmin.value, remapBody);
        assert.equal(remapped.status, 201, JSON.stringify(remapped.body));
        IdentityMappingResponse.parse(remapped.body);
        assert.equal(remapped.body.mapping_version, 2);
        assert.equal(remapped.body.source_revision, 2);
        const conflict = await request("POST", base + "/identity-mappings/remap", ownAdmin.value, remapBody);
        assert.equal(conflict.status, 409);
        assert.equal(conflict.body.error_code, "IDENTITY_MAPPING_CAS_CONFLICT");
        const revokeBody = { field: "asset", expected_mapping_version: 2, reason: "withdrawn" };
        const revokedMapping = await request("POST", base + "/identity-mappings/revoke", ownAdmin.value, revokeBody);
        assert.equal(revokedMapping.status, 200);
        IdentityMappingResponse.parse(revokedMapping.body);
        assert.ok(revokedMapping.body.revoked_at);
        const repeat = await request("POST", base + "/identity-mappings/revoke", ownAdmin.value, revokeBody);
        assert.equal(repeat.body.revoked_at, revokedMapping.body.revoked_at);
        const sourceRevoke = { expected_source_revision: 2, reason: "source withdrawn" };
        const revokedSource = await request("POST", base + `/identity-sources/${sourceId}/revoke`, ownAdmin.value, sourceRevoke);
        assert.equal(revokedSource.status, 200);
        IdentitySourceResponse.parse(revokedSource.body);
        assert.ok(revokedSource.body.revoked_at);
        const sourceRepeat = await request("POST", base + `/identity-sources/${sourceId}/revoke`, ownAdmin.value, sourceRevoke);
        assert.equal(sourceRepeat.body.revoked_at, revokedSource.body.revoked_at);
        const [history] = await sql`SELECT count(*)::int AS n FROM project_finding_identity_source_revisions WHERE source_id=${sourceId}`;
        assert.equal(history.n, 2);
      });

      await t.test("invalid UUIDs and cursors return stable HTTP codes, while missing valid resources remain 404", async () => {
        const invalid = "-".repeat(36);
        for (const path of [`/findings/${invalid}/relations`, `/canvases/${invalid}/finding-relations`]) {
          const response = await request("GET", path, reader.value);
          assert.equal(response.status, 400);
          assert.equal(response.body.error_code, "INVALID_ID");
        }
        const badSource = await request("POST", base + `/identity-sources/${invalid}/revisions`, ownAdmin.value,
          { ...sourceBody, expected_source_revision: 1 });
        assert.equal(badSource.status, 400);
        assert.equal(badSource.body.error_code, "INVALID_IDENTITY_SOURCE");
        const badMapping = await request("POST", base + "/identity-mappings", ownAdmin.value,
          { field: "asset", source_id: invalid, expected_mapping_version: null });
        assert.equal(badMapping.status, 400);
        assert.equal(badMapping.body.error_code, "INVALID_IDENTITY_MAPPING");
        const cursor = Buffer.from(JSON.stringify({ v: 1, kind: "finding_strong_relations", project, subject: findings[0], after: invalid, binding: "a".repeat(64) })).toString("base64url");
        const badCursor = await request("GET", base + "/relations?cursor=" + cursor, reader.value);
        assert.equal(badCursor.status, 400);
        assert.equal(badCursor.body.error_code, "INVALID_CURSOR");
        assert.equal((await request("GET", `/findings/${randomUUID()}/relations`, globalAdmin.value)).status, 404);
        assert.equal((await request("GET", `/canvases/${randomUUID()}/finding-relations`, globalAdmin.value)).status, 404);
      });
    } finally {
      if (closeApp) await closeApp();
      if (closeSql) await closeSql();
      if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  });
}
