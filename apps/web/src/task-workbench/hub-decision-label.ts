/** Canvas convergence fields used for Hub decision subtitle (#574). */
export type HubDecisionConvergence = {
  hub_paused?: boolean;
  auto_stopped?: boolean;
  paused_reason?: string;
};

/**
 * Compact decision-state label for the task workbench header.
 * Surfaces verify-unclosed Hub stops so silent stalls are visible.
 */
export function formatHubDecisionLabel(
  convergence: HubDecisionConvergence | null | undefined,
): string | null {
  if (!convergence) return null;
  if (convergence.hub_paused) return "已暂停";
  if (!convergence.auto_stopped) return "自驱中";
  const reason = convergence.paused_reason ?? "";
  const unclosed = reason.match(
    /^verify_unclosed:high=(\d+)\(inconclusive=(\d+),pending=(\d+)\)$/,
  );
  if (unclosed) {
    return `Hub 已停：${unclosed[1]} 个 high 未收口（${unclosed[2]} inconclusive / ${unclosed[3]} pending）`;
  }
  return reason.startsWith("verify_unclosed:") ? `Hub 已停：${reason}` : "已收敛";
}
