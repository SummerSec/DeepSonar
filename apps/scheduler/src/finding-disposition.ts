/** Finding 人工处置态。与 schema `findings_disposition_check` / Web DISPOSITION_OPTIONS 对齐。 */
export const FINDING_DISPOSITIONS = [
  "open",
  "accepted",
  "human_reproducing",
  "confirmed_vuln",
  "rejected_fp",
  "resolved",
  "archived",
] as const;

export type FindingDisposition = (typeof FINDING_DISPOSITIONS)[number];

/** 未否定处置，可作 compose 种子。 */
export const COMPOSE_SEED_DISPOSITIONS = [
  "open",
  "accepted",
  "human_reproducing",
  "confirmed_vuln",
] as const;

export const FINDINGS_LIST_WINDOW = 500;
