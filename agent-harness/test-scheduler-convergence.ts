/**
 * Scheduler 收敛并发回归：
 * 1. review/test 同时 finalize 时恰好创建一轮 Verify；
 * 2. Hub 已 complete 后以 failed/timeout/orphan 终态退出，仍会自动派 Report。
 *
 * 直接使用独立 DB 事务，避免依赖 Dispatcher 调度时序。CI 在启动 Scheduler 前执行。
 */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../apps/scheduler/src/config.js";
import { advanceCanvasAfterTerminalJob, finalizeJob } from "../apps/scheduler/src/core.js";
import { migrate, sql } from "../apps/scheduler/src/db.js";
import { maybeReverifyAfterFollowup } from "../apps/scheduler/src/verify.js";

type DbRow = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const tag = randomUUID().slice(0, 8);
const projectCanvasId = randomUUID();
const canvasIds: string[] = [];
let projectId = "";

async function createCanvas(rootStatus: string): Promise<string> {
  const canvasId = randomUUID();
  canvasIds.push(canvasId);
  await sql`
    INSERT INTO canvases (id, project_id, title, target_json)
    VALUES (
      ${canvasId},
      ${projectId},
      ${`scheduler-convergence-${tag}`},
      ${sql.json({ goal: "test convergence", network_policy: { allow_egress: false } })}
    )`;
  await sql`
    INSERT INTO canvas_nodes (canvas_id, node_type, title, status)
    VALUES (${canvasId}, 'root', ${`root-${tag}`}, ${rootStatus})`;
  return canvasId;
}

async function insertJob(
  canvasId: string,
  type: string,
  status: string,
  payload: Record<string, unknown> = {},
): Promise<DbRow> {
  const [job] = await sql`
    INSERT INTO jobs (project_id, canvas_id, type, status, payload_json, agent_snapshot_json)
    VALUES (
      ${projectId}, ${canvasId}, ${type}, ${status},
      ${sql.json(payload)}, ${sql.json({ test_fixture: true })}
    )
    RETURNING *`;
  return job as DbRow;
}

async function testConcurrentReverify(): Promise<void> {
  const canvasId = await createCanvas("active");
  const origin = await insertJob(canvasId, "audit", "succeeded");
  const [findingNode] = await sql`
    INSERT INTO canvas_nodes (canvas_id, job_id, node_type, title, status)
    VALUES (${canvasId}, ${origin.id as string}, 'finding', 'concurrent finding', 'open')
    RETURNING id`;
  const [finding] = await sql`
    INSERT INTO findings (
      project_id, job_id, node_id, fingerprint, title, severity, summary, verify_status, suggest_verify
    ) VALUES (
      ${projectId}, ${origin.id as string}, ${findingNode.id as string},
      ${`concurrent-${tag}`}, '并发补证 Finding', 'high', '并发收口测试', 'pending', true
    ) RETURNING id`;

  const followup = {
    verification_followup: {
      finding_id: finding.id as string,
      required_evidence: ["review", "test"],
    },
  };
  const review = await insertJob(canvasId, "review", "running", followup);
  const test = await insertJob(canvasId, "test", "running", followup);

  let arrivals = 0;
  let release!: () => void;
  const bothUpdated = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrive = () => {
    arrivals += 1;
    if (arrivals === 2) release();
  };

  const finish = (jobId: string) =>
    sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as typeof sql;
      await tx`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = ${jobId}`;
      const [job] = await tx`SELECT * FROM jobs WHERE id = ${jobId}`;
      arrive();
      await Promise.race([
        bothUpdated,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("concurrent finalize barrier timeout")), 5_000),
        ),
      ]);
      await maybeReverifyAfterFollowup(tx, job as DbRow);
    });

  await Promise.all([finish(review.id as string), finish(test.id as string)]);

  const verifyJobs = await sql`
    SELECT id, status FROM jobs
    WHERE finding_id = ${finding.id as string} AND type = 'verify_finding'`;
  const rounds = await sql`
    SELECT id, attempt FROM finding_verification_rounds WHERE finding_id = ${finding.id as string}`;
  assert(verifyJobs.length === 1, `并发补证后 Verify 数量应为 1，实际 ${verifyJobs.length}`);
  assert(rounds.length === 1, `并发补证后 round 数量应为 1，实际 ${rounds.length}`);
}

async function testTerminalReportRecovery(status: "failed" | "timeout" | "orphan"): Promise<void> {
  const canvasId = await createCanvas("analysis_complete");
  await insertJob(canvasId, "audit", "succeeded");
  const hub = await insertJob(canvasId, "hub_reason", status === "failed" ? "running" : status);

  if (status === "failed") {
    await sql.begin(async (txRaw) => {
      const ok = await finalizeJob(txRaw as unknown as typeof sql, hub.id as string, "failed", {
        error: "fixture failure after complete",
      });
      assert(ok, "failed Hub 应由 finalizeJob 成功收口");
    });
  } else {
    await sql.begin(async (txRaw) => {
      await advanceCanvasAfterTerminalJob(
        txRaw as unknown as typeof sql,
        hub,
        status,
      );
    });
  }

  const reports = await sql`
    SELECT tr.status, tr.report_job_id, j.type AS job_type
    FROM task_reports tr
    JOIN jobs j ON j.id = tr.report_job_id
    WHERE tr.canvas_id = ${canvasId}`;
  const [root] = await sql`
    SELECT status FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root'`;
  assert(reports.length === 1, `${status} Hub 终态后应恰好派发一个 Report`);
  assert(reports[0]?.job_type === "report", `${status} Hub 终态后报告 Job 类型错误`);
  assert(root?.status === "reporting", `${status} Hub 终态后 Root 应进入 reporting，实际 ${String(root?.status)}`);
}

async function cleanup(): Promise<void> {
  if (projectId) {
    await sql`DELETE FROM task_reports WHERE project_id = ${projectId}`;
    await sql`DELETE FROM canvas_edges WHERE canvas_id IN (SELECT id FROM canvases WHERE project_id = ${projectId})`;
    await sql`DELETE FROM canvas_nodes WHERE canvas_id IN (SELECT id FROM canvases WHERE project_id = ${projectId})`;
    await sql`DELETE FROM finding_verification_rounds WHERE finding_id IN (SELECT id FROM findings WHERE project_id = ${projectId})`;
    await sql`DELETE FROM findings WHERE project_id = ${projectId}`;
    await sql`DELETE FROM jobs WHERE project_id = ${projectId}`;
    await sql`DELETE FROM canvases WHERE project_id = ${projectId}`;
    await sql`DELETE FROM projects WHERE id = ${projectId}`;
  }
  await Promise.all(
    canvasIds.map((canvasId) =>
      rm(path.join(config.storage.blobDir, "reports", canvasId), { recursive: true, force: true }),
    ),
  );
}

try {
  await migrate();
  const [project] = await sql`
    INSERT INTO projects (canvas_id, name, config_json)
    VALUES (${projectCanvasId}, ${`scheduler-convergence-${tag}`}, ${sql.json({})})
    RETURNING id`;
  projectId = project.id as string;

  await testConcurrentReverify();
  await testTerminalReportRecovery("failed");
  await testTerminalReportRecovery("timeout");
  await testTerminalReportRecovery("orphan");
  console.log(JSON.stringify({ concurrent_reverify: "ok", terminal_report_recovery: ["failed", "timeout", "orphan"] }));
} finally {
  await cleanup();
  await sql.end();
}
