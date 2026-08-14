import type { FactVerification, FactVerificationStatus } from "./api";

export interface FactPageFilters {
  verification_status: FactVerificationStatus | "";
  evidence_kind: FactVerification["evidence_kind"] | "";
  finding_id: string;
  job_id: string;
}

export const FACT_FILTER_KEYS = [
  "verification_status",
  "evidence_kind",
  "finding_id",
  "job_id",
] as const;

export type FactFilterKey = (typeof FACT_FILTER_KEYS)[number];

const FACT_VERIFICATION_STATUSES = new Set<FactVerificationStatus>([
  "unverified",
  "verifying",
  "verified",
  "rejected",
  "needs_human",
]);
const FACT_EVIDENCE_KINDS = new Set<FactVerification["evidence_kind"]>(["review", "test"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function readFactPageFilters(searchParams: URLSearchParams): FactPageFilters {
  const verificationStatus = searchParams.get("verification_status") ?? "";
  const evidenceKind = searchParams.get("evidence_kind") ?? "";
  const findingId = searchParams.get("finding_id") ?? "";
  const jobId = searchParams.get("job_id") ?? "";
  return {
    verification_status: FACT_VERIFICATION_STATUSES.has(verificationStatus as FactVerificationStatus)
      ? verificationStatus as FactVerificationStatus
      : "",
    evidence_kind: FACT_EVIDENCE_KINDS.has(evidenceKind as FactVerification["evidence_kind"])
      ? evidenceKind as FactVerification["evidence_kind"]
      : "",
    finding_id: UUID_PATTERN.test(findingId) ? findingId : "",
    job_id: UUID_PATTERN.test(jobId) ? jobId : "",
  };
}

export function updateFactPageQuery(
  searchParams: URLSearchParams,
  key: FactFilterKey | "fact",
  value: string | null,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  const normalized = value?.trim() ?? "";
  if (normalized) next.set(key, normalized);
  else next.delete(key);
  return next;
}
