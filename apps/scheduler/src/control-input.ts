/** Stable business errors for inputs crossing the Agent/Scheduler boundary. */
export const CONTROL_INPUT_ERROR_CODES = {
  invalidPayload: "invalid_payload",
  unknownField: "unknown_field",
  unknownTool: "unknown_tool",
  toolNotAllowed: "tool_not_allowed",
  duplicateToolCall: "duplicate_tool_call",
  toolLimit: "tool_limit",
  invalidEvent: "invalid_event",
  invalidNodeRef: "invalid_node_ref",
  invalidFindingRef: "invalid_finding_ref",
  invalidRole: "invalid_role",
  invalidRuntimeImage: "invalid_runtime_image",
  invalidVerification: "invalid_verification",
  invalidProgress: "invalid_progress",
  invalidDone: "invalid_done",
  invalidHuman: "invalid_human",
  jobNotRunning: "job_not_running",
  forbiddenControlFile: "forbidden_control_file",
  invalidReferenceBudget: "invalid_reference_budget",
} as const;

export type ControlInputErrorCode = (typeof CONTROL_INPUT_ERROR_CODES)[keyof typeof CONTROL_INPUT_ERROR_CODES];

export function controlInputCodeForOperation(operation: string): ControlInputErrorCode {
  if (operation === "emit_progress") return CONTROL_INPUT_ERROR_CODES.invalidProgress;
  if (operation === "mark_job_done") return CONTROL_INPUT_ERROR_CODES.invalidDone;
  if (operation === "request_human") return CONTROL_INPUT_ERROR_CODES.invalidHuman;
  return CONTROL_INPUT_ERROR_CODES.invalidPayload;
}

export const INVALID_NODE_REF_MESSAGE =
  "Hub 图引用必须使用当前画布 YAML 中 root/fact/finding 节点的 canonical UUID（YAML root_id 的值）；禁止字段名 root_id、别名或占位符。";

export const INVALID_REFERENCE_BUDGET_MESSAGE =
  "Hub 图引用数量超过平台限制；请减少每个 from 列表或整个决策中的唯一引用数量。";

export const INVALID_PAYLOAD_MESSAGE = "控制工具参数不符合严格契约；请修正字段、类型、枚举或长度后重试。";

/** Describe an untrusted value without copying its contents into host errors. */
function inputShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(length=${value.length})`;
  switch (typeof value) {
    case "string":
      return `string(length=${value.length})`;
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
    case "function":
    case "undefined":
      return typeof value;
    default:
      return "object";
  }
}

/** Host-side control validation the Worker can usually fix by retrying the tool. */
const AGENT_CORRECTABLE_CONTROL_CODES: ReadonlySet<ControlInputErrorCode> = new Set([
  CONTROL_INPUT_ERROR_CODES.invalidPayload,
  CONTROL_INPUT_ERROR_CODES.unknownField,
  CONTROL_INPUT_ERROR_CODES.duplicateToolCall,
  CONTROL_INPUT_ERROR_CODES.toolLimit,
  CONTROL_INPUT_ERROR_CODES.invalidEvent,
  CONTROL_INPUT_ERROR_CODES.invalidNodeRef,
  CONTROL_INPUT_ERROR_CODES.invalidFindingRef,
  CONTROL_INPUT_ERROR_CODES.invalidRole,
  CONTROL_INPUT_ERROR_CODES.invalidRuntimeImage,
  CONTROL_INPUT_ERROR_CODES.invalidVerification,
  CONTROL_INPUT_ERROR_CODES.invalidProgress,
  CONTROL_INPUT_ERROR_CODES.invalidDone,
  CONTROL_INPUT_ERROR_CODES.invalidHuman,
  CONTROL_INPUT_ERROR_CODES.invalidReferenceBudget,
]);

export class ControlInputError extends Error {
  readonly code: ControlInputErrorCode;
  readonly path?: string;
  /**
   * When true, the real-agent driver must surface the message to the Worker and
   * continue the run (do not convert into fatal "语义事件处理失败").
   * Fail-closed codes (tool_not_allowed, job_not_running, forbidden_control_file)
   * stay non-retryable.
   */
  readonly retryable: boolean;

  constructor(code: ControlInputErrorCode, message: string, path?: string) {
    super(`[${code}] ${message}`);
    this.name = "ControlInputError";
    this.code = code;
    this.path = path;
    this.retryable = AGENT_CORRECTABLE_CONTROL_CODES.has(code);
  }
}

export function invalidNodeReference(path: string, value: unknown): ControlInputError {
  return new ControlInputError(
    CONTROL_INPUT_ERROR_CODES.invalidNodeRef,
    `${INVALID_NODE_REF_MESSAGE} 字段 ${path} 收到类型 ${inputShape(value)}，请使用 canonical UUID。`,
    path,
  );
}

export function invalidReferenceBudget(path: string, count: number, limit: number): ControlInputError {
  return new ControlInputError(
    CONTROL_INPUT_ERROR_CODES.invalidReferenceBudget,
    `${INVALID_REFERENCE_BUDGET_MESSAGE} 字段 ${path} 收到 ${count} 项，最多 ${limit} 项。`,
    path,
  );
}

export function invalidControlPayload(message = INVALID_PAYLOAD_MESSAGE, path?: string): ControlInputError {
  return new ControlInputError(CONTROL_INPUT_ERROR_CODES.invalidPayload, message, path);
}

export function unknownControlField(path: string): ControlInputError {
  return new ControlInputError(
    CONTROL_INPUT_ERROR_CODES.unknownField,
    `${INVALID_PAYLOAD_MESSAGE} 不允许未知字段。`,
    path,
  );
}

export function invalidRole(role: unknown, path = "role", allowed?: readonly string[]): ControlInputError {
  // Shape only — never echo the untrusted role token (may be secret-like or prompt injection).
  const allowHint =
    allowed && allowed.length > 0
      ? ` 允许的 name：${allowed.join(", ")}。`
      : " 请使用 list_available_roles 返回的 name。";
  return new ControlInputError(
    CONTROL_INPUT_ERROR_CODES.invalidRole,
    `Hub 角色必须来自本轮 list_available_roles，字段 ${path} 收到类型 ${inputShape(role)}。${allowHint}`,
    path,
  );
}

export function invalidRuntimeImage(path = "runtime_image_key", allowed?: readonly string[]): ControlInputError {
  // Shape only — never echo the untrusted image token back to the sandbox.
  const allowHint =
    allowed && allowed.length > 0
      ? ` 本轮可选 image_key：${allowed.join(", ")}。`
      : " 请使用 list_available_runtime_images 返回的 image_key。";
  return new ControlInputError(
    CONTROL_INPUT_ERROR_CODES.invalidRuntimeImage,
    `Hub 运行镜像必须来自本轮 list_available_runtime_images 的市场 image_key（项目已启用且存在可信版本），字段 ${path} 不合法或不在可选集合。${allowHint}`,
    path,
  );
}

export function invalidVerification(message: string, path = "verification"): ControlInputError {
  return new ControlInputError(CONTROL_INPUT_ERROR_CODES.invalidVerification, message, path);
}
