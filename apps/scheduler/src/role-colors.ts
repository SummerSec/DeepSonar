import {
  ROLE_UI_COLOR_ASSIGNABLE,
  ROLE_UI_COLOR_PATTERN,
  ROLE_UI_COLOR_RESERVED,
} from "@deepsonar/shared-types";
import type postgres from "postgres";

export { ROLE_UI_COLOR_ASSIGNABLE, ROLE_UI_COLOR_PATTERN, ROLE_UI_COLOR_RESERVED };

/** The allocator lock is held for the whole role INSERT transaction. */
export const ROLE_COLOR_ADVISORY_KEY = "deepsonar_role_color_allocator";

type RoleColorDb = postgres.Sql;

function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string" || !ROLE_UI_COLOR_PATTERN.test(value)) return null;
  return value.toLowerCase();
}

function isReservedColor(value: string): boolean {
  return ROLE_UI_COLOR_RESERVED.some((reserved) => reserved.toLowerCase() === value);
}

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = Math.max(0, Math.min(1, saturation));
  const l = Math.max(0, Math.min(1, lightness));
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const segment = h * 6;
  const x = chroma * (1 - Math.abs((segment % 2) - 1));
  const [r1, g1, b1] = segment < 1
    ? [chroma, x, 0]
    : segment < 2
      ? [x, chroma, 0]
      : segment < 3
        ? [0, chroma, x]
        : segment < 4
          ? [0, x, chroma]
          : segment < 5
            ? [x, 0, chroma]
            : [chroma, 0, x];
  const m = l - chroma / 2;
  return `#${[r1, g1, b1]
    .map((channel) => clampChannel((channel + m) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function rgbDistance(left: string, right: string): number {
  const channels = (value: string) => [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
  const [lr, lg, lb] = channels(left);
  const [rr, rg, rb] = channels(right);
  return Math.hypot(lr - rr, lg - rg, lb - rb);
}

/**
 * Select a role color from the shared palette.  `random` is injectable so
 * route/integration tests can force a specific slot without mocking globals.
 * Once the finite palette is exhausted, deterministic HSL candidates are
 * scored by their minimum RGB distance from every occupied/reserved color.
 */
export function pickRoleUiColor(
  usedColors: Iterable<unknown>,
  random: () => number = Math.random,
): string {
  const reserved = new Set(ROLE_UI_COLOR_RESERVED.map((color) => color.toLowerCase()));
  const used = new Set<string>();
  for (const value of usedColors) {
    const color = normalizeColor(value);
    if (color) used.add(color);
  }

  const available = ROLE_UI_COLOR_ASSIGNABLE.filter((color) => {
    const normalized = color.toLowerCase();
    return !used.has(normalized) && !reserved.has(normalized);
  });
  if (available.length > 0) {
    const rawSample = random();
    const sample = Number.isFinite(rawSample) ? rawSample : 0;
    const ratio = Math.max(0, Math.min(0.999999999, sample));
    return available[Math.floor(ratio * available.length)] ?? available[0]!;
  }

  const occupied = [...new Set([...reserved, ...used])];
  let best: { color: string; score: number } | null = null;
  // Golden-angle stepping produces deterministic candidates while the score
  // keeps each fallback maximally separated from already occupied colors.
  for (let index = 0; index < 720; index += 1) {
    const candidate = hslToHex(index * 137.507764, 0.72, 0.62);
    if (reserved.has(candidate) || used.has(candidate)) continue;
    const score = occupied.length === 0
      ? Number.POSITIVE_INFINITY
      : Math.min(...occupied.map((color) => rgbDistance(candidate, color)));
    if (!best || score > best.score || (score === best.score && candidate < best.color)) {
      best = { color: candidate, score };
    }
  }
  if (best) return best.color;

  // There are only 24 reserved colors and 720 candidates, so this is a
  // defensive impossible-state fallback. It still obeys the #RRGGBB contract.
  return "#ffffff";
}

/**
 * Resolve an imported color as a hint only.  Reserved colors and colors owned
 * by another role are remapped through the same deterministic allocator used
 * for newly-created roles.  `usedColors` must exclude the role being updated.
 */
export function resolveImportedRoleUiColor(
  sourceColor: unknown,
  currentColor: unknown,
  usedColors: Iterable<unknown>,
): string {
  const used = new Set<string>();
  for (const value of usedColors) {
    const color = normalizeColor(value);
    if (color) used.add(color);
  }
  const source = normalizeColor(sourceColor);
  if (source && !isReservedColor(source) && !used.has(source)) return source;
  const current = normalizeColor(currentColor);
  if (current && !isReservedColor(current) && !used.has(current)) return current;
  return pickRoleUiColor(used, () => 0);
}

/** Allocate from a transaction-scoped connection.  Callers must commit the
 * role INSERT in the same transaction so the advisory lock closes the read /
 * write race between concurrent role creations. */
export async function allocateRoleUiColor(
  db: RoleColorDb,
  random: () => number = Math.random,
): Promise<string> {
  await db`SELECT pg_advisory_xact_lock(hashtext(${ROLE_COLOR_ADVISORY_KEY}))`;
  const used = await db<{ ui_color: string | null }[]>`
    SELECT ui_color FROM agent_roles
    WHERE kind = 'role' AND ui_color IS NOT NULL`;
  return pickRoleUiColor(used.map((entry) => entry.ui_color), random);
}

/** A strict read-side fallback for old rows/jobs created before v16. */
export function normalizeRoleUiColor(value: unknown): string | null {
  return normalizeColor(value);
}
