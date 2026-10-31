import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!databaseUrl) {
  test("strong relations require isolated PostgreSQL", { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  test("source registry, mapping CAS, current-source invalidation, HTTP scope, and canvas limits", async () => {
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const name = `relation_fixture_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(databaseUrl);
    target.pathname = `/${name}`;
    let close: (() => Promise<unknown>) | undefined;
    let appClose: (() => Promise<unknown>) | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      process.env.DATABASE_URL = target.toString();
      process.env.AGENT_MODE = "fake";
      const [{ migrate, sql }, identity, store, { default: Fastify }, routes] = await Promise.all([
        import("../../db.js"),
        import("./identity.js"),
        import("./relation-store.js"),
        import("fastify"),
        import("./relation-routes.js"),
      ]);
      close = () => sql.end({ timeout: 5 });
      await migrate();
      const [table] = await sql`SELECT to_regclass('public.project_finding_identity_sources') AS name`;
      assert.equal(String(table.name), "project_finding_identity_sources");

      const project = randomUUID();
      const foreignProject = randomUUID();
      const canvas = randomUUID();
      const foreignCanvas = randomUUID();
      const jobs = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const findings = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();
      const [sameProblem, differentInstance, thirdInstance, foreign] = findings;
      await sql`INSERT INTO projects(id,name) VALUES
        (${project},'strong relation fixture'),(${foreignProject},'foreign fixture')`;
      await sql`INSERT INTO canvases(id,project_id,title) VALUES
        (${canvas},${project},'relation fixture'),(${foreignCanvas},${foreignProject},'foreign relation fixture')`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
        VALUES (${jobs[0]},${project},${canvas},'audit','succeeded','{}'),
               (${jobs[1]},${project},${canvas},'audit','succeeded','{}'),
               (${jobs[2]},${project},${canvas},'audit','succeeded','{}'),
               (${jobs[3]},${foreignProject},${foreignCanvas},'audit','succeeded','{}')`;
      await sql`INSERT INTO findings(id,project_id,job_id,fingerprint,title,summary,profile,verify_status,disposition)
        VALUES (${sameProblem},${project},${jobs[0]},'same','first','first declaration','security.vulnerability','pending','open'),
               (${differentInstance},${project},${jobs[1]},'different','second','unrelated declaration','security.vulnerability','pending','open'),
               (${thirdInstance},${project},${jobs[2]},'third','third','another declaration','security.vulnerability','pending','open'),
               (${foreign},${foreignProject},${jobs[3]},'foreign','foreign','foreign declaration','security.vulnerability','pending','open')`;

      const actor = { type: "internal" as const, id: "platform-test", name: "platform-test", projectId: project, scopes: ["admin"] };
      const fields = [...identity.STRONG_IDENTITY_FIELDS];
      const sourceIds = new Map<string, string>();
      const valueFor = (findingId: string, field: (typeof fields)[number]): string => {
        if (field === "root_cause") return "cause-a";
        if (findingId === sameProblem) return `${field}-a`;
        if (findingId === differentInstance) return field === "asset" ? "asset-b" : `${field}-a`;
        if (findingId === thirdInstance) return `${field}-a`;
        return `${field}-a`;
      };
      const sourceFor = (findingId: string, field: (typeof fields)[number]) => ({
        authority_version: field === "root_cause" ? "root-cause/v1" : "inventory/v1",
        source_kind: field === "root_cause" ? "platform_root_cause" as const : "platform_inventory" as const,
        source_ref: `attestation://fixture/${findingId}/${field}`,
        freshness_until: "2099-01-01T00:00:00.000Z",
        identity_fields: { [field]: identity.digestIdentityValue(valueFor(findingId, field)) },
      });

      const app = Fastify({ logger: false });
      app.addHook("onRequest", async (request) => {
        request.actor = actor;
      });
      routes.registerFindingRelationRoutes(app);
      await app.ready();
      appClose = () => app.close();

      const httpSource = await app.inject({
        method: "POST",
        url: `/findings/${sameProblem}/identity-sources`,
        payload: sourceFor(sameProblem, "asset"),
      });
      assert.equal(httpSource.statusCode, 201, httpSource.payload);
      const registeredSource = httpSource.json();
      assert.equal(registeredSource.authority_basis, "platform_admin_attestation");
      assert.equal(registeredSource.independent_external_verification, false);
      assert.match(registeredSource.content_sha256, /^sha256:[a-f0-9]{64}$/u);
      sourceIds.set(`${sameProblem}:asset`, registeredSource.source_id);

      for (const findingId of findings) {
        for (const field of fields) {
          if (!sourceIds.has(`${findingId}:${field}`)) {
            const sourceProject = findingId === foreign ? foreignProject : project;
            const source = await store.registerIdentitySource(sourceProject, findingId, sourceFor(findingId, field), { ...actor, projectId: sourceProject }, sql);
            sourceIds.set(`${findingId}:${field}`, source.source_id);
          }
        }
      }

      for (const findingId of findings) {
        const findingProject = findingId === foreign ? foreignProject : project;
        for (const field of fields) {
          const sourceId = sourceIds.get(`${findingId}:${field}`)!;
          const result = findingId === sameProblem && field === "asset"
            ? (await app.inject({
              method: "POST",
              url: `/findings/${sameProblem}/identity-mappings`,
              payload: { source_id: sourceId, field, expected_mapping_version: null },
            })).json()
            : await store.registerIdentityMapping(findingProject, findingId, {
              source_id: sourceId, field, expected_mapping_version: null,
            }, { ...actor, projectId: findingProject }, sql);
          assert.equal(result.mapping_version, 1);
          assert.equal(result.identity_digest, sourceFor(findingId, field).identity_fields[field]);
          assert.equal(result.source_kind, sourceFor(findingId, field).source_kind);
          assert.equal(result.source_ref, sourceFor(findingId, field).source_ref);
          assert.match(result.source_digest, /^sha256:[a-f0-9]{64}$/u);
        }
      }

      const rejectedCallerClaims = await app.inject({
        method: "POST",
        url: `/findings/${sameProblem}/identity-mappings`,
        payload: {
          field: "asset",
          identity_digest: identity.digestIdentityValue("caller-controlled"),
          source_kind: "platform_inventory",
        },
      });
      assert.equal(rejectedCallerClaims.statusCode, 400);
      for (const findingId of [sameProblem, differentInstance, thirdInstance]) {
        const snapshot = await store.loadCurrentIdentitySnapshot(findingId, project, sql);
        assert.ok(fields.every((field) => snapshot.fields[field].status === "valid"), JSON.stringify(snapshot));
      }
      await store.requestStrongRelationRebuild(project, sql);
      await store.requestStrongRelationRebuild(foreignProject, sql);
      const processed: number[] = [];
      for (let attempt = 0; attempt < 16; attempt += 1) {
        await sql`UPDATE project_finding_relation_work SET next_run_at = now() WHERE status IN ('pending','running')`;
        processed.push(await store.processStrongRelationBatch(sql));
      }

      const [maintenance] = await sql`SELECT phase,generation,runtime_role,target_version,CURRENT_USER AS current_role FROM platform_upgrade_state WHERE id='global'`;
      const { maintenanceIdentityMatches } = await import("../../platform-maintenance.js");
      assert.equal(maintenanceIdentityMatches(maintenance as never, {
        generation: process.env.DEEPSONAR_UPGRADE_GENERATION ?? "", version: process.env.DEEPSONAR_VERSION ?? "",
      }), true, "The isolated fixture must use the active maintenance identity");
      const [work] = await sql`SELECT status,error_code,active_generation,next_run_at,now(),next_run_at<=now() AS ready FROM project_finding_relation_work WHERE project_id=${project}`;
      assert.notEqual(work.status, "failed", JSON.stringify(work));
      assert.ok(work.active_generation, JSON.stringify({ work, processed }));
      const page = await store.readStrongRelationPage(sameProblem, undefined, sql, project, true);
      assert.ok(page);
      assert.equal(page.published, false);
      assert.equal(page.quality_gate_status, "not_evaluated");
      assert.equal(page.read_status, "complete");
      assert.deepEqual(new Set(page.items.map((item) => item.kind)), new Set(["same_problem", "same_root_cause_different_instance"]));
      assert.ok(page.items.every((item) => item.finding_id !== foreign));
      assert.deepEqual((await store.readStrongRelationPage(sameProblem, undefined, sql, project))?.items, []);

      const sameAssetSourceId = sourceIds.get(`${sameProblem}:asset`)!;
      const [storedSource] = await sql`SELECT r.content_sha256, s.current_revision, s.revoked_at
        FROM project_finding_identity_sources s
        JOIN project_finding_identity_source_revisions r ON r.project_id=s.project_id
          AND r.source_id=s.source_id AND r.finding_id=s.finding_id AND r.revision=s.current_revision
        WHERE s.source_id = ${sameAssetSourceId}::uuid`;
      assert.equal(Number(storedSource.current_revision), 1);
      assert.equal(storedSource.revoked_at, null);
      assert.match(String(storedSource.content_sha256), /^sha256:[a-f0-9]{64}$/u);
      await assert.rejects(
        sql`UPDATE project_finding_identity_source_revisions
          SET source_ref = 'attestation://tampered'
          WHERE project_id = ${project}::uuid AND source_id = ${sameAssetSourceId}::uuid AND revision = 1`,
        /identity source revisions are immutable/u,
      );

      const thirdRootSourceId = sourceIds.get(`${thirdInstance}:root_cause`)!;
      const changedThird = await app.inject({
        method: "POST",
        url: `/findings/${thirdInstance}/identity-sources/${thirdRootSourceId}/revisions`,
        payload: {
          ...sourceFor(thirdInstance, "root_cause"),
          identity_fields: { root_cause: identity.digestIdentityValue("cause-b") },
          expected_source_revision: 1,
        },
      });
      assert.equal(changedThird.statusCode, 201, changedThird.payload);
      const unchangedMapping = await sql`SELECT source_revision FROM project_finding_identity_mappings
        WHERE finding_id = ${thirdInstance} AND field = 'root_cause'`;
      assert.equal(Number(unchangedMapping[0].source_revision), 1, "mapping payload was not rewritten");
      const afterSourceChange = await store.readStrongRelationPage(sameProblem, undefined, sql, project, true);
      assert.ok(afterSourceChange);
      assert.ok(afterSourceChange.items.every((item) => item.finding_id !== thirdInstance), "current source revision invalidates only affected derived relations on read");
      assert.ok(afterSourceChange.items.some((item) => item.finding_id === differentInstance), "unaffected current relations remain readable");
      assert.equal(afterSourceChange.status, "stale");
      assert.ok(afterSourceChange.stale_results_omitted);
      const staleRevision = await app.inject({
        method: "POST",
        url: `/findings/${thirdInstance}/identity-sources/${thirdRootSourceId}/revisions`,
        payload: { ...sourceFor(thirdInstance, "root_cause"), expected_source_revision: 1 },
      });
      assert.equal(staleRevision.statusCode, 409);

      const differentAssetSourceId = sourceIds.get(`${differentInstance}:asset`)!;
      const revisedAsset = await store.reviseIdentitySource(project, differentInstance, differentAssetSourceId, 1, {
        ...sourceFor(differentInstance, "asset"),
        identity_fields: { asset: identity.digestIdentityValue("asset-b-revised") },
      }, actor, sql);
      assert.equal(revisedAsset.current_revision, 2);
      const remapped = await store.remapIdentityMapping(project, differentInstance, {
        source_id: differentAssetSourceId, field: "asset", expected_mapping_version: 1,
      }, "accepted source revision", actor, sql);
      assert.equal(remapped.mapping_version, 2);
      await assert.rejects(
        store.remapIdentityMapping(project, differentInstance, {
          source_id: differentAssetSourceId, field: "asset", expected_mapping_version: 1,
        }, "stale CAS", actor, sql),
        (error: unknown) => error instanceof store.StrongRelationStoreError && error.code === "IDENTITY_MAPPING_CAS_CONFLICT",
      );

      const foreignSourceId = sourceIds.get(`${foreign}:asset`)!;
      await assert.rejects(
        store.registerIdentityMapping(project, sameProblem, {
          source_id: foreignSourceId, field: "asset", expected_mapping_version: null,
        }, actor, sql),
        (error: unknown) => error instanceof store.StrongRelationStoreError && error.code === "IDENTITY_SOURCE_NOT_FOUND",
      );

      const sameRootSourceId = sourceIds.get(`${sameProblem}:root_cause`)!;
      const revoked = await app.inject({
        method: "POST",
        url: `/findings/${sameProblem}/identity-sources/${sameRootSourceId}/revoke`,
        payload: { expected_source_revision: 1, reason: "operator attestation withdrawn" },
      });
      assert.equal(revoked.statusCode, 200, revoked.payload);
      const afterRevoke = await store.readStrongRelationPage(sameProblem, undefined, sql, project, true);
      assert.equal(afterRevoke?.identity_status, "insufficient_information");
      assert.deepEqual(afterRevoke?.items, []);

      const extraCount = 501;
      await sql.begin(async (raw) => {
        const tx = raw as unknown as typeof sql;
        for (let index = 0; index < extraCount; index += 1) {
          const jobId = randomUUID();
          const findingId = randomUUID();
          await tx`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json)
            VALUES (${jobId},${project},${canvas},'audit','succeeded','{}')`;
          await tx`INSERT INTO findings(id,project_id,job_id,fingerprint,title,summary,profile,verify_status,disposition)
            VALUES (${findingId},${project},${jobId},${`extra-${index}`},${`extra-${index}`},'bounded read fixture',
              'security.vulnerability','pending','open')`;
        }
      });
      const boundedCanvas = await store.readCanvasStrongRelations(canvas, sql, project, true);
      assert.ok(boundedCanvas);
      assert.equal(boundedCanvas.read_status, "truncated");
      assert.equal(boundedCanvas.read_reason, "CANVAS_FINDING_LIMIT");
      assert.equal(boundedCanvas.truncated, true);
      assert.equal(boundedCanvas.query_budget.used_findings, 500);
      assert.deepEqual(boundedCanvas.items, []);
    } finally {
      await appClose?.();
      await close?.();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  });
}
