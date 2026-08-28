export type HealthOpenSandboxLevel = "ok" | "error" | "unconfigured" | "skipped";

export type HealthOpenSandbox = {
  level?: HealthOpenSandboxLevel;
  domain?: string;
  ready?: boolean;
};

/** Operator-facing /health.opensandbox line. Skipped (fake / 未探测) stays hidden. */
export function formatHealthOpenSandbox(status: HealthOpenSandbox | null | undefined): string | null {
  if (status?.level === "ok") return "OpenSandbox 就绪";
  if (status?.level === "error") return "OpenSandbox 不可达";
  if (status?.level === "unconfigured") return "OpenSandbox 未配置";
  return null;
}

export function healthOpenSandboxDegraded(status: HealthOpenSandbox | null | undefined): boolean {
  return status?.level === "error" || status?.level === "unconfigured";
}
