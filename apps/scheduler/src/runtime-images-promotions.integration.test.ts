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

  test("resolver distinguishes a stale explicit pin from latest trusted", async () => {
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

  test("authoritative official catalog promotion rolls only stale non-held official project pins", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const { migrate, sql } = await import("./db.js");
    const runtime = await import("./runtime-images.js");
    await migrate();

    const suffix = randomUUID().slice(0, 8);
    const imageKey = `deepsonar-auto-roll-${suffix}`;
    const imageId = randomUUID();
    const staleVersionId = randomUUID();
    const executableOldVersionId = randomUUID();
    const staleDigest = `sha256:${"1".repeat(64)}`;
    const executableOldDigest = `sha256:${"2".repeat(64)}`;
    const newDigest = `sha256:${"3".repeat(64)}`;
    const hostPlatform = runtime.hostRuntimePlatform();
    const staleGithub = `ghcr.io/summersec/${imageKey}@${staleDigest}`;
    const executableOldAcr = `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/${imageKey}@${executableOldDigest}`;
    const newGithub = `ghcr.io/summersec/${imageKey}@${newDigest}`;
    const newAcr = `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/${imageKey}@${newDigest}`;
    const projects = {
      auto: randomUUID(),
      hold: randomUUID(),
      executableOld: randomUUID(),
      followLatest: randomUUID(),
      thirdParty: randomUUID(),
      unrelatedOfficial: randomUUID(),
    };
    const frozenJobId = randomUUID();
    const thirdPartyImageId = randomUUID();
    const thirdPartyOldVersionId = randomUUID();
    const thirdPartyLatestVersionId = randomUUID();
    const unrelatedImageId = randomUUID();
    const unrelatedOldVersionId = randomUUID();
    const unrelatedLatestVersionId = randomUUID();
    try {
      await sql`UPDATE global_settings SET runtime_registry_channel = 'aliyun-acr' WHERE id = 'global'`;
      for (const [kind, projectId] of Object.entries(projects)) {
        await sql`
          INSERT INTO projects (id, canvas_id, name, config_json)
          VALUES (
            ${projectId},
            ${`canvas-${projectId}`},
            ${`Official pin roll ${kind} ${suffix}`},
            ${sql.json((kind === "hold" ? { official_runtime_pin_policy: "hold" } : {}) as never)}
          )`;
      }
      await sql`
        INSERT INTO runtime_images (id, image_key, name, description, publisher, source_kind, official)
        VALUES (${imageId}, ${imageKey}, 'Auto roll fixture', 'fixture', 'SummerSec', 'official', true)`;
      await sql`
        INSERT INTO runtime_image_versions
          (id, runtime_image_id, version, image_ref, resolved_ref, digest, platforms_json, trust_status, promoted_at)
        VALUES
          (${staleVersionId}, ${imageId}, '0.1.40', ${staleGithub}, ${staleGithub}, ${staleDigest}, ${sql.json([hostPlatform] as never)}, 'trusted', NULL),
          (${executableOldVersionId}, ${imageId}, '0.1.41', ${executableOldAcr}, ${executableOldAcr}, ${executableOldDigest}, ${sql.json([hostPlatform] as never)}, 'trusted', NULL)`;
      await sql`
        INSERT INTO runtime_image_version_refs (version_id, channel, image_ref, resolved_ref, digest, evidence_json)
        VALUES (${executableOldVersionId}, 'aliyun-acr', ${executableOldAcr}, ${executableOldAcr}, ${executableOldDigest}, ${sql.json({ source: "fixture" } as never)})`;
      await sql`
        INSERT INTO project_runtime_images (project_id, runtime_image_id, selected_version_id, enabled)
        VALUES
          (${projects.auto}, ${imageId}, ${staleVersionId}, true),
          (${projects.hold}, ${imageId}, ${staleVersionId}, true),
          (${projects.executableOld}, ${imageId}, ${executableOldVersionId}, true),
          (${projects.followLatest}, ${imageId}, NULL, true)`;
      await sql`
        INSERT INTO jobs (id, project_id, type, status, agent_snapshot_json)
        VALUES (
          ${frozenJobId}, ${projects.auto}, 'audit', 'succeeded',
          ${sql.json({ runtime_image_version_id: staleVersionId, image_digest: staleDigest } as never)}
        )`;

      const thirdOldRef = `registry.internal/third-party-${suffix}@sha256:${"4".repeat(64)}`;
      const thirdLatestRef = `registry.internal/third-party-${suffix}@sha256:${"5".repeat(64)}`;
      await sql`
        INSERT INTO runtime_images (id, image_key, name, description, publisher, source_kind, official)
        VALUES (${thirdPartyImageId}, ${`third-party-${suffix}`}, 'Third party fixture', 'fixture', 'fixture', 'third_party', false)`;
      await sql`
        INSERT INTO runtime_image_versions
          (id, runtime_image_id, version, image_ref, resolved_ref, digest, platforms_json, trust_status, promoted_at)
        VALUES
          (${thirdPartyOldVersionId}, ${thirdPartyImageId}, '1.0.0', ${thirdOldRef}, ${thirdOldRef}, ${`sha256:${"4".repeat(64)}`}, ${sql.json([hostPlatform] as never)}, 'revoked', NULL),
          (${thirdPartyLatestVersionId}, ${thirdPartyImageId}, '1.1.0', ${thirdLatestRef}, ${thirdLatestRef}, ${`sha256:${"5".repeat(64)}`}, ${sql.json([hostPlatform] as never)}, 'trusted', now())`;
      await sql`
        INSERT INTO project_runtime_images (project_id, runtime_image_id, selected_version_id, enabled)
        VALUES (${projects.thirdParty}, ${thirdPartyImageId}, ${thirdPartyOldVersionId}, true)`;

      const unrelatedKey = `deepsonar-unrelated-${suffix}`;
      const unrelatedOldDigest = `sha256:${"6".repeat(64)}`;
      const unrelatedLatestDigest = `sha256:${"7".repeat(64)}`;
      const unrelatedOldRef = `ghcr.io/summersec/${unrelatedKey}@${unrelatedOldDigest}`;
      const unrelatedLatestRef = `crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec/${unrelatedKey}@${unrelatedLatestDigest}`;
      await sql`
        INSERT INTO runtime_images (id, image_key, name, description, publisher, source_kind, official)
        VALUES (${unrelatedImageId}, ${unrelatedKey}, 'Unrelated official fixture', 'fixture', 'SummerSec', 'official', true)`;
      await sql`
        INSERT INTO runtime_image_versions
          (id, runtime_image_id, version, image_ref, resolved_ref, digest, platforms_json, trust_status, promoted_at)
        VALUES
          (${unrelatedOldVersionId}, ${unrelatedImageId}, '0.1.40', ${unrelatedOldRef}, ${unrelatedOldRef}, ${unrelatedOldDigest}, ${sql.json([hostPlatform] as never)}, 'revoked', NULL),
          (${unrelatedLatestVersionId}, ${unrelatedImageId}, '0.1.42', ${unrelatedLatestRef}, ${unrelatedLatestRef}, ${unrelatedLatestDigest}, ${sql.json([hostPlatform] as never)}, 'trusted', now())`;
      await sql`
        INSERT INTO runtime_image_version_refs (version_id, channel, image_ref, resolved_ref, digest, evidence_json)
        VALUES (${unrelatedLatestVersionId}, 'aliyun-acr', ${unrelatedLatestRef}, ${unrelatedLatestRef}, ${unrelatedLatestDigest}, ${sql.json({ source: "fixture" } as never)})`;
      await sql`
        INSERT INTO project_runtime_images (project_id, runtime_image_id, selected_version_id, enabled)
        VALUES (${projects.unrelatedOfficial}, ${unrelatedImageId}, ${unrelatedOldVersionId}, true)`;

      const catalog = {
        schema: "deepsonar.registry/v2" as const,
        schema_version: 2 as const,
        source: "remote" as const,
        fallback: false,
        images: [{
          image_key: imageKey,
          name: "Auto roll fixture",
          description: "fixture",
          publisher: "SummerSec",
          source_kind: "official" as const,
          project_opt_in: false,
          versions: [{
            version: "0.1.42",
            image_ref: newGithub,
            digest: newDigest,
            platforms: [hostPlatform],
            registry_refs: { github: newGithub, "aliyun-acr": newAcr },
          }],
        }],
      };
      await runtime.applyOfficialRuntimeCatalog(catalog);
      await runtime.applyOfficialRuntimeCatalog(catalog);

      const bindings = await sql`
        SELECT project_id, selected_version_id
        FROM project_runtime_images
        WHERE project_id = ANY(${Object.values(projects)}::uuid[])`;
      const selected = new Map(bindings.map((row) => [String(row.project_id), row.selected_version_id ? String(row.selected_version_id) : null]));
      const [savedNew] = await sql`
        SELECT id FROM runtime_image_versions WHERE runtime_image_id = ${imageId} AND digest = ${newDigest}`;
      assert.ok(savedNew?.id);
      assert.equal(selected.get(projects.auto), String(savedNew.id), "default policy must roll a stale official pin");
      assert.equal(selected.get(projects.hold), staleVersionId, "hold policy must preserve a stale official pin");
      assert.equal(selected.get(projects.executableOld), executableOldVersionId, "an executable trusted old pin must stay pinned");
      assert.equal(selected.get(projects.followLatest), null, "follow-latest must remain null");
      assert.equal(selected.get(projects.thirdParty), thirdPartyOldVersionId, "third-party pins must never auto-roll");
      assert.equal(
        selected.get(projects.unrelatedOfficial),
        unrelatedOldVersionId,
        "a partial catalog apply must not roll an official image absent from that catalog",
      );

      const [frozenJob] = await sql`SELECT agent_snapshot_json FROM jobs WHERE id = ${frozenJobId}`;
      assert.equal(frozenJob.agent_snapshot_json.runtime_image_version_id, staleVersionId, "historical Job snapshots stay immutable");

      const audits = await sql`
        SELECT action, project_id, resource_id, before_json, after_json
        FROM audit_logs
        WHERE action = 'runtime_image.project_pin_auto_roll'
          AND project_id = ANY(${Object.values(projects)}::uuid[])`;
      assert.equal(audits.length, 1, "every actual roll gets exactly one audit and skipped pins get none");
      assert.equal(String(audits[0].project_id), projects.auto);
      assert.equal(audits[0].resource_id, imageId);
      assert.equal(audits[0].before_json.image_key, imageKey);
      assert.equal(audits[0].before_json.version_id, staleVersionId);
      assert.equal(audits[0].after_json.from_version, "0.1.40");
      assert.equal(audits[0].after_json.to_version, "0.1.42");
      assert.equal(audits[0].after_json.source, "official_catalog_promote");
    } finally {
      // Audit rows intentionally retain their project FK; the integration DB is disposable.
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
}
