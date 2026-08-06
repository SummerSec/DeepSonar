/**
 * Small helpers for JSON object textareas (settingsConfig editors).
 * Empty text is treated as valid "use defaults" unless requireNonEmpty is set.
 */

export type JsonTextValidation =
  | { ok: true; empty: true; value: null }
  | { ok: true; empty: false; value: Record<string, unknown> }
  | { ok: false; empty: boolean; error: string; line?: number; column?: number };

/** Parse textarea content as a JSON object (not array/primitive). */
export function validateJsonObjectText(text: string, options?: { requireNonEmpty?: boolean }): JsonTextValidation {
  const trimmed = text.trim();
  if (!trimmed) {
    if (options?.requireNonEmpty) {
      return { ok: false, empty: true, error: "JSON 不能为空" };
    }
    return { ok: true, empty: true, value: null };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, empty: false, error: "必须是 JSON 对象 { … }，不能是数组或原始值" };
    }
    return { ok: true, empty: false, value: parsed as Record<string, unknown> };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const position = /position\s+(\d+)/i.exec(message);
    if (position) {
      const index = Number(position[1]);
      const before = trimmed.slice(0, Number.isFinite(index) ? index : 0);
      const line = before.split("\n").length;
      const lastNl = before.lastIndexOf("\n");
      const column = before.length - lastNl;
      return { ok: false, empty: false, error: message, line, column };
    }
    return { ok: false, empty: false, error: message };
  }
}

/** Pretty-print JSON object text; throws if invalid. */
export function formatJsonObjectText(text: string, space = 2): string {
  const result = validateJsonObjectText(text, { requireNonEmpty: true });
  if (!result.ok) throw new Error(result.error);
  return `${JSON.stringify(result.value, null, space)}\n`;
}

export function formatJsonObject(value: Record<string, unknown>, space = 2): string {
  return `${JSON.stringify(value, null, space)}\n`;
}
