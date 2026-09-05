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
    process.env.DEEPSONAR_IMAGE_REGISTRY = "crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec";
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
              dockerhub: `docker.io/sumsec/${imageKey}@${newDigest}`,
              "aliyun-acr": `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/${imageKey}@${newDigest}`,
            },
            // This fixture exercises the Scheduler's defensive demotion path
            // after a channel-only catalog has already crossed the parser.
            // Public release catalogs still require available GitHub evidence.
            registry_evidence: {
              github: { available: false, provenance: "unavailable", reason: "channel_not_published" },
              dockerhub: {
                available: true,
                ref: `docker.io/sumsec/${imageKey}@${newDigest}`,
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

  test("official catalog stores the deployment registry ref for admission scans", async () => {
    const { applyOfficialRuntimeCatalog } = await import("./runtime-images.js");
    const { sql } = await import("./db.js");
    const imageKey = `deepsonar-admission-${randomUUID().slice(0, 8)}`;
    const digest = `sha256:${"c".repeat(64)}`;
    const githubRef = `ghcr.io/summersec/${imageKey}@${digest}`;
    const acrRef = `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/${imageKey}@${digest}`;
    try {
      await applyOfficialRuntimeCatalog({
        schema: "deepsonar.registry/v2",
        schema_version: 2,
        source: "remote",
        images: [{
          image_key: imageKey,
          name: "Admission fixture",
          description: "fixture",
          publisher: "SummerSec",
          source_kind: "official",
          project_opt_in: false,
          versions: [{
            version: "0.1.0",
            image_ref: githubRef,
            digest,
            platforms: ["linux/amd64"],
            registry_refs: { github: githubRef, "aliyun-acr": acrRef },
          }],
        }],
      });

      const [row] = await sql`
        SELECT v.image_ref, v.resolved_ref
        FROM runtime_image_versions v
        JOIN runtime_images i ON i.id = v.runtime_image_id
        WHERE i.image_key = ${imageKey} AND v.digest = ${digest}`;
      assert.equal(row?.image_ref, acrRef);
      assert.equal(row?.resolved_ref, acrRef);
    } finally {
      await sql`DELETE FROM runtime_images WHERE image_key = ${imageKey}`;
    }
  });

  test("revoked official digest is re-scanned only when its admission registry ref changes", async () => {
    const { applyOfficialRuntimeCatalog } = await import("./runtime-images.js");
    const { sql } = await import("./db.js");
    const imageKey = `deepsonar-revoked-${randomUUID().slice(0, 8)}`;
    const digest = `sha256:${"d".repeat(64)}`;
    const githubRef = `ghcr.io/summersec/${imageKey}@${digest}`;
    const acrRef = `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/${imageKey}@${digest}`;
    const catalog = {
      schema: "deepsonar.registry/v2" as const,
      schema_version: 2 as const,
      source: "remote" as const,
      images: [{
        image_key: imageKey,
        name: "Revoked fixture",
        description: "fixture",
        publisher: "SummerSec",
        source_kind: "official" as const,
        project_opt_in: false,
        versions: [{
          version: "0.1.0",
          image_ref: githubRef,
          digest,
          platforms: ["linux/amd64"],
          registry_refs: { github: githubRef, "aliyun-acr": acrRef },
        }],
      }],
    };
    try {
      const [image] = await sql`
        INSERT INTO runtime_images (image_key, name, description, publisher, source_kind, official)
        VALUES (${imageKey}, 'Revoked fixture', 'fixture', 'SummerSec', 'official', true)
        RETURNING id`;
      await sql`
        INSERT INTO runtime_image_versions
          (runtime_image_id, version, image_ref, resolved_ref, digest, platforms_json, trust_status, status_reason, revoked_at)
        VALUES
          (${image.id}, '0.1.0', ${githubRef}, ${githubRef}, ${digest}, ${sql.json(["linux/amd64"] as never)},
           'revoked', 'ghcr pull unauthorized', now())`;

      await applyOfficialRuntimeCatalog(catalog);
      const [recovered] = await sql`
        SELECT v.id, v.image_ref, v.trust_status, v.status_reason,
          (SELECT count(*)::int FROM runtime_image_scans s
           WHERE s.runtime_image_version_id = v.id AND s.status = 'queued'
             AND s.result_json @> ${sql.json({ restore_official_trust: true } as never)}) AS queued_scans
        FROM runtime_image_versions v WHERE v.runtime_image_id = ${image.id} AND v.digest = ${digest}`;
      assert.equal(recovered.image_ref, acrRef);
      assert.equal(recovered.trust_status, "quarantined");
      assert.equal(recovered.queued_scans, 1);

      await applyOfficialRuntimeCatalog(catalog);
      const [sameRef] = await sql`
        SELECT v.trust_status,
          (SELECT count(*)::int FROM runtime_image_scans s WHERE s.runtime_image_version_id = v.id) AS scan_count
        FROM runtime_image_versions v WHERE v.id = ${recovered.id}`;
      assert.equal(sameRef.trust_status, "quarantined", "扫描成功前重复同步不得提前恢复信任");
      assert.equal(sameRef.scan_count, 1, "同一引用重复同步不得重复排队");
    } finally {
      await sql`DELETE FROM runtime_images WHERE image_key = ${imageKey}`;
    }
  });

  test("stale project pin is distinct from latest trusted and is not silently rewritten", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const { migrate, sql } = await import("./db.js");
    const runtime = await import("./runtime-images.js");
    await migrate();

    const imageKey = `deepsonar-pin-stale-${randomUUID().slice(0, 8)}`;
    const imageId = randomUUID();
    const oldVersionId = randomUUID();
    const newVersionId = randomUUID();
    const oldDigest = `sha256:${"e".repeat(64)}`;
    const newDigest = `sha256:${"f".repeat(64)}`;
    const hostPlatform = runtime.hostRuntimePlatform();
    const oldGithub = `ghcr.io/summersec/${imageKey}@${oldDigest}`;
    const newRef = `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/${imageKey}@${newDigest}`;
    const oldAcr = `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/${imageKey}@${oldDigest}`;
    try {
      await sql`UPDATE global_settings SET runtime_registry_channel = 'aliyun-acr' WHERE id = 'global'`;
      await sql`
        INSERT INTO runtime_images (id, image_key, name, description, publisher, source_kind, official)
        VALUES (${imageId}, ${imageKey}, 'Pin stale fixture', 'fixture', 'SummerSec', 'official', true)`;
      await sql`
        INSERT INTO runtime_image_versions
          (id, runtime_image_id, version, image_ref, resolved_ref, digest, platforms_json, trust_status, promoted_at)
        VALUES
          (${oldVersionId}, ${imageId}, '0.1.38', ${oldGithub}, ${oldGithub}, ${oldDigest}, ${sql.json([hostPlatform] as never)}, 'trusted', NULL),
          (${newVersionId}, ${imageId}, '0.1.39', ${newRef}, ${newRef}, ${newDigest}, ${sql.json([hostPlatform] as never)}, 'trusted', now())`;
      await sql`
        INSERT INTO runtime_image_version_refs (version_id, channel, image_ref, resolved_ref, digest, evidence_json)
        VALUES (${newVersionId}, 'aliyun-acr', ${newRef}, ${newRef}, ${newDigest}, ${sql.json({ source: "fixture" } as never)})`;

      await assert.rejects(
        () => runtime.resolveRuntimeImageForProjectBinding(sql, imageId, oldVersionId),
        (error: unknown) => {
          assert.ok(error instanceof runtime.RuntimeImagePinStaleError);
          assert.equal(error.code, "RUNTIME_IMAGE_PIN_STALE");
          assert.equal(error.statusCode, 409);
          assert.equal(error.imageKey, imageKey);
          assert.equal(error.selectedVersionId, oldVersionId);
          assert.equal(error.selectedVersion, "0.1.38");
          assert.equal(error.latestVersionId, newVersionId);
          assert.equal(error.latestVersion, "0.1.39");
          const mapped = runtime.runtimeImageHttpError(error);
          assert.equal(mapped?.statusCode, 409);
          assert.equal(mapped?.body.error_code, "RUNTIME_IMAGE_PIN_STALE");
          return true;
        },
      );

      const followLatest = await runtime.resolveRuntimeImageForProjectBinding(sql, imageId, null);
      assert.equal(followLatest.runtime_image_version_id, newVersionId);
      assert.equal(followLatest.image_digest, newDigest);

      const pinLatest = await runtime.resolveRuntimeImageForProjectBinding(sql, imageId, newVersionId);
      assert.equal(pinLatest.runtime_image_version_id, newVersionId);

      await sql`
        INSERT INTO runtime_image_version_refs (version_id, channel, image_ref, resolved_ref, digest, evidence_json)
        VALUES (${oldVersionId}, 'aliyun-acr', ${oldAcr}, ${oldAcr}, ${oldDigest}, ${sql.json({ source: "fixture" } as never)})`;
      const explicitPin = await runtime.resolveRuntimeImageForProjectBinding(sql, imageId, oldVersionId);
      assert.equal(explicitPin.runtime_image_version_id, oldVersionId, "executable explicit pin must not auto-follow latest");
      assert.equal(explicitPin.image_digest, oldDigest);
    } finally {
      await sql`DELETE FROM runtime_images WHERE id = ${imageId}`;
    }
  });

  test("only revoked official versions return RUNTIME_IMAGE_REVOKED, not PLATFORM_UNAVAILABLE", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const { migrate, sql } = await import("./db.js");
    const runtime = await import("./runtime-images.js");
    await migrate();

    const imageKey = `deepsonar-revoked-only-${randomUUID().slice(0, 8)}`;
    const imageId = randomUUID();
    const versionId = randomUUID();
    const digest = `sha256:${"9".repeat(64)}`;
    const acrRef = `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/${imageKey}@${digest}`;
    try {
      await sql`UPDATE global_settings SET runtime_registry_channel = 'aliyun-acr' WHERE id = 'global'`;
      await sql`
        INSERT INTO runtime_images (id, image_key, name, description, publisher, source_kind, official, project_opt_in)
        VALUES (${imageId}, ${imageKey}, 'Revoked official', 'fixture', 'SummerSec', 'official', true, false)`;
      await sql`
        INSERT INTO runtime_image_versions
          (id, runtime_image_id, version, image_ref, resolved_ref, digest, platforms_json, trust_status, status_reason, revoked_at)
        VALUES
          (${versionId}, ${imageId}, '0.1.41', ${acrRef}, ${acrRef}, ${digest},
           ${sql.json(["linux/amd64", "linux/arm64"] as never)},
           'revoked', 'admission policy failed: critical=19, secrets=0', now())`;
      await sql`
        INSERT INTO runtime_image_version_refs (version_id, channel, image_ref, resolved_ref, digest, evidence_json)
        VALUES (${versionId}, 'aliyun-acr', ${acrRef}, ${acrRef}, ${digest}, ${sql.json({ source: "fixture" } as never)})`;

      await assert.rejects(
        () => runtime.resolveRuntimeImageForProjectBinding(sql, imageId, null),
        (error: unknown) => {
          assert.ok(error instanceof runtime.RuntimeImageRevokedError);
          assert.equal(error.code, "RUNTIME_IMAGE_REVOKED");
          assert.equal(error.statusCode, 409);
          assert.equal(error.imageKey, imageKey);
          const mapped = runtime.runtimeImageHttpError(error);
          assert.equal(mapped?.statusCode, 409);
          assert.equal(mapped?.body.error_code, "RUNTIME_IMAGE_REVOKED");
          assert.doesNotMatch(String(mapped?.body.error), /PLATFORM_UNAVAILABLE|platforms explicitly/);
          return true;
        },
      );

      const warnings = await runtime.listOfficialDefaultImageTrustWarnings(sql);
      assert.ok(warnings.some((row) => row.image_key === imageKey && row.trust_status === "revoked"));
    } finally {
      await sql`DELETE FROM runtime_images WHERE id = ${imageId}`;
    }
  });

  test("official catalog promote rolls stale official pins only", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";
    process.env.DEEPSONAR_IMAGE_REGISTRY = "crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec";
    const { migrate, sql } = await import("./db.js");
    const runtime = await import("./runtime-images.js");
    await migrate();

    const suffix = randomUUID().slice(0, 8);
    const officialKey = `deepsonar-pin-roll-${suffix}`;
    const thirdPartyKey = `third-party-pin-roll-${suffix}`;
    const officialId = randomUUID();
    const thirdPartyId = randomUUID();
    const oldOfficialVersionId = randomUUID();
    const pinOkVersionId = randomUUID();
    const oldThirdVersionId = randomUUID();
    const newThirdVersionId = randomUUID();
    const staleProjectId = randomUUID();
    const pinOkProjectId = randomUUID();
    const thirdPartyProjectId = randomUUID();
    const holdProjectId = randomUUID();
    const followLatestProjectId = randomUUID();
    const canvasId = randomUUID();
    const jobId = randomUUID();
    const hostPlatform = runtime.hostRuntimePlatform();
    const oldDigest = `sha256:${"1".repeat(64)}`;
    const pinOkDigest = `sha256:${"2".repeat(64)}`;
    const newDigest = `sha256:${"3".repeat(64)}`;
    const thirdOldDigest = `sha256:${"4".repeat(64)}`;
    const thirdNewDigest = `sha256:${"5".repeat(64)}`;
    const newGithub = `ghcr.io/summersec/${officialKey}@${newDigest}`;
    const newAcr = `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/${officialKey}@${newDigest}`;
    const pinOkAcr = `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/${officialKey}@${pinOkDigest}`;
    const snapshotBefore = {
      runtime_image: { runtime_image_version_id: oldOfficialVersionId, image_key: officialKey },
    };

    try {
      await sql`UPDATE global_settings SET runtime_registry_channel = 'aliyun-acr' WHERE id = 'global'`;
      await sql`
        INSERT INTO runtime_images (id, image_key, name, description, publisher, source_kind, official)
        VALUES
          (${officialId}, ${officialKey}, 'Official roll', 'fixture', 'SummerSec', 'official', true),
          (${thirdPartyId}, ${thirdPartyKey}, 'Third party roll', 'fixture', 'Other', 'third_party', false)`;
      await sql`
        INSERT INTO runtime_image_versions
          (id, runtime_image_id, version, image_ref, resolved_ref, digest, platforms_json, trust_status, promoted_at)
        VALUES
          (${oldOfficialVersionId}, ${officialId}, '0.1.41', ${`ghcr.io/summersec/${officialKey}@${oldDigest}`},
           ${`ghcr.io/summersec/${officialKey}@${oldDigest}`}, ${oldDigest}, ${sql.json([hostPlatform] as never)}, 'trusted', NULL),
          (${pinOkVersionId}, ${officialId}, '0.1.40', ${pinOkAcr}, ${pinOkAcr}, ${pinOkDigest},
           ${sql.json([hostPlatform] as never)}, 'trusted', NULL),
          (${oldThirdVersionId}, ${thirdPartyId}, '9.0.0', ${`example.local/${thirdPartyKey}@${thirdOldDigest}`},
           ${`example.local/${thirdPartyKey}@${thirdOldDigest}`}, ${thirdOldDigest}, ${sql.json([hostPlatform] as never)}, 'disabled', NULL),
          (${newThirdVersionId}, ${thirdPartyId}, '9.1.0', ${`example.local/${thirdPartyKey}@${thirdNewDigest}`},
           ${`example.local/${thirdPartyKey}@${thirdNewDigest}`}, ${thirdNewDigest}, ${sql.json([hostPlatform] as never)}, 'trusted', now())`;
      await sql`
        INSERT INTO runtime_image_version_refs (version_id, channel, image_ref, resolved_ref, digest, evidence_json)
        VALUES (${pinOkVersionId}, 'aliyun-acr', ${pinOkAcr}, ${pinOkAcr}, ${pinOkDigest}, ${sql.json({ source: "fixture" } as never)})`;

      for (const [projectId, name] of [
        [staleProjectId, "stale official"],
        [pinOkProjectId, "pin ok official"],
        [thirdPartyProjectId, "third party"],
        [holdProjectId, "hold official"],
        [followLatestProjectId, "follow latest"],
      ] as const) {
        await sql`
          INSERT INTO projects (id, name)
          VALUES (${projectId}, ${name})`;
      }
      await sql`
        INSERT INTO canvases (id, project_id, title)
        VALUES (${canvasId}, ${staleProjectId}, 'frozen snapshot canvas')`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, agent_snapshot_json)
        VALUES (${jobId}, ${staleProjectId}, ${canvasId}, 'hub_reason', ${sql.json(snapshotBefore as never)})`;
      await sql`
        INSERT INTO project_runtime_images (project_id, runtime_image_id, selected_version_id, enabled, pin_policy)
        VALUES
          (${staleProjectId}, ${officialId}, ${oldOfficialVersionId}, true, 'follow'),
          (${pinOkProjectId}, ${officialId}, ${pinOkVersionId}, true, 'follow'),
          (${thirdPartyProjectId}, ${thirdPartyId}, ${oldThirdVersionId}, true, 'follow'),
          (${holdProjectId}, ${officialId}, ${oldOfficialVersionId}, true, 'hold'),
          (${followLatestProjectId}, ${officialId}, NULL, true, 'follow')`;

      const result = await runtime.applyOfficialRuntimeCatalog({
        schema: "deepsonar.registry/v2",
        schema_version: 2,
        source: "remote",
        images: [{
          image_key: officialKey,
          name: "Official roll",
          description: "fixture",
          publisher: "SummerSec",
          source_kind: "official",
          project_opt_in: false,
          versions: [{
            version: "0.1.43",
            image_ref: newGithub,
            digest: newDigest,
            platforms: [hostPlatform],
            registry_refs: { github: newGithub, "aliyun-acr": newAcr },
          }],
        }],
      });

      const [newVersion] = await sql`
        SELECT id, version FROM runtime_image_versions
        WHERE runtime_image_id = ${officialId} AND digest = ${newDigest}`;
      assert.ok(newVersion?.id);
      assert.equal(newVersion.version, "0.1.43");
      assert.equal(result.pin_rolls.length, 1);
      assert.equal(result.pin_rolls[0]?.project_id, staleProjectId);
      assert.equal(result.pin_rolls[0]?.image_key, officialKey);
      assert.equal(result.pin_rolls[0]?.from_version_id, oldOfficialVersionId);
      assert.equal(result.pin_rolls[0]?.from_version, "0.1.41");
      assert.equal(result.pin_rolls[0]?.to_version_id, String(newVersion.id));
      assert.equal(result.pin_rolls[0]?.to_version, "0.1.43");

      const pins = await sql`
        SELECT project_id, selected_version_id, pin_policy
        FROM project_runtime_images
        WHERE runtime_image_id IN (${officialId}, ${thirdPartyId})
        ORDER BY project_id`;
      const pinByProject = Object.fromEntries(pins.map((row) => [String(row.project_id), row]));
      assert.equal(String(pinByProject[staleProjectId]?.selected_version_id), String(newVersion.id));
      assert.equal(String(pinByProject[pinOkProjectId]?.selected_version_id), pinOkVersionId);
      assert.equal(String(pinByProject[thirdPartyProjectId]?.selected_version_id), oldThirdVersionId);
      assert.equal(String(pinByProject[holdProjectId]?.selected_version_id), oldOfficialVersionId);
      assert.equal(pinByProject[holdProjectId]?.pin_policy, "hold");
      assert.equal(pinByProject[followLatestProjectId]?.selected_version_id, null);

      const [audit] = await sql`
        SELECT action, project_id, before_json, after_json
        FROM audit_logs
        WHERE action = 'runtime_image.official_pin_roll' AND project_id = ${staleProjectId}
        ORDER BY id DESC LIMIT 1`;
      assert.equal(audit?.action, "runtime_image.official_pin_roll");
      assert.equal(String(audit?.before_json?.selected_version_id), oldOfficialVersionId);
      assert.equal(String(audit?.after_json?.selected_version_id), String(newVersion.id));
      assert.equal(audit?.after_json?.trigger, "official_catalog_promote");
      assert.equal(audit?.after_json?.image_key, officialKey);

      const [frozenJob] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id = ${jobId}`;
      assert.deepEqual(frozenJob?.agent_snapshot_json, snapshotBefore);

      const fallback = await runtime.applyOfficialRuntimeCatalog({
        schema: "deepsonar.registry/v2",
        schema_version: 2,
        source: "bundled",
        fallback: true,
        images: [{
          image_key: officialKey,
          name: "Official roll",
          description: "fixture",
          publisher: "SummerSec",
          source_kind: "official",
          project_opt_in: false,
          versions: [{
            version: "0.1.43",
            image_ref: newGithub,
            digest: newDigest,
            platforms: [hostPlatform],
            registry_refs: { github: newGithub, "aliyun-acr": newAcr },
          }],
        }],
      });
      assert.deepEqual(fallback.pin_rolls, []);
      const [holdPin] = await sql`
        SELECT selected_version_id FROM project_runtime_images
        WHERE project_id = ${holdProjectId} AND runtime_image_id = ${officialId}`;
      assert.equal(String(holdPin?.selected_version_id), oldOfficialVersionId);
    } finally {
      await sql`DELETE FROM jobs WHERE id = ${jobId}`;
      await sql`DELETE FROM canvases WHERE id = ${canvasId}`;
      await sql`DELETE FROM runtime_images WHERE id IN (${officialId}, ${thirdPartyId})`;
    }
  });
}
