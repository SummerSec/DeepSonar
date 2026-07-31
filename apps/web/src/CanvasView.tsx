import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, type CanvasData, type CanvasNode } from "./api";
import { nodeTypes } from "./nodes";
import { Sidebar } from "./Sidebar";

const EDGE_STYLE: Record<string, { stroke: string; animated?: boolean }> = {
  child: { stroke: "#95999f" },
  produces: { stroke: "#e2a03f", animated: true },
  verifies: { stroke: "#22a06b" },
  next: { stroke: "#3a76f0" },
};

function toFlow(data: CanvasData): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: data.nodes.map((n) => ({
      id: n.id,
      type: n.node_type,
      position: { x: n.x, y: n.y },
      width: n.w,
      height: n.h,
      data: { canvas: n },
      draggable: false,
      connectable: false,
    })),
    edges: data.edges.map((e) => ({
      id: e.id,
      source: e.from_node_id,
      target: e.to_node_id,
      label: e.edge_type,
      animated: EDGE_STYLE[e.edge_type]?.animated ?? false,
      style: { stroke: EDGE_STYLE[e.edge_type]?.stroke ?? "#95999f", strokeWidth: 2 },
      labelStyle: { fill: "#666", fontSize: 11 },
    })),
  };
}

export function CanvasView({ projectId }: { projectId: string }) {
  const [data, setData] = useState<CanvasData | null>(null);
  const [selected, setSelected] = useState<CanvasNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  // §6.4：MVP 轮询刷新（5s）；WS 二期
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .canvas(projectId)
        .then((d) => alive && (setData(d), setError(null)))
        .catch((e) => alive && setError(String(e)));
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectId]);

  const { nodes, edges } = useMemo(() => (data ? toFlow(data) : { nodes: [], edges: [] }), [data]);

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const found = data?.nodes.find((n) => n.id === node.id) ?? null;
      setSelected(found);
    },
    [data],
  );

  if (error) return <div className="canvas-error">画布加载失败：{error}</div>;
  if (!data) return <div className="canvas-loading">加载中…</div>;

  return (
    <div className="canvas-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
      {selected && <Sidebar node={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
