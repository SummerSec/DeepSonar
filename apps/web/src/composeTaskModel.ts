import type { FindingSummary } from "./api";

export const MAX_COMPOSE_SEEDS = 8;
export const COMPOSE_SEED_DISPOSITIONS = new Set(["open", "accepted", "confirmed_vuln"]);

export function isComposeSeedCandidate(finding: FindingSummary): boolean {
  return finding.verify_status === "confirmed" &&
    COMPOSE_SEED_DISPOSITIONS.has(String(finding.disposition ?? "open"));
}

export interface ComposeSeedFilters {
  search?: string;
  severity?: string;
  profile?: string;
  disposition?: string;
  canvasId?: string;
}

export function filterComposeSeedCandidates(
  findings: readonly FindingSummary[],
  filters: ComposeSeedFilters = {},
): FindingSummary[] {
  const needle = filters.search?.trim().toLowerCase() ?? "";
  return findings.filter((finding) => {
    if (!isComposeSeedCandidate(finding)) return false;
    if (filters.severity && String(finding.severity ?? "").toLowerCase() !== filters.severity.toLowerCase()) return false;
    if (filters.profile && finding.profile !== filters.profile) return false;
    if (filters.disposition && String(finding.disposition ?? "open") !== filters.disposition) return false;
    if (filters.canvasId && finding.canvas_id !== filters.canvasId) return false;
    if (!needle) return true;
    return [
      finding.title,
      finding.summary,
      finding.location,
      finding.canvas_title,
      ...finding.tags_json,
    ].filter(Boolean).join(" ").toLowerCase().includes(needle);
  });
}

export function parseComposeSeedQuery(value: string | null): string[] {
  return [...new Set((value ?? "").split(",").map((id) => id.trim()).filter(Boolean))]
    .slice(0, MAX_COMPOSE_SEEDS);
}

export function composeSeedTaskUrl(projectId: string, ids: readonly string[]): string {
  const concreteIds = [...new Set(ids)].slice(0, MAX_COMPOSE_SEEDS);
  return `/projects/${projectId}/tasks?compose=${concreteIds.join(",")}`;
}

export function composeRetryErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/COMPOSE_SEEDS_STALE|种子必须全部属于当前项目|冻结种子/.test(message)) {
    return "冻结种子当前已不可用。请回到 Findings 重新选择可代入项并新建组合任务。";
  }
  return `重试失败：${message}`;
}
