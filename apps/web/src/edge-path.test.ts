import assert from "node:assert/strict";
import test from "node:test";
import {
  collectElkSectionPoints,
  orthogonalBusPoints,
  pathMidpoint,
  polylinePath,
  simplifyPolyline,
} from "./edge-path";

test("orthogonal bus is a three-segment gutter, not a diagonal", () => {
  const points = orthogonalBusPoints({ x: 0, y: 10 }, { x: 200, y: 110 });
  assert.deepEqual(points, [
    { x: 0, y: 10 },
    { x: 56, y: 10 },
    { x: 56, y: 110 },
    { x: 200, y: 110 },
  ]);
  assert.match(polylinePath(points), /^M 0 10 L 56 10 L 56 110 L 200 110$/);
});

test("same-column buses wrap above the cards instead of down the centerline", () => {
  const east = { x: 280, y: 80 };
  const west = { x: 0, y: 260 };
  const points = orthogonalBusPoints(east, west);
  assert.ok(points.length >= 4);
  for (const point of points.slice(1, -1)) {
    const insideCard = point.x > 0.5 && point.x < 279.5 && point.y > 80 && point.y < 260;
    assert.equal(insideCard, false, `bend ${point.x},${point.y} must not cut through the column`);
  }
});

test("colinear elk bends collapse so the path does not jitter", () => {
  const points = simplifyPolyline([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 8 },
  ]);
  assert.deepEqual(points, [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 8 },
  ]);
});

test("elk sections keep start, bends, and end in order", () => {
  assert.deepEqual(
    collectElkSectionPoints({
      startPoint: { x: 280, y: 80 },
      bendPoints: [{ x: 320, y: 80 }, { x: 320, y: 200 }],
      endPoint: { x: 400, y: 200 },
    }),
    [
      { x: 280, y: 80 },
      { x: 320, y: 80 },
      { x: 320, y: 200 },
      { x: 400, y: 200 },
    ],
  );
});

test("label sits on the polyline midpoint", () => {
  assert.deepEqual(
    pathMidpoint([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]),
    { x: 10, y: 0 },
  );
});
