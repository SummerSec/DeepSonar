import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { CanvasNode } from "./api";

export type DFHNodeData = { canvas: CanvasNode };
export type DFHNode = Node<DFHNodeData, string>;

const STATUS_COLOR: Record<string, string> = {
  active: "#3a76f0",
  running: "#3a76f0",
  succeeded: "#22a06b",
  confirmed: "#22a06b",
  open: "#e2a03f",
  pending: "#95999f",
  failed: "#e5484d",
  timeout: "#e5484d",
  orphan: "#e5484d",
  cancelled: "#95999f",
  false_positive: "#95999f",
  needs_human: "#e2a03f",
};

const SEVERITY_COLOR: Record<string, string> = {
  low: "#95999f",
  medium: "#e2a03f",
  high: "#e5484d",
  critical: "#b3247a",
};

const TYPE_LABEL: Record<string, string> = {
  root: "项目根",
  job: "运行",
  finding: "发现",
  note: "说明",
  human: "需人工",
};

function Pill({ text, color }: { text: string; color: string }) {
  return (
    <span className="pill" style={{ background: color }}>
      {text}
    </span>
  );
}

function BaseNode({ data, selected }: NodeProps<DFHNode>) {
  const n = data.canvas;
  const statusColor = STATUS_COLOR[n.status ?? ""] ?? "#95999f";
  const severity = (n.body_json?.severity as string) ?? null;
  return (
    <div className={`dfh-node dfh-node-${n.node_type} ${selected ? "selected" : ""}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="dfh-node-header" style={{ borderLeftColor: statusColor }}>
        <span className="dfh-node-type">{TYPE_LABEL[n.node_type] ?? n.node_type}</span>
        {n.status && <Pill text={n.status} color={statusColor} />}
        {severity && <Pill text={severity} color={SEVERITY_COLOR[severity] ?? "#95999f"} />}
      </div>
      <div className="dfh-node-title">{n.title}</div>
      {n.node_type === "finding" && Boolean(n.body_json?.location) && (
        <div className="dfh-node-sub">{String(n.body_json.location)}</div>
      )}
      {n.node_type === "job" && Boolean(n.body_json?.last_progress) && (
        <div className="dfh-node-sub">
          {String((n.body_json.last_progress as { message?: string })?.message ?? "")}
        </div>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

// 每种 node_type 一个组件（§3.2 固定节点类型）
export const nodeTypes = {
  root: BaseNode,
  job: BaseNode,
  finding: BaseNode,
  note: BaseNode,
  human: BaseNode,
};
