import { SkillApplicability, type SuggestProjectSkillsPayload } from "@deepsonar/shared-types";

export const SKILL_SUGGESTION_POLICY = "deepsonar.skill-suggestions/v1";
export interface SuggestionEnvironment {
  runtime_digest: string | null; tools: string[] | null; allow_egress: boolean | null;
  remaining_seconds: number | null;
}
export function assessSkillApplicability(raw: string | undefined, target: SuggestProjectSkillsPayload["target"], environment: SuggestionEnvironment) {
  const unknown = (reason: string) => ({ status: "unknown" as const, reasons: [reason], declaration: null });
  if (raw === undefined) return unknown("APPLICABILITY_MISSING");
  if (Buffer.byteLength(raw, "utf8") > 12000) return unknown("APPLICABILITY_INVALID");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return unknown("APPLICABILITY_INVALID"); }
  const parsed = SkillApplicability.safeParse(value);
  if (!parsed.success) return unknown("APPLICABILITY_INVALID");
  const d = parsed.data, conflicts: string[] = [], missing: string[] = [];
  if (!d.task_types.includes(target.task_type)) conflicts.push("TASK_TYPE_MISMATCH");
  if (!d.input_kinds.includes(target.input_kind)) conflicts.push("INPUT_KIND_MISMATCH");
  if (!d.target_versions.includes(target.target_version)) conflicts.push("TARGET_VERSION_MISMATCH");
  if (environment.runtime_digest === null) missing.push("RUNTIME_UNKNOWN");
  else if (!d.runtime_digests.includes(environment.runtime_digest)) conflicts.push("RUNTIME_MISMATCH");
  if (environment.tools === null) missing.push("TOOLS_UNKNOWN");
  else if (!environment.tools.includes("pull_skill") || d.required_tools.some(tool => !environment.tools!.includes(tool))) conflicts.push("TOOLS_MISMATCH");
  if (d.requires_network && environment.allow_egress === null) missing.push("NETWORK_UNKNOWN");
  else if (d.requires_network && !environment.allow_egress) conflicts.push("NETWORK_MISMATCH");
  if (environment.remaining_seconds === null) missing.push("TIME_BUDGET_UNKNOWN");
  else if (environment.remaining_seconds <= 0 || environment.remaining_seconds < d.minimum_seconds) conflicts.push("TIME_BUDGET_INSUFFICIENT");
  if (d.minimum_tokens > 0) missing.push("TOKEN_BUDGET_UNKNOWN");
  return { status: conflicts.length ? "incompatible" as const : missing.length ? "unknown" as const : "compatible" as const,
    reasons: [...conflicts, ...missing], declaration: d };
}
