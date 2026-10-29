import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PlanResult, SubmitPlanPayload } from "@deepsonar/shared-types";
import { deleteProjectsLeavingAuditShells } from "../../test-project-teardown.js";
import { loadPlanGapReport } from "../plan-protocol/gap-report.js";
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
        (error: unknown) => {
          assert.ok(error instanceof ControlInputError, `expected ControlInputError, got ${String(error)}`);
          assert.equal(error.code, "invalid_payload", `${error.code}: ${error.message}`);
          return true;
        },
      );

      const planEventId = randomUUID();
      const acceptedPlan = SubmitPlanPayload.parse({
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
      });
      const accepted = await ingestEvent(planJobId, {
        v: 1,
        event_id: planEventId,
        type: "plan",
        payload: acceptedPlan,
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
        payload: PlanResult.parse({
          v: 1,
          outcome: "continue",
          summary: "入口已定位，下一步需要动态验证",
          execution: [{ task_id: "explore-auth", status: "done" }],
        }),
      });
      const [afterResult] = await sql<{ payload_json: unknown; status: string }[]>`
        SELECT payload_json, status FROM jobs WHERE id = ${planJobId}`;
      const resultAudit = readPlanAudit(afterResult?.payload_json);
      assert.equal(afterResult?.status, "running");
      assert.equal(resultAudit?.result?.outcome, "continue");
      assert.equal(resultAudit?.termination_reason, "continue");
      assert.equal(resultAudit?.raw?.tasks.length, 2);

      const gapReport = await loadPlanGapReport(sql, canvasId, projectId);
      assert.equal(gapReport.entries.length, 1);
      assert.equal(gapReport.entries[0]?.audit?.completion_assessment, "unknown");
      assert.equal(gapReport.entries[0]?.job_id, planJobId);
      assert.deepEqual(gapReport, await loadPlanGapReport(sql, canvasId, projectId));
      assert.equal((await loadPlanGapReport(sql, canvasId, randomUUID())).entries.length, 0);
      assert.equal((await loadPlanGapReport(sql, hubCanvasId, projectId)).entries.length, 0);
      for (const execution of [
        [{ task_id: "not-in-plan", status: "done" }],
        [{ task_id: "explore-auth", status: "done" }, { task_id: "explore-auth", status: "blocked" }],
      ]) {
        await assert.rejects(ingestEvent(planJobId, {
          v: 1, event_id: randomUUID(), type: "plan_result",
          payload: { v: 1, outcome: "continue", summary: "Invalid execution references must be rejected", execution },
        }), (error: unknown) => error instanceof ControlInputError && error.code === "invalid_payload");
      }
      assert.deepEqual(gapReport, await loadPlanGapReport(sql, canvasId, projectId), "rejection does not alter audit");
      await ingestEvent(planJobId, { v: 1, event_id: randomUUID(), type: "plan", payload: { plan: audit!.raw } });
      const replaced = await loadPlanGapReport(sql, canvasId, projectId);
      assert.equal(replaced.entries[0]?.audit?.proposed_outcome, null);
      assert.notEqual(replaced.entries[0]?.audit?.source_sha256, gapReport.entries[0]?.audit?.source_sha256);

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
          payload: SubmitPlanPayload.parse({
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
          }),
        }),
        (error: unknown) => {
          assert.ok(error instanceof ControlInputError, `expected ControlInputError, got ${String(error)}`);
          assert.equal(error.code, "tool_not_allowed", `${error.code}: ${error.message}`);
          return true;
        },
      );
      const { buildReportInput, refreshTaskReport } = await import("../../report.js");
      await sql`UPDATE jobs SET status = 'succeeded' WHERE canvas_id = ${canvasId}`;
      await sql`UPDATE canvas_nodes SET status = 'analysis_complete' WHERE id = ${rootId}`;
      const beforeReportAudit = await buildReportInput(canvasId, sql);
      const frozenHash = createHash("sha256").update(JSON.stringify(beforeReportAudit, null, 2)).digest("hex");
      await sql`INSERT INTO task_reports (canvas_id, project_id, version, status, input_uri, input_sha256)
        VALUES (${canvasId}, ${projectId}, 1, 'succeeded', 'fixture/report-input.json', ${frozenHash})`;
      const reportJobId = randomUUID();
      await sql`INSERT INTO jobs (id, project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        VALUES (${reportJobId}, ${projectId}, ${canvasId}, 'report', 'running',
          ${sql.json({ name: "report", role_kind: "system", platform_tools: ["submit_plan"] })}, '{}'::jsonb)`;
      // The current static system-role allowlist rejects this even when the snapshot asks for it.
      await assert.rejects(
        ingestEvent(reportJobId, { v: 1, event_id: randomUUID(), type: "plan", payload: { plan: audit!.raw } }),
        (error: unknown) => error instanceof ControlInputError && error.code === "tool_not_allowed",
      );
      const [reportAudit] = await sql`SELECT payload_json FROM jobs WHERE id = ${reportJobId}`;
      assert.equal(readPlanAudit(reportAudit!.payload_json), null);
      await sql`UPDATE jobs SET status = 'succeeded' WHERE id = ${reportJobId}`;
      // Synthetic durable historical rows exercise projection isolation; not reachable via current ingestion.
      await sql`INSERT INTO jobs (project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        SELECT ${projectId}, ${canvasId}, 'report', 'succeeded', '{}'::jsonb,
          ${sql.json({ plan_protocol: audit } as never)} FROM generate_series(1, 33)`;
      assert.deepEqual(await buildReportInput(canvasId, sql), beforeReportAudit);
      assert.deepEqual(await refreshTaskReport(canvasId), { ok: false, reason: "plan_criteria_unproven" });
      assert.deepEqual(await refreshTaskReport(canvasId), { ok: false, reason: "plan_criteria_unproven" });
      assert.deepEqual(await buildReportInput(canvasId, sql), beforeReportAudit, "blocked refresh must neither append Report audits nor bounce a new Hub");
      const [versions] = await sql`SELECT count(*)::int AS count FROM task_reports WHERE canvas_id = ${canvasId}`;
      assert.equal(versions!.count, 1);

      await sql`
        INSERT INTO jobs (project_id, canvas_id, type, status, agent_snapshot_json, payload_json)
        SELECT ${projectId}, ${canvasId}, 'hub_reason', 'succeeded', '{}'::jsonb,
          ${sql.json({ plan_protocol: audit } as never)}
        FROM generate_series(1, 33)`;
      const capped = await loadPlanGapReport(sql, canvasId, projectId);
      assert.equal(capped.entries.length, 32);
      assert.equal(capped.truncated, true);
      const largeAudit = { ...audit!, raw: { ...audit!.raw!, tasks: Array.from({ length: 100 }, (_, index) => ({
        ...audit!.raw!.tasks[0]!, id: `task-${index}`,
        expected_outputs: Array.from({ length: 32 }, () => "x".repeat(500)),
      })) } };
      await sql`UPDATE jobs SET payload_json = ${sql.json({ plan_protocol: largeAudit } as never)}
        WHERE canvas_id = ${canvasId}`;
      const byteCapped = await loadPlanGapReport(sql, canvasId, projectId);
      assert.equal(byteCapped.entries.length, 0);
      assert.equal(byteCapped.truncated, true);
    } finally {
      const canvasIds = [canvasId, hubCanvasId];
      await sql`DELETE FROM task_reports WHERE canvas_id = ANY(${canvasIds})`;
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
