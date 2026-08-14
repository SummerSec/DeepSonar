import type { SessionItemKind, SessionTimelineItem } from "./parseAgentSession";

export type SessionLedgerRow = {
  item: SessionTimelineItem;
  /** Stable one-based position in the parser output. */
  index: number;
  /** Derived turn number; parser output remains unchanged. */
  turn: number;
  /** One-based step number inside the derived turn. */
  step: number;
  /** Whether this row opens a new user/model turn. */
  turnStart: boolean;
  /** Lower-cased text used by the local toolbar search. */
  searchText: string;
};

export type SessionLedgerFilter = {
  kind?: SessionItemKind | "all";
  query?: string;
};

function searchableText(item: SessionTimelineItem): string {
  return [item.title, item.toolName, item.body, item.kind].filter(Boolean).join(" ").toLocaleLowerCase();
}

/**
 * Project parser items into the compact, turn-aware ledger used by the viewer.
 * This is intentionally a view model: no parser item is rewritten or enriched
 * in the persisted session contract.
 */
export function buildSessionLedger(items: readonly SessionTimelineItem[]): SessionLedgerRow[] {
  let turn = 0;
  let step = 0;

  return items.map((item, itemIndex) => {
    const turnStart = turn === 0 || item.kind === "user";
    if (turnStart) {
      turn += 1;
      step = 1;
    } else {
      step += 1;
    }

    return {
      item,
      index: itemIndex + 1,
      turn,
      step,
      turnStart,
      searchText: searchableText(item),
    };
  });
}

export function filterSessionLedger(
  rows: readonly SessionLedgerRow[],
  { kind = "all", query = "" }: SessionLedgerFilter = {},
): SessionLedgerRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (kind !== "all" && row.item.kind !== kind) return false;
    return !needle || row.searchText.includes(needle);
  });
}

export function sessionLedgerTurnCount(rows: readonly SessionLedgerRow[]): number {
  return rows.length ? rows[rows.length - 1]!.turn : 0;
}

export function sessionViewerWorkspaceMode(hasSelection: boolean): "ledger" | "split" {
  return hasSelection ? "split" : "ledger";
}
