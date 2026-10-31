import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeRoleUiColor,
  pickRoleUiColor,
  ROLE_UI_COLOR_ASSIGNABLE,
  ROLE_UI_COLOR_PATTERN,
  ROLE_UI_COLOR_RESERVED,
  resolveImportedRoleUiColor,
} from "./role-colors.js";

function relativeLuminance(value: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

test("role color allocator picks an injectable unused palette slot", () => {
  const first = pickRoleUiColor([], () => 0);
  const last = pickRoleUiColor([], () => 0.999999);
  assert.equal(first, ROLE_UI_COLOR_ASSIGNABLE[0]);
  assert.equal(last, ROLE_UI_COLOR_ASSIGNABLE.at(-1));
  assert.notEqual(first, last);
  assert.equal(ROLE_UI_COLOR_PATTERN.test(first), true);
  assert.equal(ROLE_UI_COLOR_RESERVED.includes(first as never), false);
});

test("role color allocator excludes reserved and occupied colors", () => {
  const occupied = [ROLE_UI_COLOR_ASSIGNABLE[0], ROLE_UI_COLOR_RESERVED[0], "#NOT-A-COLOR"];
  const color = pickRoleUiColor(occupied, () => 0);
  assert.equal(color, ROLE_UI_COLOR_ASSIGNABLE[1]);
  assert.notEqual(color, ROLE_UI_COLOR_ASSIGNABLE[0]);
  assert.equal(ROLE_UI_COLOR_PATTERN.test(color), true);
});

test("role color allocator has deterministic maximally-separated HSL fallback", () => {
  const occupied = [...ROLE_UI_COLOR_ASSIGNABLE, ...ROLE_UI_COLOR_RESERVED];
  const first = pickRoleUiColor(occupied, () => 0);
  const second = pickRoleUiColor([...occupied].reverse(), () => 0.75);
  assert.equal(first, second);
  assert.equal(ROLE_UI_COLOR_PATTERN.test(first), true);
  assert.equal(occupied.map((value) => value.toLowerCase()).includes(first), false);
});

test("role color allocator stays unique beyond the finite palette", () => {
  const used: string[] = [];
  for (let index = 0; index < 1500; index += 1) {
    const color = pickRoleUiColor(used, () => 0);
    assert.equal(ROLE_UI_COLOR_PATTERN.test(color), true);
    assert.equal(ROLE_UI_COLOR_RESERVED.includes(color as never), false);
    assert.ok(relativeLuminance(color) >= 0.3);
    assert.equal(used.includes(color), false);
    used.push(color);
  }
  assert.equal(new Set(used).size, used.length);
});

test("imported role colors are hints and remap reserved or colliding values", () => {
  assert.equal(resolveImportedRoleUiColor(ROLE_UI_COLOR_RESERVED[0], null, []), ROLE_UI_COLOR_ASSIGNABLE[0]);
  assert.equal(
    resolveImportedRoleUiColor(ROLE_UI_COLOR_ASSIGNABLE[0], null, [ROLE_UI_COLOR_ASSIGNABLE[0]]),
    ROLE_UI_COLOR_ASSIGNABLE[1],
  );
  assert.equal(
    resolveImportedRoleUiColor("#ABCDEF", "#123456", []),
    "#abcdef",
  );
});

test("legacy role colors normalize strictly for read-side fallback", () => {
  assert.equal(normalizeRoleUiColor("#ABCDEF"), "#abcdef");
  assert.equal(normalizeRoleUiColor("#abcdef"), "#abcdef");
  assert.equal(normalizeRoleUiColor("blue"), null);
  assert.equal(normalizeRoleUiColor(null), null);
});
