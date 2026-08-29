import type { SessionItemKind, SessionTimelineItem } from "./parseAgentSession";

export type SessionTokenBucket = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type SessionTurnUsage = SessionTokenBucket & {
  turn: number;
  events: number;
};

export type SessionGatewayUsageRow = {
  request_no?: number;
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  settlement_status?: string;
  observed_at?: string;
};

export type SessionGatewayModelUsage = {
  key: string;
  provider: string;
  model: string;
  requests: number;
  input: number;
  output: number;
  total: number;
};

export type SessionTokenUsage = {
  session: SessionTokenBucket & {
    peakContext: number | null;
    reportedEvents: number;
    turns: SessionTurnUsage[];
  };
  gateway: {
    requests: number;
    input: number;
    output: number;
    total: number;
    settled: number;
    unknown: number;
    notReported: number;
    models: SessionGatewayModelUsage[];
    rows: Array<SessionGatewayUsageRow & { request_no: number; provider: string; model: string }>;
  } | null;
};

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

function tokenCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function addBucket(target: SessionTokenBucket, tokens?: SessionTimelineItem["tokens"]): void {
  if (!tokens) return;
  target.input += tokenCount(tokens.input);
  target.output += tokenCount(tokens.output);
  target.cacheRead += tokenCount(tokens.cacheRead);
  target.cacheWrite += tokenCount(tokens.cacheWrite);
}

function promptSideTokens(tokens?: SessionTimelineItem["tokens"]): number {
  if (!tokens) return 0;
  return tokenCount(tokens.input) + tokenCount(tokens.cacheRead) + tokenCount(tokens.cacheWrite);
}

/**
 * Session 归档 usage 与 Gateway 账本分列，不互相改写或对账成同一数字。
 * 峰值上下文取单条 usage 的 prompt 侧（input + cache）。
 */
export function buildSessionTokenUsage(
  rows: readonly SessionLedgerRow[],
  gatewayUsage: readonly SessionGatewayUsageRow[] = [],
): SessionTokenUsage {
  const session: SessionTokenUsage["session"] = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    peakContext: null,
    reportedEvents: 0,
    turns: [],
  };
  const turns = new Map<number, SessionTurnUsage>();

  for (const row of rows) {
    const tokens = row.item.tokens;
    if (!tokens) continue;
    session.reportedEvents += 1;
    addBucket(session, tokens);
    const peak = promptSideTokens(tokens);
    if (peak > 0 && (session.peakContext == null || peak > session.peakContext)) {
      session.peakContext = peak;
    }
    const current = turns.get(row.turn) ?? {
      turn: row.turn,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      events: 0,
    };
    current.events += 1;
    addBucket(current, tokens);
    turns.set(row.turn, current);
  }
  session.turns = [...turns.values()].sort((a, b) => a.turn - b.turn);

  if (gatewayUsage.length === 0) {
    return { session, gateway: null };
  }

  const models = new Map<string, SessionGatewayModelUsage>();
  const gateway = {
    requests: gatewayUsage.length,
    input: 0,
    output: 0,
    total: 0,
    settled: 0,
    unknown: 0,
    notReported: 0,
    models: [] as SessionGatewayModelUsage[],
    rows: gatewayUsage
      .map((row, index) => ({
        ...row,
        request_no: tokenCount(row.request_no) || index + 1,
        provider: row.provider?.trim() || "unknown",
        model: row.model?.trim() || "—",
      }))
      .sort((a, b) => a.request_no - b.request_no),
  };

  for (const row of gateway.rows) {
    gateway.input += tokenCount(row.input_tokens);
    gateway.output += tokenCount(row.output_tokens);
    gateway.total += tokenCount(row.total_tokens);
    if (row.settlement_status === "unknown") gateway.unknown += 1;
    else if (row.settlement_status === "not_reported") gateway.notReported += 1;
    else gateway.settled += 1;
    const key = `${row.provider}::${row.model}`;
    const model = models.get(key) ?? {
      key,
      provider: row.provider,
      model: row.model,
      requests: 0,
      input: 0,
      output: 0,
      total: 0,
    };
    model.requests += 1;
    model.input += tokenCount(row.input_tokens);
    model.output += tokenCount(row.output_tokens);
    model.total += tokenCount(row.total_tokens);
    models.set(key, model);
  }
  gateway.models = [...models.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  return { session, gateway };
}

export function sessionHasTokenUsage(usage: SessionTokenUsage): boolean {
  return usage.session.reportedEvents > 0 || usage.gateway != null;
}
