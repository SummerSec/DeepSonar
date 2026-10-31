import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
      const dockerHubRef = "docker.io/sumsec/" + imageKey + "@" + digest;
      await sql.unsafe(
        "INSERT INTO projects (id, name) VALUES (" +
        [projectId, "runtime channel fixture"].map(quote).join(", ") + ")",
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
    } finally {
      if (schedulerSql) await schedulerSql.end({ timeout: 5 }).catch(() => undefined);
      if (created) await admin.unsafe("DROP DATABASE IF EXISTS " + identifier(databaseName));
      await admin.end();
    }
  });
}
