import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { HUB_REFERENCE_LIMITS } from "@deepsonar/shared-types";
import { ControlInputError } from "./control-input.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("Hub graph-reference integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("invalid Hub references roll back the whole decision without PostgreSQL UUID errors", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("./db.js");
    const { applySideEffects, ingestEvent, insertEdgesIfAbsentBatch } = await import("./core.js");
    const { queryHubReferenceNodes } = await import("./graph.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `graph-reference-${randomUUID()}`;
    const otherCanvasId = `graph-reference-other-${randomUUID()}`;
    const jobId = randomUUID();
    const validSnapshot = { agent_cli: "claude-code", credential_id: null, model: null };
    let rootId = "";
    let otherRootId = "";

    await sql`
      INSERT INTO projects (id, canvas_id, name, config_json)
      VALUES (${projectId}, ${canvasId}, 'graph-reference', ${sql.json({})})`;
    await sql`
      INSERT INTO canvases (id, project_id, title, target_json)
      VALUES (${canvasId}, ${projectId}, 'graph-reference', ${sql.json({})})`;
    await sql`
      INSERT INTO canvases (id, project_id, title, target_json)
      VALUES (${otherCanvasId}, ${projectId}, 'graph-reference-other', ${sql.json({})})`;
    const [root] = await sql<{ id: string }[]>`
      INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
      VALUES (${canvasId}, 'root', 'root', 'active', ${sql.json({})})
      RETURNING id`;
    rootId = root.id;
    const [otherRoot] = await sql<{ id: string }[]>`
      INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
      VALUES (${otherCanvasId}, 'root', 'other root', 'active', ${sql.json({})})
      RETURNING id`;
    otherRootId = otherRoot.id;
    await sql`
      INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
      VALUES (${jobId}, ${projectId}, ${canvasId}, 'hub_reason', 'running', ${sql.json(validSnapshot)}, ${sql.json({})})`;

    const decision = (from: unknown, complete = false) =>
      complete
        ? { complete: { from, description: "完成" } }
        : { intents: [{ from, role: "review", description: "复核", prompt: "执行复核" }] };

    const attempt = async (payload: unknown, label: string, expectedCode = "invalid_node_ref") => {
      const eventId = randomUUID();
      await assert.rejects(
        () => ingestEvent(jobId, { v: 1, event_id: eventId, type: "hub_decision", payload }),
        (error: unknown) => {
          assert.ok(error instanceof ControlInputError, `${label}: expected ControlInputError`);
          assert.equal(error.code, expectedCode, label);
          if (expectedCode === "invalid_node_ref") assert.match(error.message, /YAML root_id/);
          else if (expectedCode === "invalid_reference_budget") assert.match(error.message, /invalid_reference_budget|引用数量/);
          else assert.match(error.message, new RegExp(expectedCode));
          assert.doesNotMatch(error.message, /invalid input syntax for type uuid/i);
          return true;
        },
      );
      const [counts] = await sql<{ events: number; dedup: number; edges: number; jobs: number }[]>`
        SELECT
          (SELECT COUNT(*)::int FROM events WHERE job_id = ${jobId}) AS events,
          (SELECT COUNT(*)::int FROM event_dedup WHERE job_id = ${jobId}) AS dedup,
          (SELECT COUNT(*)::int FROM canvas_edges WHERE canvas_id = ${canvasId}) AS edges,
          (SELECT COUNT(*)::int FROM jobs WHERE parent_job_id = ${jobId}) AS jobs`;
      assert.deepEqual(counts, { events: 0, dedup: 0, edges: 0, jobs: 0 }, `${label}: partial side effect`);
    };

    try {
      await attempt(decision(["root_id"]), "root_id field name");
      await attempt(decision(["not-a-uuid"]), "non-UUID");
      await attempt(decision([otherRootId]), "cross-canvas UUID");
      await attempt(decision(["root_id"], true), "complete.from field name");
      await attempt(decision(undefined), "missing from");
      await attempt(
        decision(Array.from({ length: HUB_REFERENCE_LIMITS.perFrom + 1 }, () => rootId)),
        "per-from reference budget",
        "invalid_reference_budget",
      );
      const totalBudgetRefs = Array.from({ length: HUB_REFERENCE_LIMITS.totalUnique + 1 }, () => randomUUID());
      const totalBudgetIntents = [];
      for (let offset = 0; offset < totalBudgetRefs.length; offset += HUB_REFERENCE_LIMITS.perFrom) {
        totalBudgetIntents.push({
          from: totalBudgetRefs.slice(offset, offset + HUB_REFERENCE_LIMITS.perFrom),
          role: "review",
          description: `intent-${offset}`,
          prompt: "run",
        });
      }
      await attempt(
        { intents: totalBudgetIntents },
        "total unique reference budget",
        "invalid_reference_budget",
      );
      const beyondCapIntents = Array.from({ length: 7 }, (_, index) => ({
        from: [rootId],
        role: index === 6 ? "role-that-is-not-enabled" : "review",
        description: `cap intent ${index}`,
        prompt: "run enough detail",
      }));
      await attempt(
        { intents: beyondCapIntents },
        "invalid role beyond max intent cap",
        "invalid_role",
      );

      const [validResult] = await sql<{ id: string }[]>`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'fact', 'valid fact', 'open', ${sql.json({})})
        RETURNING id`;
      const validEventId = randomUUID();
      const accepted = await ingestEvent(jobId, {
        v: 1,
        event_id: validEventId,
        type: "hub_decision",
        payload: decision([validResult.id]),
      });
      assert.equal(accepted.deduped, false);
      const [{ eventCount }] = await sql<{ eventCount: number }[]>`
        SELECT COUNT(*)::int AS "eventCount" FROM events WHERE job_id = ${jobId}`;
      assert.equal(eventCount, 1);

      const [factOne] = await sql<{ id: string }[]>`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'fact', 'fact one', 'open', ${sql.json({})})
        RETURNING id`;
      const [factTwo] = await sql<{ id: string }[]>`
        INSERT INTO canvas_nodes (canvas_id, node_type, title, status, body_json)
        VALUES (${canvasId}, 'fact', 'fact two', 'open', ${sql.json({})})
        RETURNING id`;
      const completePayload = {
        complete: {
          from: [factOne.id, factOne.id, factTwo.id],
          description: "完成批量引用",
        },
      };
      await sql`UPDATE jobs SET status = 'succeeded' WHERE parent_job_id = ${jobId}`;
      await sql`UPDATE jobs SET status = 'succeeded' WHERE id = ${jobId}`;
      await sql`
        INSERT INTO jobs (id, project_id, canvas_id, parent_job_id, type, status, agent_snapshot_json, payload_json)
        VALUES (${randomUUID()}, ${projectId}, ${canvasId}, ${jobId}, 'review', 'succeeded', ${sql.json(validSnapshot)}, ${sql.json({})})`;
      let lookupCalls = 0;
      let lookedUpIds: string[] = [];
      let batchInsertCalls = 0;
      const batchEdgeSizes: number[] = [];
      const services = {
        hubReferenceLookup: async (tx: typeof sql, targetCanvasId: string, ids: readonly string[]) => {
          lookupCalls += 1;
          lookedUpIds = [...ids];
          return queryHubReferenceNodes(tx, targetCanvasId, ids);
        },
        hubEdgeBatchInsert: async (
          tx: typeof sql,
          edges: readonly { canvasId: string; fromId: string; toId: string; edgeType: string }[],
        ) => {
          batchInsertCalls += 1;
          batchEdgeSizes.push(edges.length);
          return insertEdgesIfAbsentBatch(tx, edges);
        },
      };
      await sql.begin(async (rawTx) => {
        await applySideEffects(rawTx as unknown as typeof sql, jobId, "hub_decision", completePayload, services);
      });
      assert.equal(lookupCalls, 1, "core should perform one batched reference lookup");
      assert.deepEqual(lookedUpIds, [factOne.id, factTwo.id], "duplicate references should be queried once");
      const [{ completeEdges }] = await sql<{ completeEdges: number }[]>`
        SELECT COUNT(*)::int AS "completeEdges" FROM canvas_edges
        WHERE canvas_id = ${canvasId}
          AND to_node_id = ${rootId}
          AND edge_type = 'to'
          AND from_node_id = ANY(${[factOne.id, factTwo.id]}::uuid[])`;
      assert.equal(completeEdges, 2, "complete should create one edge per unique reference");
      assert.equal(batchInsertCalls, 1);
      assert.deepEqual(batchEdgeSizes, [2]);

      await sql.begin(async (rawTx) => {
        await applySideEffects(rawTx as unknown as typeof sql, jobId, "hub_decision", completePayload, services);
      });
      assert.equal(lookupCalls, 2, "each core event should still use one batch lookup");
      assert.equal(batchInsertCalls, 2, "replay should use one batch insert");
      const [{ duplicateEdges }] = await sql<{ duplicateEdges: number }[]>`
        SELECT COUNT(*)::int AS "duplicateEdges" FROM canvas_edges
        WHERE canvas_id = ${canvasId}
          AND to_node_id = ${rootId}
          AND edge_type = 'to'
          AND from_node_id = ANY(${[factOne.id, factTwo.id]}::uuid[])`;
      assert.equal(duplicateEdges, 2, "replaying a decision must not duplicate edges");

      const intentsPayload = {
        intents: [
          { from: [factOne.id, factOne.id], role: "review", description: "意图一", prompt: "执行一" },
          { from: [factTwo.id], role: "review", description: "意图二", prompt: "执行二" },
        ],
      };
      await sql.begin(async (rawTx) => {
        await applySideEffects(rawTx as unknown as typeof sql, jobId, "hub_decision", intentsPayload, services);
      });
      assert.equal(lookupCalls, 3, "multiple intents should share one reference snapshot");
      assert.equal(batchInsertCalls, 3);
      assert.deepEqual(batchEdgeSizes, [2, 2, 2]);
      const [{ intentEdges }] = await sql<{ intentEdges: number }[]>`
        SELECT COUNT(*)::int AS "intentEdges"
        FROM canvas_edges e
        JOIN canvas_nodes n ON n.id = e.to_node_id
        WHERE e.canvas_id = ${canvasId}
          AND e.edge_type = 'from'
          AND n.node_type = 'intent'
          AND e.from_node_id = ANY(${[factOne.id, factTwo.id]}::uuid[])`;
      assert.equal(intentEdges, 2, "multiple intents should create one edge per unique source");

      await sql.begin(async (rawTx) => {
        await applySideEffects(rawTx as unknown as typeof sql, jobId, "hub_decision", intentsPayload, services);
      });
      assert.equal(lookupCalls, 4, "duplicate intents still use one batch lookup");
      assert.equal(batchInsertCalls, 3, "duplicate intents with no new edges are a batch no-op");

      await sql`UPDATE jobs SET status = 'succeeded' WHERE parent_job_id = ${jobId}`;
      await sql.begin(async (rawTx) => {
        await applySideEffects(
          rawTx as unknown as typeof sql,
          jobId,
          "hub_decision",
          { complete: { from: [], description: "空引用完成" } },
          services,
        );
      });
      assert.equal(lookupCalls, 4, "empty references should skip the membership read");
      assert.equal(batchInsertCalls, 3, "empty references must not issue an INSERT batch");
    } finally {
      await sql`DELETE FROM canvas_edges WHERE canvas_id IN (${canvasId}, ${otherCanvasId})`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id IN (${canvasId}, ${otherCanvasId})`;
      await sql`DELETE FROM event_dedup WHERE job_id = ${jobId}`;
      await sql`DELETE FROM events WHERE job_id = ${jobId}`;
      await sql`DELETE FROM jobs WHERE parent_job_id = ${jobId}`;
      await sql`DELETE FROM jobs WHERE id = ${jobId}`;
      await sql`DELETE FROM canvases WHERE id IN (${canvasId}, ${otherCanvasId})`;
      await sql`DELETE FROM projects WHERE id = ${projectId}`;
      await sql.end({ timeout: 5 });
    }
  });
}
