import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import {
  Brain,
  Bug,
  CaretDown,
  CaretUp,
  CheckCircle,
  Compass,
  Database,
  FileText,
  FileX,
  Note,
  Robot,
  SealCheck,
  Target,
  UserCircle,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { ROLE_UI_COLOR_PATTERN } from "@deepsonar/shared-types";
import type { CanvasNode } from "./api";
import { SEVERITY_COLOR, STATUS_COLOR, VERIFICATION_META } from "./semantics";

export type DEEPSONARNodeData = {
  canvas: CanvasNode;
  /** 从 root 起算的图深度（root=1） */
  depth?: number;
  /** 直接后继数量（>0 时显示展开/收起） */
  childCount?: number;
  /** 当前是否有效展开（后继可见） */
  isExpanded?: boolean;
  /** 展开本节点的直接后继 */
  onExpandNode?: () => void;
  /** 收起本节点后继 */
  onCollapseNode?: () => void;
};
export type DEEPSONARNode = Node<DEEPSONARNodeData, string>;
export type SemanticNodeKind =
  | "task"
  | "intent"
  | "hub"
  | "finding"
  | "subagent"
  | "verify"
  | "fact"
  | "report"
  | "human"
  | "note";

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

/** 语义样式：色 + 中文标签 + 短码（图例/卡片共用） */
export const SEMANTIC_STYLE: Record<
  SemanticNodeKind,
  { label: string; short: string; color: string; hint: string }
> = {
  task: { label: "任务", short: "TASK", color: "#2dd4bf", hint: "任务根节点" },
  intent: { label: "意图", short: "INTENT", color: "#38bdf8", hint: "Hub 下发的角色意图" },
  hub: { label: "中枢", short: "HUB", color: "#a78bfa", hint: "Hub 决策 Agent" },
  finding: { label: "发现", short: "FIND", color: "#fb7185", hint: "审计发现 Finding" },
  subagent: { label: "Agent", short: "AGENT", color: "#f59e0b", hint: "工作角色 Agent" },
  verify: { label: "验证", short: "VERIFY", color: "#34d399", hint: "验证 Agent" },
  fact: { label: "事实", short: "FACT", color: "#22d3ee", hint: "已提交事实" },
  report: { label: "报告", short: "REPORT", color: "#818cf8", hint: "任务报告" },
  human: { label: "人工", short: "HUMAN", color: "#f97316", hint: "需人工介入" },
  note: { label: "说明", short: "NOTE", color: "#94a3b8", hint: "过程说明" },
};

/** Frozen role color wins over the semantic fallback for role intent/job
 * nodes. Unknown/legacy nodes intentionally fall back to the fixed semantic
 * color rather than reading mutable role configuration from the client. */
export function nodeDisplayColor(n: CanvasNode): string {
  const semantic = semanticNodeKind(n);
  const frozen = n.body_json?.ui_color;
  if ((semantic === "subagent" || semantic === "intent") &&
      typeof frozen === "string" && ROLE_UI_COLOR_PATTERN.test(frozen)) {
    return frozen.toLowerCase();
  }
  return SEMANTIC_STYLE[semantic].color;
}

/** 运行中状态：状态点带呼吸脉冲 */
const LIVE_STATUS = new Set(["running", "claimed", "provisioning", "active", "generating"]);

function kindIcon(semantic: SemanticNodeKind, size = 16): ReactNode {
  switch (semantic) {
    case "task":
      return <Target size={size} weight="fill" />;
    case "intent":
      return <Compass size={size} weight="fill" />;
    case "hub":
      return <Brain size={size} weight="fill" />;
    case "finding":
      return <Bug size={size} weight="fill" />;
    case "subagent":
      return <Robot size={size} weight="fill" />;
    case "verify":
      return <SealCheck size={size} weight="fill" />;
    case "fact":
      return <Database size={size} weight="fill" />;
    case "human":
      return <UserCircle size={size} weight="fill" />;
    case "note":
      return <Note size={size} weight="fill" />;
    case "report":
      return <FileText size={size} weight="fill" />;
    default:
      return null;
  }
}

function BaseNode({ data }: NodeProps<DEEPSONARNode>) {
  const n = data.canvas;
  const semantic = semanticNodeKind(n);
  const style = SEMANTIC_STYLE[semantic];
  const displayColor = nodeDisplayColor(n);
  const status = n.status ?? "";
  const statusColor = STATUS_COLOR[status] ?? "#71717a";
  const severity = (n.body_json?.severity as string) ?? null;
  const sevColor = severity ? (SEVERITY_COLOR[severity] ?? "#71717a") : null;
  const jobType = (n.body_json?.type as string) ?? null;
  const role = (n.body_json?.role as string) ?? null;
  const location = (n.body_json?.location as string) ?? null;
  const lastAction =
    (n.body_json?.last_progress as { message?: string } | undefined)?.message ?? null;
  const target = n.body_json?.target as Record<string, unknown> | undefined;
  const targetText = target ? String(target.content ?? "") : null;

  const childCount = data.childCount ?? 0;
  const isExpanded = Boolean(data.isExpanded);
  const hasChildren = childCount > 0;

  const verification =
    n.node_type === "fact" && n.verification_status
      ? (VERIFICATION_META[n.verification_status] ?? {
          label: n.verification_status,
          color: "#71717a",
        })
      : null;

  // 类型专属描边：意图虚线/呼吸；发现偏实线强调；Agent 实线
  const typeBorder =
    semantic === "intent"
      ? status === "pending"
        ? "border-dashed"
        : LIVE_STATUS.has(status)
          ? ""
          : status === "succeeded"
            ? ""
            : ""
      : semantic === "finding"
        ? ""
        : "";

  const glow =
    LIVE_STATUS.has(status) && (semantic === "intent" || semantic === "subagent" || semantic === "hub" || semantic === "verify")
      ? `0 0 18px color-mix(in srgb, ${displayColor} 28%, transparent)`
      : undefined;

  const reportStatusIcon =
    n.node_type === "report" ? (
      status === "succeeded" ? (
        <CheckCircle size={16} className="text-emerald-400" />
      ) : status === "failed" ? (
        <FileX size={16} className="text-red-400" />
      ) : (
        <FileText size={16} className="text-sky-400" />
      )
    ) : null;

  // Agent 类：显示角色名；意图：role；发现：severity 已在底栏
  const roleOrType =
    semantic === "intent"
      ? role
      : semantic === "subagent" || semantic === "verify" || semantic === "hub"
        ? role || jobType
        : null;

  return (
    <div
      className={`deepsonar-node deepsonar-node--${semantic} w-full overflow-hidden rounded-[16px] ${typeBorder}`}
      style={{
        border: `1.5px solid color-mix(in srgb, ${displayColor} 55%, transparent)`,
        boxShadow: glow ?? `0 0 0 1px color-mix(in srgb, ${displayColor} 18%, transparent)`,
        background: `linear-gradient(135deg, color-mix(in srgb, ${displayColor} 16%, #0c1012) 0%, #0c1012 48%)`,
      }}
      data-kind={semantic}
      title={`${style.label} · ${style.hint}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />

      {/* 左侧类型色条：扫一眼就能分类型 */}
      <div
        className="absolute inset-y-0 left-0 w-[5px]"
        style={{ background: displayColor }}
        aria-hidden
      />

      <div className="relative pl-[5px]">
        <div className="rounded-[12px] px-3 py-2.5">
          {/* 类型徽章行：图标 + 中文名 + 短码 */}
          <div className="flex items-center gap-2">
            <span
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg"
              style={{
                color: displayColor,
                background: `color-mix(in srgb, ${displayColor} 18%, transparent)`,
                boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${displayColor} 40%, transparent)`,
              }}
            >
              {reportStatusIcon ?? kindIcon(semantic, 15)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className="rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold tracking-wide"
                  style={{
                    color: displayColor,
                    background: `color-mix(in srgb, ${displayColor} 16%, transparent)`,
                    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${displayColor} 45%, transparent)`,
                  }}
                >
                  {style.label}
                </span>
                <span className="font-mono text-[9px] tracking-[0.14em] text-zinc-600">{style.short}</span>
                {roleOrType && (
                  <span
                    className="max-w-[7.5rem] truncate rounded border px-1 py-0.5 font-mono text-[10px] uppercase tracking-wider"
                    style={{
                      color: displayColor,
                      borderColor: `${displayColor}55`,
                      background: `color-mix(in srgb, ${displayColor} 10%, transparent)`,
                    }}
                    title={roleOrType}
                  >
                    {roleOrType}
                  </span>
                )}
                {verification && (
                  <span
                    className="rounded border px-1 font-mono text-[10px]"
                    style={{ color: verification.color, borderColor: `${verification.color}66` }}
                  >
                    {verification.label}
                  </span>
                )}
              </div>
            </div>
            {status && (
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <span
                  className={`inline-block size-1.5 rounded-full ${LIVE_STATUS.has(status) ? "deepsonar-live-dot" : ""}`}
                  style={{ background: statusColor }}
                />
                <span className="font-mono text-[10px]" style={{ color: statusColor }}>
                  {status}
                </span>
              </span>
            )}
          </div>

          {/* 标题 */}
          <div
            className="mt-2 text-[14px] font-medium leading-snug text-zinc-100"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {n.title}
          </div>

          {/* 底栏元信息 */}
          <div className="mt-1.5 flex items-center gap-2">
            {location && (
              <span className="truncate font-mono text-[11px] text-zinc-500">{location}</span>
            )}
            {!location && (lastAction || targetText || (semantic === "subagent" && jobType)) && (
              <span className="truncate font-mono text-[11px] text-zinc-500">
                {lastAction ?? targetText ?? jobType ?? ""}
              </span>
            )}
            {severity && (
              <span
                className="ml-auto shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider"
                style={{
                  color: sevColor ?? undefined,
                  background: sevColor ? `color-mix(in srgb, ${sevColor} 16%, transparent)` : undefined,
                }}
              >
                {severity}
              </span>
            )}
          </div>

          {hasChildren && (
            <button
              type="button"
              className={`mt-2 flex w-full items-center justify-center gap-1 rounded-md py-1 font-mono text-[10px] transition-colors ${
                isExpanded
                  ? "text-zinc-500 ring-1 ring-white/[.08] hover:bg-white/[.04] hover:text-zinc-300"
                  : "text-acc-400/90 ring-1 ring-acc-400/20 hover:bg-acc-400/[.08] hover:text-acc-300"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                if (isExpanded) data.onCollapseNode?.();
                else data.onExpandNode?.();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              aria-expanded={isExpanded}
            >
              {isExpanded ? (
                <>
                  <CaretUp size={11} /> 收起 · {childCount}
                </>
              ) : (
                <>
                  <CaretDown size={11} /> 展开 · {childCount}
                </>
              )}
            </button>
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
