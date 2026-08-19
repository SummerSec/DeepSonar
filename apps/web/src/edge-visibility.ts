/** CSS var on `.react-flow`: scale stroke/dash so CSS `scale(zoom)` cannot crush them. */
export const EDGE_ZOOM_BOOST_CSS_VAR = "--deepsonar-edge-zoom-boost";

/** Screen-pixel floor. Below this, topology strokes look like they vanished. */
export const MIN_SCREEN_STROKE_PX = 1.2;
export const MIN_SCREEN_DASH_ON_PX = 1;
export const TOPOLOGY_STROKE_PX = 2.4;

/** Production #235 measurement: 48 nodes fit to scale(0.08555). */
export const FIT_CRUSH_ZOOM = 0.08555;

export function clampViewportZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return zoom;
}

/**
 * Multiply user-space stroke/dash by this so that after CSS `scale(zoom)`
 * the painted stroke stays ≥ {@link MIN_SCREEN_STROKE_PX}.
 * Zoom ≥ 1 keeps #241 thickness unchanged.
 */
export function edgeZoomBoost(
  zoom: number,
  userStroke = TOPOLOGY_STROKE_PX,
  minScreenPx = MIN_SCREEN_STROKE_PX,
): number {
  const z = clampViewportZoom(zoom);
  if (!Number.isFinite(userStroke) || userStroke <= 0) return 1;
  const screen = userStroke * z;
  return screen >= minScreenPx ? 1 : minScreenPx / screen;
}

export function boostedStrokeCss(userStroke = TOPOLOGY_STROKE_PX): string {
  return `calc(${userStroke}px * var(${EDGE_ZOOM_BOOST_CSS_VAR}, 1))`;
}

export function boostedDashCss(dash: string): string | undefined {
  const parts = dash.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.map((part) => `calc(${part}px * var(${EDGE_ZOOM_BOOST_CSS_VAR}, 1))`).join(" ");
}

export function applyEdgeZoomBoostVar(
  pane: { style: { setProperty(name: string, value: string): void } } | null | undefined,
  zoom: number,
): number {
  const boost = edgeZoomBoost(zoom);
  pane?.style.setProperty(EDGE_ZOOM_BOOST_CSS_VAR, String(boost));
  return boost;
}

export function edgeScreenMetrics(
  userStroke: number,
  dash: string,
  zoom: number,
): { zoom: number; boost: number; strokePx: number; dashOnPx: number; dashOffPx: number } {
  const z = clampViewportZoom(zoom);
  const boost = edgeZoomBoost(z, userStroke);
  const parts = dash.trim() ? dash.split(/\s+/).map(Number) : [];
  return {
    zoom: z,
    boost,
    strokePx: userStroke * boost * z,
    dashOnPx: (parts[0] ?? 0) * boost * z,
    dashOffPx: (parts[1] ?? 0) * boost * z,
  };
}

export function isEdgeReadableOnScreen(userStroke: number, dash: string, zoom: number): boolean {
  const metrics = edgeScreenMetrics(userStroke, dash, zoom);
  if (metrics.strokePx + 1e-6 < MIN_SCREEN_STROKE_PX) return false;
  if (!dash.trim()) return true;
  return metrics.dashOnPx + 1e-6 >= MIN_SCREEN_DASH_ON_PX;
}
