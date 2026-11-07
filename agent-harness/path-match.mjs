// Shared workflow path-pattern matching.
//
// Extracted so both the run plan (#836/#961) and the Reverse suite plan (#976)
// can use the same matcher without importing each other. The semantics are
// unchanged: `dir/**` selects everything inside `dir`, `*` never crosses `/`,
// and patterns are matched per segment.

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Translate a workflows `paths` pattern into a matcher. */
export function pathPatternToRegExp(pattern) {
  const segments = String(pattern).split("/");
  const source = segments
    .map((segment, index) => {
      if (segment === "**") return index === segments.length - 1 ? "(?:.*)?" : "(?:[^/]+/)*";
      const body = escapeRegExp(segment).replaceAll("\\*", "[^/]*");
      return index === segments.length - 1 ? body : `${body}/`;
    })
    .join("");
  return new RegExp(`^${source}$`, "u");
}

export function matchesPathPattern(pattern, path) {
  return pathPatternToRegExp(pattern).test(path);
}

export const matchesAnyPath = (patterns, path) =>
  patterns.some((pattern) => matchesPathPattern(pattern, path));
