import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Brain, Bug, CheckCircle, Compass, Database, FileText, FileX, Note, Robot, SealCheck, UserCircle } from "@phosphor-icons/react";
import type { CanvasNode } from "./api";
import { SEVERITY_COLOR, STATUS_COLOR, VERIFICATION_META } from "./semantics";

export type DEEPSONARNodeData = { canvas: CanvasNode };
export type DEEPSONARNode = Node<DEEPSONARNodeData, string>;
export type SemanticNodeKind = "task" | "intent" | "hub" | "finding" | "subagent" | "verify" | "fact" | "report" | "human" | "note";

export function semanticNodeKind(n: CanvasNode): SemanticNodeKind {
  const jobType = String(n.body_json?.type ?? "");
  if (n.node_type === "root") return "task";
  if (n.node_type === "intent") return "intent";
  if (n.node_type === "finding") return "finding";
  if (n.node_type === "fact") return "fact";
  if (n.node_type === "report") return "report";
  if (n.node_type === "human") return "human";
  if (n.node_type === "note") return "note";
  if (jobType === "hub_reason") return "hub";
  if (jobType === "verify_finding" || jobType === "verify") return "verify";
  return "subagent";
}

export const SEMANTIC_STYLE: Record<SemanticNodeKind, { label: string; color: string }> = {
  task: { label: "任务", color: "#2dd4bf" },
  intent: { label: "意图", color: "#38bdf8" },
  hub: { label: "中枢", color: "#a78bfa" },
  finding: { label: "发现", color: "#fb7185" },
  subagent: { label: "子 Agent", color: "#f59e0b" },
  verify: { label: "验证 Agent", color: "#34d399" },
  fact: { label: "事实", color: "#22d3ee" },
  report: { label: "报告", color: "#818cf8" },
  human: { label: "人工", color: "#f97316" },
  note: { label: "说明", color: "#94a3b8" },
};

/** 语义状态色（与侧栏/图例共用同一套） */

const TYPE_LABEL: Record<string, string> = {
  root: "任务",
  job: "运行",
  finding: "发现",
  note: "说明",
  human: "需人工",
  intent: "意图",
  fact: "事实",
  report: "报告",
};

/** fact 节点验证状态徽标（独立于执行状态 status） */

/** 运行中状态：状态点带呼吸脉冲 */
const LIVE_STATUS = new Set(["running", "claimed", "provisioning", "active", "generating"]);

function BaseNode({ data }: NodeProps<DEEPSONARNode>) {
  const n = data.canvas;
  const semantic = semanticNodeKind(n);
  const semanticStyle = SEMANTIC_STYLE[semantic];
  const status = n.status ?? "";
  const statusColor = STATUS_COLOR[status] ?? "#71717a";
  const severity = (n.body_json?.severity as string) ?? null;
  const sevColor = severity ? (SEVERITY_COLOR[severity] ?? "#71717a") : null;
  const jobType = (n.body_json?.type as string) ?? null;
  const role = (n.body_json?.role as string) ?? null;
  const location = (n.body_json?.location as string) ?? null;
  // 「当前动作」（工具调用聚合，executor 直接写显示态）优先于 job 类型展示
  const lastAction = (n.body_json?.last_progress as { message?: string } | undefined)?.message ?? null;
  // 任务 root：显示自然语言内容
  const target = n.body_json?.target as Record<string, unknown> | undefined;
  const targetText = target
    ? String(target.content ?? "")
    : null;

  // 类型标签：hub job 单独标识为「中枢」
  const typeLabel = semanticStyle.label ?? TYPE_LABEL[n.node_type] ?? n.node_type;

  const semanticIcon =
    semantic === "task" ? <Compass size={15} /> :
    semantic === "intent" ? <Compass size={15} /> :
    semantic === "hub" ? <Brain size={15} weight="fill" /> :
    semantic === "finding" ? <Bug size={15} weight="fill" /> :
    semantic === "subagent" ? <Robot size={15} /> :
    semantic === "verify" ? <SealCheck size={15} /> :
    semantic === "fact" ? <Database size={15} /> :
    semantic === "human" ? <UserCircle size={15} /> :
    semantic === "note" ? <Note size={15} /> : null;

  // 报告节点：图标随状态变化（生成中 / 成功 / 失败）
  const reportIcon =
    n.node_type === "report" ? (
      status === "succeeded" ? (
        <CheckCircle size={14} className="text-emerald-400" />
      ) : status === "failed" ? (
        <FileX size={14} className="text-red-400" />
      ) : (
        <FileText size={14} className="text-sky-400" />
      )
    ) : null;

  // fact 节点：验证状态徽标（独立于执行状态）
  const verification =
    n.node_type === "fact" && n.verification_status
      ? (VERIFICATION_META[n.verification_status] ?? {
          label: n.verification_status,
          color: "#71717a",
        })
      : null;

  // 报告节点描边：成功=实线结论，失败=红，生成中=呼吸
  const reportBorder =
    n.node_type === "report"
      ? status === "succeeded"
        ? "border-emerald-800/80"
        : status === "failed"
          ? "border-red-900/70"
          : "border-sky-500/70 shadow-[0_0_14px_rgba(56,189,248,0.18)]"
      : "";

  // intent 三态样式（§8.3）：pending=虚线未认领 / running=呼吸描边 / succeeded=实线已结论
  const intentBorder =
    n.node_type === "intent"
      ? status === "pending"
        ? "border-dashed border-zinc-600"
        : LIVE_STATUS.has(status)
          ? "border-sky-500/70 shadow-[0_0_14px_rgba(56,189,248,0.18)]"
          : status === "succeeded"
            ? "border-emerald-800/80"
            : "border-red-900/70"
      : "";

  return (
    <div className={`deepsonar-node w-full rounded-[18px] p-1 ring-1 ${intentBorder} ${reportBorder}`} style={{ background: `color-mix(in srgb, ${semanticStyle.color} 13%, transparent)`, boxShadow: `0 0 0 1px color-mix(in srgb, ${semanticStyle.color} 32%, transparent)` }}>
      <Handle type="target" position={Position.Left} isConnectable={false} />

      <div className="rounded-[14px] bg-[#12171a] px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,.045)]">

      {/* 头部：类型 + 状态 */}
      <div className="flex items-center gap-2">
        {reportIcon}
        {!reportIcon && <span style={{ color: semanticStyle.color }}>{semanticIcon}</span>}
        <span className="font-mono text-[12px] uppercase tracking-[0.14em]" style={{ color: semanticStyle.color }}>
          {typeLabel}
        </span>
        {verification && (
          <span
            className="rounded border px-1 font-mono text-[11px]"
            style={{ color: verification.color, borderColor: `${verification.color}66` }}
          >
            {verification.label}
          </span>
        )}
        {status && (
          <span className="ml-auto flex items-center gap-1.5">
            <span
              className={`inline-block size-2 rounded-full ${LIVE_STATUS.has(status) ? "deepsonar-live-dot" : ""}`}
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

      </div>

      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

// 每种 node_type 一个组件（§3.2 固定节点类型 + §8.3 图语义节点 + §8.4 报告节点）
export const nodeTypes = {
  root: BaseNode,
  job: BaseNode,
  finding: BaseNode,
  note: BaseNode,
  human: BaseNode,
  intent: BaseNode,
  fact: BaseNode,
  report: BaseNode,
};
