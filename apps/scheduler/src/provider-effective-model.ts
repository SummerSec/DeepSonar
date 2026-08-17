import { parseDshPiAiSettings } from "./dsh-pi-ai-settings.js";

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function extractModelFromSettings(agentCli: string, settingsConfig: unknown): string | null {
  const settings = asObject(settingsConfig);
  if (agentCli === "claude-code") {
    const env = asObject(settings.env);
    for (const model of [
      env.ANTHROPIC_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      env.ANTHROPIC_SMALL_FAST_MODEL,
    ]) {
      if (typeof model === "string" && model.trim()) return model.trim();
    }
    return null;
  }
  if (agentCli === "codex") {
    const config = typeof settings.config === "string" ? settings.config : "";
    const match = /^\s*model\s*=\s*(?:"([^"]+)"|'([^']+)')/m.exec(config);
    return match?.[1] || match?.[2] || null;
  }
  if (agentCli === "pi") {
    const providers = asObject(settings.providers);
    const providerEntries = Object.keys(providers).length > 0
      ? Object.values(providers)
      : [settings];
    for (const rawProvider of providerEntries) {
      const provider = asObject(rawProvider);
      const models = provider.models;
      if (Array.isArray(models)) {
        const model = models.find((item) => {
          const id = asObject(item).id;
          return typeof id === "string" && id.trim();
        });
        const id = asObject(model).id;
        if (typeof id === "string" && id.trim()) return id.trim();
      } else {
        const modelId = Object.keys(asObject(models)).find((id) => id.trim());
        if (modelId) return modelId.trim();
      }
    }
    return null;
  }
  if (agentCli === "dsh") return parseDshPiAiSettings(settingsConfig).modelIds[0] ?? null;
  const modelIds = Object.keys(asObject(settings.models));
  return modelIds.find((model) => model.trim())?.trim() ?? null;
}

export function resolveRequestedModel(input: {
  roleModel?: string | null;
  agentCli: string;
  settingsConfig: unknown;
}): string | null {
  const override = input.roleModel?.trim();
  return override || extractModelFromSettings(input.agentCli, input.settingsConfig);
}

/** Resolve the model ID that the upstream gateway will actually receive. */
export function resolveEffectiveModel(input: {
  roleModel?: string | null;
  agentCli: string;
  settingsConfig: unknown;
}): string | null {
  const requested = resolveRequestedModel(input);
  if (!requested || input.agentCli !== "claude-code") return requested;

  const env = asObject(asObject(input.settingsConfig).env);
  const aliasKey = ({
    fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
    sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  } as const)[requested.toLowerCase() as "fable" | "sonnet" | "opus" | "haiku"];
  if (!aliasKey) return requested;
  const mapped = env[aliasKey];
  if (typeof mapped === "string" && mapped.trim()) return mapped.trim();
  const main = env.ANTHROPIC_MODEL;
  return typeof main === "string" && main.trim() ? main.trim() : requested;
}

export function snapshotUpstreamModel(snapshot: { model?: unknown; upstream_model?: unknown }): string | null {
  const upstream = typeof snapshot.upstream_model === "string" ? snapshot.upstream_model.trim() : "";
  if (upstream) return upstream;
  const requested = typeof snapshot.model === "string" ? snapshot.model.trim() : "";
  return requested || null;
}
