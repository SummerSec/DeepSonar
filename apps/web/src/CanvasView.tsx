import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, type CanvasData, type CanvasNode } from "./api";
import { layoutNodes } from "./layout";
import { nodeTypes } from "./nodes";
import { Sidebar } from "./Sidebar";

/** 边语义色（图例与之一致，不产生文字 label） */
const EDGE_STYLE: Record<string, { stroke: string; animated?: boolean }> = {
  child: { stroke: "#3f3f48" },
  produces: { stroke: "#d97706", animated: true },
  verifies: { stroke: "#10b981" },
  next: { stroke: "#38bdf8" },
  from: { stroke: "#a78bfa" }, // 事实 → 意图（Cairn Intent.from）
  to: { stroke: "#2dd4bf" }, // 意图 → 事实（Cairn Intent.to）
};

const NODE_W = 280;

function toFlow(data: CanvasData): { nodes: Node[]; edges: Edge[] } {
  const pos = layoutNodes(data.nodes, data.edges);
  return {
    nodes: data.nodes.map((n) => ({
      id: n.id,
      type: n.node_type,
      position: pos.get(n.id) ?? { x: n.x, y: n.y },
      width: NODE_W,
      data: { canvas: n },
      draggable: false,
      connectable: false,
    })),
    edges: data.edges.map((e) => {
      const st = EDGE_STYLE[e.edge_type] ?? { stroke: "#3f3f48" };
      return {
        id: e.id,
        source: e.from_node_id,
        target: e.to_node_id,
        type: "smoothstep",
        animated: st.animated ?? false,
        style: { stroke: st.stroke, strokeWidth: 1.5, opacity: 0.85 },
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
    { color: EDGE_STYLE.from.stroke, label: "from 引用" },
    { color: EDGE_STYLE.to.stroke, label: "to 结论" },
    { color: EDGE_STYLE.child.stroke, label: "child 包含" },
  ];
  return (
    <div className="absolute bottom-4 left-4 z-10 flex items-center gap-4 rounded-lg border border-ink-700 bg-ink-900/90 px-3 py-2 backdrop-blur">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: it.color }} />
          <span className="font-mono text-[12px] text-zinc-400">{it.label}</span>
        </span>
      ))}
    </div>
  );
}

export function CanvasView({ canvasId }: { canvasId: string }) {
  const [data, setData] = useState<CanvasData | null>(null);
  const [selected, setSelected] = useState<CanvasNode | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [canvasId]);

  const { nodes, edges } = useMemo(() => (data ? toFlow(data) : { nodes: [], edges: [] }), [data]);

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
          <span className="dfh-live-dot inline-block size-2 rounded-full bg-acc-500" />
          正在连接调度器…
        </div>
      </div>
    );

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: false }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.5} color="#222228" />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap
          pannable
          zoomable
          nodeColor="#2a2a31"
          nodeStrokeColor="#3f3f48"
          position="top-right"
          style={{ width: 140, height: 90 }}
        />
      </ReactFlow>
      <Legend />
      {selected && <Sidebar node={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
