import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("runtime image channel integration requires TEST_DATABASE_URL (skipped)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use a scheduler default database",
  }, () => {});
} else {
  test("selected channel switches refs without rewriting historical snapshots and fails closed", async () => {
    const quote = (value: string): string => "'" + value.replaceAll("'", "''") + "'";
    const identifier = (value: string): string => '"' + value.replaceAll('"', '""') + '"';
    const adminUrl = new URL(testDatabaseUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const admin = postgres(adminUrl.toString(), { max: 1 });
    const databaseName = "deepsonar_runtime_channels_" + process.pid + "_" + Date.now() + "_" + randomUUID().slice(0, 8);
    const targetUrl = new URL(testDatabaseUrl);
    targetUrl.pathname = "/" + databaseName;
    targetUrl.search = "";
    let created = false;
    let legacyName: string | null = null;
    let schedulerSql: { end: (options?: { timeout?: number }) => Promise<unknown> } | null = null;
    try {
      await admin.unsafe("CREATE DATABASE " + identifier(databaseName));
      created = true;
      process.env.DATABASE_URL = targetUrl.toString();
      process.env.AGENT_MODE = "real";

      const { migrate, sql } = await import("./db.js");
      const runtime = await import("./runtime-images.js");
      schedulerSql = sql;
      await migrate();

      const projectId = randomUUID();
      const imageId = randomUUID();
      const versionId = randomUUID();
      const imageKey = "channel-fixture-" + randomUUID().slice(0, 8);
      const digest = "sha256:" + "c".repeat(64);
      const githubRef = "ghcr.io/summersec/" + imageKey + "@" + digest;
      const dockerHubRef = "docker.io/summersec/" + imageKey + "@" + digest;
      await sql.unsafe(
        "INSERT INTO projects (id, canvas_id, name) VALUES (" +
        [projectId, "canvas-" + projectId, "runtime channel fixture"].map(quote).join(", ") + ")",
      );
      await sql.unsafe(
        "INSERT INTO runtime_images (id, image_key, name, description, publisher, source_kind, official) VALUES (" +
        [imageId, imageKey, "Channel fixture", "fixture", "SummerSec", "official", "true"].map(quote).join(", ") + ")",
      );
      await sql.unsafe(
        "INSERT INTO runtime_image_versions (id, runtime_image_id, version, image_ref, resolved_ref, digest, platforms_json, trust_status, promoted_at) VALUES (" +
        [versionId, imageId, "0.1.0", githubRef, githubRef, digest, JSON.stringify(["linux/amd64"]), "trusted"].map(quote).join(", ") + ", now())",
      );
      await sql.unsafe(
        "INSERT INTO runtime_image_version_refs (version_id, channel, image_ref, resolved_ref, digest, evidence_json) VALUES " +
        "(" + [versionId, "github", githubRef, githubRef, digest, JSON.stringify({ source: "fixture" })].map(quote).join(", ") + "), " +
        "(" + [versionId, "dockerhub", dockerHubRef, dockerHubRef, digest, JSON.stringify({ source: "fixture" })].map(quote).join(", ") + ")",
      );

      const resolve = (db: typeof sql) => runtime.resolveRuntimeImageForJob(db, projectId, "audit", imageKey);
      await sql.unsafe("UPDATE global_settings SET runtime_registry_channel = 'github' WHERE id = 'global'");
      const oldSnapshot = await resolve(sql);
      assert.equal(oldSnapshot.registry_channel, "github");
      assert.equal(oldSnapshot.image_ref, githubRef);
      assert.equal(oldSnapshot.image_digest, digest);

      await sql.unsafe("UPDATE global_settings SET runtime_registry_channel = 'dockerhub' WHERE id = 'global'");
      const newSnapshot = await resolve(sql);
      assert.equal(newSnapshot.registry_channel, "dockerhub");
      assert.equal(newSnapshot.image_ref, dockerHubRef);
      assert.equal(newSnapshot.image_digest, digest);
      assert.equal(oldSnapshot.registry_channel, "github");
      assert.equal(oldSnapshot.image_ref, githubRef);

      await sql.unsafe(
        "DELETE FROM runtime_image_version_refs WHERE version_id = " + quote(versionId) + " AND channel = 'dockerhub'",
      );
      await assert.rejects(
        resolve(sql),
        (error: unknown) => error instanceof runtime.RuntimeImageChannelUnavailableError
          && error.code === "RUNTIME_IMAGE_CHANNEL_UNAVAILABLE"
          && error.statusCode === 409
          && error.channel === "dockerhub"
          && error.imageKey === imageKey,
      );

      const baselinePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../database/fixtures/schema-v12.sql");
      const migrationsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../database/migrations");
      legacyName = "deepsonar_runtime_channels_v1_" + process.pid + "_" + Date.now() + "_" + randomUUID().slice(0, 8);
      await admin.unsafe("CREATE DATABASE " + identifier(legacyName));
      const legacyUrl = new URL(testDatabaseUrl);
      legacyUrl.pathname = "/" + legacyName;
      legacyUrl.search = "";
      const legacy = postgres(legacyUrl.toString(), { max: 1 });
      try {
        await legacy.unsafe(await readFile(baselinePath, "utf8"));
        const legacyImageId = randomUUID();
        const legacyVersionId = randomUUID();
        const legacyKey = "legacy-fixture-" + randomUUID().slice(0, 8);
        const legacyDigest = "sha256:" + "d".repeat(64);
        const legacyRef = "ghcr.io/summersec/" + legacyKey + "@" + legacyDigest;
        await legacy.unsafe(
          "INSERT INTO runtime_images (id, image_key, name, description, publisher, source_kind, official) VALUES (" +
          [legacyImageId, legacyKey, "Legacy fixture", "fixture", "SummerSec", "official", "true"].map(quote).join(", ") + ")",
        );
        await legacy.unsafe(
          "INSERT INTO runtime_image_versions (id, runtime_image_id, version, image_ref, resolved_ref, digest, platforms_json, trust_status) VALUES (" +
          [legacyVersionId, legacyImageId, "0.1.0", legacyRef, legacyRef, legacyDigest, JSON.stringify(["linux/amd64"]), "trusted"].map(quote).join(", ") + ")",
        );

        const migrationNames: Record<number, string> = {
          13: "add_schema_migrations",
          14: "add_canvas_change_log",
          15: "credential_health_metadata",
          16: "role_ui_colors",
          17: "add_event_rate_limits",
          18: "runtime_registry_channels",
        };
        for (const version of [13, 14, 15, 16, 17, 18]) {
          const filename = String(version).padStart(4, "0") + "_" + migrationNames[version] + ".sql";
          const bodyBytes = await readFile(path.join(migrationsPath, filename));
          await legacy.unsafe(bodyBytes.toString("utf8"));
          await legacy.unsafe(
            "INSERT INTO schema_migrations (version, filename, checksum, result) VALUES (" +
            [String(version), filename, createHash("sha256").update(bodyBytes).digest("hex"), "succeeded"].map(quote).join(", ") + ")",
          );
          await legacy.unsafe("UPDATE schema_meta SET version = " + String(version) + ", applied_at = now() WHERE id = 'global'");
        }
        const [backfilled] = await legacy.unsafe(
          "SELECT channel, image_ref, resolved_ref, digest FROM runtime_image_version_refs WHERE version_id = " + quote(legacyVersionId),
        ) as { channel: string; image_ref: string; resolved_ref: string; digest: string }[];
        assert.deepEqual(backfilled, {
          channel: "github",
          image_ref: legacyRef,
          resolved_ref: legacyRef,
          digest: legacyDigest,
        });
      } finally {
        await legacy.end({ timeout: 5 });
      }
    } finally {
      if (schedulerSql) await schedulerSql.end({ timeout: 5 }).catch(() => undefined);
      if (legacyName) await admin.unsafe("DROP DATABASE IF EXISTS " + identifier(legacyName));
      if (created) await admin.unsafe("DROP DATABASE IF EXISTS " + identifier(databaseName));
      await admin.end();
    }
  });
}
