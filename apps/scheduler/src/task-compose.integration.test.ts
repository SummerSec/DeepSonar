import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("compose task PostgreSQL integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("compose tasks freeze eligible seeds, project nodes, and fail closed when stale", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";
    const blobDir = path.resolve(process.cwd(), `data/task-compose-report-${process.pid}-${Date.now()}`);
    process.env.BLOB_DIR = blobDir;
    const { migrate, sql } = await import("./db.js");
    const { ensureCanvasForTask } = await import("./core.js");
    const { buildGraphSnapshot } = await import("./graph.js");
    const { TaskSeedInputError, validateFrozenTaskSeedsForRetry } = await import("./task-compose.js");
    await migrate();

    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const sourceCanvasId = randomUUID();
    const sourceRootId = randomUUID();
    const sourceNodeId = randomUUID();
    const sourceJobId = randomUUID();
    const findingId = randomUUID();
    const canvasIds: string[] = [];
    try {
      await sql`
        INSERT INTO projects (id, canvas_id, name, config_json)
        VALUES
          (${projectId}, ${"compose-project-" + projectId}, 'compose-project', ${sql.json({ rules: { hubEnabled: false } })}),
          (${otherProjectId}, ${"compose-other-" + otherProjectId}, 'compose-other', ${sql.json({ rules: { hubEnabled: false } })})`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${sourceCanvasId}, ${projectId}, 'origin task', ${sql.json({ goal: "origin" })})`;
      await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES (${sourceJobId}, ${projectId}, ${sourceCanvasId}, 'audit', 'succeeded', ${sql.json({})}, ${sql.json({})})`;
      await sql`INSERT INTO canvas_nodes (id, canvas_id, node_type, title, status, body_json)
        VALUES
          (${sourceRootId}, ${sourceCanvasId}, 'root', 'origin task', 'succeeded', ${sql.json({})}),
          (${sourceNodeId}, ${sourceCanvasId}, 'finding', 'confirmed primitive', 'confirmed', ${sql.json({ summary: "origin" })})`;
      await sql`INSERT INTO findings (
          id, project_id, job_id, node_id, fingerprint, title, severity, profile,
          category, tags_json, location, summary, verify_status, disposition
        ) VALUES (
          ${findingId}, ${projectId}, ${sourceJobId}, ${sourceNodeId}, 'compose-fixture',
          'confirmed primitive', 'medium', 'security.vulnerability', 'injection',
          ${sql.json(["chain", "auth"])}, 'src/auth.ts:10', 'historical summary', 'confirmed', 'open'
        )`;
      const reportMarkdown = "# Finding report\n\nVerified exploit chain and remediation context.";
      const reportUri = `finding-reports/${findingId}/v1/report.md`;
      await mkdir(path.dirname(path.join(blobDir, reportUri)), { recursive: true });
      await writeFile(path.join(blobDir, reportUri), reportMarkdown, "utf8");
      await sql`INSERT INTO finding_reports (
          finding_id, canvas_id, project_id, version, status, input_uri, input_sha256,
          markdown_uri, markdown_sha256, summary_json
        ) VALUES (
          ${findingId}, ${sourceCanvasId}, ${projectId}, 1, 'succeeded',
          'finding-reports/input.json', ${"0".repeat(64)}, ${reportUri},
          ${createHash("sha256").update(reportMarkdown).digest("hex")}, ${sql.json({})}
        )`;

      const standardCanvasId = await ensureCanvasForTask({
        projectId, title: "standard", target: { goal: "empty start" },
      });
      canvasIds.push(standardCanvasId);
      const [standard] = await sql`SELECT c.target_json,
          (SELECT count(*)::int FROM canvas_nodes n WHERE n.canvas_id = c.id AND n.node_type = 'finding') AS seed_nodes
        FROM canvases c WHERE c.id = ${standardCanvasId}`;
      assert.equal((standard.target_json as Record<string, unknown>).kind, "standard");
      assert.equal(standard.seed_nodes, 0);

      const composeCanvasId = await ensureCanvasForTask({
        projectId,
        title: "compose",
        allowComposeSeeds: true,
        target: { kind: "compose", goal: "find a chain", seed_finding_ids: [findingId] },
      });
      canvasIds.push(composeCanvasId);
      const [compose] = await sql`SELECT target_json FROM canvases WHERE id = ${composeCanvasId}`;
      const frozen = compose.target_json as Record<string, unknown>;
      assert.equal(frozen.kind, "compose");
      assert.deepEqual(frozen.seed_finding_ids, [findingId.toLowerCase()]);
      const frozenSeed = (frozen.seed_findings as Record<string, unknown>[])[0];
      assert.equal(frozenSeed.summary, reportMarkdown);
      assert.equal(frozenSeed.content_source, "finding_report");
      assert.equal(frozenSeed.report_version, 1);

      const [projection] = await sql`SELECT n.id, n.job_id, n.status, n.body_json,
          EXISTS (
            SELECT 1 FROM canvas_edges e JOIN canvas_nodes root ON root.id = e.from_node_id
            WHERE e.to_node_id = n.id AND e.edge_type = 'child' AND root.node_type = 'root'
          ) AS attached_to_root
        FROM canvas_nodes n
        WHERE n.canvas_id = ${composeCanvasId} AND n.node_type = 'finding'`;
      assert.equal(projection.job_id, null);
      assert.equal(projection.status, "imported");
      assert.equal(projection.attached_to_root, true);
      assert.equal((projection.body_json as Record<string, unknown>).origin, "seed");
      assert.equal((projection.body_json as Record<string, unknown>).readonly, true);
      assert.equal(
        (await sql`SELECT count(*)::int AS count FROM canvas_nodes
          WHERE canvas_id = ${composeCanvasId} AND node_type = 'finding' AND status = 'confirmed'`)[0].count,
        0,
        "imported seeds do not inflate this task's confirmed Finding rollup",
      );
      assert.equal((await sql`SELECT count(*)::int AS count FROM findings WHERE project_id = ${projectId}`)[0].count, 1);

      const graph = await buildGraphSnapshot(composeCanvasId, "hub", { maxYamlChars: 12_000 });
      assert.ok(graph.referableIds.includes(String(projection.id)));
      assert.match(graph.yaml, /"imported":true/);
      assert.match(graph.yaml, new RegExp(String(projection.id)));
      assert.doesNotMatch(graph.yaml, new RegExp(findingId));

      await sql`UPDATE findings SET disposition = 'rejected_fp' WHERE id = ${findingId}`;
      const [afterDisposition] = await sql`SELECT target_json FROM canvases WHERE id = ${composeCanvasId}`;
      assert.deepEqual((afterDisposition.target_json as Record<string, unknown>).seed_findings, frozen.seed_findings);
      await assert.rejects(
        validateFrozenTaskSeedsForRetry(sql, projectId, frozen),
        (error: unknown) => error instanceof TaskSeedInputError && /当前为 confirmed/.test(error.message),
      );

      const before = Number((await sql`SELECT count(*)::int AS count FROM canvases WHERE project_id = ${projectId}`)[0].count);
      await assert.rejects(ensureCanvasForTask({
        projectId, title: "stale compose", allowComposeSeeds: true,
        target: { kind: "compose", goal: "must fail", seed_finding_ids: [findingId] },
      }), TaskSeedInputError);
      const after = Number((await sql`SELECT count(*)::int AS count FROM canvases WHERE project_id = ${projectId}`)[0].count);
      assert.equal(after, before, "invalid seed selection does not create a canvas");

      await sql`UPDATE findings SET disposition = 'open' WHERE id = ${findingId}`;
      await assert.rejects(ensureCanvasForTask({
        projectId: otherProjectId, title: "cross-project compose", allowComposeSeeds: true,
        target: { kind: "compose", goal: "must fail", seed_finding_ids: [findingId] },
      }), TaskSeedInputError);
    } finally {
      await sql`DELETE FROM canvas_edges WHERE canvas_id = ANY(${[sourceCanvasId, ...canvasIds]}::text[])`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id = ANY(${[sourceCanvasId, ...canvasIds]}::text[])`;
      await sql`DELETE FROM finding_verification_rounds WHERE finding_id = ${findingId}`;
      await sql`DELETE FROM findings WHERE id = ${findingId}`;
      await sql`DELETE FROM jobs WHERE id = ${sourceJobId}`;
      await sql`DELETE FROM canvases WHERE project_id = ANY(${[projectId, otherProjectId]}::uuid[])`;
      await sql`DELETE FROM projects WHERE id = ANY(${[projectId, otherProjectId]}::uuid[])`;
      await sql.end({ timeout: 5 });
      await rm(blobDir, { recursive: true, force: true });
    }
  });
}
