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
  computeNodeDepths,
  computeVisibleIds,
  countCollapsedChildren,
  DEFAULT_MAX_DEPTH,
  maxDepthOf,
} from "./graph-depth";
import { elkLayout, layoutNodes, NODE_W } from "./layout";
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
  depths: Map<string, number>,
  depthVisible: Set<string>,
  expandedIds: ReadonlySet<string>,
  handlers: ExpandHandlers,
): { nodes: Node[]; edges: Edge[] } {
  // elk 分层 DAG 布局优先；未算完/失败时退回固定列占位（§8.3 Phase ③）
  const fallback = elkPos ? null : layoutNodes(data.nodes, data.edges);
  return {
    nodes: data.nodes.map((n) => {
      const depth = depths.get(n.id) ?? 1;
      const isExpanded = expandedIds.has(n.id);
      // 仅对当前深度门控下可见的节点计算折叠后继，避免给隐藏节点挂按钮
      const collapsedChildCount = depthVisible.has(n.id)
        ? countCollapsedChildren(n.id, data.edges, depthVisible)
        : 0;
      return {
        id: n.id,
        type: n.node_type,
        position: elkPos?.get(n.id) ?? fallback?.get(n.id) ?? { x: n.x, y: n.y },
        width: NODE_W,
        data: {
          canvas: n,
          depth,
          collapsedChildCount,
          isExpanded,
          onExpandNode: collapsedChildCount > 0 ? () => handlers.expandNode(n.id) : undefined,
          onCollapseNode: isExpanded ? () => handlers.collapseNode(n.id) : undefined,
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
  /** 全局深度上限；默认前 3 层。全开 = graphMax；隐藏 = 回到 3 并清空手动展开 */
  const [maxDepth, setMaxDepth] = useState(DEFAULT_MAX_DEPTH);
  /** 用户手动展开的节点 id（揭开其直接后继，可层层点开） */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
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
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [canvasId]);

  // elkjs 分层 DAG 布局：数据变更 → 异步重算（§8.3 Phase ③，图从 root 自由生长）
  useEffect(() => {
    if (!data) return;
    let alive = true;
    elkLayout(data.nodes, data.edges)
      .then((m) => alive && setElkPos(m))
      .catch(() => {}); // 失败保留固定列占位
    return () => {
      alive = false;
    };
  }, [data]);

  // 节点消失时清理 expandedIds，避免悬空 id 堆积
  useEffect(() => {
    if (!data) return;
    const alive = new Set(data.nodes.map((n) => n.id));
    setExpandedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (alive.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [data]);

  const depths = useMemo(
    () => (data ? computeNodeDepths(data.nodes, data.edges) : new Map<string, number>()),
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
  }, []);

  const collapseNode = useCallback((id: string) => {
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
  }, [graphMaxDepth]);

  /** 隐藏深层：回到默认前 3 层，并清掉所有手动展开 */
  const collapseToDefault = useCallback(() => {
    setMaxDepth(DEFAULT_MAX_DEPTH);
    setExpandedIds(new Set());
  }, []);

  const depthVisible = useMemo(() => {
    if (!data) return new Set<string>();
    return computeVisibleIds(data.nodes, data.edges, depths, effectiveMaxDepth, expandedIds);
  }, [data, depths, effectiveMaxDepth, expandedIds]);

  const handlers = useMemo(
    () => ({ expandNode, collapseNode }),
    [expandNode, collapseNode],
  );

  const { nodes, edges } = useMemo(
    () =>
      data
        ? toFlow(data, elkPos, depths, depthVisible, expandedIds, handlers)
        : { nodes: [], edges: [] },
    [data, depthVisible, depths, elkPos, expandedIds, handlers],
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

  const isFullyOpen = effectiveMaxDepth >= graphMaxDepth && expandedIds.size === 0;
  const isDefaultCollapsed =
    effectiveMaxDepth <= DEFAULT_MAX_DEPTH &&
    maxDepth <= DEFAULT_MAX_DEPTH &&
    expandedIds.size === 0;

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

  // 图生长 / 深度切换导致可见节点数变化时 fitView；普通轮询不打扰
  const nodeCount = visibleNodes.length;
  const prevCount = useRef(0);
  useEffect(() => {
    if (nodeCount > 0 && nodeCount !== prevCount.current) {
      prevCount.current = nodeCount;
      const t = setTimeout(() => rf.current?.fitView({ padding: 0.15, maxZoom: 1, duration: 300 }), 50);
      return () => clearTimeout(t);
    }
  }, [nodeCount]);

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
  const manualExpandHint = expandedIds.size > 0 ? ` · 手展 ${expandedIds.size}` : "";

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
                {manualExpandHint}
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

            {/* 深度：全开 / 隐藏（前 3 层）；单节点展开在卡片上操作 */}
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-black/20 px-3 py-2.5 ring-1 ring-white/[.05]">
              <TreeStructure size={14} className="shrink-0 text-acc-400" />
              <span className="font-mono text-[10px] text-zinc-500">深度</span>
              <span className="font-mono text-[11px] tabular-nums text-zinc-300">
                ≤ {effectiveMaxDepth}
                <span className="text-zinc-600"> / {graphMaxDepth}</span>
              </span>
              <span className="mx-0.5 h-3 w-px bg-white/[.08]" />
              <button
                type="button"
                disabled={isFullyOpen || graphMaxDepth <= DEFAULT_MAX_DEPTH}
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
                title="隐藏深层：只保留前 3 层，并清除手动展开"
              >
                隐藏
              </button>
              {depthHiddenCount > 0 && (
                <span className="font-mono text-[10px] text-zinc-600">藏 {depthHiddenCount} 个节点</span>
              )}
              {expandedIds.size > 0 && (
                <span className="font-mono text-[10px] text-zinc-500">
                  已手展 {expandedIds.size} 个节点
                </span>
              )}
              <span className="w-full font-mono text-[9px] leading-relaxed text-zinc-600 sm:w-auto sm:ml-auto">
                默认前 3 层；点节点卡片「展开」可只打开该节点后继
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
              {manualExpandHint}
            </span>
            <CaretDown size={12} className="ml-auto text-zinc-600" />
          </button>
        )}
      </div>
      <Legend />
      {selected && <Sidebar node={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
