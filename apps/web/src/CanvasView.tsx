import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CaretDown, CaretUp, Funnel, TreeStructure, X } from "@phosphor-icons/react";
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
import { api, type CanvasData, type CanvasNode } from "./api";
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
import { nodeTypes, semanticNodeKind, SEMANTIC_STYLE, type SemanticNodeKind } from "./nodes";
import { Sidebar } from "./Sidebar";

/** 边语义色与流速；颜色表达关系，动画表达方向。 */
const EDGE_STYLE: Record<string, { stroke: string; speed: string }> = {
  child: { stroke: "#59656b", speed: "4.8s" },
  produces: { stroke: "#91a0a7", speed: "2.8s" },
  verifies: { stroke: "#6fbbe8", speed: "1.8s" },
  next: { stroke: "#748087", speed: "2.2s" },
  from: { stroke: "#657279", speed: "3.2s" }, // 事实 → 意图（Cairn Intent.from）
  to: { stroke: "var(--color-acc-400)", speed: "2.5s" }, // 意图 → 事实（Cairn Intent.to）
};

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
): { nodes: Node[]; edges: Edge[] } {
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
      };
    }),
    edges: data.edges.map((e) => {
      const st = EDGE_STYLE[e.edge_type] ?? EDGE_STYLE.child;
      return {
        id: e.id,
        source: e.from_node_id,
        target: e.to_node_id,
        type: "smoothstep",
        animated: true,
        className: `deepsonar-edge deepsonar-edge-${e.edge_type}`,
        style: {
          stroke: st.stroke,
          strokeWidth: 1.8,
          opacity: 0.9,
          "--deepsonar-edge-speed": st.speed,
        } as CSSProperties,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: st.stroke },
      };
    }),
  };
}

/** 边语义图例（替代旧的边上文字 label） */
function Legend() {
  const items = [
    { color: EDGE_STYLE.produces.stroke, label: "produces 产出" },
    { color: EDGE_STYLE.verifies.stroke, label: "verifies 验证" },
    { color: EDGE_STYLE.next.stroke, label: "next 决策" },
    { color: EDGE_STYLE.from.stroke, label: "from 引用" },
    { color: EDGE_STYLE.to.stroke, label: "to 结论" },
    { color: EDGE_STYLE.child.stroke, label: "child 包含" },
  ];
  return (
    <div className="surface-shell absolute bottom-3 left-3 z-10 max-w-[calc(100%-1.5rem)] rounded-[17px] p-1" style={{ position: "absolute" }}>
      <div className="surface-core flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[13px] px-3 py-2">
        {(["intent", "hub", "finding", "subagent", "verify"] as SemanticNodeKind[]).map((kind) => (
          <span key={kind} className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full" style={{ background: SEMANTIC_STYLE[kind].color }} />
            <span className="font-mono text-[9px] text-zinc-500">{SEMANTIC_STYLE[kind].label}</span>
          </span>
        ))}
        <span className="mx-1 h-3 w-px bg-white/[.08]" />
        {items.map((it) => (
          <span key={it.label} className="flex items-center gap-1.5">
            <span className="inline-block h-px w-3 rounded" style={{ background: it.color }} />
            <span className="font-mono text-[9px] text-zinc-500">{it.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function CanvasView({ canvasId }: { canvasId: string }) {
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
  const [filtersOpen, setFiltersOpen] = useState(true);
  /** 全局深度上限；默认前 3 层。全开 = graphMax；隐藏 = 回到 3 并清空手动覆盖 */
  const [maxDepth, setMaxDepth] = useState(DEFAULT_MAX_DEPTH);
  /** 用户强制展开（覆盖默认 depth 折叠） */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  /** 用户强制收起（覆盖默认 depth 展开） */
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const rf = useRef<ReactFlowInstance | null>(null);

  // §6.4：MVP 轮询刷新（5s）；WS 二期
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .canvas(canvasId)
        .then((d) => alive && (setData(d), setError(null)))
        .catch((e) => alive && setError(String(e)));
    setData(null);
    setSelected(null);
    setElkPos(null);
    setMaxDepth(DEFAULT_MAX_DEPTH);
    setExpandedIds(new Set());
    setCollapsedIds(new Set());
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [canvasId]);

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

  // 稳定签名：仅当可见节点/边集合变化时重算布局（轮询同集合不抖动）
  const visibleLayoutKey = useMemo(() => {
    if (!data) return "";
    const nids = data.nodes
      .filter((n) => depthVisible.has(n.id))
      .map((n) => n.id)
      .sort()
      .join(",");
    const eids = data.edges
      .filter((e) => depthVisible.has(e.from_node_id) && depthVisible.has(e.to_node_id))
      .map((e) => e.id)
      .sort()
      .join(",");
    return `${nids}|${eids}`;
  }, [data, depthVisible]);

  /** 可见子图：展开/收起或改深度后只对这部分做布局，避免留下空洞 */
  const visibleSubgraph = useMemo(() => {
    if (!data || !visibleLayoutKey) return { nodes: [] as CanvasNode[], edges: [] as CanvasData["edges"] };
    const nodes = data.nodes.filter((n) => depthVisible.has(n.id));
    const edges = data.edges.filter(
      (e) => depthVisible.has(e.from_node_id) && depthVisible.has(e.to_node_id),
    );
    return { nodes, edges };
    // depthVisible 与 key 同步变化；用 key 保证同集合时引用稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, visibleLayoutKey]);

  // elkjs：对当前可见子图重算布局（展开/收起/深度调整时自适应）
  // 仅当可见集合签名变化时重跑；轮询刷新同集合不重排，避免布局抖动
  useEffect(() => {
    if (visibleSubgraph.nodes.length === 0) {
      setElkPos(null);
      return;
    }
    // 先清空，立刻走 fallback 可见子图排布，避免沿用上一帧全图坐标留下空洞
    setElkPos(null);
    let alive = true;
    const { nodes: layoutN, edges: layoutE } = visibleSubgraph;
    elkLayout(layoutN, layoutE)
      .then((m) => {
        if (alive) setElkPos(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意只跟 visibleLayoutKey
  }, [visibleLayoutKey]);

  const fallbackPos = useMemo(
    () =>
      visibleSubgraph.nodes.length > 0
        ? layoutNodes(visibleSubgraph.nodes, visibleSubgraph.edges)
        : null,
    [visibleSubgraph],
  );

  const handlers = useMemo(
    () => ({ expandNode, collapseNode }),
    [expandNode, collapseNode],
  );

  const { nodes, edges } = useMemo(
    () =>
      data
        ? toFlow(
            data,
            elkPos,
            fallbackPos,
            depths,
            effectiveMaxDepth,
            expandedIds,
            collapsedIds,
            outgoing,
            handlers,
          )
        : { nodes: [], edges: [] },
    [
      collapsedIds,
      data,
      depths,
      effectiveMaxDepth,
      elkPos,
      expandedIds,
      fallbackPos,
      handlers,
      outgoing,
    ],
  );

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
  const filterActive = Boolean(kindFilter || severityFilter || roleFilter || statusFilter || query.trim());

  const depthHiddenCount = useMemo(() => {
    if (!data) return 0;
    return data.nodes.length - depthVisible.size;
  }, [data, depthVisible]);

  const manualOverrideCount = expandedIds.size + collapsedIds.size;
  const isFullyOpen =
    effectiveMaxDepth >= graphMaxDepth && expandedIds.size === 0 && collapsedIds.size === 0;
  const isDefaultCollapsed =
    maxDepth === DEFAULT_MAX_DEPTH && expandedIds.size === 0 && collapsedIds.size === 0;

  const { visibleNodes, visibleEdges, matchedCount } = useMemo(() => {
    if (!data) return { visibleNodes: nodes, visibleEdges: edges, matchedCount: 0 };

    if (!filterActive) {
      return {
        visibleNodes: nodes.filter((n) => depthVisible.has(n.id)),
        visibleEdges: edges.filter((e) => depthVisible.has(e.source) && depthVisible.has(e.target)),
        matchedCount: depthVisible.size,
      };
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

    return {
      visibleNodes: nodes.filter((n) => visible.has(n.id)),
      visibleEdges: edges.filter((e) => visible.has(e.source) && visible.has(e.target)),
      matchedCount: matched.size,
    };
  }, [
    data,
    depthVisible,
    edges,
    filterActive,
    kindFilter,
    nodes,
    query,
    roleFilter,
    severityFilter,
    showContext,
    statusFilter,
  ]);

  // 可见集合或布局重算后 fitView，让展开/收起后的自适应排布落入视野
  const nodeCount = visibleNodes.length;
  const prevLayoutSig = useRef("");
  useEffect(() => {
    const sig = `${visibleLayoutKey}#${elkPos ? "elk" : "fb"}#${nodeCount}`;
    if (nodeCount > 0 && sig !== prevLayoutSig.current) {
      prevLayoutSig.current = sig;
      const t = setTimeout(() => rf.current?.fitView({ padding: 0.15, maxZoom: 1, duration: 280 }), 60);
      return () => clearTimeout(t);
    }
  }, [elkPos, nodeCount, visibleLayoutKey]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const found = data?.nodes.find((n) => n.id === node.id) ?? null;
      setSelected(found);
    },
    [data],
  );

  if (error)
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
            return canvasNode ? SEMANTIC_STYLE[semanticNodeKind(canvasNode)].color : "#2a2a31";
          }}
          nodeStrokeColor="#3f3f48"
          position="top-right"
          style={{ width: 140, height: 90 }}
        />
      </ReactFlow>

      <div
        className="surface-shell absolute left-4 top-4 z-10 w-[calc(100%-2rem)] max-w-[980px] rounded-[20px] p-1 xl:w-[calc(100%-13rem)]"
        style={{ position: "absolute" }}
      >
        {filtersOpen ? (
          <div className="surface-core rounded-[16px] px-4 py-3">
            <div className="mb-3 flex items-center gap-2 border-b border-white/[.055] pb-2.5">
              <Funnel size={15} className="text-acc-400" />
              <span className="text-[12px] font-medium text-zinc-200">筛选过程节点</span>
              <span className="font-mono text-[10px] text-zinc-600">
                {filterActive
                  ? `命中 ${matchedCount} / ${nodes.length}`
                  : `显示 ${visibleNodes.length} / ${nodes.length}`}
                {depthHiddenCount > 0 ? ` · 藏 ${depthHiddenCount}` : ""}
                {manualOverrideHint}
              </span>
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
                命中 {matchedCount} / {nodes.length}
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
      {/* 关联 job 的节点：与「运行」页同一套详情（执行过程 / 筛选 / 事件 / session） */}
      {selected?.job_id ? (
        <JobDetailPanel jobId={selected.job_id} onClose={() => setSelected(null)} />
      ) : selected ? (
        <Sidebar node={selected} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
}
