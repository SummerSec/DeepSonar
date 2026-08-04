/** Project-token ownership is enforced at the resource boundary, not by
 * trusting caller-supplied UUID filters. */
export function projectScopeAllows(actorProjectId: string | null | undefined, resourceProjectId: string | null | undefined): boolean {
  return !actorProjectId || actorProjectId === resourceProjectId;
}

export function isUuid(value: string | undefined): boolean {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
