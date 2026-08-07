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
