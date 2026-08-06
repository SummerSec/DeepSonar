/**
 * TOML helpers for Codex config.toml editing (CC Switch dialect).
 * Empty text is valid "use defaults" unless requireNonEmpty is set.
 */
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export type TomlTextValidation =
  | { ok: true; empty: true; value: null }
  | { ok: true; empty: false; value: Record<string, unknown> }
  | { ok: false; empty: boolean; error: string; line?: number; column?: number };

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Parse textarea content as a TOML table (root must be a table, not array/value). */
export function validateTomlText(text: string, options?: { requireNonEmpty?: boolean }): TomlTextValidation {
  const trimmed = text.trim();
  if (!trimmed) {
    if (options?.requireNonEmpty) {
      return { ok: false, empty: true, error: "TOML 不能为空" };
    }
    return { ok: true, empty: true, value: null };
  }
  try {
    const parsed = parseToml(trimmed);
    const obj = asObject(parsed);
    if (!obj) {
      return { ok: false, empty: false, error: "根节点必须是 TOML 表（table），不能是数组或原始值" };
    }
    return { ok: true, empty: false, value: obj };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // smol-toml often includes "at line X, column Y"
    const lineCol = /line\s+(\d+)(?:\s*,\s*column\s+(\d+))?/i.exec(message);
    if (lineCol) {
      return {
        ok: false,
        empty: false,
        error: message,
        line: Number(lineCol[1]),
        column: lineCol[2] ? Number(lineCol[2]) : undefined,
      };
    }
    return { ok: false, empty: false, error: message };
  }
}

/** Pretty-print TOML; throws if invalid. */
export function formatTomlText(text: string): string {
  const result = validateTomlText(text, { requireNonEmpty: true });
  if (!result.ok) throw new Error(result.error);
  const out = stringifyToml(result.value);
  return out.endsWith("\n") ? out : `${out}\n`;
}

export function formatTomlObject(value: Record<string, unknown>): string {
  const out = stringifyToml(value);
  return out.endsWith("\n") ? out : `${out}\n`;
}

/** Default Codex config.toml body (without auth.json). */
export function defaultCodexToml(baseUrl: string, model = "gpt-5", reasoning = "high"): string {
  const endpoint = baseUrl.trim() || "https://api.openai.com/v1";
  return formatTomlObject({
    model_provider: "custom",
    model,
    model_reasoning_effort: reasoning,
    disable_response_storage: true,
    model_providers: {
      custom: {
        name: "custom",
        base_url: endpoint,
        wire_api: "responses",
        requires_openai_auth: true,
      },
    },
  });
}
