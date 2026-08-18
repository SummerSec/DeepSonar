import type { sql } from "../../db.js";
import type { JobTransitionPlan } from "./transition-policy.js";

/** 调用方提供的 postgres 标记客户端或事务客户端。 */
export type JobLifecycleDatabase = typeof sql;

/** 生命周期 CAS 操作返回的行；调用方按需投影，避免绑定生成式数据库模型。 */
export type JobLifecycleRow = Record<string, unknown>;

export type JobTransitionRow = JobLifecycleRow;

/** 启动恢复对 provision 阶段 Job 的明确分类，避免把 orphan 当作重排成功。 */
export type ProvisionReconcileResult = {
  requeued: JobLifecycleRow[];
  orphaned: JobLifecycleRow[];
};

export interface JobTransitionRequest extends JobTransitionPlan {
  jobId: string;
}

export type JobTransitionExecutor = (request: JobTransitionRequest) => Promise<JobTransitionRow | null>;

export interface JobLifecycleOperations {
  claimPendingJob: (jobId: string) => Promise<JobLifecycleRow | null>;
  failExecution: (jobId: string, error: string) => Promise<JobLifecycleRow | null>;
  reapExecutionTimeout: () => Promise<JobLifecycleRow[]>;
  reapProvisionTimeout: (provisionSec: number) => Promise<JobLifecycleRow[]>;
  reapLeaseOrphans: () => Promise<JobLifecycleRow[]>;
  reapStalledExecution: (stallSec: number) => Promise<JobLifecycleRow[]>;
  reconcileProvisioning: () => Promise<ProvisionReconcileResult>;
  reconcileRunning: () => Promise<JobLifecycleRow[]>;
  cancelJob: (jobId: string, error: string) => Promise<JobLifecycleRow | null>;
  cancelJobsOnCanvas: (canvasId: string, error: string, preserveExistingError?: boolean, clearRuntimeMetadata?: boolean) => Promise<JobLifecycleRow[]>;
  cancelJobsForRuntimeImageVersion: (versionId: string, error: string) => Promise<JobLifecycleRow[]>;
}
