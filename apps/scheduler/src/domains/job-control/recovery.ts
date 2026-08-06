import { recoverVerifyJobTerminal } from "../../core.js";
import { sql } from "../../db.js";
import { finalizeReportJob } from "../../report.js";

export async function recoverCancelledDerivedJob(
  job: Record<string, unknown>,
  reason: string,
): Promise<void> {
  const jobId = String(job.id);
  if (job.type === "verify_finding") {
    await recoverVerifyJobTerminal(jobId, "cancelled", reason);
    return;
  }
  if (job.type === "report") {
    await sql.begin((tx) => finalizeReportJob(
      tx as unknown as typeof sql,
      jobId,
      { failed: true, error: reason },
    ));
  }
}
