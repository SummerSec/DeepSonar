import type { FindingSummary, ProjectFindingsSummary } from "./api";

export const PROJECT_RISK_TITLE = "项目风险";
export const PROJECT_RISK_CAPTION = "风险发现";
export const PROJECT_RISK_EYEBROW = "PROJECT RISK";
export const PROJECT_RISK_SUBTITLE =
  "本项目全部任务的风险发现，不是单画布工作台。跨项目检索请用「跨项目发现」。";

export function findingsListTruncated(loaded: number, total: number): boolean {
  return total > loaded;
}

export function canvasScopedTotal(
  summary: ProjectFindingsSummary | null | undefined,
  canvasIds: readonly string[],
): number | null {
  if (!summary) return null;
  if (!canvasIds.length) return summary.total;
  return summary.canvases
    .filter((canvas) => canvasIds.includes(canvas.id))
    .reduce((sum, canvas) => sum + canvas.count, 0);
}

export function filterProjectFindings(
  rows: readonly FindingSummary[],
  filters: {
    severities?: readonly string[];
    profiles?: readonly string[];
    verifyStatuses?: readonly string[];
    dispositions?: readonly string[];
    canvasIds?: readonly string[];
    q?: string;
  },
): FindingSummary[] {
  const needle = filters.q?.trim().toLowerCase() ?? "";
  return rows.filter((finding) => {
    if (filters.severities?.length && !filters.severities.includes(finding.severity || "unset")) return false;
    if (filters.profiles?.length && !filters.profiles.includes(finding.profile)) return false;
    if (filters.verifyStatuses?.length && !filters.verifyStatuses.includes(finding.verify_status ?? "pending")) return false;
    if (filters.dispositions?.length && !filters.dispositions.includes(String(finding.disposition ?? "open"))) return false;
    if (filters.canvasIds?.length && !filters.canvasIds.includes(finding.canvas_id ?? "")) return false;
    if (!needle) return true;
    const hay =
      `${finding.title} ${finding.profile} ${finding.category ?? ""} ${finding.summary ?? ""} ${finding.location ?? ""} ${finding.project_name ?? ""} ${finding.canvas_title ?? ""} ${finding.tags_json.join(" ")} ${finding.fingerprint ?? ""}`.toLowerCase();
    return hay.includes(needle);
  });
}

export function dispositionBadgeTone(disposition: string): string {
  if (disposition === "confirmed_vuln") return "border-red-400/25 bg-red-400/[.08] text-red-300";
  if (disposition === "open") return "border-amber-400/25 bg-amber-400/[.08] text-amber-300";
  if (disposition === "accepted") return "border-sky-400/20 bg-sky-400/[.06] text-sky-300";
  if (disposition === "human_reproducing") return "border-violet-400/25 bg-violet-400/[.08] text-violet-300";
  return "border-zinc-400/20 bg-zinc-400/[.06] text-zinc-400";
}
