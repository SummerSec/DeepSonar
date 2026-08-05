import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("runtime image no-GitHub promotion reconciliation (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("Docker Hub/ACR-only v2 catalog demotes the stale GitHub projection", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";
    const { migrate, sql } = await import("./db.js");
    const { applyOfficialRuntimeCatalog } = await import("./runtime-images.js");
    await migrate();

    const imageKey = `deepsonar-promotions-${randomUUID().slice(0, 8)}`;
    const oldDigest = `sha256:${"a".repeat(64)}`;
    const newDigest = `sha256:${"b".repeat(64)}`;
    const imageId = randomUUID();
    try {
      await sql`
        INSERT INTO runtime_images (id, image_key, name, description, publisher, source_kind, official)
        VALUES (${imageId}, ${imageKey}, 'Promotion fixture', 'fixture', 'SummerSec', 'official', true)`;
      await sql`
        INSERT INTO runtime_image_versions
          (runtime_image_id, version, image_ref, resolved_ref, digest, platforms_json, trust_status, promoted_at)
        VALUES
          (${imageId}, '0.1.0', ${`ghcr.io/summersec/${imageKey}@${oldDigest}`}, ${`ghcr.io/summersec/${imageKey}@${oldDigest}`}, ${oldDigest}, ${sql.json(["linux/amd64"] as never)}, 'trusted', now())`;

      await applyOfficialRuntimeCatalog({
        schema: "deepsonar.registry/v2",
        schema_version: 2,
        source: "remote",
        images: [{
          image_key: imageKey,
          name: "Promotion fixture",
          description: "fixture",
          publisher: "SummerSec",
          source_kind: "official",
          project_opt_in: false,
          versions: [{
            version: "0.2.0",
            digest: newDigest,
            platforms: ["linux/amd64"],
            size_bytes: 42,
            registry_refs: {
              dockerhub: `docker.io/summersec/${imageKey}@${newDigest}`,
              "aliyun-acr": `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/${imageKey}@${newDigest}`,
            },
            // This fixture exercises the Scheduler's defensive demotion path
            // after a channel-only catalog has already crossed the parser.
            // Public release catalogs still require available GitHub evidence.
            registry_evidence: {
              github: { available: false, provenance: "unavailable", reason: "channel_not_published" },
              dockerhub: {
                available: true,
                ref: `docker.io/summersec/${imageKey}@${newDigest}`,
                inspect_digest: newDigest,
                provenance: "cross-registry-copy+inspect",
              },
              "aliyun-acr": {
                available: true,
                ref: `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/${imageKey}@${newDigest}`,
                inspect_digest: newDigest,
                provenance: "cross-registry-copy+inspect",
              },
            },
          }],
        }],
      });

      const rows = await sql`
        SELECT version, digest, promoted_at
        FROM runtime_image_versions
        WHERE runtime_image_id = ${imageId}
        ORDER BY version`;
      assert.equal(rows.length, 1, "legacy Scheduler projection must not apply a channel-only v2 version");
      assert.equal(rows[0].digest, oldDigest);
      assert.equal(rows[0].promoted_at, null, "stale GitHub projection must be demoted");
    } finally {
      await sql`DELETE FROM runtime_images WHERE id = ${imageId}`;
    }
  });
}
