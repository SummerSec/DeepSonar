export type LayoutPoint = { x: number; y: number };

const EPS = 0.5;

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

export function simplifyPolyline(points: readonly LayoutPoint[]): LayoutPoint[] {
  if (points.length <= 2) return points.map((point) => ({ x: point.x, y: point.y }));
  const out: LayoutPoint[] = [{ x: points[0].x, y: points[0].y }];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = out[out.length - 1];
    const cur = points[i];
    const next = points[i + 1];
    if (near(prev.x, cur.x) && near(prev.y, cur.y)) continue;
    const colinear =
      (near(prev.x, cur.x) && near(cur.x, next.x)) ||
      (near(prev.y, cur.y) && near(cur.y, next.y));
    if (colinear) continue;
    out.push({ x: cur.x, y: cur.y });
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (!near(tail.x, last.x) || !near(tail.y, last.y)) out.push({ x: last.x, y: last.y });
  return out;
}

/**
 * Layer-gutter bus: leave the east port, travel in the first gap after the
 * source, enter the west port. Never take 50% of a skip-layer span (that
 * puts a barcode through the columns in between). Same-column / back-edges
 * wrap above the cards so the vertical segment never sits on the centerline.
 */
export function orthogonalBusPoints(
  source: LayoutPoint,
  target: LayoutPoint,
  lane = 0,
  laneCount = 1,
): LayoutPoint[] {
  const lanes = Math.max(laneCount, 1);
  const laneOffset = (Math.min(Math.max(lane, 0), lanes - 1) - (lanes - 1) / 2) * 8;
  const span = target.x - source.x;
  if (span > 24) {
    if (near(source.y, target.y)) return simplifyPolyline([source, target]);
    const gutter = Math.min(56, Math.max(36, span * 0.5));
    // A wide fan-out can make the centered lane offset larger than the
    // gutter. Keep every bend strictly between the two ports so an east-port
    // edge never starts by travelling back through its source card.
    const margin = Math.min(20, span / 3);
    const midX = Math.max(
      source.x + margin,
      Math.min(source.x + gutter + laneOffset, target.x - margin),
    );
    return simplifyPolyline([
      source,
      { x: midX, y: source.y },
      { x: midX, y: target.y },
      target,
    ]);
  }
  const rightBus = source.x + 28 + lane * 8;
  const leftBus = target.x - 28 - lane * 8;
  const clearY = Math.min(source.y, target.y) - 28 - lane * 10;
  return simplifyPolyline([
    source,
    { x: rightBus, y: source.y },
    { x: rightBus, y: clearY },
    { x: leftBus, y: clearY },
    { x: leftBus, y: target.y },
    target,
  ]);
}

/** Keep the bus X from layout, but start/end on the live React Flow handles. */
export function snapOrthogonalEndpoints(
  points: readonly LayoutPoint[],
  source: LayoutPoint,
  target: LayoutPoint,
): LayoutPoint[] {
  if (points.length < 2) return orthogonalBusPoints(source, target);
  const next = points.map((point) => ({ x: point.x, y: point.y }));
  next[0] = { x: source.x, y: source.y };
  next[next.length - 1] = { x: target.x, y: target.y };
  if (next.length >= 3) {
    next[1] = { x: next[1].x, y: source.y };
    next[next.length - 2] = { x: next[next.length - 2].x, y: target.y };
  }
  return simplifyPolyline(next);
}

export function polylinePath(points: readonly LayoutPoint[]): string {
  if (points.length < 2) return "";
  const [first, ...rest] = points;
  return `M ${first.x} ${first.y}${rest.map((point) => ` L ${point.x} ${point.y}`).join("")}`;
}

export function pathMidpoint(points: readonly LayoutPoint[]): LayoutPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { x: points[0].x, y: points[0].y };
  let total = 0;
  const segs: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const len = Math.hypot(dx, dy);
    segs.push(len);
    total += len;
  }
  if (total <= EPS) return { x: points[0].x, y: points[0].y };
  let remain = total / 2;
  for (let i = 1; i < points.length; i += 1) {
    const len = segs[i - 1];
    if (remain <= len) {
      const t = len === 0 ? 0 : remain / len;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
    remain -= len;
  }
  return { x: points[points.length - 1].x, y: points[points.length - 1].y };
}

export function collectElkSectionPoints(section: {
  startPoint?: { x?: number; y?: number };
  endPoint?: { x?: number; y?: number };
  bendPoints?: Array<{ x?: number; y?: number }>;
}): LayoutPoint[] {
  const pts: LayoutPoint[] = [];
  const push = (point?: { x?: number; y?: number }) => {
    if (!point) return;
    pts.push({ x: point.x ?? 0, y: point.y ?? 0 });
  };
  push(section.startPoint);
  for (const bend of section.bendPoints ?? []) push(bend);
  push(section.endPoint);
  return simplifyPolyline(pts);
}
