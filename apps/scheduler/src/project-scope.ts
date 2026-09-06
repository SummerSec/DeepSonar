export const PROJECT_MISMATCH = "PROJECT_MISMATCH";
export const PROJECT_SCOPE_FORBIDDEN = "PROJECT_SCOPE_FORBIDDEN";

/** Project-token ownership is enforced at the resource boundary, not by
 * trusting caller-supplied UUID filters. */
export function projectScopeAllows(actorProjectId: string | null | undefined, resourceProjectId: string | null | undefined): boolean {
  return !actorProjectId || actorProjectId === resourceProjectId;
}

export function isProjectScopedActor(actorProjectId: string | null | undefined): boolean {
  return Boolean(actorProjectId);
}

/** Body/query project_id is never authorization: project actors are forced to self. */
export function resolveActorProjectId(
  actorProjectId: string | null | undefined,
  requestedProjectId: string | null | undefined,
): { ok: true; projectId: string | null } | { ok: false; error_code: typeof PROJECT_MISMATCH } {
  if (!actorProjectId) return { ok: true, projectId: requestedProjectId ?? null };
  if (requestedProjectId && requestedProjectId !== actorProjectId) {
    return { ok: false, error_code: PROJECT_MISMATCH };
  }
  return { ok: true, projectId: actorProjectId };
}

export function isUuid(value: string | undefined): boolean {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export type CanvasScopeDecision = "allow" | "not_found" | "mismatch";

export function canvasScopeDecision(
  actorProjectId: string | null | undefined,
  canvasProjectId: string | null | undefined,
): CanvasScopeDecision {
  if (!canvasProjectId) return "not_found";
  return projectScopeAllows(actorProjectId, canvasProjectId) ? "allow" : "mismatch";
}
