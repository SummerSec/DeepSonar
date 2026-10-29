import { sql } from "../../db.js";
import { QueryParameterError } from "../../pagination.js";
import { isUuid } from "../../project-scope.js";

const FILTER_KEYS = ["project_id", "canvas_id", "severity", "profile", "category", "verify_status", "disposition"] as const;
type FilterKey = typeof FILTER_KEYS[number];
export type FindingQuery = Record<FilterKey, string[] | null> & { q: string | null };

/** OR within a dimension, AND across dimensions. Search is a literal substring. */
export function parseFindingQuery(query: Record<string, unknown>): FindingQuery {
  const result = {} as FindingQuery;
  for (const key of FILTER_KEYS) {
    const raw = query[key];
    if (raw === undefined || raw === null || raw === "") { result[key] = null; continue; }
    if (typeof raw !== "string" || raw.length > 4000) throw new QueryParameterError(key);
    const values = [...new Set(raw.split(",").map((value) => value.trim()))];
    if (values.length > 100 || values.some((value) => !value || value.length > 200)) throw new QueryParameterError(key);
    if ((key === "project_id" || key === "canvas_id") && values.some((value) => !isUuid(value))) throw new QueryParameterError(key);
    result[key] = values;
  }
  if (query.q !== undefined && (typeof query.q !== "string" || query.q.length > 200)) throw new QueryParameterError("q");
  const text = typeof query.q === "string" ? query.q.trim() : "";
  result.q = text ? `%${text.replace(/[\\%_]/g, "\\$&")}%` : null;
  return result;
}

/** Both callers join the same authorized source chain before aggregation/paging. */
export function findingQueryPredicate(query: FindingQuery) {
  return sql`
    (${query.project_id}::uuid[] IS NULL OR f.project_id = ANY(${query.project_id}::uuid[]))
    AND (${query.canvas_id}::text[] IS NULL OR j.canvas_id = ANY(${query.canvas_id}::text[]))
    AND (${query.severity}::text[] IS NULL OR COALESCE(NULLIF(f.severity, ''), 'unset') = ANY(${query.severity}::text[]))
    AND (${query.profile}::text[] IS NULL OR f.profile = ANY(${query.profile}::text[]))
    AND (${query.category}::text[] IS NULL OR f.category = ANY(${query.category}::text[]))
    AND (${query.verify_status}::text[] IS NULL OR f.verify_status = ANY(${query.verify_status}::text[]))
    AND (${query.disposition}::text[] IS NULL OR f.disposition = ANY(${query.disposition}::text[]))
    AND (${query.q}::text IS NULL OR f.title ILIKE ${query.q} OR f.location ILIKE ${query.q}
      OR f.summary ILIKE ${query.q} OR f.fingerprint ILIKE ${query.q})`;
}
