import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { ingestEvent, transitionJob } from "./core.js";
import { sql } from "./db.js";
import { executeReal } from "./executor-real.js";
import { planeWriteback } from "./plane-sync.js";
import { runner } from "./runtime.js";

/**
 * Dispatcher（§4.2 调度循环的 DB 侧）：
 * 从 pending 领取 job（遵守全局/每项目并发上限）→ claimed → provisioning → running
 * Phase 0 执行器为 noop：走通状态机 + 事件 + 画布 + lease，不碰真实沙箱。
 */

const activeLeases = new Map<string, ReturnType<typeof setInterval>>();

/** 内置 real 类型；其余 job.type 若在角色注册表（agent_roles）中也为 real（Phase ② 自定义角色） */
const REAL_BASE_TYPES = new Set(["audit_module", "verify_finding", "hub_reason"]);

async function isRealType(type: string): Promise<boolean> {
  if (REAL_BASE_TYPES.has(type)) return true;
  const [r] = await sql`SELECT 1 FROM agent_roles WHERE name = ${type}`;
  return Boolean(r);
}

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

    // 原子 claim：并发下只有一个实例能改成功；claimed_at 供 provision 超时判定
    const row = await transitionJob(job.id, "claimed", { claimed_at: new Date() });
    if (!row) continue;
    claimed++;
    void runJob(job.id).catch((e) => console.error(`[dispatcher] job ${job.id} 异常:`, e));
  }
  return claimed;
}

async function runJob(jobId: string) {
  let handle: { sandboxId: string } | null = null;
  try {
    const [job] = await sql`SELECT * FROM jobs WHERE id = ${jobId}`;
    if (!job) return;

    // provisioning：起沙箱（real 模式注入 agent 凭据 + 放行 LLM 端点出网）
    // provision 纳入同一异常保护 + 独立超时（§8.3：provision 异常不得让 job 永久卡住）
    const useReal = config.runtime.agentMode === "real" && (await isRealType(job.type as string));
    if (!(await transitionJob(jobId, "provisioning"))) return; // 竞态：已被 cancel/reap
    handle = await withTimeout(
      runner.provision({
        jobId,
        image: config.runtime.imageAudit,
        env: useReal ? config.runtime.agentEnv : undefined,
        network: useReal ? "restricted" : "none",
        limits: config.runtime.sandboxLimits,
      }),
      config.timeouts.provisionSec * 1000,
      `provision 超时（${config.timeouts.provisionSec}s）`,
    );
    await sql`UPDATE jobs SET sandbox_id = ${handle.sandboxId} WHERE id = ${jobId}`;

    // running：开 lease（竞态守卫：此时被 cancel 则放弃执行，直接走 finally 回收）
    const lease = new Date(Date.now() + config.timeouts.leaseTtlSec * 1000);
    if (!(await transitionJob(jobId, "running", { started_at: new Date(), lease_expires_at: lease }))) {
      return;
    }
    startLeaseRenewal(jobId, handle);

    // 画布：job 节点（如不存在）——claim 时由 routes/planeSync 建 root 之外的 job 节点
    await ensureJobNode(jobId, job);

    await execute(jobId, job.type);
    // execute 内部通过 done 事件 finalize；若 type 无 done（noop 直发），这里兜底
    // finalizeJob 有 running 守卫：执行期间被 cancel 时这个兜底 done 会被安全忽略
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
    // 守卫：只覆盖活动状态；cancelled/timeout/orphan 终态不被失败覆盖（§8.2）
    await sql`UPDATE jobs SET status = 'failed', finished_at = now(), error = ${msg} WHERE id = ${jobId} AND status IN ('claimed','provisioning','running')`;
    await sql`UPDATE canvas_nodes SET status = 'failed', updated_at = now() WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent"]}) AND status = 'running'`;
  } finally {
    stopLeaseRenewal(jobId);
    if (handle) {
      const h = handle;
      await runner.destroy(h).catch((e) => console.error(`[dispatcher] 沙箱回收失败 ${h.sandboxId}:`, e));
    }
    await planeWriteback(jobId).catch((e) => console.error("[plane] 回写异常:", e));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

/** 执行器路由：real 模式走 agentbox-sdk 真实 agent；否则内置假 agent（联调/演示用） */
async function execute(jobId: string, type: string) {
  if (config.runtime.agentMode === "real" && (await isRealType(type))) {
    await executeReal(jobId, type);
    return;
  }
  await executeFake(jobId, type);
}

/** Phase 0/1 执行器：noop 直发事件；audit/verify/hub/explore 由假 agent 脚本驱动（联调/演示用） */
async function executeFake(jobId: string, type: string) {
  const emit = (t: string, payload: unknown) =>
    ingestEvent(jobId, { v: 1, event_id: randomUUID(), type: t as never, payload });

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

  if (type === "hub_reason") {
    // 假 hub：confirmed 风险优先派发环境/PoC 验收；普通轮次按事实是否充足决定收敛。
    const [job] = await sql`SELECT canvas_id, payload_json FROM jobs WHERE id = ${jobId}`;
    const canvasId = job?.canvas_id as string | null;
    const trigger = (job?.payload_json?.trigger ?? {}) as { kind?: string; finding_id?: string };
    await emit("progress", { message: "假 hub：读图决策中", percent: 50 });
    if (canvasId) {
      if (trigger.kind === "confirmed_finding") {
        const refs = trigger.finding_id
          ? await sql`SELECT node_id AS id FROM findings WHERE id = ${trigger.finding_id} AND node_id IS NOT NULL`
          : [];
        await emit("hub_decision", {
          intents: [
            {
              from: refs.map((r) => r.id as string),
              role: "test",
              description: "搭建最小运行环境并编写 PoC，动态复现已确认风险，记录利用条件与影响",
            },
          ],
        });
        return;
      }
      const facts = await sql`
        SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'fact' ORDER BY created_at`;
      if (facts.length > 0) {
        await emit("hub_decision", {
          complete: {
            from: facts.map((f) => f.id as string),
            description: "假 hub：事实已足够，目标达成（演示结论）",
          },
        });
      } else {
        const refs = await sql`
          SELECT id FROM canvas_nodes
          WHERE canvas_id = ${canvasId} AND node_type = ANY(${["finding", "fact", "root"]})
          ORDER BY created_at LIMIT 2`;
        await emit("hub_decision", {
          intents: [
            {
              from: refs.map((r) => r.id as string),
              role: "explore",
              description: "假 hub：探索代码，收集与审计目标相关的事实",
            },
          ],
        });
      }
    }
    return; // done 由 runJob 兜底
  }

  // 角色 job（explore/analyze/verify/test/code/自定义）：假 agent 产出一条演示事实
  const [roleJob] = await sql`SELECT payload_json FROM jobs WHERE id = ${jobId}`;
  const rolePayload = (roleJob?.payload_json ?? {}) as Record<string, unknown>;
  await emit("progress", { message: `假 agent（${type}）：执行中`, percent: 50 });
  await emit("fact", {
    intent_node_id: (rolePayload.intent_node_id as string) ?? null,
    title: `假 agent ${type} 事实`,
    description: `假 agent（${type}）：auth/login.php:42 存在未参数化拼接，用户输入经 $_GET 直达 mysqli_query，属高危数据流（演示事实）。`,
  });
  return; // done 由 runJob 兜底
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
  // intent 节点由 hub_decision 随角色 job 同事务创建（1:1）；已有节点则只同步运行态
  const existing = await sql`SELECT id, node_type FROM canvas_nodes WHERE job_id = ${jobId}`;
  if (existing.length > 0) {
    // resume 重跑的 job：节点已在（上一轮终态），同步回 running
    await sql`
      UPDATE canvas_nodes SET status = 'running', updated_at = now()
      WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent"]}) AND status = 'pending'`;
    return;
  }
  // 一任务一画布：优先 job 自带的任务画布；历史 job（canvas_id 为空）兜底到项目旧画布
  let canvasId = job.canvas_id as string | null;
  if (!canvasId) {
    const [project] = await sql`SELECT canvas_id FROM projects WHERE id = ${job.project_id as string}`;
    canvasId = (project?.canvas_id as string) ?? null;
  }
  if (!canvasId) return;
  const [{ next_x }] = await sql<[{ next_x: number }]>`
    SELECT COALESCE(MAX(x + w), 60) + 40 AS next_x FROM canvas_nodes WHERE canvas_id = ${canvasId}`;
  const [node] = await sql`
    INSERT INTO canvas_nodes ${sql({
      canvas_id: canvasId,
      job_id: jobId,
      node_type: "job",
      title: `${job.type} #${(jobId as string).slice(0, 8)}`,
      body_json: { type: job.type, payload: job.payload_json } as never,
      x: next_x,
      y: 300,
      status: "running",
    })}
    RETURNING id`;
  // child 边：任务 root → job（早退保证不重复）
  const [root] = await sql`
    SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
  if (root) {
    await sql`
      INSERT INTO canvas_edges ${sql({
        canvas_id: canvasId,
        from_node_id: root.id,
        to_node_id: node.id,
        edge_type: "child",
      })}`;
  }
}

/**
 * 事件驱动的领取触发器（§4.2：全程事件触发，无轮询）：
 * jobs 表触发器 pg_notify('dfh_jobs') → LISTEN 收到即跑一轮 dispatchOnce。
 * 重入保护：运行中再来事件只标记补跑，不并发抢。
 */
let kickRunning = false;
let kickAgain = false;

export function kickDispatcher() {
  if (kickRunning) {
    kickAgain = true;
    return;
  }
  kickRunning = true;
  void (async () => {
    try {
      do {
        kickAgain = false;
        await dispatchOnce();
      } while (kickAgain);
    } catch (e) {
      console.error("[dispatcher]", e);
    } finally {
      kickRunning = false;
    }
  })();
}

export function startDispatcher() {
  // 事件源：DB LISTEN/NOTIFY（0005_job_events.sql；NOTIFY 提交后投递，与事务可见性一致）
  const listenPromise = sql.listen("dfh_jobs", () => kickDispatcher());
  // 启动补跑： scheduler 停机期间堆积的 pending job 不会产生新事件，先清一次
  void listenPromise.then(() => kickDispatcher()).catch((e) => console.error("[dispatcher] LISTEN 失败:", e));

  // 兜底轮询默认关闭；DFH_DISPATCH_POLL_SEC>0 显式开启（调试/极端场景用）
  let timer: ReturnType<typeof setInterval> | null = null;
  if (config.timeouts.dispatchPollSec > 0) {
    timer = setInterval(() => kickDispatcher(), config.timeouts.dispatchPollSec * 1000);
    console.log(`[dispatcher] 兜底轮询已开启：${config.timeouts.dispatchPollSec}s（默认应关闭，事件驱动）`);
  }
  return () => {
    if (timer) clearInterval(timer);
    void listenPromise.then((l) => l.unlisten()).catch(() => {});
  };
}
