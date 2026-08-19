import type { AuthStatus } from "./api";

export const AUTH_STATUS_UNAVAILABLE = "无法获取鉴权状态";
export const RAIL_AUTH_LOADING_LABEL = "检查鉴权状态…";
export const RAIL_AUTH_ERROR_LABEL = "鉴权状态不可用";
export const RAIL_AUTH_DEV_LABEL = "开发模式 · 鉴权关闭";

export type AuthStatusReadiness =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: AuthStatus };

export type RailAuthPresentation =
  | { kind: "loading"; label: typeof RAIL_AUTH_LOADING_LABEL; className: "is-pending"; title: typeof RAIL_AUTH_LOADING_LABEL }
  | { kind: "error"; label: typeof RAIL_AUTH_ERROR_LABEL; className: "is-error"; title: string }
  | { kind: "dev"; label: typeof RAIL_AUTH_DEV_LABEL; className: "is-dev"; title: typeof RAIL_AUTH_DEV_LABEL }
  | { kind: "session" };

export function authStatusErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return AUTH_STATUS_UNAVAILABLE;
}

/** 仅当接口明确返回关闭时才视为开发模式；缺失或失败都不算。 */
export function isExplicitAuthDisabled(status: AuthStatus | null | undefined): boolean {
  return status?.auth_required === false;
}

/**
 * 与快捷入口的 loaded/loadError 同一纪律：未完成或失败不能当成“鉴权关闭”。
 */
export function resolveAuthStatusReadiness(input: {
  loading: boolean;
  status: AuthStatus | null;
  error?: unknown;
}): AuthStatusReadiness {
  if (input.loading) return { kind: "loading" };
  if (!input.status) return { kind: "error", message: authStatusErrorMessage(input.error) };
  return { kind: "ready", status: input.status };
}

export function resolveRailAuthPresentation(input: {
  loading: boolean;
  status: AuthStatus | null;
  error?: unknown;
}): RailAuthPresentation {
  const readiness = resolveAuthStatusReadiness(input);
  if (readiness.kind === "loading") {
    return { kind: "loading", label: RAIL_AUTH_LOADING_LABEL, className: "is-pending", title: RAIL_AUTH_LOADING_LABEL };
  }
  if (readiness.kind === "error") {
    return { kind: "error", label: RAIL_AUTH_ERROR_LABEL, className: "is-error", title: readiness.message };
  }
  if (isExplicitAuthDisabled(readiness.status)) {
    return { kind: "dev", label: RAIL_AUTH_DEV_LABEL, className: "is-dev", title: RAIL_AUTH_DEV_LABEL };
  }
  return { kind: "session" };
}
