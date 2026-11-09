import { useCallback, useEffect, useRef, useState } from "react";
import { HumanRequestGuidance } from "@deepsonar/shared-types";
import { api, type CanvasNode } from "./api";
import { humanInterventionJobId, isPendingHumanIntervention, subjectFindingId, type HumanInterventionItem } from "./human-messages";

export type HumanInterventionDetailEntry =
  | { status: "loading"; updatedAt: string }
  | { status: "error"; updatedAt: string; error: string }
  | { status: "loaded"; updatedAt: string; node: CanvasNode };

export interface HumanInterventionDetailSnapshot {
  canvasId: string | null;
  entries: ReadonlyMap<string, HumanInterventionDetailEntry>;
}

const EMPTY_ENTRIES: ReadonlyMap<string, HumanInterventionDetailEntry> = new Map();
const EMPTY_SNAPSHOT: HumanInterventionDetailSnapshot = { canvasId: null, entries: EMPTY_ENTRIES };
const MAX_DETAILS = 12;
const MAX_CONCURRENT_DETAILS = 4;

export function isCurrentHumanTaskCallback(requestCanvasId: string | null, activeCanvasId: string | null): boolean {
  return requestCanvasId !== null && requestCanvasId === activeCanvasId;
}

type HumanDetailRequest = { canvasId: string; node: CanvasNode };
type HumanDetailLoader = (canvasId: string, nodeId: string) => Promise<CanvasNode>;

export class HumanInterventionDetailStore {
  private snapshot: HumanInterventionDetailSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private queue: HumanDetailRequest[] = [];
  private active = 0;

  constructor(private readonly loadNode: HumanDetailLoader, private readonly concurrency = MAX_CONCURRENT_DETAILS) {}

  getSnapshot = (): HumanInterventionDetailSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  refresh(canvasId: string, nodes: readonly CanvasNode[]): void {
    if (this.snapshot.canvasId !== canvasId) {
      this.queue = [];
      this.snapshot = { canvasId, entries: new Map() };
      this.publish();
    }

    const requested = nodes.filter((node) => node.node_type === "human").slice(0, MAX_DETAILS);
    const currentIds = new Set(requested.map((node) => node.id));
    const entries = new Map([...this.snapshot.entries].filter(([id]) => currentIds.has(id)));
    const queueBefore = this.queue.length;
    this.queue = this.queue.filter((request) => currentIds.has(request.node.id) && request.canvasId === canvasId);
    let changed = entries.size !== this.snapshot.entries.size || this.queue.length !== queueBefore;

    for (const node of requested) {
      const current = entries.get(node.id);
      if (current?.updatedAt === node.updated_at) continue;
      entries.set(node.id, { status: "loading", updatedAt: node.updated_at });
      this.queue.push({ canvasId, node });
      changed = true;
    }

    if (changed) {
      this.snapshot = { canvasId, entries };
      this.publish();
    }
    this.drain();
  }

  retry(canvasId: string, node: CanvasNode): void {
    if (this.snapshot.canvasId !== canvasId) return;
    const current = this.snapshot.entries.get(node.id);
    if (current?.status !== "error" || current.updatedAt !== node.updated_at) return;
    const entries = new Map(this.snapshot.entries);
    entries.set(node.id, { status: "loading", updatedAt: node.updated_at });
    this.snapshot = { canvasId, entries };
    this.queue.push({ canvasId, node });
    this.publish();
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const request = this.queue.shift()!;
      const entry = this.snapshot.entries.get(request.node.id);
      if (this.snapshot.canvasId !== request.canvasId || entry?.status !== "loading" || entry.updatedAt !== request.node.updated_at) continue;
      this.active += 1;
      void this.loadNode(request.canvasId, request.node.id)
        .then((node) => {
          if (node.id !== request.node.id) throw new Error("L1 返回了不同的人工请求节点");
          this.finish(request, { status: "loaded", updatedAt: request.node.updated_at, node });
        })
        .catch((cause: unknown) => {
          this.finish(request, {
            status: "error",
            updatedAt: request.node.updated_at,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        })
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  private finish(request: HumanDetailRequest, entry: HumanInterventionDetailEntry): void {
    const current = this.snapshot.entries.get(request.node.id);
    if (this.snapshot.canvasId !== request.canvasId || current?.updatedAt !== request.node.updated_at) return;
    const entries = new Map(this.snapshot.entries);
    entries.set(request.node.id, entry);
    this.snapshot = { canvasId: request.canvasId, entries };
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}

export function mergeHumanInterventionDetails(
  items: readonly HumanInterventionItem[],
  details: ReadonlyMap<string, HumanInterventionDetailEntry>,
): HumanInterventionItem[] {
  return items.map((item) => {
    const detail = details.get(item.node.id);
    const loaded = detail?.status === "loaded" && detail.updatedAt === item.node.updated_at ? detail.node : null;
    const node = loaded ?? item.node;
    const body = node.body_json;
    const parsedGuidance = HumanRequestGuidance.safeParse(body.guidance);
    return {
      ...item,
      node,
      reason: typeof body.reason === "string" ? body.reason : node.title || "等待人工判断",
      findingId: loaded ? subjectFindingId(node) : item.findingId,
      jobId: loaded ? humanInterventionJobId(node) : item.jobId,
      pending: loaded ? isPendingHumanIntervention(node) : item.pending,
      guidance: loaded && parsedGuidance.success ? parsedGuidance.data : null,
      guidanceStatus: !loaded
        ? detail?.status === "error" ? "error" : "loading"
        : parsedGuidance.success ? "available" : "missing",
      detailStatus: !loaded ? detail?.status ?? "loading" : "loaded",
      detailVersionMatches: Boolean(loaded && loaded.updated_at === item.node.updated_at),
      detailError: detail?.status === "error" && detail.updatedAt === item.node.updated_at ? detail.error : undefined,
    };
  });
}

export function useHumanInterventionDetails(canvasId: string, nodes: readonly CanvasNode[]) {
  const storeRef = useRef<HumanInterventionDetailStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new HumanInterventionDetailStore(async (id, nodeId) => (await api.canvasNode(id, nodeId)).node);
  }
  const store = storeRef.current;
  const [snapshot, setSnapshot] = useState(store.getSnapshot);

  useEffect(() => {
    const unsubscribe = store.subscribe(() => setSnapshot(store.getSnapshot()));
    store.refresh(canvasId, nodes);
    return unsubscribe;
  }, [canvasId, nodes, store]);

  const retry = useCallback((node: CanvasNode) => store.retry(canvasId, node), [canvasId, store]);
  return {
    entries: snapshot.canvasId === canvasId ? snapshot.entries : EMPTY_ENTRIES,
    retry,
  };
}
