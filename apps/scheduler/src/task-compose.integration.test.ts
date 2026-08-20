import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

type SchedulerSql = typeof import("./db.js").sql;

/** Wipe compose fixtures in FK-safe order. `events` / `event_dedup` have no ON DELETE CASCADE. */
async function wipeProjectComposeFixtures(db: SchedulerSql, projectIds: readonly string[]): Promise<void> {
  if (projectIds.length === 0) return;
  const ids = [...projectIds];
  await db`DELETE FROM canvas_edges WHERE canvas_id IN (SELECT id FROM canvases WHERE project_id = ANY(${ids}::uuid[]))`;
  await db`DELETE FROM canvas_nodes WHERE canvas_id IN (SELECT id FROM canvases WHERE project_id = ANY(${ids}::uuid[]))`;
  await db`DELETE FROM task_reports WHERE project_id = ANY(${ids}::uuid[])`;
  await db`DELETE FROM finding_verification_rounds WHERE finding_id IN (SELECT id FROM findings WHERE project_id = ANY(${ids}::uuid[]))`;
  await db`DELETE FROM findings WHERE project_id = ANY(${ids}::uuid[])`;
  await db`DELETE FROM event_dedup WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ANY(${ids}::uuid[]))`;
  await db`DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ANY(${ids}::uuid[]))`;
  await db`UPDATE jobs SET parent_job_id = NULL WHERE project_id = ANY(${ids}::uuid[])`;
  await db`DELETE FROM jobs WHERE project_id = ANY(${ids}::uuid[])`;
  await db`DELETE FROM canvases WHERE project_id = ANY(${ids}::uuid[])`;
  await db`DELETE FROM projects WHERE id = ANY(${ids}::uuid[])`;
}

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
      assert.match(graph.yaml, /compose_scope:/);
      assert.match(graph.yaml, new RegExp(String(projection.id)));
      assert.doesNotMatch(graph.yaml, new RegExp(findingId));

      await sql`UPDATE findings SET disposition = 'rejected_fp' WHERE id = ${findingId}`;
      const [afterDisposition] = await sql`SELECT target_json FROM canvases WHERE id = ${composeCanvasId}`;
      assert.deepEqual((afterDisposition.target_json as Record<string, unknown>).seed_findings, frozen.seed_findings);
      await assert.rejects(
        validateFrozenTaskSeedsForRetry(sql, projectId, frozen),
        (error: unknown) => error instanceof TaskSeedInputError && /当前处置为/.test(error.message),
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
      await wipeProjectComposeFixtures(sql, [projectId, otherProjectId]);
      await rm(blobDir, { recursive: true, force: true });
    }
  });

  test("compose accepts pending seeds, rejects out-of-scope findings and unbound explore", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";
    const { migrate, sql } = await import("./db.js");
    const { ensureCanvasForTask, ingestEvent } = await import("./core.js");
    const { TaskSeedInputError, validateFrozenTaskSeedsForRetry } = await import("./task-compose.js");
    const { ControlInputError } = await import("./control-input.js");
    await migrate();

    const projectId = randomUUID();
    const sourceCanvasId = randomUUID();
    const sourceRootId = randomUUID();
    const sourceJobId = randomUUID();
    const pendingIds = Array.from({ length: 7 }, () => randomUUID());
    const confirmedId = randomUUID();
    const canvasIds: string[] = [];
    const workerJobId = randomUUID();
    const hubJobId = randomUUID();
    try {
      await sql`
        INSERT INTO projects (id, canvas_id, name, config_json)
        VALUES (${projectId}, ${"compose-pending-" + projectId}, 'compose-pending', ${sql.json({ rules: { hubEnabled: true } })})`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json)
        VALUES (${sourceCanvasId}, ${projectId}, 'origin pending', ${sql.json({ goal: "origin" })})`;
      await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES (${sourceJobId}, ${projectId}, ${sourceCanvasId}, 'audit', 'succeeded', ${sql.json({})}, ${sql.json({})})`;
      await sql`INSERT INTO canvas_nodes (id, canvas_id, node_type, title, status, body_json)
        VALUES (${sourceRootId}, ${sourceCanvasId}, 'root', 'origin pending', 'succeeded', ${sql.json({})})`;
      for (const [index, findingId] of pendingIds.entries()) {
        const nodeId = randomUUID();
        await sql`INSERT INTO canvas_nodes (id, canvas_id, node_type, title, status, body_json)
          VALUES (${nodeId}, ${sourceCanvasId}, 'finding', ${"pending medium " + index}, 'open', ${sql.json({ summary: "pending" })})`;
        await sql`INSERT INTO findings (
            id, project_id, job_id, node_id, fingerprint, title, severity, profile,
            category, tags_json, location, summary, verify_status, disposition
          ) VALUES (
            ${findingId}, ${projectId}, ${sourceJobId}, ${nodeId}, ${"pending-fixture-" + index},
            ${"pending medium " + index}, 'medium', 'security.vulnerability', 'injection',
            ${sql.json(["chain"])}, ${"hiview/base/mod" + index + ".cpp:10"}, 'pending historical summary', 'pending', 'open'
          )`;
      }
      const confirmedNodeId = randomUUID();
      await sql`INSERT INTO canvas_nodes (id, canvas_id, node_type, title, status, body_json)
        VALUES (${confirmedNodeId}, ${sourceCanvasId}, 'finding', 'confirmed sibling', 'confirmed', ${sql.json({})})`;
      await sql`INSERT INTO findings (
          id, project_id, job_id, node_id, fingerprint, title, severity, profile,
          category, tags_json, location, summary, verify_status, disposition
        ) VALUES (
          ${confirmedId}, ${projectId}, ${sourceJobId}, ${confirmedNodeId}, 'pending-confirmed-sibling',
          'confirmed sibling', 'medium', 'security.vulnerability', 'injection',
          ${sql.json(["chain"])}, 'hiview/base/confirmed.cpp:1', 'confirmed summary', 'confirmed', 'open'
        )`;

      const pendingCanvasId = await ensureCanvasForTask({
        projectId,
        title: "pending compose",
        allowComposeSeeds: true,
        target: { kind: "compose", goal: "confirm the mediums", seed_finding_ids: pendingIds },
      });
      canvasIds.push(pendingCanvasId);
      const [pendingCanvas] = await sql`SELECT target_json FROM canvases WHERE id = ${pendingCanvasId}`;
      const frozen = pendingCanvas.target_json as Record<string, unknown>;
      assert.equal(frozen.kind, "compose");
      assert.equal((frozen.seed_findings as { verify_status: string }[]).every((seed) => seed.verify_status === "pending"), true);
      await validateFrozenTaskSeedsForRetry(sql, projectId, frozen);
      const pendingGraph = await (await import("./graph.js")).buildGraphSnapshot(pendingCanvasId, "hub", { maxYamlChars: 12_000 });
      assert.match(pendingGraph.yaml, /compose_scope:/);
      assert.match(pendingGraph.yaml, /"verify_status":"pending"/);
      assert.doesNotMatch(pendingGraph.yaml, new RegExp(pendingIds[0]));

      const mixedCanvasId = await ensureCanvasForTask({
        projectId,
        title: "mixed compose",
        allowComposeSeeds: true,
        target: { kind: "compose", goal: "mix", seed_finding_ids: [...pendingIds.slice(0, 7), confirmedId].slice(0, 8) },
      });
      canvasIds.push(mixedCanvasId);

      const [projection] = await sql`SELECT id FROM canvas_nodes
        WHERE canvas_id = ${pendingCanvasId} AND node_type = 'finding' ORDER BY created_at LIMIT 1`;
      const [root] = await sql`SELECT id FROM canvas_nodes WHERE canvas_id = ${pendingCanvasId} AND node_type = 'root'`;
      await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES (
          ${workerJobId}, ${projectId}, ${pendingCanvasId}, 'audit', 'running',
          ${sql.json({ name: "audit", role_kind: "role", platform_tools: ["emit_finding", "mark_job_done"] })},
          ${sql.json({})}
        )`;
      await sql`INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${pendingCanvasId}, ${workerJobId}, 'job', 'audit', 'running', ${sql.json({})})`;

      await ingestEvent(workerJobId, {
        v: 1,
        event_id: randomUUID(),
        type: "finding",
        payload: {
          title: "Same module follow-on",
          summary: "Additional evidence stays inside the frozen hiview module and supports the selected seed.",
          location: "hiview/services/follow.cpp:4",
          profile: "security.vulnerability",
        },
      });
      await assert.rejects(
        ingestEvent(workerJobId, {
          v: 1,
          event_id: randomUUID(),
          type: "finding",
          payload: {
            title: "Unrelated new repository",
            summary: "This finding points at a repository that was never part of the frozen compose seeds.",
            location: "appexecfwk/src/new.cpp:1",
            profile: "security.vulnerability",
          },
        }),
        (error: unknown) => error instanceof ControlInputError && /种子资产/.test(String(error)),
      );

      await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES (
          ${hubJobId}, ${projectId}, ${pendingCanvasId}, 'hub_reason', 'running',
          ${sql.json({ name: "hub_reason", role_kind: "hub", platform_tools: ["list_available_roles", "submit_hub_decision", "mark_job_done"] })},
          ${sql.json({})}
        )`;
      await assert.rejects(
        ingestEvent(hubJobId, {
          v: 1,
          event_id: randomUUID(),
          type: "hub_decision",
          payload: {
            intents: [{
              from: [String(root.id)],
              role: "explore",
              description: "Hunt a new repo",
              prompt: "Clone repositories outside the frozen seeds and keep hunting the whole graph for variants.",
            }],
          },
        }),
        (error: unknown) => error instanceof ControlInputError && /imported 种子/.test(String(error)),
      );
      await ingestEvent(hubJobId, {
        v: 1,
        event_id: randomUUID(),
        type: "hub_decision",
        payload: {
          intents: [{
            from: [String(projection.id)],
            role: "explore",
            description: "Stay on seed assets",
            prompt: "Only inspect the bound seed projection assets and collect missing confirmation evidence.",
          }],
        },
      });
      const [exploreJob] = await sql`SELECT payload_json FROM jobs WHERE parent_job_id = ${hubJobId} AND type = 'explore'`;
      assert.match(String((exploreJob.payload_json as { intent?: { prompt?: string } }).intent?.prompt), /调度器范围/);

      await sql`UPDATE findings SET disposition = 'rejected_fp' WHERE id = ${pendingIds[0]}`;
      await assert.rejects(validateFrozenTaskSeedsForRetry(sql, projectId, frozen), TaskSeedInputError);
    } finally {
      await wipeProjectComposeFixtures(sql, [projectId]);
      await sql.end({ timeout: 5 });
    }
  });
}
