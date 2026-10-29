import type { FindingQueryFilters } from "./api";
import { readMultiSearchParam, writeMultiSearchParam } from "./searchable-select-model";

export const FINDING_FILTER_PARAMS = ["severity", "profile", "verify", "disposition", "project", "canvas", "q"] as const;
export const FINDING_PAGE_SIZE = 50;

/** URL state is shared by list and aggregate; opening a detail never changes the query. */
export function findingQueryFilters(params: URLSearchParams, scope: "project" | "global", projectId?: string): FindingQueryFilters {
  const csv = (key: string) => readMultiSearchParam(params, key).join(",") || undefined;
  return {
    project_id: scope === "project" ? projectId : csv("project"),
    severity: csv("severity"),
    profile: csv("profile"),
    verify_status: csv("verify"),
    disposition: csv("disposition"),
    canvas_id: scope === "project" ? csv("canvas") : undefined,
    q: params.get("q")?.trim() || undefined,
  };
}

export function updateFindingQuery(params: URLSearchParams, key: string, value: string | readonly string[] | null): URLSearchParams {
  const next = new URLSearchParams(params);
  if (typeof value !== "string" && value !== null) writeMultiSearchParam(next, key, value);
  else if (value) next.set(key, value);
  else next.delete(key);
  if (FINDING_FILTER_PARAMS.includes(key as typeof FINDING_FILTER_PARAMS[number])) next.delete("cursor");
  return next;
}

export function clearFindingQuery(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of [...FINDING_FILTER_PARAMS, "cursor"]) next.delete(key);
  return next;
}
