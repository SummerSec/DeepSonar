/**
 * Regression checks for the application transfer manifest schema contract.
 * No Scheduler or PostgreSQL process is required.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProjectManifest,
} from "../apps/scheduler/src/transfer/export.js";
import {
  buildPlatformManifest,
  PLATFORM_FORMAT,
} from "../apps/scheduler/src/transfer/platform.js";
import {
  buildManifestSource,
  openDeepsonarPack,
  validateManifestSchemaVersion,
  writeDeepsonarPack,
  type Manifest,
} from "../apps/scheduler/src/transfer/pack.js";
import { SCHEMA_VERSION } from "../apps/scheduler/src/schema-version.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaSqlPath = path.join(repoRoot, "database", "schema.sql");

function baseManifest(schemaVersion: number, format: string): Manifest {
  return {
    format,
    format_version: "1.0",
    created_at: new Date(0).toISOString(),
    source: {
      app_version: "test",
      schema_version: schemaVersion,
      instance_id: "sha256:test",
      project_id: format === PLATFORM_FORMAT ? "platform" : "project",
      project_name: "test",
    },
    // Platform manifests use a separate preset string at runtime; this value
    // is irrelevant to schema validation and keeps the shared test fixture typed.
    preset: "configuration",
    modules: [],
    counts: {},
    compatibility: { minimum_importer_version: "1.0", module_versions: {} },
    secrets: { mode: "excluded", algorithm: null },
    signature: null,
  };
}

async function packWithSchema(tempDir: string, schemaVersion: number, format: string): Promise<Buffer> {
  const outPath = path.join(tempDir, `${schemaVersion}-${format}.deepsonarpack`);
  await writeDeepsonarPack(
    [{ path: "data/project.json", content: "{}" }],
    baseManifest(schemaVersion, format),
    outPath,
  );
  return readFile(outPath);
}

async function main(): Promise<void> {
  const schemaSql = readFileSync(schemaSqlPath, "utf8");
  const schemaRow = schemaSql.match(/INSERT INTO schema_meta\s*\(id, version\)\s*VALUES\s*\('global',\s*(\d+)\)/i);
  assert.ok(schemaRow, "database/schema.sql must declare schema_meta version");
  assert.equal(Number(schemaRow[1]), SCHEMA_VERSION, "database baseline and db.ts must share SCHEMA_VERSION");

  const projectManifest = buildProjectManifest({
    projectId: "project",
    projectName: "test",
    preset: "project_full",
    modules: [],
    counts: {},
    credentialsMode: "excluded",
    instanceId: "test-instance",
  });
  assert.equal(projectManifest.source.schema_version, SCHEMA_VERSION, "project exporter schema drifted");

  const platformManifest = buildPlatformManifest({
    preset: "platform_full",
    modules: [],
    counts: {},
    credentialsMode: "excluded",
    instanceId: "test-instance",
  });
  assert.equal(platformManifest.source.schema_version, SCHEMA_VERSION, "platform exporter schema drifted");

  assert.equal(buildManifestSource({
    app_version: "test",
    instance_id: "sha256:test",
    project_id: "project",
    project_name: "test",
  }).schema_version, SCHEMA_VERSION);
  assert.throws(() => validateManifestSchemaVersion(SCHEMA_VERSION - 1), (error: unknown) => (
    error && typeof error === "object" && "code" in error && error.code === "BAD_SCHEMA_VERSION"
  ));
  assert.throws(() => validateManifestSchemaVersion(SCHEMA_VERSION + 1), (error: unknown) => (
    error && typeof error === "object" && "code" in error && error.code === "BAD_SCHEMA_VERSION"
  ));

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "deepsonar-transfer-schema-"));
  try {
    const current = await openDeepsonarPack(await packWithSchema(tempDir, SCHEMA_VERSION, "deepsonar-project-export"));
    assert.equal(current.manifest.source.schema_version, SCHEMA_VERSION);

    await assert.rejects(
      async () => openDeepsonarPack(await packWithSchema(tempDir, SCHEMA_VERSION - 1, "deepsonar-project-export")),
      (error: unknown) => error && typeof error === "object" && "code" in error && error.code === "BAD_SCHEMA_VERSION",
    );

    await assert.rejects(
      async () => openDeepsonarPack(await packWithSchema(tempDir, SCHEMA_VERSION + 1, "deepsonar-project-export")),
      (error: unknown) => error && typeof error === "object" && "code" in error && error.code === "BAD_SCHEMA_VERSION",
    );
    await assert.rejects(
      async () => openDeepsonarPack(await packWithSchema(tempDir, 0, "deepsonar-platform-export")),
      (error: unknown) => error && typeof error === "object" && "code" in error && error.code === "BAD_SCHEMA_VERSION",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  console.log(`transfer schema checks passed (schema v${SCHEMA_VERSION})`);
}

await main();
