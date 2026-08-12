/**
 * Dispatcher 进程内的 provision 中止句柄。
 *
 * 取消的权威顺序仍由 Job lifecycle 事务保证：先提交
 * `cancel_requested`/Job 终态，再调用这里的句柄中止外部创建。该注册表只
 * 负责把已提交的取消通知到当前进程，重启后的资源清理由 reconcile 完成。
 */

export type ProvisionCancellation = {
  attemptId: string;
  abortController: AbortController;
  cancelProvision?: () => Promise<void>;
};

type RegisteredProvision = ProvisionCancellation & {
  cancelPromise: Promise<void> | null;
};

const activeProvisions = new Map<string, RegisteredProvision>();

export function registerProvisionCancellation(
  jobId: string,
  input: ProvisionCancellation,
): () => void {
  const current = activeProvisions.get(jobId);
  if (current && current.attemptId !== input.attemptId) {
    throw new Error(`job ${jobId} 已存在其他 Attempt 的 provision 句柄`);
  }
  const entry: RegisteredProvision = { ...input, cancelPromise: null };
  activeProvisions.set(jobId, entry);
  return () => {
    if (activeProvisions.get(jobId) === entry) activeProvisions.delete(jobId);
  };
}

/**
 * 只在取消已由数据库事务提交后调用。AbortSignal 立即通知 runner，
 * cancelProvision 负责处理尚未返回 sandbox_id 的 provider 资源。
 */
export async function interruptProvision(jobId: string, attemptId?: string): Promise<boolean> {
  const entry = activeProvisions.get(jobId);
  if (!entry || (attemptId && entry.attemptId !== attemptId)) return false;
  entry.abortController.abort();
  if (!entry.cancelPromise) {
    entry.cancelPromise = Promise.resolve(entry.cancelProvision?.()).catch(() => undefined);
  }
  await entry.cancelPromise;
  return true;
}
