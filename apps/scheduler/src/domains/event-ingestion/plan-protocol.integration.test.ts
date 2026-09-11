import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { deleteProjectsLeavingAuditShells } from "../../test-project-teardown.js";
import { readPlanAudit } from "../plan-protocol/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

const PROMPT = "定位任务目标的权威材料，记录版本、来源和仍缺失的信息；只提交新增事实。";

if (!testDatabaseUrl) {
  test("plan protocol integration (set TEST_DATABASE_URL to run)", {
    skip: "TEST_DATABASE_URL is not set; refusing to use the scheduler default database",
  }, () => {});
} else {
  test("submit_plan / submit_plan_result persist audit and Hub complete adapts without extra events", async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.AGENT_MODE = "fake";

    const { migrate, sql } = await import("../../db.js");
    const { ingestEvent } = await import("../../core.js");
    const { ControlInputError } = await import("../../control-input.js");
    await migrate();

    const projectId = randomUUID();
    const canvasId = `plan-protocol-${randomUUID()}`;
    const hubCanvasId = `plan-protocol-hub-${randomUUID()}`;
    const planJobId = randomUUID();
    const hubJobId = randomUUID();
    const workerJobId = randomUUID();
    const succeededRoleJobId = randomUUID();
    const rootId = randomUUID();
    const hubRootId = randomUUID();

    await sql`
      INSERT INTO projects (id, name, config_json)
      VALUES (${projectId}, 'plan-protocol', ${sql.json({
        rules: { hubEnabled: true, maxIntentsPerDecision: 1 },
      })})`;
    await sql`
      INSERT INTO canvases (id, project_id, title, target_json)
      VALUES (${canvasId}, ${projectId}, 'plan-protocol', ${sql.json({})})`;
    await sql`
      INSERT INTO canvases (id, project_id, title, target_json)
      VALUES (${hubCanvasId}, ${projectId}, 'plan-protocol-hub', ${sql.json({})})`;
    await sql`
      INSERT INTO canvas_nodes (id, canvas_id, node_type, title, status, body_json)
      VALUES (${rootId}, ${canvasId}, 'root', 'root', 'active', ${sql.json({})})`;
    await sql`
      INSERT INTO canvas_nodes (id, canvas_id, node_type, title, status, body_json)
      VALUES (${hubRootId}, ${hubCanvasId}, 'root', 'root', 'active', ${sql.json({})})`;
    await sql`
      INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
      VALUES (
        ${planJobId}, ${projectId}, ${canvasId}, 'hub_reason', 'running',
        ${sql.json({
          name: "hub_reason",
          role_kind: "hub",
          platform_tools: ["submit_plan", "submit_plan_result", "submit_hub_decision", "mark_job_done"],
        })},
        ${sql.json({})}
      )`;
    await sql`
      INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
      VALUES (
        ${workerJobId}, ${projectId}, ${canvasId}, 'explore', 'running',
        ${sql.json({ name: "explore", role_kind: "role", platform_tools: ["emit_fact", "mark_job_done"] })},
        ${sql.json({})}
      )`;
    await sql`
      INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
      VALUES (
        ${succeededRoleJobId}, ${projectId}, ${hubCanvasId}, 'explore', 'succeeded',
        ${sql.json({ name: "explore", role_kind: "role", platform_tools: ["emit_fact", "mark_job_done"] })},
        ${sql.json({})}
      )`;
    await sql`
      INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
      VALUES (
        ${hubJobId}, ${projectId}, ${hubCanvasId}, 'hub_reason', 'running',
        ${sql.json({
          name: "hub_reason",
          role_kind: "hub",
          platform_tools: ["list_available_roles", "submit_hub_decision", "mark_job_done"],
        })},
        ${sql.json({})}
      )`;
    for (const [jobId, jobCanvasId, status] of [
      [planJobId, canvasId, "running"],
      [workerJobId, canvasId, "running"],
      [succeededRoleJobId, hubCanvasId, "succeeded"],
      [hubJobId, hubCanvasId, "running"],
    ] as const) {
      await sql`
        INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status, body_json)
        VALUES (${jobCanvasId}, ${jobId}, 'job', ${jobId.slice(0, 8)}, ${status}, ${sql.json({})})`;
    }

    try {
      await assert.rejects(
        ingestEvent(planJobId, {
          v: 1,
          event_id: randomUUID(),
          type: "plan_result",
          payload: { v: 1, outcome: "continue", summary: "还没有可用的计划原文" },
        }),
        (error: unknown) => error instanceof ControlInputError && error.code === "invalid_payload",
      );

      const planEventId = randomUUID();
      const accepted = await ingestEvent(planJobId, {
        v: 1,
        event_id: planEventId,
        type: "plan",
        payload: {
          plan: {
            v: 1,
            goal: "确认认证入口与会话校验",
            tasks: [
              {
                id: "explore-auth",
                title: "梳理登录与会话入口",
                role: "explore",
                description: "定位登录与会话校验链路",
                prompt: PROMPT,
              },
              {
                id: "analyze-auth",
                title: "分析会话绑定边界",
                role: "analyze",
                description: "分析会话绑定与失效范围",
                prompt: PROMPT,
                depends_on: ["explore-auth"],
              },
            ],
            completion: { mode: "explicit_result", description: "由后续结果声明是否继续" },
          },
        },
      });
      assert.equal(accepted.deduped, false);

      const [planJob] = await sql<{ payload_json: unknown; status: string }[]>`
        SELECT payload_json, status FROM jobs WHERE id = ${planJobId}`;
      const audit = readPlanAudit(planJob?.payload_json);
      assert.equal(planJob?.status, "running");
      assert.equal(audit?.source, "submit_plan");
      assert.equal(audit?.raw?.tasks.length, 2);
      assert.equal(audit?.trimmed?.tasks.length, 1);
      assert.equal(audit?.trimmed?.tasks[0]?.id, "explore-auth");
      assert.ok(audit?.trim_reasons.some((reason) => reason.startsWith("dropped_tasks")));
      assert.equal(audit?.result, null);

      const [workerCount] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM jobs WHERE parent_job_id = ${planJobId}`;
      assert.equal(workerCount?.count, 0, "Phase 1 submit_plan must not dispatch workers");

      const replay = await ingestEvent(planJobId, {
        v: 1,
        event_id: planEventId,
        type: "plan",
        payload: { plan: audit?.raw },
      });
      assert.equal(replay.deduped, true);

      await ingestEvent(planJobId, {
        v: 1,
        event_id: randomUUID(),
        type: "plan_result",
        payload: {
          v: 1,
          outcome: "continue",
          summary: "入口已定位，下一步需要动态验证",
          execution: [{ task_id: "explore-auth", status: "done" }],
        },
      });
      const [afterResult] = await sql<{ payload_json: unknown; status: string }[]>`
        SELECT payload_json, status FROM jobs WHERE id = ${planJobId}`;
      const resultAudit = readPlanAudit(afterResult?.payload_json);
      assert.equal(afterResult?.status, "running");
      assert.equal(resultAudit?.result?.outcome, "continue");
      assert.equal(resultAudit?.termination_reason, "continue");
      assert.equal(resultAudit?.raw?.tasks.length, 2);

      await ingestEvent(hubJobId, {
        v: 1,
        event_id: randomUUID(),
        type: "hub_decision",
        payload: {
          complete: {
            from: [hubRootId],
            description: "目标已被当前引用证据完整覆盖",
          },
        },
      });
      const [hubJob] = await sql<{ payload_json: unknown }[]>`
        SELECT payload_json FROM jobs WHERE id = ${hubJobId}`;
      const hubAudit = readPlanAudit(hubJob?.payload_json);
      assert.equal(hubAudit?.source, "hub_intent_adapter");
      assert.equal(hubAudit?.result?.outcome, "complete");
      assert.equal(hubAudit?.termination_reason, "hub_complete");
      const [hubEvents] = await sql<{ types: string[] }[]>`
        SELECT COALESCE(array_agg(type ORDER BY job_seq), '{}') AS types
        FROM events WHERE job_id = ${hubJobId}`;
      assert.deepEqual(hubEvents?.types, ["hub_decision"], "Hub path must not insert extra plan events");
      const [dispatched] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM jobs WHERE parent_job_id = ${hubJobId}`;
      assert.equal(dispatched?.count, 0, "Hub complete must not dispatch workers");

      await assert.rejects(
        ingestEvent(workerJobId, {
          v: 1,
          event_id: randomUUID(),
          type: "plan",
          payload: {
            plan: {
              v: 1,
              goal: "worker should not submit plans",
              tasks: [{
                id: "worker-task",
                title: "未授权的计划任务项",
                role: "explore",
                description: "工人角色未启用该计划工具",
                prompt: PROMPT,
              }],
              completion: { mode: "explicit_result", description: "该提交不应被接受" },
            },
          },
        }),
        (error: unknown) => error instanceof ControlInputError && error.code === "tool_not_allowed",
      );
    } finally {
      const canvasIds = [canvasId, hubCanvasId];
      await sql`DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ${projectId})`;
      await sql`DELETE FROM canvas_edges WHERE canvas_id = ANY(${canvasIds})`;
      await sql`DELETE FROM canvas_nodes WHERE canvas_id = ANY(${canvasIds})`;
      await sql`UPDATE jobs SET parent_job_id = NULL WHERE project_id = ${projectId}`;
      await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
      await sql`DELETE FROM canvases WHERE id = ANY(${canvasIds})`;
      await deleteProjectsLeavingAuditShells(sql, [projectId]);
      await sql.end({ timeout: 5 });
    }
  });
}
