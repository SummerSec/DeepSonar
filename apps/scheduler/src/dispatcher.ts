import { randomUUID } from "node:crypto";
import { NoopRunner, type SandboxRunner } from "@dfh/runtime-sandbox";
import { config } from "./config.js";
import { ingestEvent, transitionJob } from "./core.js";
import { sql } from "./db.js";
import { planeWriteback } from "./plane-sync.js";

/**
 * Dispatcher（§4.2 调度循环的 DB 侧）：
 * 从 pending 领取 job（遵守全局/每项目并发上限）→ claimed → provisioning → running
 * Phase 0 执行器为 noop：走通状态机 + 事件 + 画布 + lease，不碰真实沙箱。
 */

const runner: SandboxRunner = new NoopRunner();
const activeLeases = new Map<string, ReturnType<typeof setInterval>>();

export async function dispatchOnce(): Promise<number> {
  const [{ running }] = await sql<[{ running: number }]>`
    SELECT COUNT(*)::int AS running FROM jobs WHERE status IN ('claimed','provisioning','running')`;
  let slots = config.limits.maxGlobalJobs - running;
  if (slots <= 0) return 0;

  const pending = await sql`
    SELECT id, project_id, type FROM jobs
    WHERE status = 'pending'
    ORDER BY priority DESC, created_at
    LIMIT ${slots * 2}`;

  let claimed = 0;
  for (const job of pending) {
    if (claimed >= slots) break;
    const [{ cnt }] = await sql<[{ cnt: number }]>`
      SELECT COUNT(*)::int AS cnt FROM jobs
      WHERE project_id = ${job.project_id} AND status IN ('claimed','provisioning','running')`;
    if (cnt >= config.limits.maxJobsPerProject) continue;

    // 原子 claim：并发下只有一个实例能改成功
    const row = await transitionJob(job.id, "claimed");
    if (!row) continue;
    claimed++;
    void runJob(job.id).catch((e) => console.error(`[dispatcher] job ${job.id} 异常:`, e));
  }
  return claimed;
}

async function runJob(jobId: string) {
  const [job] = await sql`SELECT * FROM jobs WHERE id = ${jobId}`;
  if (!job) return;

  // provisioning：起沙箱（Phase 0 = noop）
  await transitionJob(jobId, "provisioning");
  const handle = await runner.provision({
    jobId,
    image: config.runtime.imageAudit,
    network: "none",
  });
  await sql`UPDATE jobs SET sandbox_id = ${handle.sandboxId} WHERE id = ${jobId}`;

  // running：开 lease
  const lease = new Date(Date.now() + config.timeouts.leaseTtlSec * 1000);
  await transitionJob(jobId, "running", {
    started_at: new Date(),
    lease_expires_at: lease,
  });
  startLeaseRenewal(jobId, handle);

  // 画布：job 节点（如不存在）——claim 时由 routes/planeSync 建 root 之外的 job 节点
  await ensureJobNode(jobId, job);

  try {
    await execute(jobId, job.type);
    // execute 内部通过 done 事件 finalize；若 type 无 done（noop 直发），这里兜底
    const [cur] = await sql`SELECT status FROM jobs WHERE id = ${jobId}`;
    if (cur?.status === "running") {
      await ingestEvent(jobId, {
        v: 1,
        event_id: randomUUID(),
        type: "done",
        payload: { summary: "executor 正常退出" },
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sql`UPDATE jobs SET status = 'failed', finished_at = now(), error = ${msg} WHERE id = ${jobId} AND status IN ('claimed','provisioning','running')`;
  } finally {
    stopLeaseRenewal(jobId);
    await runner.destroy(handle).catch(() => {});
    await planeWriteback(jobId).catch((e) => console.error("[plane] 回写异常:", e));
  }
}

/** Phase 0/1 执行器：noop 直发事件；audit/verify 由假 agent 脚本驱动（§10 Phase 1 验收用） */
async function execute(jobId: string, type: string) {
  const emit = (t: "progress" | "finding" | "done" | "human", payload: unknown) =>
    ingestEvent(jobId, { v: 1, event_id: randomUUID(), type: t, payload });

  if (type === "noop") {
    await emit("progress", { message: "noop executor ok", percent: 100 });
    return;
  }

  if (type === "audit_module") {
    const [job] = await sql`SELECT payload_json FROM jobs WHERE id = ${jobId}`;
    const fake = (job?.payload_json?.fake_finding ?? null) as {
      title?: string;
      severity?: string;
      location?: string;
      summary?: string;
    } | null;
    await emit("progress", { message: "假 agent：开始审计", percent: 10 });
    // 模拟真实 agent 产出的结构化 finding（severity 默认 high → 触发规则引擎派生验证）
    await emit("finding", {
      title: fake?.title ?? "SQL 注入：未参数化的查询拼接",
      severity: fake?.severity ?? "high",
      location: fake?.location ?? "auth/login.php:42",
      summary: fake?.summary ?? "用户输入直接拼入 SQL 语句，可注入。",
      rule_id: "fake-sqli-001",
      suggest_verify: true,
      raw: { source: "fake-agent", v: 1 },
    });
    await emit("progress", { message: "假 agent：审计完成", percent: 100 });
    return; // done 由 runJob 兜底
  }

  if (type === "verify_finding") {
    await emit("progress", { message: "假 agent：验证中（静态复核）", percent: 50 });
    await ingestEvent(jobId, {
      v: 1,
      event_id: randomUUID(),
      type: "done",
      payload: { summary: "假 agent：复核确认可利用", verdict: "confirmed" },
    });
    return;
  }
  // 未知类型：保活等待外部通道（Phase 2 真实 agent）
}

// lease 续期：调度器侧维护（§3.3；接入 SDK 后改为控制通道探测驱动）
function startLeaseRenewal(jobId: string, handle: { sandboxId: string }) {
  const timer = setInterval(async () => {
    const alive = await runner.isAlive(handle).catch(() => false);
    if (!alive) return; // 停续，交给 Reaper 判 orphan
    await sql`
      UPDATE jobs SET lease_expires_at = now() + (${config.timeouts.leaseTtlSec} * interval '1 second'),
                      heartbeat_at = now()
      WHERE id = ${jobId} AND status = 'running'`;
  }, Math.max(5, config.timeouts.leaseTtlSec / 3) * 1000);
  activeLeases.set(jobId, timer);
}

function stopLeaseRenewal(jobId: string) {
  const t = activeLeases.get(jobId);
  if (t) clearInterval(t);
  activeLeases.delete(jobId);
}

async function ensureJobNode(jobId: string, job: Record<string, unknown>) {
  const existing = await sql`SELECT 1 FROM canvas_nodes WHERE job_id = ${jobId} AND node_type = 'job'`;
  if (existing.length > 0) return;
  const [project] = await sql`SELECT canvas_id FROM projects WHERE id = ${job.project_id as string}`;
  if (!project) return;
  const [{ next_x }] = await sql<[{ next_x: number }]>`
    SELECT COALESCE(MAX(x + w), 60) + 40 AS next_x FROM canvas_nodes WHERE canvas_id = ${project.canvas_id}`;
  await sql`
    INSERT INTO canvas_nodes ${sql({
      canvas_id: project.canvas_id,
      job_id: jobId,
      node_type: "job",
      title: `${job.type} #${(jobId as string).slice(0, 8)}`,
      body_json: { type: job.type, payload: job.payload_json } as never,
      x: next_x,
      y: 300,
      status: "running",
    })}`;
}

export function startDispatcher() {
  const timer = setInterval(() => {
    void dispatchOnce().catch((e) => console.error("[dispatcher]", e));
  }, config.timeouts.pollIntervalSec * 1000);
  void dispatchOnce().catch(() => {});
  return () => clearInterval(timer);
}
