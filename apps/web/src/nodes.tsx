import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { CanvasNode } from "./api";

export type DFHNodeData = { canvas: CanvasNode };
export type DFHNode = Node<DFHNodeData, string>;

/** 语义状态色（与侧栏/图例共用同一套） */
export const STATUS_COLOR: Record<string, string> = {
  active: "#38bdf8",
  running: "#38bdf8",
  claimed: "#38bdf8",
  provisioning: "#38bdf8",
  succeeded: "#34d399",
  confirmed: "#34d399",
  pending: "#71717a",
  open: "#fbbf24",
  needs_human: "#fbbf24",
  waiting_human: "#fbbf24",
  failed: "#f87171",
  timeout: "#f87171",
  orphan: "#f87171",
  cancelled: "#71717a",
  false_positive: "#71717a",
};

export const SEVERITY_COLOR: Record<string, string> = {
  low: "#71717a",
  medium: "#fbbf24",
  high: "#f97316",
  critical: "#f43f5e",
};

const TYPE_LABEL: Record<string, string> = {
  root: "任务",
  job: "运行",
  finding: "发现",
  note: "说明",
  human: "需人工",
  intent: "意图",
  fact: "事实",
};

/** 运行中状态：状态点带呼吸脉冲 */
const LIVE_STATUS = new Set(["running", "claimed", "provisioning", "active"]);

function BaseNode({ data }: NodeProps<DFHNode>) {
  const n = data.canvas;
  const status = n.status ?? "";
  const statusColor = STATUS_COLOR[status] ?? "#71717a";
  const severity = (n.body_json?.severity as string) ?? null;
  const sevColor = severity ? (SEVERITY_COLOR[severity] ?? "#71717a") : null;
  const jobType = (n.body_json?.type as string) ?? null;
  const role = (n.body_json?.role as string) ?? null;
  const location = (n.body_json?.location as string) ?? null;
  // 「当前动作」（工具调用聚合，executor 直接写显示态）优先于 job 类型展示
  const lastAction = (n.body_json?.last_progress as { message?: string } | undefined)?.message ?? null;
  // 任务 root：显示目标（module_path > repo_path > type）
  const target = n.body_json?.target as Record<string, unknown> | undefined;
  const targetText = target
    ? String(target.module_path ?? target.repo_path ?? target.type ?? "")
    : null;

  return (
    <div className="dfh-node w-full rounded-[10px] border border-ink-700 bg-ink-850/95 px-3.5 py-3">
      <Handle type="target" position={Position.Left} isConnectable={false} />

      {/* 头部：类型 + 状态 */}
      <div className="flex items-center gap-2">
        <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-zinc-500">
          {TYPE_LABEL[n.node_type] ?? n.node_type}
        </span>
        {status && (
          <span className="ml-auto flex items-center gap-1.5">
            <span
              className={`inline-block size-2 rounded-full ${LIVE_STATUS.has(status) ? "dfh-live-dot" : ""}`}
              style={{ background: statusColor }}
            />
            <span className="font-mono text-[12px]" style={{ color: statusColor }}>
              {status}
            </span>
          </span>
        )}
      </div>

      {/* 标题：最多两行 */}
      <div
        className="mt-1.5 text-[15px] font-medium leading-snug text-zinc-100"
        style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
      >
        {n.title}
      </div>

      {/* 底部元信息：位置 / job 类型 / severity */}
      <div className="mt-1.5 flex items-center gap-2">
        {location && (
          <span className="truncate font-mono text-[13px] text-zinc-500">{location}</span>
        )}
        {!location && (
          <span className="truncate font-mono text-[13px] text-zinc-500">
            {lastAction ?? role ?? targetText ?? jobType ?? ""}
          </span>
        )}
        {severity && (
          <span
            className="ml-auto font-mono text-[12px] font-medium uppercase tracking-wider"
            style={{ color: sevColor ?? undefined }}
          >
            {severity}
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

// 每种 node_type 一个组件（§3.2 固定节点类型 + §8.3 图语义节点）
export const nodeTypes = {
  root: BaseNode,
  job: BaseNode,
  finding: BaseNode,
  note: BaseNode,
  human: BaseNode,
  intent: BaseNode,
  fact: BaseNode,
};
