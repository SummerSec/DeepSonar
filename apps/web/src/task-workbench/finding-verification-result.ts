export type VerificationJobLike = {
  id: string;
  status: string;
  error: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
};

export type VerificationRoundLike = {
  at?: string;
  finished_at?: string | null;
  missing?: string[];
};

function stamp(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

export function verificationResultTimestamp(row: {
  at?: string;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
}): string {
  return stamp(row.finished_at) || stamp(row.at) || stamp(row.started_at) || stamp(row.created_at);
}

function latestByTimestamp<T>(rows: readonly T[], timestamp: (row: T) => string): T | undefined {
  return rows.reduce<T | undefined>((latest, row) => {
    if (!latest) return row;
    return timestamp(row) >= timestamp(latest) ? row : latest;
  }, undefined);
}

export function selectLatestVerificationJob<T extends VerificationJobLike>(
  jobs: readonly T[],
): T | undefined {
  return latestByTimestamp(jobs, verificationResultTimestamp);
}

/** Only the newest verification job may drive RepairFeedback. A later success hides older failures. */
export function selectLatestVerificationRepairJob<T extends VerificationJobLike>(
  jobs: readonly T[],
): T | undefined {
  const latest = selectLatestVerificationJob(jobs);
  if (!latest) return undefined;
  const status = latest.status.trim().toLowerCase();
  const failed = Boolean(latest.error) || ["failed", "timeout", "orphan"].includes(status);
  return failed ? latest : undefined;
}

export function selectLatestVerificationRound<T extends VerificationRoundLike>(
  rounds: readonly T[],
): T | undefined {
  return latestByTimestamp(rounds, verificationResultTimestamp);
}
