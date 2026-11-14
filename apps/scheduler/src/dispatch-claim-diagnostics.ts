/**
 * #1114/#1115 现场：gate-e2e 里新建项目的 Job 长期停在 pending，调度器既不认领也不解释。
 * 认领在 slots 用尽或候选不满足资格时静默跳过，运维与冒烟日志都看不出原因。
 * 这里只补限流日志，不改任何认领条件：同一签名/同一 Job 原因 60 秒最多一条。
 */
let lastSignature = "";
let lastLoggedAt = 0;

export function logClaimStarved(input: {
  totalActive: number;
  activeProvisioning: number;
  maxGlobalJobs: number;
  maxConcurrentProvisioning: number;
  /** 占住槽位的 Job 摘要：`<claimed_at 日期>:<status>:<短 id>`，用于线上定位。 */
  holders?: readonly string[];
  now?: number;
}): void {
  const signature = `${input.totalActive}/${input.activeProvisioning}`;
  const now = input.now ?? Date.now();
  if (signature === lastSignature && now - lastLoggedAt < 60_000) return;
  lastSignature = signature;
  lastLoggedAt = now;
  const holders = input.holders?.length ? ` holders=${input.holders.join(",")}` : "";
  console.error(
    `[dispatcher] CLAIM_STARVED active=${input.totalActive}/${input.maxGlobalJobs} ` +
      `provisioning=${input.activeProvisioning}/${input.maxConcurrentProvisioning}: new claims paused${holders}`,
  );
}

const skipLoggedAt = new Map<string, number>();
/** 去重窗口：每个窗口最多打印 SKIP_LOG_BUDGET 条明细，其余只计数并在下一窗口汇总一条。 */
const SKIP_LOG_WINDOW_MS = 60_000;
const SKIP_LOG_BUDGET = 20;
let skipWindowStart = 0;
let skipWindowLogged = 0;
let skipWindowSuppressed = 0;

function rotateSkipWindow(now: number): void {
  if (now - skipWindowStart < SKIP_LOG_WINDOW_MS) return;
  if (skipWindowSuppressed > 0) {
    console.error(`[dispatcher] CLAIM_SKIP suppressed=${skipWindowSuppressed} in last ${SKIP_LOG_WINDOW_MS / 1000}s`);
  }
  skipWindowStart = now;
  skipWindowLogged = 0;
  skipWindowSuppressed = 0;
  for (const [key, at] of skipLoggedAt) if (now - at >= SKIP_LOG_WINDOW_MS) skipLoggedAt.delete(key);
}

export function logClaimSkip(jobId: string, reason: string, now = Date.now()): void {
  if (skipWindowStart === 0) skipWindowStart = now;
  rotateSkipWindow(now);
  if (now - (skipLoggedAt.get(`${jobId}:${reason}`) ?? 0) < SKIP_LOG_WINDOW_MS) return;
  // 明细预算用尽后只计数：缓存只保存已打印过的 key，因此容量与预算同阶，不随历史 Job 增长。
  if (skipWindowLogged >= SKIP_LOG_BUDGET) {
    skipWindowSuppressed += 1;
    return;
  }
  skipLoggedAt.set(`${jobId}:${reason}`, now);
  skipWindowLogged += 1;
  console.error(`[dispatcher] CLAIM_SKIP job=${jobId} reason=${reason}`);
}

/** 供回归观察缓存容量；生产路径不读取。 */
export function claimSkipCacheSizeForTests(): number {
  return skipLoggedAt.size;
}

export function resetClaimDiagnosticsForTests(): void {
  skipLoggedAt.clear();
  skipWindowStart = 0;
  skipWindowLogged = 0;
  skipWindowSuppressed = 0;
  lastSignature = "";
  lastLoggedAt = 0;
}
