import { ModelDescriptor, type ModelDescriptor as Descriptor, type ModelLimitSource } from "@deepsonar/shared-types";
import { normalizeModelCatalog } from "../../credentials.js";
import { descriptorsFromStringCatalog } from "./descriptors.js";

/** Conflicting or malformed declarations stay unknown; never coerce provider strings. */
function limit(row: Record<string, unknown>, keys: Array<"context_length" | "context_window" | "contextWindow" | "max_output_tokens" | "maxTokens">, minimum: number) {
  const present = keys.filter((key) => row[key] !== undefined);
  if (present.length === 0) return { value: null, field: null, status: "missing" as const };
  const values = present.map((key) => row[key]);
  const valid = values.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= 10_000_000);
  if (!valid || values.some((value) => value !== values[0])) {
    return { value: null, field: present[0]!, status: "invalid" as const };
  }
  return { value: values[0] as number, field: present[0]!, status: "declared" as const };
}

/** Bounded allowlist projection: no provider body, endpoint or secrets survive. */
export function descriptorsFromModelDiscovery(input: {
  provider: string;
  rows: unknown[];
  catalogRevision: string;
}): Descriptor[] {
  const ids = normalizeModelCatalog(input.rows.map((row) => typeof row === "string" ? row
    : row && typeof row === "object" && "id" in row ? row.id : null));
  return ids.map((id) => {
    const matches = input.rows.filter((row) => typeof row === "string" ? row.trim() === id
      : row && typeof row === "object" && "id" in row && typeof row.id === "string" && row.id.trim() === id);
    const declarations = matches.map((raw) => {
      const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return { context: limit(row, ["context_window", "context_length", "contextWindow"], 1024), output: limit(row, ["max_output_tokens", "maxTokens"], 1) };
    });
    const merge = (key: "context" | "output") => {
      const first = declarations[0]![key];
      return declarations.every((row) => row[key].value === first.value && row[key].status === first.status)
        ? first : { value: null, field: first.field, status: "invalid" as const };
    };
    const context = merge("context"), output = merge("output");
    const source: ModelLimitSource = {
      trust: "provider_declared", endpoint: "models_endpoint",
      context_window: { field: context.field, status: context.status },
      max_output_tokens: { field: output.field, status: output.status },
    };
    const base = descriptorsFromStringCatalog({ provider: input.provider, catalogJson: [id], catalogRevision: input.catalogRevision })[0]!;
    return ModelDescriptor.parse({ ...base, context_window: context.value, max_output_tokens: output.value, limit_source: source });
  });
}
