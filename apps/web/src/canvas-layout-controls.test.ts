import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./CanvasView.tsx", import.meta.url), "utf8");

test("canvas utilities default collapsed and expose accessible toggles", () => {
  assert.match(source, /const \[filtersOpen, setFiltersOpen\] = useState\(false\)/);
  assert.match(source, /const \[broadcastLedgerOpen, setBroadcastLedgerOpen\] = useState\(false\)/);
  assert.match(source, /aria-expanded=\{broadcastLedgerOpen\}/);
  assert.match(source, /aria-controls="canvas-broadcast-ledger"/);
  assert.match(source, /filtersOpen \? "is-open" : "is-collapsed"/);
  assert.match(source, /getNodesBounds\(visibleNodes\)/);
  assert.match(source, /getViewportForBounds\(bounds,/);
  assert.match(source, /toPng\(viewport,/);
  assert.match(source, /aria-label=\{exportingImage \? "正在导出画布图片" : "导出画布图片"\}/);
});
