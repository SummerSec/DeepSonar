import type { FindingSummary, ProjectFindingsSummary } from "./api";

/** 项目侧合并后的「风险与报告」交付台文案（#561）。 */
export const PROJECT_DELIVERY_TITLE = "风险与报告";
export const PROJECT_DELIVERY_CAPTION = "风险发现与交付结论";
export const PROJECT_DELIVERY_NAV_SHORT = "风险报告";
export const PROJECT_DELIVERY_EYEBROW = "PROJECT DELIVERY";
export const PROJECT_DELIVERY_SUBTITLE =
  "本项目风险发现与报告交付闭环。跨项目检索请用「跨项目发现」。";

export type ProjectDeliveryPanel = "risk" | "reports";

export function readProjectDeliveryPanel(searchParams: URLSearchParams): ProjectDeliveryPanel {
  return searchParams.get("panel") === "reports" ? "reports" : "risk";
}

export function writeProjectDeliveryPanel(
  searchParams: URLSearchParams,
  panel: ProjectDeliveryPanel,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (panel === "reports") next.set("panel", "reports");
  else next.delete("panel");
  return next;
}

export function projectReportsRedirectPath(projectId: string): string {
  return `/projects/${projectId}/findings?panel=reports`;
}

/** @deprecated 使用 PROJECT_DELIVERY_*；保留别名避免外部引用断裂。 */
export const PROJECT_RISK_TITLE = PROJECT_DELIVERY_TITLE;
export const PROJECT_RISK_CAPTION = PROJECT_DELIVERY_CAPTION;
export const PROJECT_RISK_EYEBROW = PROJECT_DELIVERY_EYEBROW;
export const PROJECT_RISK_SUBTITLE = PROJECT_DELIVERY_SUBTITLE;

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

export function researchPriorityLabel(score: number | null | undefined): string | null {
  if (score == null || Number.isNaN(Number(score))) return null;
  return `优先 ${Math.round(Number(score))}`;
}

export function researchDedupeLabel(finding: {
  is_canonical?: boolean | null;
  canonical_finding_id?: string | null;
  dedupe_cluster_id?: string | null;
}): string | null {
  if (finding.is_canonical === false && finding.canonical_finding_id) return "语义重复";
  if (finding.is_canonical && finding.dedupe_cluster_id) return "canonical";
  return null;
}

export function dispositionBadgeTone(disposition: string): string {
  if (disposition === "confirmed_vuln") return "border-red-400/25 bg-red-400/[.08] text-red-300";
  if (disposition === "open") return "border-amber-400/25 bg-amber-400/[.08] text-amber-300";
  if (disposition === "accepted") return "border-sky-400/20 bg-sky-400/[.06] text-sky-300";
  if (disposition === "human_reproducing") return "border-violet-400/25 bg-violet-400/[.08] text-violet-300";
  return "border-zinc-400/20 bg-zinc-400/[.06] text-zinc-400";
}
