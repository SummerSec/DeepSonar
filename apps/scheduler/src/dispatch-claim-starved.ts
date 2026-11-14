/**
 * #1114/#1115 现场：gate-e2e 里新建项目的 Job 长期停在 pending，调度器既不认领也不解释。
 * 认领在 slots 用尽时静默返回空批次，运维与冒烟日志都看不出「容量被谁占住」。
 * 这里只补一条限流日志，不改认领条件：同一签名 60 秒最多打印一次，避免热路径刷屏。
 */
let lastSignature = "";
let lastLoggedAt = 0;

export function logClaimStarved(input: {
  totalActive: number;
  activeProvisioning: number;
  maxGlobalJobs: number;
  maxConcurrentProvisioning: number;
  now?: number;
}): void {
  const signature = `${input.totalActive}/${input.activeProvisioning}`;
  const now = input.now ?? Date.now();
  if (signature === lastSignature && now - lastLoggedAt < 60_000) return;
  lastSignature = signature;
  lastLoggedAt = now;
  console.error(
    `[dispatcher] CLAIM_STARVED active=${input.totalActive}/${input.maxGlobalJobs} ` +
      `provisioning=${input.activeProvisioning}/${input.maxConcurrentProvisioning}: new claims paused`,
  );
}
