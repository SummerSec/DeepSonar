import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteProjectsLeavingAuditShells } from "./test-project-teardown.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

if (!testDatabaseUrl) {
  test("canvas lifecycle projections (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("list/detail/summary/delta share the lifecycle rollup across active, terminal, and null transitions", async (t) => {
    process.env.DATABASE_URL = testDatabaseUrl;
    const [{ default: Fastify }, { default: websocket }, { migrate, sql }, { registerRoutes }] = await Promise.all([
      import("fastify"),
      import("@fastify/websocket"),
      import("./db.js"),
      import("./routes.js"),
    ]);
    await migrate();
    const app = Fastify({ logger: false });
    await app.register(websocket);
    registerRoutes(app);
    await app.ready();

    const projectId = randomUUID();
    const canvasId = randomUUID();
    const fields = ["active_count", "job_count", "started_at", "ended_at", "root_status", "report_status"] as const;
    const read = async (path: string): Promise<Record<string, any>> => {
      const response = await app.inject({ method: "GET", url: path });
      assert.equal(response.statusCode, 200, `${path}: ${response.payload}`);
      return JSON.parse(response.payload) as Record<string, any>;
    };
    const lifecycle = (row: Record<string, any>): Record<string, any> =>
      Object.fromEntries(fields.map((field) => [field, row[field]]));

    try {
      await sql`INSERT INTO projects (id, name) VALUES (${projectId}, 'lifecycle projection integration')`;
      await sql`INSERT INTO canvases (id, project_id, title, target_json) VALUES (${canvasId}, ${projectId}, 'lifecycle', ${sql.json({})})`;
      const [job] = await sql`
        INSERT INTO jobs (project_id, canvas_id, type, status, agent_snapshot_json, started_at)
        VALUES (${projectId}, ${canvasId}, 'audit', 'running', ${sql.json({})}, '2026-08-05T01:00:00.000Z')
        RETURNING id`;
      await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES
          (${canvasId}, ${job.id}, 'root', 'root', 'running', ${sql.json({ summary: 'active' })}),
          (${canvasId}, ${job.id}, 'report', 'report', 'pending', ${sql.json({ summary: 'pending' })}),
          (${canvasId}, ${job.id}, 'job', 'review job', 'running', ${sql.json({
            type: 'review', role: 'review', ui_color: '#ABCDEF', summary: 'role job',
          })}),
          (${canvasId}, ${job.id}, 'intent', 'review intent', 'pending', ${sql.json({
            role: 'review', ui_color: 'not-a-color', summary: 'role intent',
          })})`;

      const listActive = (await read(`/projects/${projectId}/canvases?status=all`))[0] as Record<string, any>;
      const detailActive = (await read(`/canvases/${canvasId}`)).canvas as Record<string, any>;
      const summaryResponse = await read(`/canvases/${canvasId}/summary`);
      const summaryActive = summaryResponse.canvas as Record<string, any>;
      const deltaActive = await read(`/canvases/${canvasId}/delta?since=0`);
      for (const response of [listActive, detailActive, summaryActive, deltaActive]) {
        assert.deepEqual(lifecycle(response), {
          active_count: 1,
          job_count: 1,
          started_at: "2026-08-05T01:00:00.000Z",
          ended_at: null,
          root_status: "running",
          report_status: "pending",
        });
      }
      const summaryRoleJob = summaryResponse.nodes.find((node: Record<string, any>) => node.node_type === "job");
      const summaryRoleIntent = summaryResponse.nodes.find((node: Record<string, any>) => node.node_type === "intent");
      assert.equal(summaryRoleJob.body_json.ui_color, "#abcdef");
      assert.equal(Object.hasOwn(summaryRoleIntent.body_json, "ui_color"), false);
      const deltaRoleJob = deltaActive.upsert_nodes.find((node: Record<string, any>) => node.node_type === "job");
      const deltaRoleIntent = deltaActive.upsert_nodes.find((node: Record<string, any>) => node.node_type === "intent");
      assert.equal(deltaRoleJob.body_json.ui_color, "#abcdef");
      assert.equal(Object.hasOwn(deltaRoleIntent.body_json, "ui_color"), false);
      const activeRevision = deltaActive.upper_revision;

      const [roleJobNode] = await sql`
        SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'job'`;
      await sql`
        UPDATE canvas_nodes SET body_json = ${sql.json({
          type: 'review', role: 'review', ui_color: '#FEDCBA', summary: 'role job updated',
        })} WHERE id = ${roleJobNode.id}`;
      const colorDelta = await read(`/canvases/${canvasId}/delta?since=${activeRevision}`);
      const colorRoleJob = colorDelta.upsert_nodes.find((node: Record<string, any>) => node.node_type === "job");
      assert.equal(colorRoleJob.body_json.ui_color, "#fedcba");

      await sql`UPDATE jobs SET status = 'succeeded', finished_at = '2026-08-05T01:05:00.000Z' WHERE id = ${job.id}`;
      await sql`UPDATE canvas_nodes SET status = 'succeeded' WHERE canvas_id = ${canvasId} AND node_type IN ('root', 'report')`;
      const listTerminal = (await read(`/projects/${projectId}/canvases?status=all`))[0] as Record<string, any>;
      const detailTerminal = (await read(`/canvases/${canvasId}`)).canvas as Record<string, any>;
      const summaryTerminal = (await read(`/canvases/${canvasId}/summary`)).canvas as Record<string, any>;
      const deltaTerminal = await read(`/canvases/${canvasId}/delta?since=${activeRevision}`);
      for (const response of [listTerminal, detailTerminal, summaryTerminal, deltaTerminal]) {
        assert.deepEqual(lifecycle(response), {
          active_count: 0,
          job_count: 1,
          started_at: "2026-08-05T01:00:00.000Z",
          ended_at: "2026-08-05T01:05:00.000Z",
          root_status: "succeeded",
          report_status: "succeeded",
        });
      }
      const terminalRevision = deltaTerminal.upper_revision;

      await sql`
        INSERT INTO jobs (project_id, canvas_id, type, status, agent_snapshot_json)
        VALUES (${projectId}, ${canvasId}, 'review', 'pending', ${sql.json({})})`;
      await sql`UPDATE canvas_nodes SET status = 'running' WHERE canvas_id = ${canvasId} AND node_type = 'root'`;
      await sql`UPDATE canvas_nodes SET status = 'generating' WHERE canvas_id = ${canvasId} AND node_type = 'report'`;
      const deltaNull = await read(`/canvases/${canvasId}/delta?since=${terminalRevision}`);
      assert.deepEqual(lifecycle(deltaNull), {
        active_count: 1,
        job_count: 2,
        started_at: "2026-08-05T01:00:00.000Z",
        ended_at: null,
        root_status: "running",
        report_status: "generating",
      });
      await t.test("task lists separate only settled project knowledge history without writing Canvas state", async () => {
        const historyProjectId = randomUUID();
        const otherProjectId = randomUUID();
        const projects = [historyProjectId, otherProjectId];
        const digest = "a".repeat(64);
        const addCanvas = async (state: string, options: {
          unlinked?: boolean; archived?: boolean; jobStatus?: string; unsettled?: boolean;
          reviewPending?: boolean; otherProject?: boolean; ordinary?: boolean; targetMismatch?: boolean;
        } = {}) => {
          const id = randomUUID(), workId = randomUUID();
          await sql`INSERT INTO canvases (id,project_id,title,trigger_source,trigger_event_id,target_json,status,archived_at)
            VALUES (${id},${historyProjectId},'knowledge list fixture',${options.ordinary ? 'manual' : 'project_knowledge'},
              ${workId},${sql.json({ knowledge_work_id: options.targetMismatch ? randomUUID() : workId })},
              ${options.archived ? 'archived' : 'active'},${options.archived ? new Date() : null})`;
          await sql`INSERT INTO project_knowledge_work (id,project_id,trigger_key,state,canvas_id,governance_hash)
            VALUES (${workId},${options.otherProject ? otherProjectId : historyProjectId},${workId},${state},
              ${options.unlinked ? null : id},${digest})`;
          if (options.jobStatus) {
            const [job] = await sql`INSERT INTO jobs (project_id,canvas_id,type,status,agent_snapshot_json)
              VALUES (${historyProjectId},${id},'code',${options.jobStatus},'{}') RETURNING id`;
            if (options.unsettled) {
              const [attempt] = await sql`INSERT INTO job_attempts (job_id,attempt_no,status) VALUES (${job.id},1,'failed') RETURNING id`;
              await sql`INSERT INTO job_attempt_effects (job_id,attempt_id,effect_kind,effect_id,status)
                VALUES (${job.id},${attempt.id},'fixture','fixture','unknown')`;
            }
            if (options.reviewPending) {
              await sql`INSERT INTO project_knowledge_proposals (project_id,work_id,action,state,revision,maker_job_id,
                  idempotency_key,request_digest,input_digest,reason)
                VALUES (${historyProjectId},${workId},'create','review_pending',1,${job.id},${randomUUID()},${digest},${digest},'fixture')`;
            }
          }
          return id;
        };
        const list = `/projects/${historyProjectId}/canvases`;
        const ids = async (query = "") => (await read(list + query) as unknown as Array<{id: string}>)
          .map(row => row.id).sort();
        try {
          for (const id of projects) await sql`INSERT INTO projects (id,name) VALUES (${id},'knowledge history fixture')`;
          const history = [await addCanvas('blocked', { jobStatus: 'failed' }), await addCanvas('cancelled'),
            await addCanvas('completed'), await addCanvas('blocked', { unlinked: true })].sort();
          const visible = [await addCanvas('pending', { jobStatus: 'failed' }), await addCanvas('running'),
            await addCanvas('blocked', { jobStatus: 'waiting_human' }), await addCanvas('blocked', { jobStatus: 'failed', unsettled: true }),
            await addCanvas('blocked', { jobStatus: 'succeeded', reviewPending: true }),
            await addCanvas('blocked', { unlinked: true, jobStatus: 'failed' }),
            await addCanvas('blocked', { otherProject: true }), await addCanvas('blocked', { ordinary: true }),
            await addCanvas('blocked', { targetMismatch: true })].sort();
          const archived = await addCanvas('cancelled', { archived: true });
          assert.deepEqual(await ids(), visible);
          assert.deepEqual(await ids('?status=active'), visible);
          assert.deepEqual(await ids('?status=knowledge_history'), history);
          assert.deepEqual(await ids('?status=archived'), [archived]);
          assert.deepEqual(await ids('?status=all'), [...visible, ...history, archived].sort());
          const detail = (await read(`/canvases/${history[0]}`)).canvas;
          assert.equal(detail.status, 'active');
          assert.equal(detail.archived_at, null);
          assert.deepEqual(await ids('?status=knowledge_history'), history);
        } finally {
          await sql`DELETE FROM project_knowledge_proposals WHERE project_id=${historyProjectId}`;
          await sql`DELETE FROM project_knowledge_work WHERE project_id=ANY(${projects}::uuid[])`;
          await sql`DELETE FROM jobs WHERE project_id=${historyProjectId}`;
          await sql`DELETE FROM canvases WHERE project_id=${historyProjectId}`;
          await deleteProjectsLeavingAuditShells(sql, projects);
        }
      });
    } finally {
      await sql`DELETE FROM canvas_edges WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM jobs WHERE canvas_id = ${canvasId}`;
      await sql`DELETE FROM canvases WHERE id = ${canvasId}`;
      await deleteProjectsLeavingAuditShells(sql, [projectId]);
      await app.close();
      await sql.end({ timeout: 5 });
    }
  });
}
