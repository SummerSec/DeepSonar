import type { FactVerification, FactVerificationStatus } from "./api";
import { readMultiSearchParam, writeMultiSearchParam } from "./searchable-select-model";

export interface FactPageFilters {
  verification_status: FactVerificationStatus[];
  evidence_kind: FactVerification["evidence_kind"][];
  finding_id: string[];
  job_id: string[];
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
  return {
    verification_status: readMultiSearchParam(searchParams, "verification_status")
      .filter((value): value is FactVerificationStatus => FACT_VERIFICATION_STATUSES.has(value as FactVerificationStatus)),
    evidence_kind: readMultiSearchParam(searchParams, "evidence_kind")
      .filter((value): value is FactVerification["evidence_kind"] => FACT_EVIDENCE_KINDS.has(value as FactVerification["evidence_kind"])),
    finding_id: readMultiSearchParam(searchParams, "finding_id").filter((value) => UUID_PATTERN.test(value)),
    job_id: readMultiSearchParam(searchParams, "job_id").filter((value) => UUID_PATTERN.test(value)),
  };
}

/** Stable scalar for React effect deps: same filter values → same string, even when arrays are new instances. */
export function factPageFilterKey(filters: FactPageFilters): string {
  return FACT_FILTER_KEYS.map((key) => filters[key].join(",")).join("|");
}

export function updateFactPageQuery(
  searchParams: URLSearchParams,
  key: FactFilterKey | "fact",
  value: string | readonly string[] | null,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (value !== null && typeof value !== "string") {
    writeMultiSearchParam(next, key, value);
    return next;
  }
  const normalized = value?.trim() ?? "";
  if (normalized) next.set(key, normalized);
  else next.delete(key);
  return next;
}
