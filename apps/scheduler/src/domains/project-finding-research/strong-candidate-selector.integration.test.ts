import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { selectStrongRelationCandidates } from "./strong-candidate-selector.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// These directly seeded attestations are TEST-ONLY synthetic SQL engineering
// fixtures. They do not certify external authority, human quality labels, an
// independent tuning/holdout set, quality success, or permission to publish.
if (!databaseUrl) {
  test("strong candidate selector requires isolated PostgreSQL",
    { skip: "TEST_DATABASE_URL is not set" }, () => {});
} else {
  test("raw deployed SQL corpus, canonical pairs, invalidation and257 sentinel", async () => {
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = "/postgres"; adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const name = `strong_selector_fixture_${randomUUID().replaceAll("-", "")}`;
    const target = new URL(databaseUrl); target.pathname = `/${name}`;
    let close: (() => Promise<unknown>) | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      process.env.DATABASE_URL = target.toString(); process.env.AGENT_MODE = "fake";
      const [{ migrate, sql }, identity, mapping] = await Promise.all([
        import("../../db.js"), import("./identity.js"), import("./identity-mapping-store.js"),
      ]);
      close = () => sql.end({ timeout: 5 });
      await migrate();
      const project = randomUUID(), foreignProject = randomUUID();
      const canvases = [randomUUID(), randomUUID(), randomUUID()];
      const jobs = [randomUUID(), randomUUID(), randomUUID()];
      await sql`INSERT INTO projects(id,name) VALUES (${project},'selector fixture'),(${foreignProject},'foreign selector fixture')`;
      await sql`INSERT INTO canvases(id,project_id,title) VALUES
        (${canvases[0]},${project},'one'),(${canvases[1]},${project},'two'),(${canvases[2]},${foreignProject},'foreign')`;
      await sql`INSERT INTO jobs(id,project_id,canvas_id,type,status,agent_snapshot_json) VALUES
        (${jobs[0]},${project},${canvases[0]},'audit','succeeded','{}'),
        (${jobs[1]},${project},${canvases[1]},'audit','failed','{}'),
        (${jobs[2]},${foreignProject},${canvases[2]},'audit','succeeded','{}')`;
      const rootDigest = identity.digestIdentityValue('synthetic-selector-root');
      type Mode = 'valid' | 'mapping_revoked' | 'source_revoked' | 'stale' | 'old_revision' | 'different_digest' | 'wrong_field';
      async function seed(n: number, mode: Mode = 'valid', projectId = project, job = jobs[0], mappingVersion = 1) {
        const findingId = id(n), sourceId = randomUUID();
        if (mappingVersion === 1) await sql`INSERT INTO findings(id,project_id,job_id,fingerprint,title,summary,profile,verify_status,disposition)
          VALUES (${findingId},${projectId},${job},${String(n)},'synthetic declaration','unrelated text','security.vulnerability','pending','open')`;
        const manifest = { authority_version: 'synthetic-selector/v1', source_kind: 'platform_root_cause' as const,
          source_ref: `attestation://synthetic-selector/${n}/${mappingVersion}`,
          freshness_until: mode === 'stale' ? '2000-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z',
          identity_fields: { root_cause: mode === 'different_digest' ? identity.digestIdentityValue('other-root') : rootDigest } };
        await sql`INSERT INTO project_finding_identity_sources(source_id,project_id,finding_id,current_revision,revoked_at,registered_by)
          VALUES (${sourceId},${projectId},${findingId},${mode === 'old_revision' ? 2 : 1},
            CASE WHEN ${mode === 'source_revoked'} THEN now() ELSE NULL END,'synthetic-selector-fixture')`;
        await sql`INSERT INTO project_finding_identity_source_revisions(project_id,source_id,finding_id,revision,
          authority_version,source_kind,source_ref,freshness_until,identity_fields_json,content_sha256,registered_by)
          VALUES (${projectId},${sourceId},${findingId},1,${manifest.authority_version},${manifest.source_kind},
            ${manifest.source_ref},${manifest.freshness_until}::timestamptz,${sql.json(manifest.identity_fields)},
            ${identity.identityManifestContentDigest(manifest)},'synthetic-selector-fixture')`;
        if (mode === 'old_revision') await sql`INSERT INTO project_finding_identity_source_revisions(
          project_id,source_id,finding_id,revision,authority_version,source_kind,source_ref,
          freshness_until,identity_fields_json,content_sha256,registered_by)
          SELECT project_id,source_id,finding_id,2,authority_version,source_kind,source_ref,
            freshness_until,identity_fields_json,content_sha256,registered_by
          FROM project_finding_identity_source_revisions WHERE source_id=${sourceId} AND revision=1`;
        await sql`INSERT INTO project_finding_identity_mappings(project_id,finding_id,field,source_id,source_revision,
          mapping_version,revoked_at,authorized_by) VALUES (${projectId},${findingId},
          ${mode === 'wrong_field' ? 'asset' : 'root_cause'},${sourceId},1,${mappingVersion},
          CASE WHEN ${mode === 'mapping_revoked'} THEN now() ELSE NULL END,'synthetic-selector-fixture')`;
      }
      await seed(900); await seed(1000);
      for (let n = 1001; n <= 1270; n++) await seed(n, 'valid', project, jobs[n % 2]);
      await seed(1001, 'valid', project, jobs[0], 2); // DISTINCT, not an extra pair slot
      await seed(2000, 'valid', foreignProject, jobs[2]);
      const invalid: Mode[] = ['mapping_revoked','source_revoked','stale','old_revision','different_digest','wrong_field'];
      for (let i = 0; i < invalid.length; i++) await seed(3001 + i, invalid[i]);
      const subject = await mapping.loadCurrentIdentitySnapshot(id(1000), project, sql);
      assert.equal(subject.fields.root_cause.status, 'valid');
      const select = (findingId: string) => selectStrongRelationCandidates(sql, {
        projectId: project, findingId, rootCause: subject.fields.root_cause,
      });
      const selection = await select(id(1000));
      assert.deepEqual(selection, { peerIds: Array.from({ length: 256 }, (_, i) => id(1001 + i)),
        observedCount: 257, truncated: true, countKind: 'lower_bound' });
      assert.equal(selection.peerIds.includes(id(1257)), false, 'sentinel is not executed');
      const tail = await select(id(1260));
      assert.deepEqual(tail, { peerIds: Array.from({ length: 10 }, (_, i) => id(1261 + i)),
        observedCount: 10, truncated: false, countKind: 'exact' });
      assert.ok(tail.peerIds.includes(id(1261)) && tail.peerIds.includes(id(1262)), 'both Job/Canvas corpora are selected');
      const pairs: string[] = [];
      for (const n of [1268,1269,1270]) for (const peer of (await select(id(n))).peerIds) {
        assert.ok(id(n) < peer); pairs.push(`${id(n)}:${peer}`);
      }
      assert.deepEqual(pairs, [`${id(1268)}:${id(1269)}`,`${id(1268)}:${id(1270)}`,`${id(1269)}:${id(1270)}`]);
      assert.equal(new Set(pairs).size, pairs.length, 'one canonical lower-to-higher opportunity per pair');
      assert.equal(identity.STRONG_RELATIONS_PUBLISHED, false);
      assert.equal(identity.STRONG_RELATION_QUALITY_GATE_STATUS, 'not_evaluated');
    } finally {
      if (close) await close();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end({ timeout: 5 });
    }
  });
}
