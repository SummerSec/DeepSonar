import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("project export active-job gate (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("custom findings export succeeds while project_full stays blocked by ACTIVE_JOBS", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("../db.js");
    const { deleteProjectsLeavingAuditShells } = await import("../test-project-teardown.js");
    const { runExport } = await import("./export.js");
    const { loadPackFile, openDeepsonarPack, readJsonl, removeFileSafe } = await import("./pack.js");
    const { activeJobsErrorMessage, resolveModules } = await import("./modules.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `export-active-${randomUUID()}`;
    const doneJobId = randomUUID();
    const runningJobId = randomUUID();
    const findingId = randomUUID();
    const snapshot = { agent_cli: "claude-code", credential_id: null, credential_provider: null, model: null };
    const artifactUris: string[] = [];

    const enqueue = async (preset: "project_full" | "custom", modules: string[], allowActiveJobs = false) => {
      const resolved = resolveModules(preset, modules).modules;
      const [row] = await sql`
        INSERT INTO data_exports (project_id, scope, preset, modules_json, options_json, status)
        VALUES (
          ${projectId},
          'project',
          ${preset},
          ${sql.json(resolved as never)},
          ${sql.json({
            preset,
            modules,
            allow_active_jobs: allowActiveJobs,
            credentials: { mode: "excluded" },
          } as never)},
          'pending'
        )
        RETURNING id`;
      return row.id as string;
    };

    try {
      await sql`
        INSERT INTO projects (id, name, config_json)
        VALUES (${projectId}, ${`export-active-${projectId}`}, ${sql.json({})})`;
      await sql`
        INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${canvasId}, ${projectId}, 'export active jobs', ${sql.json({})})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES (${doneJobId}, ${projectId}, ${canvasId}, 'audit', 'succeeded', ${sql.json({})}, ${sql.json(snapshot)})`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
        VALUES (${runningJobId}, ${projectId}, ${canvasId}, 'review', 'running', ${sql.json({})}, ${sql.json(snapshot)})`;
      await sql`
        INSERT INTO findings (id, project_id, job_id, fingerprint, title, severity, summary)
        VALUES (
          ${findingId}, ${projectId}, ${doneJobId}, ${`fp-${findingId}`},
          'committed finding', 'high', 'already submitted finding row'
        )`;

      const fullId = await enqueue("project_full", []);
      await runExport(fullId);
      const [fullRow] = await sql<{ status: string; error_code: string | null; error: string | null }[]>`
        SELECT status, error_code, error FROM data_exports WHERE id = ${fullId}`;
      assert.equal(fullRow?.status, "failed");
      assert.equal(fullRow?.error_code, "ACTIVE_JOBS");
      assert.equal(fullRow?.error, activeJobsErrorMessage(1));
      assert.match(fullRow?.error ?? "", /证据归档/);
      assert.match(fullRow?.error ?? "", /自定义模块/);

      const findingsId = await enqueue("custom", ["findings"]);
      await runExport(findingsId);
      const [findingsRow] = await sql<{ status: string; error_code: string | null; artifact_uri: string | null }[]>`
        SELECT status, error_code, artifact_uri FROM data_exports WHERE id = ${findingsId}`;
      assert.equal(findingsRow?.status, "succeeded", findingsRow?.error_code ?? "");
      assert.ok(findingsRow?.artifact_uri);
      artifactUris.push(findingsRow.artifact_uri);
      const pack = await openDeepsonarPack(await loadPackFile(findingsRow.artifact_uri));
      assert.ok(pack.manifest.modules.includes("findings"));
      assert.ok(pack.manifest.modules.includes("tasks"));
      const exported = readJsonl(pack.files, "data/findings.jsonl");
      assert.equal(exported.some((row) => row.source_id === findingId), true);

      const eventsId = await enqueue("custom", ["events"]);
      await runExport(eventsId);
      const [eventsRow] = await sql<{ status: string; error_code: string | null }[]>`
        SELECT status, error_code FROM data_exports WHERE id = ${eventsId}`;
      assert.equal(eventsRow?.status, "failed");
      assert.equal(eventsRow?.error_code, "ACTIVE_JOBS");
    } finally {
      await Promise.all(artifactUris.map((uri) => removeFileSafe(uri)));
      await sql`DELETE FROM data_exports WHERE project_id = ${projectId}`;
      await sql`DELETE FROM findings WHERE project_id = ${projectId}`;
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE project_id = ${projectId}`;
      await deleteProjectsLeavingAuditShells(sql, [projectId]);
    }
  });
}
