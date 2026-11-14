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

export function logClaimSkip(jobId: string, reason: string, now = Date.now()): void {
  const key = `${jobId}:${reason}`;
  if (now - (skipLoggedAt.get(key) ?? 0) < 60_000) return;
  skipLoggedAt.set(key, now);
  console.error(`[dispatcher] CLAIM_SKIP job=${jobId} reason=${reason}`);
}
