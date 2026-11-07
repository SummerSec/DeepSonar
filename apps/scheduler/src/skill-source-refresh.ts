/**
 * #954：模块源保鲜。
 *
 * 刷新是**周期行为**，不是启动副作用：启动同步（`DEEPSONAR_SKILL_SOURCE_BOOT_SYNC`）
 * 只管进程起来那一次，周期性一致性由本模块的定时器保证。两者都为 0 / false 时，
 * 模块源只能靠人工 `POST /skill-sources/:id/sync` 更新，启动时明确 warn。
 *
 * 设计边界：
 * - 只刷新平台 trusted+enabled 源；刷新**不提权**，新内容仍受 `trust_status` 门控。
 * - 串行执行，单源超时不阻塞主循环；失败有界退避重试，不影响调度。
 * - 每次刷新先用 `git ls-remote` 探针比对远端 HEAD，未变化只前移 `synced_at`。
 */
import { config } from "./config.js";
import { sql } from "./db.js";
import { inc } from "./metrics.js";
import { skillSourceAgeSeconds } from "./skill-freshness.js";
import { probeSkillSourceRemoteHead } from "./skill-source-drift.js";
import { runWithTimeout, syncSkillSource } from "./skill-sources.js";

export interface SkillSourceRefreshTarget {
  id: string;
  name: string;
  repo_url: string;
  branch: string;
  last_commit_sha: string | null;
}

export interface SkillSourceSyncOutcome {
  modules: number;
  changed: boolean;
  skipped: boolean;
}

export type SkillSourceRefreshStatus = "unchanged" | "updated" | "failed";

export interface SkillSourceRefreshOutcome {
  source_id: string;
  source: string;
  status: SkillSourceRefreshStatus;
  modules: number | null;
  attempts: number;
  error: string | null;
}

export interface SkillSourceRefreshDeps {
  listSources?: () => Promise<SkillSourceRefreshTarget[]>;
  sync?: (
    id: string,
    syncedBy: string,
    signal: AbortSignal,
  ) => Promise<SkillSourceSyncOutcome>;
  probe?: (input: {
    repoUrl: string;
    branch: string;
    signal?: AbortSignal;
  }) => Promise<string | null>;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  warn?: (message: string) => void;
}

const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000] as const;
/** 连续失败到该次数即视为需要人工介入的告警条件。 */
export const SKILL_SOURCE_FAILURE_ALERT_THRESHOLD = 3;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultListSources(): Promise<SkillSourceRefreshTarget[]> {
  return (async () => {
    const rows = await sql`
      SELECT id, name, repo_url, branch, last_commit_sha FROM skill_sources
      WHERE enabled = true AND trust_status = 'trusted'
      ORDER BY created_at ASC, id ASC`;
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      repo_url: String(row.repo_url),
      branch: String(row.branch),
      last_commit_sha: typeof row.last_commit_sha === "string" ? row.last_commit_sha : null,
    }));
  })();
}

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref();
});

interface RefreshContext {
  sync: (id: string, syncedBy: string, signal: AbortSignal) => Promise<SkillSourceSyncOutcome>;
  timeoutMs: number;
  maxAttempts: number;
  delays: readonly number[];
  sleep: (ms: number) => Promise<void>;
  warn: (message: string) => void;
  signal?: AbortSignal;
}

/** 单源刷新：有界重试后落成三态（unchanged / updated / failed）。 */
async function refreshOneSource(
  source: SkillSourceRefreshTarget,
  ctx: RefreshContext,
): Promise<SkillSourceRefreshOutcome> {
  let attempts = 0;
  let lastError: string | null = null;
  while (attempts < ctx.maxAttempts) {
    attempts += 1;
    try {
      const settled = await runWithTimeout(
        (signal) => ctx.sync(source.id, "scheduled", signal),
        ctx.timeoutMs,
        `skill-source ${source.name} scheduled sync`,
        ctx.signal,
      );
      const status: SkillSourceRefreshStatus = settled.skipped || !settled.changed ? "unchanged" : "updated";
      console.log(
        `[skills] scheduled sync source=${source.name} status=${status} modules=${settled.modules} attempts=${attempts}`,
      );
      return {
        source_id: source.id,
        source: source.name,
        status,
        modules: settled.modules,
        attempts,
        error: null,
      };
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      lastError = errorMessage(error);
      inc("deepsonar_skill_source_sync_failures_total", { source: source.name });
      ctx.warn(
        `[skills] 模块源 ${source.name} 周期刷新失败（attempt ${attempts}/${ctx.maxAttempts}）: ${lastError}`,
      );
      if (attempts < ctx.maxAttempts) await ctx.sleep(ctx.delays[Math.min(attempts - 1, ctx.delays.length - 1)] ?? 15_000);
    }
  }
  if (attempts >= SKILL_SOURCE_FAILURE_ALERT_THRESHOLD) {
    ctx.warn(
      `[skills][alert] 模块源 ${source.name} 连续 ${attempts} 次刷新失败，需要人工检查（${lastError ?? "unknown"}）`,
    );
  }
  return {
    source_id: source.id,
    source: source.name,
    status: "failed",
    modules: null,
    attempts,
    error: lastError,
  };
}

/** 一轮周期刷新：逐源串行，单源有界重试；单个源失败不影响其它源。 */
export async function refreshTrustedSkillSourcesOnce(
  deps: SkillSourceRefreshDeps = {},
): Promise<SkillSourceRefreshOutcome[]> {
  const listSources = deps.listSources ?? defaultListSources;
  const sync = deps.sync ?? ((id: string, syncedBy: string, signal: AbortSignal) =>
    syncSkillSource(id, syncedBy, signal, {
      skipIfUnchanged: true,
      probeHead: deps.probe ?? probeSkillSourceRemoteHead,
    }));
  const ctx: RefreshContext = {
    sync,
    timeoutMs: deps.timeoutMs ?? config.skillSources.refreshTimeoutSec * 1000,
    maxAttempts: Math.max(1, deps.maxAttempts ?? 3),
    delays: deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
    sleep: deps.sleep ?? defaultSleep,
    warn: deps.warn ?? ((message: string) => console.warn(message)),
    signal: deps.signal,
  };
  const sources = await listSources();
  const outcomes: SkillSourceRefreshOutcome[] = [];
  for (const source of sources) {
    if (deps.signal?.aborted) break;
    outcomes.push(await refreshOneSource(source, ctx));
  }
  return outcomes;
}

/**
 * 陈旧告警：`age > 2 × refreshIntervalSec` 的 trusted+enabled 源打 warn。
 * 阈值与指标 `deepsonar_skill_source_age_seconds` 同源（都以 `synced_at` 为准），
 * 便于「指标告警」和「日志告警」给出同一个判断。
 */
export async function warnStaleSkillSources(input: {
  intervalSec: number;
  db?: typeof sql;
  warn?: (message: string) => void;
  now?: () => number;
}): Promise<{ stale: string[]; checked: number }> {
  const db = input.db ?? sql;
  const warn = input.warn ?? ((message: string) => console.warn(message));
  const now = input.now ?? Date.now;
  const rows = await db`
    SELECT name, synced_at FROM skill_sources
    WHERE enabled = true AND trust_status = 'trusted'
    ORDER BY name ASC` as Array<{ name: string; synced_at: string | Date | null }>;
  const thresholdSec = Math.max(1, input.intervalSec) * 2;
  const stale: string[] = [];
  for (const row of rows) {
    const ageSec = skillSourceAgeSeconds(row.synced_at, now());
    if (ageSec !== null && ageSec <= thresholdSec) continue;
    stale.push(row.name);
    warn(
      `[skills][alert] 模块源 ${row.name} ${
        ageSec === null ? "从未成功同步" : `已 ${Math.round(ageSec)}s 未刷新`
      }（告警阈值 ${thresholdSec}s = 2×refreshIntervalSec）`,
    );
  }
  return { stale, checked: rows.length };
}

/** 启动校验：启动同步与周期刷新全关时明确 warn（不阻塞启动）。 */
export function warnIfSkillSourcesNeverRefresh(input: {
  bootSync: boolean;
  refreshIntervalSec: number;
  warn?: (message: string) => void;
}): boolean {
  if (input.bootSync || input.refreshIntervalSec > 0) return false;
  const warn = input.warn ?? ((message: string) => console.warn(message));
  warn(
    "[boot] 模块源既没有启动同步也没有周期刷新（DEEPSONAR_SKILL_SOURCE_BOOT_SYNC=false 且 " +
      "DEEPSONAR_SKILL_SOURCE_REFRESH_INTERVAL_SEC=0）：Skill 目录只会随人工同步更新",
  );
  return true;
}

/**
 * 注册周期刷新定时器。与 boot sync 相互独立；`intervalSec <= 0` 表示关闭。
 * 单轮未结束时不会重入，停止时中止正在进行的一轮。
 */
export function startSkillSourceRefreshLoop(deps: SkillSourceRefreshDeps & {
  intervalSec?: number;
  enabled?: boolean;
  runStaleAlert?: boolean;
} = {}): () => void {
  const intervalSec = deps.intervalSec ?? config.skillSources.refreshIntervalSec;
  const enabled = deps.enabled ?? true;
  if (!enabled || intervalSec <= 0) {
    console.log("[skills] 周期刷新未启用（DEEPSONAR_SKILL_SOURCE_REFRESH_INTERVAL_SEC=0）");
    return () => {};
  }
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const controller = new AbortController();
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const pass = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await refreshTrustedSkillSourcesOnce({ ...deps, signal: controller.signal });
      if (deps.runStaleAlert !== false) {
        await warnStaleSkillSources({
          intervalSec,
          warn: deps.warn,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        warn(`[skills] 周期刷新本轮失败（不影响调度主循环）: ${errorMessage(error)}`);
      }
    } finally {
      running = false;
    }
  };

  // 不在启动瞬间跑第一轮：启动同步（若开启）正在克隆同一批源，立刻再跑会并发写同一行。
  // 首轮在第一个周期到达时开始；关掉启动同步时也最多等一个 refreshIntervalSec。
  timer = setInterval(() => void pass(), intervalSec * 1000);
  timer.unref?.();
  console.log(`[skills] 模块源周期刷新已启用：每 ${intervalSec}s 检查一次`);

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    controller.abort(new Error("模块源周期刷新已停止"));
  };
}