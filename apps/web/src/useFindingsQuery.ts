import { useEffect, useState } from "react";
import { api, type FindingSummary, type ProjectFindingsSummary, type FindingQueryFilters } from "./api";
import { FINDING_PAGE_SIZE } from "./finding-query-state";

interface QueryState {
  key: string;
  rows: FindingSummary[];
  summary: ProjectFindingsSummary | null;
  facets: ProjectFindingsSummary | null;
  nextCursor: string | null;
  error: string | null;
  loading: boolean;
}

function emptyState(key: string): QueryState {
  return { key, rows: [], summary: null, facets: null, nextCursor: null, error: null, loading: true };
}

/** Sequential polling avoids overlapping responses; query changes invalidate all visible cached rows. */
export function useFindingsQuery(scope: "project" | "global", projectId: string | undefined, filters: FindingQueryFilters, after: string | null) {
  const key = JSON.stringify({ scope, projectId, filters, after });
  const [state, setState] = useState<QueryState>(() => emptyState(key));
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const query = JSON.parse(key) as { scope: "project" | "global"; projectId?: string; filters: FindingQueryFilters; after: string | null };
    const tick = async () => {
      try {
        if (query.scope === "project" && !query.projectId) throw new Error("缺少项目 ID");
        const { project_id: _projectId, ...summaryFilters } = query.filters;
        const summaryRequest = query.scope === "project" && query.projectId
          ? api.projectFindingsSummary(query.projectId, summaryFilters) : Promise.resolve(null);
        const facetsRequest = query.scope === "project" && query.projectId && Object.keys(summaryFilters).length
          ? api.projectFindingsSummary(query.projectId) : summaryRequest;
        const [page, summary, facets] = await Promise.all([
          api.findingsPage({ ...query.filters, after: query.after, limit: FINDING_PAGE_SIZE }),
          summaryRequest,
          facetsRequest,
        ]);
        if (!stopped) setState({ key, rows: page.items, summary, facets, nextCursor: page.has_more ? page.next_cursor : null, error: null, loading: false });
      } catch (error) {
        // Fail closed: revoked or failed queries must not leave the previous page/aggregate visible.
        if (!stopped) setState({ ...emptyState(key), error: String(error), loading: false });
      } finally {
        if (!stopped) timer = setTimeout(tick, 5000);
      }
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [key]);
  return state.key === key ? state : emptyState(key);
}
