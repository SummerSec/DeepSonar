export interface IdentifiedRow {
  id: string;
}

export interface PageProgress {
  cursor: string | null;
  hasMore: boolean;
}

/** Initialize keyset progress once; subsequent polls must not rewind it. */
export function initializePageProgress(
  previous: PageProgress | null,
  page: Pick<{ next_cursor: string | null; has_more: boolean }, "next_cursor" | "has_more">,
): PageProgress {
  return previous ?? { cursor: page.next_cursor, hasMore: page.has_more };
}

/**
 * Replace the currently visible first page while retaining every row already
 * loaded by keyset pagination. New rows can arrive at the top between polls;
 * slicing the previous array at the page size would silently drop the old
 * boundary row that the existing cursor still points past.
 */
export function mergeRefreshedPage<T extends IdentifiedRow>(
  refreshed: readonly T[],
  loaded: readonly T[],
): T[] {
  const seen = new Set(refreshed.map((item) => item.id));
  return [...refreshed, ...loaded.filter((item) => !seen.has(item.id))];
}

export function appendUniqueRows<T extends IdentifiedRow>(loaded: readonly T[], next: readonly T[]): T[] {
  const seen = new Set(loaded.map((item) => item.id));
  return [...loaded, ...next.filter((item) => !seen.has(item.id))];
}
