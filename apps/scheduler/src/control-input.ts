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
  invalidVerification: "invalid_verification",
  invalidProgress: "invalid_progress",
  invalidDone: "invalid_done",
  invalidHuman: "invalid_human",
  forbiddenControlFile: "forbidden_control_file",
  invalidReferenceBudget: "invalid_reference_budget",
} as const;

export type ControlInputErrorCode = (typeof CONTROL_INPUT_ERROR_CODES)[keyof typeof CONTROL_INPUT_ERROR_CODES];

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

export class ControlInputError extends Error {
  readonly code: ControlInputErrorCode;
  readonly path?: string;

  constructor(code: ControlInputErrorCode, message: string, path?: string) {
    super(`[${code}] ${message}`);
    this.name = "ControlInputError";
    this.code = code;
    this.path = path;
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

export function invalidRole(role: unknown, path = "role"): ControlInputError {
  return new ControlInputError(
    CONTROL_INPUT_ERROR_CODES.invalidRole,
    `Hub 角色必须来自本轮 list_available_roles，字段 ${path} 收到类型 ${inputShape(role)}，请使用返回的名称。`,
    path,
  );
}

export function invalidVerification(message: string, path = "verification"): ControlInputError {
  return new ControlInputError(CONTROL_INPUT_ERROR_CODES.invalidVerification, message, path);
}
