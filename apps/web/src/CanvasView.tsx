import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CaretDown, CaretUp, Funnel, X } from "@phosphor-icons/react";
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

function toFlow(
  data: CanvasData,
  elkPos: Map<string, { x: number; y: number }> | null,
): { nodes: Node[]; edges: Edge[] } {
  // elk 分层 DAG 布局优先；未算完/失败时退回固定列占位（§8.3 Phase ③）
  const fallback = elkPos ? null : layoutNodes(data.nodes, data.edges);
  return {
    nodes: data.nodes.map((n) => ({
      id: n.id,
      type: n.node_type,
      position: elkPos?.get(n.id) ?? fallback?.get(n.id) ?? { x: n.x, y: n.y },
      width: NODE_W,
      data: { canvas: n },
      draggable: false,
      connectable: false,
    })),
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

  const { nodes, edges } = useMemo(
    () => (data ? toFlow(data, elkPos) : { nodes: [], edges: [] }),
    [data, elkPos],
  );

  const roleOptions = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.nodes.map((n) => String(n.body_json?.role ?? (n.node_type === "job" ? n.body_json?.type ?? "" : ""))).filter(Boolean))).sort();
  }, [data]);
  const statusOptions = useMemo(() => data ? Array.from(new Set(data.nodes.map((n) => n.status ?? "").filter(Boolean))).sort() : [], [data]);
  const filterActive = Boolean(kindFilter || severityFilter || roleFilter || statusFilter || query.trim());
  const { visibleNodes, visibleEdges, matchedCount } = useMemo(() => {
    if (!data || !filterActive) return { visibleNodes: nodes, visibleEdges: edges, matchedCount: nodes.length };
    const needle = query.trim().toLowerCase();
    const matched = new Set(data.nodes.filter((n) => {
      const role = String(n.body_json?.role ?? (n.node_type === "job" ? n.body_json?.type ?? "" : ""));
      const severity = String(n.body_json?.severity ?? "");
      const searchable = `${n.title} ${n.node_type} ${role} ${severity} ${n.status ?? ""} ${JSON.stringify(n.body_json ?? {})}`.toLowerCase();
      return (!kindFilter || semanticNodeKind(n) === kindFilter) && (!severityFilter || severity === severityFilter) && (!roleFilter || role === roleFilter) && (!statusFilter || n.status === statusFilter) && (!needle || searchable.includes(needle));
    }).map((n) => n.id));
    const visible = new Set(matched);
    if (showContext) {
      for (const edge of data.edges) {
        if (matched.has(edge.from_node_id) || matched.has(edge.to_node_id)) {
          visible.add(edge.from_node_id);
          visible.add(edge.to_node_id);
        }
      }
      for (const root of data.nodes.filter((n) => n.node_type === "root")) visible.add(root.id);
    }
    return {
      visibleNodes: nodes.filter((n) => visible.has(n.id)),
      visibleEdges: edges.filter((e) => visible.has(e.source) && visible.has(e.target)),
      matchedCount: matched.size,
    };
  }, [data, edges, filterActive, kindFilter, nodes, query, roleFilter, severityFilter, showContext, statusFilter]);

  // 图生长（节点数变化）时自动 fitView；普通轮询不打扰用户视角
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
      <div className="surface-shell absolute left-4 top-4 z-10 w-[calc(100%-2rem)] max-w-[980px] rounded-[20px] p-1 xl:w-[calc(100%-13rem)]" style={{ position: "absolute" }}>
        {filtersOpen ? (
          <div className="surface-core rounded-[16px] px-4 py-3">
            <div className="mb-3 flex items-center gap-2 border-b border-white/[.055] pb-2.5">
              <Funnel size={15} className="text-acc-400" />
              <span className="text-[12px] font-medium text-zinc-200">筛选过程节点</span>
              <span className="font-mono text-[10px] text-zinc-600">{filterActive ? `命中 ${matchedCount} / ${nodes.length}` : `${nodes.length} 个节点`}</span>
              {filterActive && <button type="button" onClick={() => { setKindFilter(""); setSeverityFilter(""); setRoleFilter(""); setStatusFilter(""); setQuery(""); }} className="ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] text-zinc-500 ring-1 ring-white/[.08] hover:text-white"><X size={11} /> 清除</button>}
              <button type="button" onClick={() => setFiltersOpen(false)} className={`${filterActive ? "" : "ml-auto"} inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] text-zinc-500 ring-1 ring-white/[.08] hover:text-white`}><CaretUp size={11} /> 收起</button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <label className="flex min-w-0 flex-col gap-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-zinc-600">节点类型<select aria-label="节点类型" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className="min-h-10 rounded-lg bg-black/30 px-3 py-2 text-[12px] normal-case text-zinc-300 ring-1 ring-white/[.08]"><option value="">全部类型</option>{Object.entries(SEMANTIC_STYLE).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}</select></label>
              <label className="flex min-w-0 flex-col gap-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-zinc-600">Severity<select aria-label="画布 Severity" value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)} className="min-h-10 rounded-lg bg-black/30 px-3 py-2 text-[12px] normal-case text-zinc-300 ring-1 ring-white/[.08]"><option value="">全部级别</option>{["critical", "high", "medium", "low"].map((v) => <option key={v}>{v}</option>)}</select></label>
              <label className="flex min-w-0 flex-col gap-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-zinc-600">角色<select aria-label="画布角色" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="min-h-10 rounded-lg bg-black/30 px-3 py-2 text-[12px] normal-case text-zinc-300 ring-1 ring-white/[.08]"><option value="">全部角色</option>{roleOptions.map((v) => <option key={v}>{v}</option>)}</select></label>
              <label className="flex min-w-0 flex-col gap-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-zinc-600">状态<select aria-label="画布状态" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="min-h-10 rounded-lg bg-black/30 px-3 py-2 text-[12px] normal-case text-zinc-300 ring-1 ring-white/[.08]"><option value="">全部状态</option>{statusOptions.map((v) => <option key={v}>{v}</option>)}</select></label>
              <label className="flex min-w-0 flex-col gap-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-zinc-600">搜索<input aria-label="搜索画布节点" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="标题 / 角色 / 内容" className="min-h-10 rounded-lg bg-black/30 px-3 py-2 text-[12px] normal-case text-zinc-300 ring-1 ring-white/[.08] placeholder:text-zinc-700" /></label>
            </div>
            <label className="mt-3 flex w-fit items-center gap-2 font-mono text-[10px] text-zinc-500"><input type="checkbox" checked={showContext} onChange={(e) => setShowContext(e.target.checked)} className="size-4 accent-emerald-500" /> 保留命中节点的一跳上下文与任务根</label>
          </div>
        ) : (
          <button type="button" onClick={() => setFiltersOpen(true)} className="surface-core flex w-full items-center gap-2 rounded-[16px] px-4 py-3 text-left text-[12px] text-zinc-300 hover:bg-white/[.045]"><Funnel size={15} className="text-acc-400" /><span>展开筛选</span>{filterActive && <span className="font-mono text-[10px] text-acc-400">命中 {matchedCount} / {nodes.length}</span>}<CaretDown size={12} className="ml-auto text-zinc-600" /></button>
        )}
      </div>
      <Legend />
      {selected && <Sidebar node={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
