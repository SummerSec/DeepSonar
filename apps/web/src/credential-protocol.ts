import { parseDocument, stringify } from "yaml";

export const ANTHROPIC_WIRE_API = "anthropic-messages";
export const OPENAI_RESPONSES_WIRE_API = "openai-responses";

export function wireApiForProvider(provider: string): string {
  return provider === "anthropic" ? ANTHROPIC_WIRE_API : OPENAI_RESPONSES_WIRE_API;
}

export function providerFromWireApi(api: string): "anthropic" | "openai" | null {
  if (api === ANTHROPIC_WIRE_API) return "anthropic";
  if (api === OPENAI_RESPONSES_WIRE_API || api === "openai-completions") return "openai";
  return null;
}

export function preferredCliForProvider(compatible: readonly string[], current: string): string {
  if (compatible.includes(current)) return current;
  if (compatible.includes("pi")) return "pi";
  return compatible[0] ?? current;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function defaultDshPiAiSettings(provider: string, baseUrl: string): Record<string, unknown> {
  const anthropic = provider === "anthropic";
  const route = anthropic ? "anthropic" : "openai";
  const api = wireApiForProvider(provider);
  const endpoint = baseUrl.trim().replace(/\/+$/u, "") || (anthropic ? "https://api.anthropic.com" : "https://api.openai.com/v1");
  const model = anthropic ? "claude-sonnet-4-5" : "gpt-5";
  return {
    config: stringify({
      "llm-pi-ai": { providers: { [route]: { api, baseURL: endpoint, models: [{ id: model }] } } },
      "agent-default-model": { provider: route, model },
    }, { lineWidth: 0 }),
  };
}

export function defaultDshProviderYaml(provider: string, baseUrl: string): string {
  return String(defaultDshPiAiSettings(provider, baseUrl).config ?? "");
}

export function validateDshYamlText(text: string): { ok: boolean; empty: boolean; error?: string } {
  if (!text.trim()) return { ok: true, empty: true };
  const document = parseDocument(text, { customTags: [], prettyErrors: false });
  return document.errors.length > 0
    ? { ok: false, empty: false, error: document.errors[0]?.message ?? "YAML 解析失败" }
    : { ok: true, empty: false };
}

export function dshModelReasoningEfforts(text: string): ReadonlySet<string> | null {
  const document = parseDocument(text, { customTags: [], prettyErrors: false });
  if (document.errors.length > 0) return null;
  const root = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  const selected = root["agent-default-model"] as Record<string, unknown> | undefined;
  const route = typeof selected?.provider === "string" ? selected.provider : "";
  const modelId = typeof selected?.model === "string" ? selected.model : "";
  const piAi = root["llm-pi-ai"] as Record<string, unknown> | undefined;
  const providers = piAi?.providers as Record<string, unknown> | undefined;
  const profile = providers?.[route] as Record<string, unknown> | undefined;
  const models = Array.isArray(profile?.models) ? profile.models : [];
  const model = models.find((entry) => (entry as Record<string, unknown>)?.id === modelId) as Record<string, unknown> | undefined;
  if (model?.reasoningEfforts === false) return new Set(["off"]);
  if (!model?.reasoningEfforts || typeof model.reasoningEfforts !== "object" || Array.isArray(model.reasoningEfforts)) return null;
  return new Set(Object.keys(model.reasoningEfforts));
}

export function patchDshBaseUrl(settingsYaml: string, credentialProvider: string, baseUrl: string): string {
  if (!settingsYaml.trim()) return defaultDshProviderYaml(credentialProvider, baseUrl);
  const document = parseDocument(settingsYaml, { customTags: [], prettyErrors: false });
  if (document.errors.length > 0) return settingsYaml;
  const root = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  const defaultModel = root["agent-default-model"] as Record<string, unknown> | undefined;
  const route = typeof defaultModel?.provider === "string" ? defaultModel.provider : (credentialProvider === "anthropic" ? "anthropic" : "openai");
  const piAi = root["llm-pi-ai"] as Record<string, unknown> | undefined;
  const providers = piAi?.providers as Record<string, unknown> | undefined;
  const profile = asRecord(providers?.[route]);
  if (!profile) return settingsYaml;
  profile.baseURL = baseUrl.trim().replace(/\/+$/u, "");
  return stringify(root, { lineWidth: 0 });
}
