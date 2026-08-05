import type { sql } from "../../db.js";
import type { JobTransitionPlan } from "./transition-policy.js";

/** The postgres tagged client (or a transaction client) supplied by a caller. */
export type JobLifecycleDatabase = typeof sql;

/** Rows returned by lifecycle CAS operations.  Callers deliberately project the
 * fields they need (sandbox/type/canvas metadata) without coupling the domain
 * to a generated database model. */
export type JobLifecycleRow = Record<string, unknown>;

export type JobTransitionRow = JobLifecycleRow;

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
  reconcileProvisioning: () => Promise<JobLifecycleRow[]>;
  reconcileRunning: () => Promise<JobLifecycleRow[]>;
  cancelJob: (jobId: string, error: string) => Promise<JobLifecycleRow | null>;
  cancelJobsOnCanvas: (canvasId: string, error: string, preserveExistingError?: boolean, clearRuntimeMetadata?: boolean) => Promise<JobLifecycleRow[]>;
  cancelJobsForRuntimeImageVersion: (versionId: string, error: string) => Promise<JobLifecycleRow[]>;
}
