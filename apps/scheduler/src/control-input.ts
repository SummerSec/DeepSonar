/** Stable business errors for inputs crossing the Agent/Scheduler boundary. */
export const CONTROL_INPUT_ERROR_CODES = {
  invalidNodeRef: "invalid_node_ref",
  invalidReferenceBudget: "invalid_reference_budget",
} as const;

export type ControlInputErrorCode = (typeof CONTROL_INPUT_ERROR_CODES)[keyof typeof CONTROL_INPUT_ERROR_CODES];

export const INVALID_NODE_REF_MESSAGE =
  "Hub 图引用必须使用当前画布 YAML 中 root/fact/finding 节点的 canonical UUID（YAML root_id 的值）；禁止字段名 root_id、别名或占位符。";

export const INVALID_REFERENCE_BUDGET_MESSAGE =
  "Hub 图引用数量超过平台限制；请减少每个 from 列表或整个决策中的唯一引用数量。";

function printable(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
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
    `${INVALID_NODE_REF_MESSAGE} 字段 ${path} 收到 ${printable(value)}。`,
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
