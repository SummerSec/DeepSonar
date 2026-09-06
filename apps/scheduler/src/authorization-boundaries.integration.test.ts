import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type InjectResponse = { statusCode: number; payload: string };

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("authorization boundary integration requires TEST_DATABASE_URL (skipped)", {
    skip: "TEST_DATABASE_URL is not set",
  }, () => {});
} else {
  test("token subset, job tenancy, image catalog, usage, and transfer stay inside actor bounds", async () => {
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = (await import("postgres")).default(adminUrl.toString(), { max: 1 });
    const databaseName = `deepsonar_authz_${process.pid}_${Date.now()}_${randomUUID().slice(0, 8)}`;
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
      process.env.DEEPSONAR_AUTH_REQUIRED = "true";
      process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
      process.env.AGENT_MODE = "fake";

      const [fastifyModule, websocketModule, dbModule, routesModule, authModule, usersModule] = await Promise.all([
        import("fastify"),
        import("@fastify/websocket"),
        import("./db.js"),
        import("./routes.js"),
        import("./auth.js"),
        import("./users.js"),
      ]);
      const { default: Fastify } = fastifyModule;
      const { default: websocket } = websocketModule;
      const { migrate, sql } = dbModule;
      const { registerRoutes } = routesModule;
      const { generateToken } = authModule;
      const { createUser, issueUserSession } = usersModule;
      endSql = () => sql.end({ timeout: 5 });
      await migrate();
      const app = Fastify({ logger: false });
      await app.register(websocket);
      registerRoutes(app);
      await app.ready();
      closeApp = () => app.close();

      const ownProjectId = randomUUID();
      const otherProjectId = randomUUID();
      await sql`
        INSERT INTO projects (id, name)
        VALUES (${ownProjectId}, 'authz own'),
               (${otherProjectId}, 'authz other')`;

      const insertToken = async (name: string, scopes: string[], projectId: string | null) => {
        const token = generateToken();
        const [row] = await sql`
          INSERT INTO api_tokens (name, project_id, token_prefix, token_hash, scopes)
          VALUES (${name}, ${projectId}, ${token.prefix}, ${token.hash}, ${scopes})
          RETURNING id`;
        return { id: row.id as string, plaintext: token.plaintext, headers: { authorization: `Bearer ${token.plaintext}` } };
      };

      const managerScopes = [
        "tokens:manage",
        "tasks:read",
        "tasks:write",
        "projects:read",
        "images:read",
        "images:manage",
        "images:approve",
        "exports:read",
        "exports:write",
        "imports:read",
        "imports:write",
      ];
      const adminTok = await insertToken("authz-admin", ["admin"], null);
      const operatorTok = await insertToken("authz-operator", managerScopes, null);
      const projectTok = await insertToken("authz-project", managerScopes, ownProjectId);
      const otherProjectTok = await insertToken("authz-other-project", managerScopes, otherProjectId);
      const elevatedInProject = await insertToken(
        "authz-elevated-sibling",
        ["tokens:manage", "admin"],
        ownProjectId,
      );

      const inject = async (
        method: HttpMethod,
        url: string,
        headers: Record<string, string>,
        payload?: unknown,
      ): Promise<InjectResponse> => {
        const options: Record<string, unknown> = { method, url, headers };
        if (payload !== undefined) options.payload = payload;
        return app.inject(options as never) as unknown as Promise<InjectResponse>;
      };

      const operatorUser = await createUser({
        username: `op-${randomUUID().slice(0, 8)}`,
        password: `${randomUUID()}A!`,
        role: "operator",
      });
      const operatorSession = await issueUserSession(operatorUser.id);
      const operatorUserHeaders = { authorization: `Bearer ${operatorSession.token}` };

      // ----- P0 token subset / ownership -----
      {
        const escalate = await inject("POST", "/tokens", projectTok.headers, {
          name: "escalated",
          scopes: ["admin"],
        });
        assert.equal(escalate.statusCode, 403, escalate.payload);
        assert.equal(JSON.parse(escalate.payload).error_code, "SCOPE_EXCEEDS_ACTOR");

        const extraScope = await inject("POST", "/tokens", projectTok.headers, {
          name: "extra-images",
          scopes: ["tokens:manage", "skills:write"],
        });
        assert.equal(extraScope.statusCode, 403, extraScope.payload);
        assert.equal(JSON.parse(extraScope.payload).error_code, "SCOPE_EXCEEDS_ACTOR");

        const global = await inject("POST", "/tokens", projectTok.headers, {
          name: "forced-global",
          scopes: ["tasks:read"],
          project_id: null,
        });
        assert.equal(global.statusCode, 201, global.payload);
        assert.equal(JSON.parse(global.payload).project_id, ownProjectId);

        const cross = await inject("POST", "/tokens", projectTok.headers, {
          name: "cross-project",
          scopes: ["tasks:read"],
          project_id: otherProjectId,
        });
        assert.equal(cross.statusCode, 403, cross.payload);
        assert.equal(JSON.parse(cross.payload).error_code, "PROJECT_MISMATCH");

        const created = await inject("POST", "/tokens", projectTok.headers, {
          name: "own-subset",
          scopes: ["tokens:manage", "tasks:read"],
        });
        assert.equal(created.statusCode, 201, created.payload);
        const createdBody = JSON.parse(created.payload) as { id: string; project_id: string; scopes: string[] };
        assert.equal(createdBody.project_id, ownProjectId);
        assert.deepEqual(createdBody.scopes, ["tokens:manage", "tasks:read"]);

        const listed = await inject("GET", "/tokens", projectTok.headers);
        assert.equal(listed.statusCode, 200, listed.payload);
        const listedIds = new Set((JSON.parse(listed.payload) as Array<{ id: string }>).map((row) => row.id));
        assert.equal(listedIds.has(createdBody.id), true);
        assert.equal(listedIds.has(projectTok.id), true);
        assert.equal(listedIds.has(adminTok.id), false);
        assert.equal(listedIds.has(otherProjectTok.id), false);
        assert.equal(listedIds.has(elevatedInProject.id), false);

        const revokeOther = await inject("POST", `/tokens/${otherProjectTok.id}/revoke`, projectTok.headers);
        assert.equal(revokeOther.statusCode, 403, revokeOther.payload);
        assert.equal(JSON.parse(revokeOther.payload).error_code, "PROJECT_MISMATCH");
        const [stillOther] = await sql`SELECT revoked_at FROM api_tokens WHERE id = ${otherProjectTok.id}`;
        assert.equal(stillOther.revoked_at, null);

        const rotateElevated = await inject("POST", `/tokens/${elevatedInProject.id}/rotate`, projectTok.headers);
        assert.equal(rotateElevated.statusCode, 403, rotateElevated.payload);
        assert.equal(JSON.parse(rotateElevated.payload).error_code, "SCOPE_EXCEEDS_ACTOR");

        const rotated = await inject("POST", `/tokens/${createdBody.id}/rotate`, projectTok.headers);
        assert.equal(rotated.statusCode, 201, rotated.payload);
        const rotatedBody = JSON.parse(rotated.payload) as { scopes: string[]; project_id: string };
        assert.deepEqual(rotatedBody.scopes, ["tokens:manage", "tasks:read"]);
        assert.equal(rotatedBody.project_id, ownProjectId);

        const adminCreate = await inject("POST", "/tokens", adminTok.headers, {
          name: "admin-global",
          scopes: ["admin"],
        });
        assert.equal(adminCreate.statusCode, 201, adminCreate.payload);
        assert.equal(JSON.parse(adminCreate.payload).project_id, null);
      }

      // ----- P1 POST /jobs + existing /projects/:id compose/event hooks -----
      {
        const jobsBefore = await sql`SELECT count(*)::int AS n FROM jobs`;
        const canvasesBefore = await sql`SELECT count(*)::int AS n FROM canvases`;
        const crossJob = await inject("POST", "/jobs", projectTok.headers, {
          project_id: otherProjectId,
          type: "explore",
          title: "cross tenant",
        });
        assert.equal(crossJob.statusCode, 403, crossJob.payload);
        assert.equal(JSON.parse(crossJob.payload).error_code, "PROJECT_MISMATCH");
        const jobsAfter = await sql`SELECT count(*)::int AS n FROM jobs`;
        const canvasesAfter = await sql`SELECT count(*)::int AS n FROM canvases`;
        assert.equal(jobsAfter.n, jobsBefore.n);
        assert.equal(canvasesAfter.n, canvasesBefore.n);

        const ownJob = await inject("POST", "/jobs", projectTok.headers, {
          project_id: ownProjectId,
          type: "explore",
          title: "own job",
        });
        assert.notEqual(ownJob.statusCode, 403, ownJob.payload);

        const composeOther = await inject("POST", `/projects/${otherProjectId}/tasks`, projectTok.headers, {
          title: "compose other",
          content: "x",
          kind: "compose",
          seed_finding_ids: [randomUUID()],
        });
        assert.equal(composeOther.statusCode, 403, composeOther.payload);

        const eventOther = await inject("POST", `/projects/${otherProjectId}/events`, projectTok.headers, {
          source: "ci",
          event_type: "push",
          event_id: "dup-1",
          data: { ref: "main" },
        });
        assert.equal(eventOther.statusCode, 403, eventOther.payload);
        const eventAgain = await inject("POST", `/projects/${otherProjectId}/events`, projectTok.headers, {
          source: "ci",
          event_type: "push",
          event_id: "dup-1",
          data: { ref: "main" },
        });
        assert.equal(eventAgain.statusCode, 403, eventAgain.payload);
        const [eventCanvases] = await sql`
          SELECT count(*)::int AS n FROM canvases
          WHERE project_id = ${otherProjectId} AND trigger_event_id = 'dup-1'`;
        assert.equal(eventCanvases.n, 0);
      }

      // ----- P1 runtime-image catalog + usage -----
      const versionId = randomUUID();
      const imageId = randomUUID();
      await sql`
        INSERT INTO runtime_images (id, image_key, name, publisher, source_kind, official)
        VALUES (${imageId}, 'authz-fixture', 'Authz fixture', 'ci', 'third_party', false)`;
      await sql`
        INSERT INTO runtime_image_versions (id, runtime_image_id, version, trust_status)
        VALUES (${versionId}, ${imageId}, '1', 'trusted')`;
      const ownCanvasId = randomUUID();
      const otherCanvasId = randomUUID();
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${ownCanvasId}, ${ownProjectId}, 'own canvas', '{}'::jsonb),
               (${otherCanvasId}, ${otherProjectId}, 'other canvas', '{}'::jsonb)`;
      const ownJobId = randomUUID();
      const otherJobId = randomUUID();
      const snapshot = { runtime_image: { runtime_image_version_id: versionId } };
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES
          (${ownJobId}, ${ownProjectId}, ${ownCanvasId}, 'explore', 'succeeded', ${sql.json(snapshot as never)}),
          (${otherJobId}, ${otherProjectId}, ${otherCanvasId}, 'explore', 'succeeded', ${sql.json(snapshot as never)})`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, summary)
        VALUES
          (${randomUUID()}, ${ownProjectId}, ${ownJobId}, 'own-fp', 'own finding', 'own'),
          (${randomUUID()}, ${otherProjectId}, ${otherJobId}, 'other-fp', 'secret finding', 'leaked')`;

      const catalogMutations: Array<[HttpMethod, string, unknown]> = [
        ["PATCH", "/runtime-images/registry/channel", { channel: "github" }],
        ["POST", "/runtime-images/registry/sync", {}],
        ["POST", "/runtime-images/registry/apply", { schema: "deepsonar.registry/v2", images: [] }],
        ["POST", "/runtime-images/registry/pull", {}],
        ["POST", "/runtime-images/import", {
          image_key: "authz-import",
          name: "nope",
          publisher: "ci",
          image_ref: "ghcr.io/example/authz@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }],
        ["POST", "/runtime-images/manual-digest", {
          image_key: "authz-manual",
          name: "nope",
          publisher: "ci",
          image_ref: "ghcr.io/example/authz@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }],
        ["POST", `/runtime-images/${imageId}/official-digest`, {
          image_ref: "ghcr.io/example/authz@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }],
        ["POST", `/runtime-image-versions/${versionId}/rescan`, {}],
        ["POST", `/runtime-image-versions/${versionId}/status`, { status: "disabled" }],
      ];
      for (const [method, url, payload] of catalogMutations) {
        const projectDenied = await inject(method, url, projectTok.headers, payload);
        assert.equal(projectDenied.statusCode, 403, `${method} ${url}: ${projectDenied.payload}`);
        assert.equal(JSON.parse(projectDenied.payload).error_code, "PROJECT_SCOPE_FORBIDDEN");

        const operatorUserDenied = await inject(method, url, operatorUserHeaders, payload);
        assert.equal(operatorUserDenied.statusCode, 403, `operator user ${method} ${url}: ${operatorUserDenied.payload}`);
      }

      const operatorSync = await inject("POST", "/runtime-images/registry/sync", operatorTok.headers, {});
      assert.notEqual(operatorSync.statusCode, 403, operatorSync.payload);

      const usageProject = await inject("GET", `/runtime-image-versions/${versionId}/usage`, projectTok.headers);
      assert.equal(usageProject.statusCode, 200, usageProject.payload);
      const usageOwn = JSON.parse(usageProject.payload) as {
        projects: Array<{ id: string }>;
        jobs: Array<{ id: string; project_id: string }>;
        findings: Array<{ title: string; project_id: string }>;
      };
      assert.deepEqual(usageOwn.projects.map((row) => row.id), [ownProjectId]);
      assert.deepEqual(usageOwn.jobs.map((row) => row.project_id), [ownProjectId]);
      assert.equal(usageOwn.findings.some((row) => row.title === "secret finding"), false);

      const usageAdmin = await inject("GET", `/runtime-image-versions/${versionId}/usage`, adminTok.headers);
      assert.equal(usageAdmin.statusCode, 200, usageAdmin.payload);
      const usageAll = JSON.parse(usageAdmin.payload) as { projects: Array<{ id: string }> };
      assert.equal(new Set(usageAll.projects.map((row) => row.id)).has(otherProjectId), true);

      // ----- P1 transfer ownership / target_project_id -----
      const ownExportId = randomUUID();
      const otherExportId = randomUUID();
      const platformExportId = randomUUID();
      await sql`
        INSERT INTO data_exports (id, project_id, scope, preset, status, created_by)
        VALUES
          (${ownExportId}, ${ownProjectId}, 'project', 'configuration', 'succeeded', 'ci'),
          (${otherExportId}, ${otherProjectId}, 'project', 'configuration', 'succeeded', 'ci'),
          (${platformExportId}, NULL, 'platform', 'platform_full', 'succeeded', 'ci')`;
      const ownImportId = randomUUID();
      const otherImportId = randomUUID();
      const platformImportId = randomUUID();
      await sql`
        INSERT INTO data_imports (id, source_artifact_uri, source_sha256, scope, target_project_id, status, created_by)
        VALUES
          (${ownImportId}, '/tmp/authz-own.pack', 'aa', 'project', ${ownProjectId}, 'uploaded', 'ci'),
          (${otherImportId}, '/tmp/authz-other.pack', 'bb', 'project', ${otherProjectId}, 'uploaded', 'ci'),
          (${platformImportId}, '/tmp/authz-platform.pack', 'cc', 'platform', NULL, 'uploaded', 'ci')`;

      const otherExport = await inject("GET", `/exports/${otherExportId}`, projectTok.headers);
      assert.equal(otherExport.statusCode, 403, otherExport.payload);
      assert.equal(JSON.parse(otherExport.payload).error_code, "PROJECT_MISMATCH");
      const otherDownload = await inject("GET", `/exports/${otherExportId}/download`, projectTok.headers);
      assert.equal(otherDownload.statusCode, 403, otherDownload.payload);
      const cancelOther = await inject("POST", `/exports/${otherExportId}/cancel`, projectTok.headers);
      assert.equal(cancelOther.statusCode, 403, cancelOther.payload);
      const deleteOther = await inject("DELETE", `/exports/${otherExportId}`, projectTok.headers);
      assert.equal(deleteOther.statusCode, 403, deleteOther.payload);
      const [exportStill] = await sql`SELECT id FROM data_exports WHERE id = ${otherExportId}`;
      assert.ok(exportStill);

      const platformList = await inject("GET", "/platform/exports", projectTok.headers);
      assert.equal(platformList.statusCode, 403, platformList.payload);
      assert.equal(JSON.parse(platformList.payload).error_code, "PROJECT_SCOPE_FORBIDDEN");
      const platformCreate = await inject("POST", "/platform/exports", projectTok.headers, { preset: "platform_full" });
      assert.equal(platformCreate.statusCode, 403, platformCreate.payload);

      const ownExport = await inject("GET", `/exports/${ownExportId}`, projectTok.headers);
      assert.equal(ownExport.statusCode, 200, ownExport.payload);

      const otherImport = await inject("GET", `/imports/${otherImportId}`, projectTok.headers);
      assert.equal(otherImport.statusCode, 403, otherImport.payload);
      const platformImport = await inject("GET", `/imports/${platformImportId}`, projectTok.headers);
      assert.equal(platformImport.statusCode, 403, platformImport.payload);
      assert.equal(JSON.parse(platformImport.payload).error_code, "PROJECT_SCOPE_FORBIDDEN");
      const applyOther = await inject("POST", `/imports/${otherImportId}/apply`, projectTok.headers, {
        mode: "merge_configuration",
        target_project_id: otherProjectId,
      });
      assert.equal(applyOther.statusCode, 403, applyOther.payload);
      const applyCreateNew = await inject("POST", `/imports/${ownImportId}/apply`, projectTok.headers, {
        mode: "create_new",
      });
      assert.equal(applyCreateNew.statusCode, 403, applyCreateNew.payload);
      assert.equal(JSON.parse(applyCreateNew.payload).error_code, "PROJECT_SCOPE_FORBIDDEN");
      const applyPlatform = await inject("POST", `/imports/${ownImportId}/apply`, projectTok.headers, {
        mode: "merge_platform",
      });
      assert.equal(applyPlatform.statusCode, 403, applyPlatform.payload);
      const applyCrossTarget = await inject("POST", `/imports/${ownImportId}/apply`, projectTok.headers, {
        mode: "merge_configuration",
        target_project_id: otherProjectId,
      });
      assert.equal(applyCrossTarget.statusCode, 403, applyCrossTarget.payload);
      assert.equal(JSON.parse(applyCrossTarget.payload).error_code, "PROJECT_MISMATCH");
      const [importUnchanged] = await sql`SELECT status, target_project_id FROM data_imports WHERE id = ${ownImportId}`;
      assert.equal(importUnchanged.status, "uploaded");
      assert.equal(importUnchanged.target_project_id, ownProjectId);
      const [projectsUnchanged] = await sql`SELECT count(*)::int AS n FROM projects`;
      assert.equal(projectsUnchanged.n, 2);

      const operatorSeesOther = await inject("GET", `/exports/${otherExportId}`, operatorTok.headers);
      assert.equal(operatorSeesOther.statusCode, 200, operatorSeesOther.payload);
      const adminSeesPlatform = await inject("GET", `/exports/${platformExportId}`, adminTok.headers);
      assert.equal(adminSeesPlatform.statusCode, 200, adminSeesPlatform.payload);
    } finally {
      if (closeApp) await closeApp();
      if (endSql) await endSql();
      if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end({ timeout: 5 });
    }
  });
}
