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
  if (agentCli === "dsh" && Array.isArray(settings.models)) {
    const model = settings.models.map(asObject).find((item) => typeof item.id === "string" && item.id.trim());
    return typeof model?.id === "string" ? model.id.trim() : null;
  }
  const modelIds = Object.keys(asObject(settings.models));
  return modelIds.find((model) => model.trim())?.trim() ?? null;
}

export function resolveEffectiveModel(input: {
  roleModel?: string | null;
  agentCli: string;
  settingsConfig: unknown;
}): string | null {
  const override = input.roleModel?.trim();
  return override || extractModelFromSettings(input.agentCli, input.settingsConfig);
}
