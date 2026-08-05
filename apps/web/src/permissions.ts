import type { AuthMe } from "./api";

export function canAccessAnyScope(me: AuthMe | null, scopes: readonly string[]): boolean {
  if (!me || !me.authenticated || !me.actor) return false;
  if (!me.auth_required || me.actor.role === "admin" || me.actor.scopes.includes("admin")) return true;
  return scopes.some((scope) => me.actor!.scopes.includes(scope)
    || (scope === "images:read" && me.actor!.scopes.includes("images:manage")));
}
