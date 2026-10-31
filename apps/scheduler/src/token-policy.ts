import { actorHasScope, type Actor } from "./auth.js";

export const SCOPE_EXCEEDS_ACTOR = "SCOPE_EXCEEDS_ACTOR";

/** New or rotated token scopes must be a subset of the caller's effective scopes. */
export function actorCanGrantScopes(actor: Pick<Actor, "scopes">, scopes: readonly string[]): boolean {
  return scopes.every((scope) => actorHasScope(actor as Actor, scope));
}

/**
 * Project actors cannot mint a global token or bind another project.
 * Unscoped actors keep the requested project_id (including null = platform).
 */
export function resolveCreatedTokenProjectId(
  actorProjectId: string | null | undefined,
  requestedProjectId: string | null | undefined,
): { ok: true; projectId: string | null } | { ok: false } {
  if (!actorProjectId) return { ok: true, projectId: requestedProjectId ?? null };
  if (requestedProjectId != null && requestedProjectId !== actorProjectId) return { ok: false };
  return { ok: true, projectId: actorProjectId };
}

/** List / revoke / rotate only cover tokens the actor could have created. */
export function tokenManagedByActor(
  actor: Pick<Actor, "projectId" | "scopes">,
  token: { project_id: string | null; scopes: readonly string[] },
): boolean {
  if (actor.projectId && token.project_id !== actor.projectId) return false;
  return actorCanGrantScopes(actor, token.scopes);
}
