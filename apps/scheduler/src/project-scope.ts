/** Project-token ownership is enforced at the resource boundary, not by
 * trusting caller-supplied UUID filters. */
export function projectScopeAllows(actorProjectId: string | null | undefined, resourceProjectId: string | null | undefined): boolean {
  return !actorProjectId || actorProjectId === resourceProjectId;
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
