import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CaretDown, CaretUp, Eye, EyeSlash, Funnel, TreeStructure, X } from "@phosphor-icons/react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, type CanvasData, type CanvasNode, type FindingTrace } from "./api";
import {
  applyCanvasDelta,
  CANVAS_SKELETON_REFRESH_MS,
  mergeHydratedCanvasData,
  mergeHydratedNodeData,
  shouldApplyHydratedNode,
  shouldApplyCanvasDelta,
  shouldApplyCanvasSummary,
  syncSelectedNode,
} from "./canvas-sync";
import {
  buildOutgoing,
  computeNodeDepths,
  computeVisibleIds,
  countDirectChildren,
  DEFAULT_MAX_DEPTH,
  isEffectivelyExpanded,
  maxDepthOf,
} from "./graph-depth";
import { elkLayout, layoutNodes, NODE_W } from "./layout";
import { JobDetailPanel } from "./JobDetailPanel";
import { EDGE_STYLE } from "./edge-style";
import { nodeDisplayColor, nodeTypes, semanticNodeKind, SEMANTIC_STYLE, type SemanticNodeKind } from "./nodes";
import { Sidebar } from "./Sidebar";
import { findingTraceIds, traceDisplayIds, type TraceFocusMode } from "./finding-trace-focus";

/** 边类型只控制线型/流速；颜色始终取源节点最终展示色。 */
export { EDGE_STYLE } from "./edge-style";

/** Avoid a main-thread ELK layout spike on large topology snapshots. */
export const ELK_NODE_THRESHOLD = 200;
export const CANVAS_DELTA_POLL_MS = 3_000;

type ExpandHandlers = {
  expandNode: (id: string) => void;
  collapseNode: (id: string) => void;
};

function toFlow(
  data: CanvasData,
  elkPos: Map<string, { x: number; y: number }> | null,
  fallbackPos: Map<string, { x: number; y: number }> | null,
  depths: Map<string, number>,
  maxDepth: number,
  expandedIds: ReadonlySet<string>,
  collapsedIds: ReadonlySet<string>,
  outgoing: Map<string, string[]>,
  handlers: ExpandHandlers,
  focusNodeIds: ReadonlySet<string>,
  focusEdgeIds: ReadonlySet<string>,
  focusMode: TraceFocusMode,
): { nodes: Node[]; edges: Edge[] } {
  const nodeColors = new Map(data.nodes.map((node) => [node.id, nodeDisplayColor(node)]));
  return {
    nodes: data.nodes.map((n) => {
      const depth = depths.get(n.id) ?? 1;
      const childCount = countDirectChildren(n.id, outgoing);
      const expanded = isEffectivelyExpanded(n.id, depth, maxDepth, expandedIds, collapsedIds);
      return {
        id: n.id,
        type: n.node_type,
        // 布局只对当前可见子图计算，展开/收起后自适应重排
        position: elkPos?.get(n.id) ?? fallbackPos?.get(n.id) ?? { x: n.x, y: n.y },
        width: NODE_W,
        data: {
          canvas: n,
          depth,
          childCount,
          isExpanded: expanded,
          onExpandNode: childCount > 0 ? () => handlers.expandNode(n.id) : undefined,
          onCollapseNode: childCount > 0 ? () => handlers.collapseNode(n.id) : undefined,
        },
        draggable: false,
        connectable: false,
        style: focusNodeIds.size > 0 && focusMode === "dim" && !focusNodeIds.has(n.id)
          ? { opacity: 0.16 }
          : undefined,
      };
    }),
    edges: data.edges.map((e) => {
      const st = EDGE_STYLE[e.edge_type] ?? EDGE_STYLE.child;
      const sourceColor = nodeColors.get(e.from_node_id) ?? SEMANTIC_STYLE.note.color;
      return {
        id: e.id,
        source: e.from_node_id,
        target: e.to_node_id,
        type: "smoothstep",
        animated: true,
        className: `deepsonar-edge deepsonar-edge-${e.edge_type}`,
        style: {
          stroke: sourceColor,
          strokeWidth: 1.8,
          opacity: focusNodeIds.size > 0 && focusMode === "dim" && !focusEdgeIds.has(e.id) ? 0.08 : 0.9,
          strokeDasharray: st.dash || undefined,
          "--deepsonar-edge-speed": st.speed,
        } as CSSProperties,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: sourceColor },
      };
    }),
  };
}

/** 节点类型 + 边语义图例 */
function Legend() {
  const nodeKinds: SemanticNodeKind[] = [
    "task",
    "hub",
    "intent",
    "subagent",
    "verify",
    "finding",
    "fact",
    "report",
    "human",
  ];
  const edgeItems = [
    { dash: EDGE_STYLE.produces.dash, label: "produces" },
    { dash: EDGE_STYLE.verifies.dash, label: "verifies" },
    { dash: EDGE_STYLE.next.dash, label: "next" },
    { dash: EDGE_STYLE.from.dash, label: "from" },
    { dash: EDGE_STYLE.to.dash, label: "to" },
    { dash: EDGE_STYLE.child.dash, label: "child" },
  ];
  return (
    <div
      className="surface-shell absolute bottom-3 left-3 z-10 max-w-[min(720px,calc(100%-1.5rem))] rounded-[17px] p-1"
      style={{ position: "absolute" }}
    >
      <div className="surface-core flex flex-col gap-2 rounded-[13px] px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-600">节点</span>
          {nodeKinds.map((kind) => {
            const meta = SEMANTIC_STYLE[kind];
            return (
              <span
                key={kind}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium"
                style={{
                  color: meta.color,
                  background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
                  boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${meta.color} 40%, transparent)`,
                }}
                title={meta.hint}
              >
                <span className="inline-block size-1.5 rounded-full" style={{ background: meta.color }} />
                {meta.label}
              </span>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/[.05] pt-1.5">
          <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-600">边</span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full" style={{ background: SEMANTIC_STYLE.subagent.color }} />
            <span className="font-mono text-[9px] text-zinc-500">颜色 = 源节点</span>
          </span>
          {edgeItems.map((it) => (
            <span key={it.label} className="flex items-center gap-1.5">
              <svg aria-hidden="true" className="h-2 w-5 overflow-visible" viewBox="0 0 20 2">
                <line
                  x1="0"
                  y1="1"
                  x2="20"
                  y2="1"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeDasharray={it.dash || undefined}
                />
              </svg>
              <span className="font-mono text-[9px] text-zinc-500">{it.label}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CanvasView({
  canvasId,
  onData,
  trace,
  focusNodeId,
  findingIdByNodeId,
  onTraceFinding,
  onExitTrace,
}: {
  canvasId: string;
  onData?: (data: CanvasData) => void;
  trace?: FindingTrace | null;
  focusNodeId?: string | null;
  findingIdByNodeId?: ReadonlyMap<string, string>;
  onTraceFinding?: (findingId: string) => void;
  onExitTrace?: () => void;
}) {
  const [data, setData] = useState<CanvasData | null>(null);
  const [selected, setSelected] = useState<CanvasNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elkPos, setElkPos] = useState<Map<string, { x: number; y: number }> | null>(null);
  const [kindFilter, setKindFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [query, setQuery] = useState("");
  const [showContext, setShowContext] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(() =>
    typeof window === "undefined" || window.matchMedia("(min-width: 640px)").matches,
  );
  const [traceMode, setTraceMode] = useState<TraceFocusMode>("hide");
  /** 全局深度上限；默认前 3 层。全开 = graphMax；隐藏 = 回到 3 并清空手动覆盖 */
  const [maxDepth, setMaxDepth] = useState(DEFAULT_MAX_DEPTH);
  /** 用户强制展开（覆盖默认 depth 折叠） */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  /** 用户强制收起（覆盖默认 depth 展开） */
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const rf = useRef<ReactFlowInstance | null>(null);
  const hydratedNodesRef = useRef(new Map<string, CanvasNode>());
  const nodeRequestRef = useRef(0);
  const revisionRef = useRef("0");
  const syncGenerationRef = useRef(0);
  const deltaInFlightRef = useRef<number | null>(null);
  const summaryInFlightRef = useRef<number | null>(null);
  const focusedNodeRef = useRef("");
  const focusedViewportRef = useRef("");
  const clearSelected = useCallback(() => {
    nodeRequestRef.current += 1;
    setSelected(null);
  }, []);

  useEffect(() => {
    if (!focusNodeId || !data) return;
    const found = data.nodes.find((node) => node.id === focusNodeId);
    if (!found) return;
    const focusKey = `${canvasId}:${focusNodeId}`;
    if (focusedNodeRef.current === focusKey) return;
    focusedNodeRef.current = focusKey;
    setSelected(found);
    const requestId = ++nodeRequestRef.current;
    const requestGeneration = syncGenerationRef.current;
    const requestRevision = revisionRef.current;
    void api.canvasNode(canvasId, found.id).then((result) => {
      if (!shouldApplyHydratedNode(
        requestGeneration,
        syncGenerationRef.current,
        requestRevision,
        revisionRef.current,
        requestId,
        nodeRequestRef.current,
      )) return;
      const hydrated = mergeHydratedNodeData(found, result.node);
      hydratedNodesRef.current.set(found.id, hydrated);
      setSelected(hydrated);
    }).catch(() => {});
  }, [canvasId, data, focusNodeId]);

  useEffect(() => {
    if (!focusNodeId) {
      focusedNodeRef.current = "";
      focusedViewportRef.current = "";
    }
  }, [focusNodeId]);

  // Load L0 once, then apply durable revision-bounded deltas.  A slow summary
  // refresh is retained only as a consistency fallback (for example after a
  // retention gap); normal active updates never retransmit the full body set.
  useEffect(() => {
    let alive = true;
    const generation = ++syncGenerationRef.current;
    // A canvas switch starts an independent request generation.  Allow the
    // new canvas to issue its initial request even if the old one is still in
    // flight; generation checks below discard the stale response.
    summaryInFlightRef.current = null;
    deltaInFlightRef.current = null;
    const loadSummary = async () => {
      if (summaryInFlightRef.current === generation) return;
      summaryInFlightRef.current = generation;
      try {
        const summary = await api.canvasSummary(canvasId);
        if (!alive || generation !== syncGenerationRef.current) return;
        const responseRevision = summary.revision ?? summary.watermark ?? "0";
        // A summary is allowed to initialize or advance state, never rewind a
        // revision already accepted from a faster delta response.
        if (!shouldApplyCanvasSummary(generation, syncGenerationRef.current, responseRevision, revisionRef.current)) return;
        const next = mergeHydratedCanvasData(summary, hydratedNodesRef.current);
        revisionRef.current = responseRevision;
        setData(next);
        setSelected((previous) => syncSelectedNode(next, previous, hydratedNodesRef.current));
        setError(null);
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (summaryInFlightRef.current === generation) summaryInFlightRef.current = null;
      }
    };
    const loadDelta = async () => {
      if (deltaInFlightRef.current === generation) return;
      deltaInFlightRef.current = generation;
      const since = revisionRef.current;
      try {
        const delta = await api.canvasDelta(canvasId, since);
        if (!alive || !shouldApplyCanvasDelta(
          generation,
          syncGenerationRef.current,
          since,
          revisionRef.current,
          delta.upper_revision,
        )) return;
        setData((before) => {
          if (!before) return before;
          const next = applyCanvasDelta(before, delta, hydratedNodesRef.current);
          revisionRef.current = delta.upper_revision;
          setSelected((previous) => syncSelectedNode(next, previous, hydratedNodesRef.current));
          return next;
        });
        setError(null);
      } catch (e) {
        // A retained-window gap is explicit and recoverable: reload only the
        // bounded L0 summary, then continue from its current revision.
        const message = String(e);
        if (/CURSOR_GAP|DELTA_CHANGELOG_REQUIRED|-> 410/u.test(message)) {
          await loadSummary();
          return;
        }
        if (alive) setError(message);
      } finally {
        if (deltaInFlightRef.current === generation) deltaInFlightRef.current = null;
      }
    };
    setData(null);
    clearSelected();
    focusedNodeRef.current = "";
    focusedViewportRef.current = "";
    setElkPos(null);
    setMaxDepth(DEFAULT_MAX_DEPTH);
    setExpandedIds(new Set());
    setCollapsedIds(new Set());
    hydratedNodesRef.current.clear();
    revisionRef.current = "0";
    void loadSummary().then(() => {
      if (alive) void loadDelta();
    });
    const deltaTimer = setInterval(() => void loadDelta(), CANVAS_DELTA_POLL_MS);
    const summaryTimer = setInterval(() => void loadSummary(), CANVAS_SKELETON_REFRESH_MS);
    return () => {
      alive = false;
      syncGenerationRef.current += 1;
      clearInterval(deltaTimer);
      clearInterval(summaryTimer);
    };
  }, [canvasId, clearSelected, onData]);

  useEffect(() => {
    if (data) onData?.(data);
  }, [data, onData]);

  // 节点消失时清理手动覆盖，避免悬空 id 堆积
  useEffect(() => {
    if (!data) return;
    const alive = new Set(data.nodes.map((n) => n.id));
    const prune = (prev: Set<string>) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (alive.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    };
    setExpandedIds(prune);
    setCollapsedIds(prune);
  }, [data]);

  const depths = useMemo(
    () => (data ? computeNodeDepths(data.nodes, data.edges) : new Map<string, number>()),
    [data],
  );
  const outgoing = useMemo(
    () => (data ? buildOutgoing(data.edges) : new Map<string, string[]>()),
    [data],
  );
  const graphMaxDepth = useMemo(() => maxDepthOf(depths), [depths]);
  const effectiveMaxDepth = Math.min(maxDepth, graphMaxDepth);

  const expandNode = useCallback((id: string) => {
    setExpandedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setCollapsedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const collapseNode = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setExpandedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setMaxDepth(graphMaxDepth);
    setExpandedIds(new Set());
    setCollapsedIds(new Set());
  }, [graphMaxDepth]);

  /** 隐藏深层：回到默认前 3 层，并清掉所有手动展开/收起 */
  const collapseToDefault = useCallback(() => {
    setMaxDepth(DEFAULT_MAX_DEPTH);
    setExpandedIds(new Set());
    setCollapsedIds(new Set());
  }, []);

  const depthVisible = useMemo(() => {
    if (!data) return new Set<string>();
    return computeVisibleIds(
      data.nodes,
      data.edges,
      depths,
      effectiveMaxDepth,
      expandedIds,
      collapsedIds,
    );
  }, [collapsedIds, data, depths, effectiveMaxDepth, expandedIds]);

  const filterActive = Boolean(kindFilter || severityFilter || roleFilter || statusFilter || query.trim());

  /**
   * 最终展示集合 = 深度门控 ∩ 属性筛选（可含一跳上下文）。
   * 布局只对这批节点算，筛选/展开/画布增删都会触发重排。
   */
  const { displayIds: baseDisplayIds, matchedCount } = useMemo(() => {
    if (!data) return { displayIds: new Set<string>(), matchedCount: 0 };

    if (!filterActive) {
      return { displayIds: new Set(depthVisible), matchedCount: depthVisible.size };
    }

    const needle = query.trim().toLowerCase();
    const matched = new Set(
      data.nodes
        .filter((n) => {
          if (!depthVisible.has(n.id)) return false;
          const role = String(n.body_json?.role ?? (n.node_type === "job" ? n.body_json?.type ?? "" : ""));
          const severity = String(n.body_json?.severity ?? "");
          const searchable =
            `${n.title} ${n.node_type} ${role} ${severity} ${n.status ?? ""} ${JSON.stringify(n.body_json ?? {})}`.toLowerCase();
          return (
            (!kindFilter || semanticNodeKind(n) === kindFilter) &&
            (!severityFilter || severity === severityFilter) &&
            (!roleFilter || role === roleFilter) &&
            (!statusFilter || n.status === statusFilter) &&
            (!needle || searchable.includes(needle))
          );
        })
        .map((n) => n.id),
    );

    const visible = new Set(matched);
    if (showContext) {
      for (const edge of data.edges) {
        if (matched.has(edge.from_node_id) || matched.has(edge.to_node_id)) {
          if (depthVisible.has(edge.from_node_id)) visible.add(edge.from_node_id);
          if (depthVisible.has(edge.to_node_id)) visible.add(edge.to_node_id);
        }
      }
      for (const root of data.nodes.filter((n) => n.node_type === "root")) {
        if (depthVisible.has(root.id)) visible.add(root.id);
      }
    }
    return { displayIds: visible, matchedCount: matched.size };
  }, [
    data,
    depthVisible,
    filterActive,
    kindFilter,
    query,
    roleFilter,
    severityFilter,
    showContext,
    statusFilter,
  ]);

  const traceIds = useMemo(() => findingTraceIds(trace, data), [data, trace]);
  const traceActive = Boolean(trace && traceIds.nodeIds.size > 0);
  const displayIds = useMemo(
    () => traceActive ? traceDisplayIds(baseDisplayIds, traceIds.nodeIds, traceMode) : baseDisplayIds,
    [baseDisplayIds, traceActive, traceIds.nodeIds, traceMode],
  );

  // 布局签名：展示节点/边集合变化 → 重算（含筛选、深度、展开收起、图生长）
  const layoutKey = useMemo(() => {
    if (!data || displayIds.size === 0) return "";
    const nids = [...displayIds].sort().join(",");
    const eids = data.edges
      .filter((e) =>
        displayIds.has(e.from_node_id) &&
        displayIds.has(e.to_node_id) &&
        (!traceActive || traceMode === "dim" || traceIds.edgeIds.has(e.id)))
      .map((e) => e.id)
      .sort()
      .join(",");
    return `${nids}|${eids}`;
  }, [data, displayIds, traceActive, traceIds.edgeIds, traceMode]);

  const layoutSubgraph = useMemo(() => {
    if (!data || !layoutKey) return { nodes: [] as CanvasNode[], edges: [] as CanvasData["edges"] };
    return {
      nodes: data.nodes.filter((n) => displayIds.has(n.id)),
      edges: data.edges.filter((e) =>
        displayIds.has(e.from_node_id) &&
        displayIds.has(e.to_node_id) &&
        (!traceActive || traceMode === "dim" || traceIds.edgeIds.has(e.id))),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 与 layoutKey 同步
  }, [data, layoutKey, traceActive, traceIds.edgeIds, traceMode]);

  // elkjs：对小型当前展示子图重算最优分层布局。大图使用服务端持久化
  // 坐标，避免一次性把数百节点/边交给 ELK 阻塞主线程。
  useEffect(() => {
    if (layoutSubgraph.nodes.length === 0 || layoutSubgraph.nodes.length > ELK_NODE_THRESHOLD) {
      setElkPos(null);
      return;
    }
    // 立刻清空 → fallback 占位，避免旧坐标留下空洞
    setElkPos(null);
    let alive = true;
    const { nodes: layoutN, edges: layoutE } = layoutSubgraph;
    elkLayout(layoutN, layoutE)
      .then((m) => {
        if (alive) setElkPos(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 layoutKey 驱动
  }, [layoutKey]);

  const fallbackPos = useMemo(
    () =>
      layoutSubgraph.nodes.length > 0 && layoutSubgraph.nodes.length <= ELK_NODE_THRESHOLD
        ? layoutNodes(layoutSubgraph.nodes, layoutSubgraph.edges)
        : null,
    [layoutSubgraph],
  );

  const handlers = useMemo(
    () => ({ expandNode, collapseNode }),
    [expandNode, collapseNode],
  );

  // 只物化当前展示子图的 flow 节点，坐标来自最新布局
  const { visibleNodes, visibleEdges } = useMemo(() => {
    if (!data || displayIds.size === 0) return { visibleNodes: [] as Node[], visibleEdges: [] as Edge[] };
    const subset: CanvasData = {
      ...data,
      nodes: data.nodes.filter((n) => displayIds.has(n.id)),
      edges: data.edges.filter(
        (e) =>
          displayIds.has(e.from_node_id) &&
          displayIds.has(e.to_node_id) &&
          (!traceActive || traceMode === "dim" || traceIds.edgeIds.has(e.id)),
      ),
    };
    const flow = toFlow(
      subset,
      elkPos,
      fallbackPos,
      depths,
      effectiveMaxDepth,
      expandedIds,
      collapsedIds,
      outgoing,
      handlers,
      traceActive ? traceIds.nodeIds : new Set<string>(),
      traceActive ? traceIds.edgeIds : new Set<string>(),
      traceMode,
    );
    return { visibleNodes: flow.nodes, visibleEdges: flow.edges };
  }, [
    collapsedIds,
    data,
    depths,
    displayIds,
    effectiveMaxDepth,
    elkPos,
    expandedIds,
    fallbackPos,
    handlers,
    outgoing,
    traceActive,
    traceIds.edgeIds,
    traceIds.nodeIds,
    traceMode,
  ]);

  const totalNodeCount = data?.nodes.length ?? 0;

  const roleOptions = useMemo(() => {
    if (!data) return [];
    return Array.from(
      new Set(
        data.nodes
          .map((n) => String(n.body_json?.role ?? (n.node_type === "job" ? n.body_json?.type ?? "" : "")))
          .filter(Boolean),
      ),
    ).sort();
  }, [data]);
  const statusOptions = useMemo(
    () => (data ? Array.from(new Set(data.nodes.map((n) => n.status ?? "").filter(Boolean))).sort() : []),
    [data],
  );

  const depthHiddenCount = useMemo(() => {
    if (!data) return 0;
    return data.nodes.length - depthVisible.size;
  }, [data, depthVisible]);

  const manualOverrideCount = expandedIds.size + collapsedIds.size;
  const isFullyOpen =
    effectiveMaxDepth >= graphMaxDepth && expandedIds.size === 0 && collapsedIds.size === 0;
  const isDefaultCollapsed =
    maxDepth === DEFAULT_MAX_DEPTH && expandedIds.size === 0 && collapsedIds.size === 0;

  // 布局签名变化或 elk 算完后 fitView
  const prevLayoutSig = useRef("");
  useEffect(() => {
    const sig = `${layoutKey}#${elkPos ? "elk" : "fb"}#${visibleNodes.length}`;
    if (visibleNodes.length > 0 && sig !== prevLayoutSig.current) {
      prevLayoutSig.current = sig;
      const t = setTimeout(
        () => rf.current?.fitView({
          padding: 0.18,
          maxZoom: 1.05,
          duration: 320,
          nodes: traceActive
            ? visibleNodes.filter((node) => traceIds.nodeIds.has(node.id))
            : undefined,
        }),
        80,
      );
      return () => clearTimeout(t);
    }
  }, [elkPos, layoutKey, traceActive, traceIds.nodeIds, visibleNodes]);

  useEffect(() => {
    if (!focusNodeId || !traceActive) return;
    const node = visibleNodes.find((item) => item.id === focusNodeId);
    if (!node) return;
    const focusKey = `${canvasId}:${focusNodeId}:${layoutKey}:${elkPos ? "elk" : "fallback"}`;
    if (focusedViewportRef.current === focusKey) return;
    focusedViewportRef.current = focusKey;
    const timer = window.setTimeout(() => {
      void rf.current?.fitView({ nodes: [node], padding: 0.7, maxZoom: 1.2, duration: 320 });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [canvasId, elkPos, focusNodeId, layoutKey, traceActive, visibleNodes]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const found = data?.nodes.find((n) => n.id === node.id) ?? null;
      setSelected(found);
      if (!found) return;
      const requestId = ++nodeRequestRef.current;
      const requestGeneration = syncGenerationRef.current;
      const requestRevision = revisionRef.current;
      void api.canvasNode(canvasId, found.id).then((result) => {
        if (!shouldApplyHydratedNode(
          requestGeneration,
          syncGenerationRef.current,
          requestRevision,
          revisionRef.current,
          requestId,
          nodeRequestRef.current,
        )) return;
        setData((before) => {
          if (!before) return before;
          if (!shouldApplyHydratedNode(
            requestGeneration,
            syncGenerationRef.current,
            requestRevision,
            revisionRef.current,
            requestId,
            nodeRequestRef.current,
          )) return before;
          const latest = before.nodes.find((item) => item.id === result.node.id);
          if (!latest) return before;
          const hydrated = mergeHydratedNodeData(latest, result.node);
          hydratedNodesRef.current.set(result.node.id, hydrated);
          const nodes = before.nodes.map((item) => item.id === result.node.id ? hydrated : item);
          const next = { ...before, nodes };
          setSelected(hydrated);
          return next;
        });
      }).catch(() => {
        // L0 summary remains usable when an optional L1 hydration races a deleted node.
      });
    },
    [canvasId, data],
  );

  if (!data && error)
    return (
      <div className="flex h-full items-center justify-center">
        <div className="rounded-[10px] border border-red-900/60 bg-red-950/40 px-6 py-4 text-sm text-red-300">
          画布加载失败：{error}
        </div>
      </div>
    );
  if (!data)
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <span className="deepsonar-live-dot inline-block size-2 rounded-full bg-acc-500" />
          正在连接调度器…
        </div>
      </div>
    );

  const depthSummary =
    depthHiddenCount > 0
      ? `深度 ≤${effectiveMaxDepth} · 藏 ${depthHiddenCount}`
      : `深度 ≤${effectiveMaxDepth}`;
  const manualOverrideHint =
    manualOverrideCount > 0 ? ` · 手调 ${manualOverrideCount}` : "";

  return (
    <div className="relative h-full w-full">
      {error && (
        <div className="absolute right-4 top-4 z-20 rounded-md border border-red-900/60 bg-red-950/80 px-3 py-2 font-mono text-[10px] text-red-300">
          同步失败：{error}
        </div>
      )}
      {traceActive && (
        <div className="surface-shell absolute left-4 top-4 z-20 max-w-[calc(100%-2rem)] rounded-[14px] p-1">
          <div className="surface-core flex flex-wrap items-center gap-2 rounded-[10px] px-3 py-2">
            <TreeStructure size={15} className="text-acc-400" />
            <span className="text-[12px] font-medium text-zinc-200">Finding 验证链路</span>
            <span className="hidden font-mono text-[10px] text-zinc-500 sm:inline">
              {traceIds.nodeIds.size} 节点 · {traceIds.edgeIds.size} 边
            </span>
            <div className="ml-auto inline-flex rounded-lg bg-black/25 p-0.5 ring-1 ring-white/[.07]">
              <button
                type="button"
                onClick={() => setTraceMode("dim")}
                aria-pressed={traceMode === "dim"}
                title="淡化非链路节点"
                className={`inline-flex size-7 items-center justify-center rounded-md ${traceMode === "dim" ? "bg-white/[.1] text-acc-300" : "text-zinc-500"}`}
              >
                <Eye size={14} />
              </button>
              <button
                type="button"
                onClick={() => setTraceMode("hide")}
                aria-pressed={traceMode === "hide"}
                title="隐藏非链路节点"
                className={`inline-flex size-7 items-center justify-center rounded-md ${traceMode === "hide" ? "bg-white/[.1] text-acc-300" : "text-zinc-500"}`}
              >
                <EyeSlash size={14} />
              </button>
            </div>
            <button
              type="button"
              onClick={onExitTrace}
              className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 ring-1 ring-white/[.08] hover:text-white"
              title="退出链路聚焦"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}
      <ReactFlow
        nodes={visibleNodes}
        edges={visibleEdges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onInit={(i) => (rf.current = i)}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.2} color="#263037" />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => {
            const canvasNode = (node.data as { canvas?: CanvasNode }).canvas;
            return canvasNode ? nodeDisplayColor(canvasNode) : "#2a2a31";
          }}
          nodeStrokeColor="#3f3f48"
          position="top-right"
          style={{ width: 140, height: 90 }}
        />
      </ReactFlow>

      <div
        className={`surface-shell absolute left-4 ${traceActive ? "top-20 hidden sm:block" : "top-4"} z-10 w-[calc(100%-2rem)] max-w-[980px] rounded-[20px] p-1 xl:w-[calc(100%-13rem)]`}
        style={{ position: "absolute" }}
      >
        {filtersOpen ? (
          <div className="surface-core rounded-[16px] px-4 py-3">
            <div className="mb-3 flex items-center gap-2 border-b border-white/[.055] pb-2.5">
              <Funnel size={15} className="text-acc-400" />
              <span className="text-[12px] font-medium text-zinc-200">筛选过程节点</span>
              <span className="font-mono text-[10px] text-zinc-600">
                {filterActive
                  ? `命中 ${matchedCount} / ${totalNodeCount}`
                  : `显示 ${visibleNodes.length} / ${totalNodeCount}`}
                {depthHiddenCount > 0 ? ` · 藏 ${depthHiddenCount}` : ""}
                {manualOverrideHint}
              </span>
              {layoutSubgraph.nodes.length > ELK_NODE_THRESHOLD && (
                <span className="font-mono text-[10px] text-amber-300">大图使用服务端坐标（跳过 ELK）</span>
              )}
              {filterActive && (
                <button
                  type="button"
                  onClick={() => {
                    setKindFilter("");
                    setSeverityFilter("");
                    setRoleFilter("");
                    setStatusFilter("");
                    setQuery("");
                  }}
                  className="ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] text-zinc-500 ring-1 ring-white/[.08] hover:text-white"
                >
                  <X size={11} /> 清除
                </button>
              )}
              <button
                type="button"
                onClick={() => setFiltersOpen(false)}
                className={`${filterActive ? "" : "ml-auto"} inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] text-zinc-500 ring-1 ring-white/[.08] hover:text-white`}
              >
                <CaretUp size={11} /> 收起
              </button>
            </div>

            {/* 深度：可手动输入上限（默认 3）；全开 / 隐藏；单节点展开在卡片上操作 */}
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-black/20 px-3 py-2.5 ring-1 ring-white/[.05]">
              <TreeStructure size={14} className="shrink-0 text-acc-400" />
              <label className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                深度 ≤
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={graphMaxDepth}
                  step={1}
                  value={maxDepth}
                  aria-label="显示深度上限"
                  title={`显示 depth ≤ N 的节点，范围 1–${graphMaxDepth}，默认 ${DEFAULT_MAX_DEPTH}`}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") return;
                    const n = Number.parseInt(raw, 10);
                    if (!Number.isFinite(n)) return;
                    // 输入时夹到 [1, graphMaxDepth]；清空后不写，避免受控框被锁死
                    setMaxDepth(Math.max(1, Math.min(graphMaxDepth, Math.trunc(n))));
                  }}
                  onBlur={() => {
                    // 失焦兜底：非法/空 → 默认 3；超出图深 → 夹到图深
                    setMaxDepth((d) => {
                      if (!Number.isFinite(d) || d < 1) return DEFAULT_MAX_DEPTH;
                      return Math.max(1, Math.min(graphMaxDepth, Math.trunc(d)));
                    });
                  }}
                  className="h-7 w-12 rounded-md bg-black/40 px-1.5 text-center font-mono text-[12px] tabular-nums text-zinc-200 ring-1 ring-white/[.1] outline-none focus:ring-acc-400/40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span className="tabular-nums text-zinc-600">/ {graphMaxDepth}</span>
              </label>
              <span className="mx-0.5 h-3 w-px bg-white/[.08]" />
              <button
                type="button"
                disabled={isFullyOpen || graphMaxDepth <= 1}
                onClick={expandAll}
                className="rounded-full px-2.5 py-1 font-mono text-[10px] text-acc-400 ring-1 ring-acc-400/25 transition-colors hover:bg-acc-400/[.08] disabled:opacity-35"
                title="展开全部深度"
              >
                全开
              </button>
              <button
                type="button"
                disabled={isDefaultCollapsed}
                onClick={collapseToDefault}
                className="rounded-full px-2.5 py-1 font-mono text-[10px] text-zinc-400 ring-1 ring-white/[.08] transition-colors hover:bg-white/[.05] hover:text-zinc-200 disabled:opacity-35"
                title={`隐藏深层：只保留前 ${DEFAULT_MAX_DEPTH} 层，并清除手动展开`}
              >
                隐藏
              </button>
              {depthHiddenCount > 0 && (
                <span className="font-mono text-[10px] text-zinc-600">藏 {depthHiddenCount} 个节点</span>
              )}
              {manualOverrideCount > 0 && (
                <span className="font-mono text-[10px] text-zinc-500">
                  手调 {manualOverrideCount}
                  {expandedIds.size > 0 ? ` · 展 ${expandedIds.size}` : ""}
                  {collapsedIds.size > 0 ? ` · 收 ${collapsedIds.size}` : ""}
                </span>
              )}
              <span className="w-full font-mono text-[9px] leading-relaxed text-zinc-600 sm:ml-auto sm:w-auto">
                默认 {DEFAULT_MAX_DEPTH}；每个有后继的节点都可「展开 / 收起」
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <label className="flex min-w-0 flex-col gap-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-zinc-600">
                节点类型
                <select
                  aria-label="节点类型"
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value)}
                  className="min-h-10 rounded-lg bg-black/30 px-3 py-2 text-[12px] normal-case text-zinc-300 ring-1 ring-white/[.08]"
                >
                  <option value="">全部类型</option>
                  {Object.entries(SEMANTIC_STYLE).map(([value, meta]) => (
                    <option key={value} value={value}>
                      {meta.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-col gap-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-zinc-600">
                Severity
                <select
                  aria-label="画布 Severity"
                  value={severityFilter}
                  onChange={(e) => setSeverityFilter(e.target.value)}
                  className="min-h-10 rounded-lg bg-black/30 px-3 py-2 text-[12px] normal-case text-zinc-300 ring-1 ring-white/[.08]"
                >
                  <option value="">全部级别</option>
                  {["critical", "high", "medium", "low"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-col gap-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-zinc-600">
                角色
                <select
                  aria-label="画布角色"
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                  className="min-h-10 rounded-lg bg-black/30 px-3 py-2 text-[12px] normal-case text-zinc-300 ring-1 ring-white/[.08]"
                >
                  <option value="">全部角色</option>
                  {roleOptions.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-col gap-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-zinc-600">
                状态
                <select
                  aria-label="画布状态"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="min-h-10 rounded-lg bg-black/30 px-3 py-2 text-[12px] normal-case text-zinc-300 ring-1 ring-white/[.08]"
                >
                  <option value="">全部状态</option>
                  {statusOptions.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-col gap-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-zinc-600">
                搜索
                <input
                  aria-label="搜索画布节点"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="标题 / 角色 / 内容"
                  className="min-h-10 rounded-lg bg-black/30 px-3 py-2 text-[12px] normal-case text-zinc-300 ring-1 ring-white/[.08] placeholder:text-zinc-700"
                />
              </label>
            </div>
            <label className="mt-3 flex w-fit items-center gap-2 font-mono text-[10px] text-zinc-500">
              <input
                type="checkbox"
                checked={showContext}
                onChange={(e) => setShowContext(e.target.checked)}
                className="size-4 accent-emerald-500"
              />{" "}
              保留命中节点的一跳上下文与任务根（仍受深度限制）
            </label>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setFiltersOpen(true)}
            className="surface-core flex w-full items-center gap-2 rounded-[16px] px-4 py-3 text-left text-[12px] text-zinc-300 hover:bg-white/[.045]"
          >
            <Funnel size={15} className="text-acc-400" />
            <span>展开筛选</span>
            {filterActive && (
              <span className="font-mono text-[10px] text-acc-400">
                命中 {matchedCount} / {totalNodeCount}
              </span>
            )}
            <span className="font-mono text-[10px] text-zinc-500">
              {depthSummary}
              {manualOverrideHint}
            </span>
            <CaretDown size={12} className="ml-auto text-zinc-600" />
          </button>
        )}
      </div>
      <Legend />
      {/*
        节点详情分流：
        - fact/finding/root/note/human/report：优先看节点 body（description/summary 等）
        - intent/job（含 hub、verify）：与「运行」页同一套 Job 过程详情
      */}
      {selected &&
        (selected.job_id && ["intent", "job"].includes(selected.node_type) ? (
          <JobDetailPanel jobId={selected.job_id} onClose={clearSelected} />
        ) : (
          <Sidebar
            node={selected}
            onClose={clearSelected}
            onTraceFinding={
              selected.node_type === "finding" && findingIdByNodeId?.get(selected.id) && onTraceFinding
                ? () => onTraceFinding(findingIdByNodeId.get(selected.id) as string)
                : undefined
            }
          />
        ))}
    </div>
  );
}
