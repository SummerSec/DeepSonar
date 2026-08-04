/** Stable business errors for inputs crossing the Agent/Scheduler boundary. */
export const CONTROL_INPUT_ERROR_CODES = {
  invalidNodeRef: "invalid_node_ref",
} as const;

export type ControlInputErrorCode = (typeof CONTROL_INPUT_ERROR_CODES)[keyof typeof CONTROL_INPUT_ERROR_CODES];

export const INVALID_NODE_REF_MESSAGE =
  "Hub 图引用必须使用当前画布 YAML 中 root/fact/finding 节点的 canonical UUID（YAML root_id 的值）；禁止字段名 root_id、别名或占位符。";

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
