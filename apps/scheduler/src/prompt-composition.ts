/**
 * Prompt composition v1 (#594 first slice): unify sources, versions, preview, and
 * RoleConfig binding. Business text remains replaceable; platform privileges stay
 * code-enforced and cannot be expanded by natural language.
 *
 * Override order for *business* layers (cannot cover platform protocol/auth):
 *   task allowed overrides → project override → role/capability defaults.
 *
 * Injection channels are explicit. Unsupported CLI materialization must fail closed
 * rather than silently appending user messages as a fake "system prompt replace".
 */
import { createHash } from "node:crypto";

export const PROMPT_COMPOSITION_STRATEGY_ID = "prompt.composition" as const;
export const PROMPT_COMPOSITION_STRATEGY_VERSION = 1 as const;

/** Max characters for a single business prompt component (aligned with RoleConfig). */
export const PROMPT_COMPONENT_MAX_CHARS = 100_000;

export type PromptLayerKind =
  | "platform_protocol"
  | "role_capability"
  | "project_override"
  | "task_dispatch"
  | "image_manual_index"
  | "context_data";

export type PromptInjectionChannel =
  | "system_prompt"
  | "instruction_files"
  | "user_message"
  | "unsupported";

export type PromptComponentScope = "platform" | "global_role" | "project" | "job" | "attempt";

export type PromptComponent = {
  /** Stable identity within a layer (e.g. role_id, dispatch revision id). */
  component_id: string;
  layer: PromptLayerKind;
  version: string | number;
  scope: PromptComponentScope;
  /** Human-readable source label for preview/audit. */
  source_label: string;
  content: string;
  /** Optional schema/vars description — recorded, not executed. */
  variables_schema?: Record<string, unknown> | null;
  /** Declared replaceable / append-only / locked parts. */
  mutability?: "replaceable" | "append_only" | "locked";
};

export type PromptCompositionInput = {
  platform_protocol: PromptComponent;
  role_capability?: PromptComponent | null;
  project_override?: PromptComponent | null;
  task_dispatch?: PromptComponent | null;
  image_manual_index?: PromptComponent | null;
  context_data?: PromptComponent | null;
  /** Tools/network actually authorized by the kernel — never inferred from text. */
  authorized_tools: readonly string[];
  allow_egress: boolean;
  /** CLI-declared injection support. */
  supported_channels: readonly PromptInjectionChannel[];
  /** Desired channel for this Job/Attempt. */
  requested_channel: PromptInjectionChannel;
};

export type PromptLayerTrace = {
  layer: PromptLayerKind;
  component_id: string | null;
  version: string | number | null;
  source_label: string | null;
  content_sha256: string | null;
  char_count: number;
  included: boolean;
  shadowed_by: PromptLayerKind | null;
  reason: string;
};

export type PromptCompositionPreview = {
  strategy_id: typeof PROMPT_COMPOSITION_STRATEGY_ID;
  strategy_version: typeof PROMPT_COMPOSITION_STRATEGY_VERSION;
  /** Business override order documentation (platform always first / non-overridable). */
  business_override_order: readonly PromptLayerKind[];
  layers: PromptLayerTrace[];
  assembled_business_markdown: string;
  assembled_sha256: string;
  injection_channel: PromptInjectionChannel;
  injection_ok: boolean;
  injection_error: string | null;
  validation_errors: string[];
  validation_warnings: string[];
  /** Freeze record for Attempt — versions only, no secrets. */
  freeze_record: {
    strategy_id: typeof PROMPT_COMPOSITION_STRATEGY_ID;
    strategy_version: typeof PROMPT_COMPOSITION_STRATEGY_VERSION;
    component_versions: Record<string, string | number | null>;
    assembled_sha256: string;
    injection_channel: PromptInjectionChannel;
    allow_egress: boolean;
    authorized_tools: string[];
  };
};

const BUSINESS_OVERRIDE_ORDER = [
  "task_dispatch",
  "project_override",
  "role_capability",
] as const satisfies readonly PromptLayerKind[];

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function trimContent(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Privilege-expansion lint — advisory to validation_errors; code still owns auth. */
const PRIVILEGE_EXPANSION_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /DEEPSONAR_ALLOW_EGRESS\s*=\s*1/i, reason: "business text must not set DEEPSONAR_ALLOW_EGRESS=1" },
  { re: /扩大\s*(工具|网络|凭据|权限)/, reason: "business text must not claim to expand tools/network/credentials" },
  { re: /绕过\s*(验证|门禁|沙箱|权限)/, reason: "business text must not instruct bypassing gates or sandbox" },
  { re: /ignore\s+(all\s+)?(previous|prior|platform)\s+instructions/i, reason: "business text must not override platform protocol" },
];

export function digestPromptContent(content: string): string {
  return sha256(trimContent(content));
}

export function roleConfigPromptComponent(input: {
  roleId: string;
  roleConfigId?: string | null;
  roleConfigVersion: number | string;
  instructionsMarkdown: string | null | undefined;
  scope: "global_role" | "project";
  sourceLabel?: string;
}): PromptComponent {
  const content = trimContent(input.instructionsMarkdown ?? "");
  return {
    component_id: input.roleConfigId?.trim() || `role:${input.roleId}`,
    layer: input.scope === "project" ? "project_override" : "role_capability",
    version: input.roleConfigVersion,
    scope: input.scope,
    source_label: input.sourceLabel ?? (input.scope === "project" ? "project RoleConfig" : "global RoleConfig"),
    content,
    mutability: "replaceable",
  };
}

export function taskDispatchPromptComponent(input: {
  revisionId: string;
  revisionVersion: number | string;
  prompt: string;
  sourceLabel?: string;
}): PromptComponent {
  return {
    component_id: input.revisionId,
    layer: "task_dispatch",
    version: input.revisionVersion,
    scope: "job",
    source_label: input.sourceLabel ?? "Hub task dispatch",
    content: trimContent(input.prompt),
    mutability: "replaceable",
  };
}

export function platformProtocolComponent(content: string, version: string | number = 1): PromptComponent {
  return {
    component_id: "platform.protocol",
    layer: "platform_protocol",
    version,
    scope: "platform",
    source_label: "platform required protocol",
    content: trimContent(content),
    mutability: "locked",
  };
}

function validateComponentSize(c: PromptComponent | null | undefined, errors: string[]): void {
  if (!c) return;
  if (c.content.length > PROMPT_COMPONENT_MAX_CHARS) {
    errors.push(`${c.layer}/${c.component_id}: content exceeds ${PROMPT_COMPONENT_MAX_CHARS} characters`);
  }
}

function lintPrivilegeExpansion(c: PromptComponent | null | undefined, errors: string[]): void {
  if (!c || c.layer === "platform_protocol") return;
  for (const { re, reason } of PRIVILEGE_EXPANSION_PATTERNS) {
    if (re.test(c.content)) {
      errors.push(`${c.layer}/${c.component_id}: ${reason}`);
    }
  }
}

function resolveBusinessContent(input: PromptCompositionInput): {
  content: string;
  winner: PromptLayerKind | null;
  traces: PromptLayerTrace[];
} {
  const traces: PromptLayerTrace[] = [];
  const candidates: { layer: PromptLayerKind; component: PromptComponent | null | undefined }[] = [
    { layer: "task_dispatch", component: input.task_dispatch },
    { layer: "project_override", component: input.project_override },
    { layer: "role_capability", component: input.role_capability },
  ];

  let winner: PromptLayerKind | null = null;
  let content = "";

  for (const { layer, component } of candidates) {
    const text = trimContent(component?.content);
    const has = Boolean(component && text);
    if (!winner && has) {
      winner = layer;
      content = text;
      traces.push({
        layer,
        component_id: component!.component_id,
        version: component!.version,
        source_label: component!.source_label,
        content_sha256: digestPromptContent(text),
        char_count: text.length,
        included: true,
        shadowed_by: null,
        reason: "selected by business override order (task → project → role)",
      });
    } else if (has) {
      traces.push({
        layer,
        component_id: component!.component_id,
        version: component!.version,
        source_label: component!.source_label,
        content_sha256: digestPromptContent(text),
        char_count: text.length,
        included: false,
        shadowed_by: winner,
        reason: `shadowed by ${winner}; retained for audit/diff only`,
      });
    } else {
      traces.push({
        layer,
        component_id: component?.component_id ?? null,
        version: component?.version ?? null,
        source_label: component?.source_label ?? null,
        content_sha256: null,
        char_count: 0,
        included: false,
        shadowed_by: null,
        reason: "empty or absent",
      });
    }
  }

  return { content, winner, traces };
}

export function assemblePromptComposition(input: PromptCompositionInput): PromptCompositionPreview {
  const validation_errors: string[] = [];
  const validation_warnings: string[] = [];

  if (!trimContent(input.platform_protocol.content)) {
    validation_errors.push("platform_protocol content is required");
  }
  if (input.platform_protocol.mutability && input.platform_protocol.mutability !== "locked") {
    validation_errors.push("platform_protocol must be locked mutability");
  }

  for (const c of [
    input.platform_protocol,
    input.role_capability,
    input.project_override,
    input.task_dispatch,
    input.image_manual_index,
    input.context_data,
  ]) {
    validateComponentSize(c, validation_errors);
    lintPrivilegeExpansion(c, validation_errors);
  }

  // Business text cannot authorize tools/network.
  if (!input.allow_egress) {
    for (const c of [input.role_capability, input.project_override, input.task_dispatch]) {
      if (c && /允许\s*(访问)?\s*(外部|公网|出网)/.test(c.content)) {
        validation_warnings.push(
          `${c.layer}: mentions allowing egress but Job allow_egress=false — text is ignored for network auth`,
        );
      }
    }
  }

  const business = resolveBusinessContent(input);
  const layers: PromptLayerTrace[] = [
    {
      layer: "platform_protocol",
      component_id: input.platform_protocol.component_id,
      version: input.platform_protocol.version,
      source_label: input.platform_protocol.source_label,
      content_sha256: digestPromptContent(input.platform_protocol.content),
      char_count: trimContent(input.platform_protocol.content).length,
      included: true,
      shadowed_by: null,
      reason: "platform protocol always included; not overridable by business layers",
    },
    ...business.traces,
  ];

  for (const optional of [
    { layer: "image_manual_index" as const, component: input.image_manual_index },
    { layer: "context_data" as const, component: input.context_data },
  ]) {
    const text = trimContent(optional.component?.content);
    const has = Boolean(optional.component && text);
    layers.push({
      layer: optional.layer,
      component_id: optional.component?.component_id ?? null,
      version: optional.component?.version ?? null,
      source_label: optional.component?.source_label ?? null,
      content_sha256: has ? digestPromptContent(text) : null,
      char_count: text.length,
      included: has,
      shadowed_by: null,
      reason: has ? "appended as reference index / context summary" : "empty or absent",
    });
  }

  const parts: string[] = [];
  parts.push(`## 平台必需协议\n\n${trimContent(input.platform_protocol.content)}`);
  if (business.content) {
    const label =
      business.winner === "task_dispatch"
        ? "本次任务指令"
        : business.winner === "project_override"
          ? "项目覆盖指令"
          : "角色/能力默认指令";
    parts.push(`## ${label}\n\n${business.content}`);
  }
  const manual = trimContent(input.image_manual_index?.content);
  if (manual) parts.push(`## 镜像工具手册索引\n\n${manual}`);
  const ctx = trimContent(input.context_data?.content);
  if (ctx) parts.push(`## 上下文数据摘要\n\n${ctx}`);

  const assembled_business_markdown = parts.join("\n\n");
  const assembled_sha256 = digestPromptContent(assembled_business_markdown);

  let injection_ok = true;
  let injection_error: string | null = null;
  if (input.requested_channel === "unsupported") {
    injection_ok = false;
    injection_error = "requested injection channel is unsupported for this CLI";
    validation_errors.push(injection_error);
  } else if (!input.supported_channels.includes(input.requested_channel)) {
    injection_ok = false;
    injection_error = `CLI does not support injection channel '${input.requested_channel}' (supported: ${input.supported_channels.join(", ") || "none"})`;
    validation_errors.push(injection_error);
  }
  // Never silently treat user_message as system_prompt replacement.
  if (
    input.requested_channel === "system_prompt" &&
    !input.supported_channels.includes("system_prompt") &&
    input.supported_channels.includes("user_message")
  ) {
    injection_ok = false;
    injection_error =
      "cannot materialize system_prompt via user_message append; unsupported channel must be rejected";
    validation_errors.push(injection_error);
  }

  const component_versions: Record<string, string | number | null> = {
    platform_protocol: input.platform_protocol.version,
    role_capability: input.role_capability?.version ?? null,
    project_override: input.project_override?.version ?? null,
    task_dispatch: input.task_dispatch?.version ?? null,
    image_manual_index: input.image_manual_index?.version ?? null,
    context_data: input.context_data?.version ?? null,
  };

  return {
    strategy_id: PROMPT_COMPOSITION_STRATEGY_ID,
    strategy_version: PROMPT_COMPOSITION_STRATEGY_VERSION,
    business_override_order: BUSINESS_OVERRIDE_ORDER,
    layers,
    assembled_business_markdown,
    assembled_sha256,
    injection_channel: input.requested_channel,
    injection_ok,
    injection_error,
    validation_errors,
    validation_warnings,
    freeze_record: {
      strategy_id: PROMPT_COMPOSITION_STRATEGY_ID,
      strategy_version: PROMPT_COMPOSITION_STRATEGY_VERSION,
      component_versions,
      assembled_sha256,
      injection_channel: input.requested_channel,
      allow_egress: input.allow_egress,
      authorized_tools: [...input.authorized_tools],
    },
  };
}

/**
 * Distinguish the three re-run / replan intents from #594 §三.
 * Pure classifier — callers still enforce effect_pending / cancel rules.
 */
export type PromptRerunIntent =
  | "revise_and_redispatch"
  | "rerun_original_input"
  | "rerun_current_config"
  | "request_hub_replan";

export function describePromptRerunIntent(intent: PromptRerunIntent): {
  intent: PromptRerunIntent;
  creates_new_revision: boolean;
  reuses_frozen_business_input: boolean;
  refreshes_role_config: boolean;
  creates_new_hub_plan: boolean;
  summary_zh: string;
} {
  switch (intent) {
    case "revise_and_redispatch":
      return {
        intent,
        creates_new_revision: true,
        reuses_frozen_business_input: false,
        refreshes_role_config: false,
        creates_new_hub_plan: false,
        summary_zh: "修订派发内容并重新校验；原子替换调度目标，保留旧修订记录",
      };
    case "rerun_original_input":
      return {
        intent,
        creates_new_revision: false,
        reuses_frozen_business_input: true,
        refreshes_role_config: false,
        creates_new_hub_plan: false,
        summary_zh: "按原业务输入重跑；仍遵守当前准入与吊销检查",
      };
    case "rerun_current_config":
      return {
        intent,
        creates_new_revision: true,
        reuses_frozen_business_input: false,
        refreshes_role_config: true,
        creates_new_hub_plan: false,
        summary_zh: "按当前 RoleConfig 重跑；为新 Attempt 冻结新输入并展示配置差异",
      };
    case "request_hub_replan":
      return {
        intent,
        creates_new_revision: true,
        reuses_frozen_business_input: false,
        refreshes_role_config: false,
        creates_new_hub_plan: true,
        summary_zh: "请求 Hub 重新规划；不得混同于刷新 RoleConfig 后重跑",
      };
  }
}
