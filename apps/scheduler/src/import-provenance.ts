/**
 * Import provenance and resume/rerun admission hints (#400).
 *
 * Imported entities are historical by default. Tokens, sandbox identity and
 * credential secrets never come back with the pack. Operators may resume or
 * rerun-current only after current governance admission.
 */

import { RESUMABLE_JOB_STATUSES } from "./domains/job-lifecycle/transition-policy.js";

export const JOB_IMPORTED_READONLY = "JOB_IMPORTED_READONLY" as const;

export type JobExecutionClass = "live" | "historical";
export type JobProvenanceSource = "native" | "import";

export interface ImportOrigin {
  source_job_id: string | null;
  original_status: string | null;
}

export interface JobProvenance {
  source: JobProvenanceSource;
  execution_class: JobExecutionClass;
  import_origin: ImportOrigin | null;
  default_readonly: boolean;
  resumable_status: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseImportOrigin(payload: unknown): ImportOrigin | null {
  const origin = asRecord(asRecord(payload).import_origin);
  const sourceJobId = asText(origin.source_job_id);
  const originalStatus = asText(origin.original_status);
  if (!sourceJobId && !originalStatus) return null;
  return { source_job_id: sourceJobId, original_status: originalStatus };
}

export function jobProvenance(status: string, payload: unknown): JobProvenance {
  const importOrigin = parseImportOrigin(payload);
  const imported = importOrigin !== null;
  const resumable = (RESUMABLE_JOB_STATUSES as readonly string[]).includes(status);
  return {
    source: imported ? "import" : "native",
    execution_class: imported ? "historical" : "live",
    import_origin: importOrigin,
    default_readonly: imported,
    resumable_status: resumable,
  };
}

/**
 * Imported cancelled jobs that were archived from an active status stay
 * historical. Other imported terminal jobs may resume/rerun after admission.
 */
export function importedResumeBlockedReason(provenance: JobProvenance, status: string): string | null {
  if (provenance.source !== "import") return null;
  if (status === "cancelled") {
    return "导入时活动 Job 已归档为 cancelled，只读展示；请新建任务或对可恢复历史调用 rerun-current";
  }
  if (!provenance.resumable_status) {
    return `导入 Job 状态 ${status} 不允许续跑`;
  }
  return null;
}
