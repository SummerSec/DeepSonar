/**
 * REA CLI (#718) observation → CliCapabilityResult 归一化。
 * 仅产出 Evidence/Fact 输入（is_finding: false）；截断/超时/取消/部分 JSON 一律 inconclusive，不得当作成功。
 */
import {
  CLI_UNAVAILABLE_CODE,
  CliCapabilityResult,
  type CliUnavailableReason,
} from "@deepsonar/shared-types";

export const REA_CLI_CAPABILITY_ID = "binary.rea.cli" as const;
export const REA_TOOL = "rea" as const;
export const REA_TOOL_VERSION = "6.4.0" as const;

export type ReaCliObservationInput = {
  job_id: string;
  workspace: string;
  argv: readonly string[];
  /** Process exit code; null when killed before an exit code was observed. */
  exit_code: number | null;
  stdout: string;
  stderr: string;
  /** Hard byte cap already applied by the collector (Job / launcher). */
  max_output_bytes: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  /** Wall-clock timeout fired before process exit. */
  timed_out?: boolean;
  /** Cancel / SIGTERM / Reaper requested stop. */
  cancelled?: boolean;
  /** Evidence artifact path retained under the Job workspace. */
  evidence_ref: string;
};

export type ReaCliCleanupPlan = {
  retain: string[];
  delete_ephemeral: string[];
  notes: string[];
};

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "empty_stdout" };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "json_parse_error",
    };
  }
}

/**
 * Build a governed CliCapabilityResult from one REA CLI observation.
 * Never sets is_finding true. Partial / truncated / timed-out / cancelled → inconclusive.
 */
export function buildReaCliCapabilityResult(input: ReaCliObservationInput): CliCapabilityResult {
  const stdoutTruncated = Boolean(input.stdout_truncated) || input.stdout.length > input.max_output_bytes;
  const stderrTruncated = Boolean(input.stderr_truncated) || input.stderr.length > input.max_output_bytes;
  const truncated = stdoutTruncated || stderrTruncated;
  const truncationNotes: string[] = [];
  if (stdoutTruncated) truncationNotes.push("stdout exceeded max_output_bytes or collector truncation flag");
  if (stderrTruncated) truncationNotes.push("stderr exceeded max_output_bytes or collector truncation flag");

  const parsed = tryParseJson(
    stdoutTruncated ? input.stdout.slice(0, input.max_output_bytes) : input.stdout,
  );
  const partialJson = !parsed.ok && input.stdout.trim().length > 0;
  if (partialJson) truncationNotes.push(`stdout JSON incomplete or invalid: ${parsed.reason}`);

  const timedOut = Boolean(input.timed_out);
  const cancelled = Boolean(input.cancelled);
  const nonZero = input.exit_code !== null && input.exit_code !== 0;

  let unavailableReason: CliUnavailableReason | null = null;
  if (timedOut) unavailableReason = "timeout";
  else if (truncated || partialJson) unavailableReason = truncated ? "truncated" : "inconclusive";
  else if (cancelled) unavailableReason = "inconclusive";
  else if (nonZero) unavailableReason = "inconclusive";

  const inconclusive =
    timedOut || cancelled || truncated || partialJson || nonZero || input.exit_code === null;

  // Always retain parsed JSON when available so cancelled/truncated/non-zero paths
  // still archive observations; wrap with status flags when inconclusive.
  const successShape = parsed.ok
    ? inconclusive
      ? {
          observation: parsed.value,
          parse_ok: true,
          timed_out: timedOut,
          cancelled,
          incomplete: true,
        }
      : parsed.value
    : {
        parse_ok: false,
        parse_reason: parsed.reason,
        stdout_preview: input.stdout.slice(0, 400),
        stderr_preview: input.stderr.slice(0, 400),
        timed_out: timedOut,
        cancelled,
      };

  return CliCapabilityResult.parse({
    schema: "deepsonar.cli-capability-result/v1",
    is_finding: false,
    job_id: input.job_id,
    workspace: input.workspace,
    capability_id: REA_CLI_CAPABILITY_ID,
    tool: REA_TOOL,
    tool_version: REA_TOOL_VERSION,
    argv: [...input.argv],
    exit_code: input.exit_code,
    stdout_truncated: stdoutTruncated,
    stderr_truncated: stderrTruncated,
    truncated,
    truncation_notes: truncationNotes.slice(0, 16),
    inconclusive,
    unavailable_code: unavailableReason ? CLI_UNAVAILABLE_CODE : null,
    unavailable_reason: unavailableReason,
    evidence_ref: input.evidence_ref,
    result: successShape,
  });
}

/**
 * Cleanup guidance after a REA/Ghidra attempt. Retain evidence; drop ephemeral provider temps.
 */
export function planReaCliCleanup(input: {
  workspace: string;
  evidencePaths: string[];
  ephemeralPaths?: string[];
}): ReaCliCleanupPlan {
  const retain = [...new Set(input.evidencePaths.filter(Boolean))];
  const deleteEphemeral = [...new Set((input.ephemeralPaths ?? []).filter(Boolean))];
  return {
    retain,
    delete_ephemeral: deleteEphemeral,
    notes: [
      "Retain raw JSON, redacted stderr, exit code, truncation flags, sample SHA-256, tool versions, image digest and redacted argv before sandbox cleanup.",
      "Ghidra temporary projects/DBs are ephemeral; cancelled runs discard session annotations.",
      "Do not interpret incomplete REA output as verified findings.",
      `Workspace root: ${input.workspace}`,
    ],
  };
}

/** True when a frozen image key may invoke binary.rea.cli. */
export function isReaCliImageAdmitted(imageKey: string): boolean {
  return imageKey === "deepsonar-reverse";
}
