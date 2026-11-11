import { buildAgentRuntimeLaunchSpecification } from "@deepsonar/runtime-sandbox";
import { freezeAgentRuntimeProfile } from "../../agent-runtime-profile.js";
import { hasProviderSettingsConfig, materializeProviderSettings } from "../../provider-settings.js";
import type { AgentRuntimeSnapshot } from "../role-runtime-snapshot/index.js";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Keep provider connectivity, discard role files/hooks/extensions, then fingerprint the actual launch. */
export function isolateKnowledgeConfiguration(snapshot: AgentRuntimeSnapshot) {
  if (!snapshot.runtime_profile) throw new Error("KNOWLEDGE_RUNTIME_PROFILE_MISSING");
  const settings = object(snapshot.settings_config_json);
  const cleanSettings = snapshot.agent_cli === "claude-code" && hasProviderSettingsConfig(settings) ? {
    env: Object.fromEntries(Object.entries(object(settings.env)).filter(([key]) =>
      /^ANTHROPIC_(?:MODEL|DEFAULT_.*_MODEL|SMALL_FAST_MODEL|BASE_URL|AUTH_TOKEN|API_KEY)$/.test(key))),
  } : settings;
  let configFiles = hasProviderSettingsConfig(settings)
    ? materializeProviderSettings({ agentCli: snapshot.agent_cli, settingsConfig: cleanSettings,
      overrides: { model: snapshot.model, reasoning: snapshot.reasoning, context_window_tokens: snapshot.context_window_tokens } }) : [];
  if (snapshot.agent_cli === "pi" && !configFiles.length) {
    const models = snapshot.config_files.find(file => file.path === ".pi/agent/models.json");
    if (models) configFiles = materializeProviderSettings({ agentCli: "pi",
      settingsConfig: { providers: object(JSON.parse(models.content)).providers }, overrides: { model: snapshot.model } });
  }
  const { profile_fingerprint: _fingerprint, ...body } = snapshot.runtime_profile;
  const runtimeProfile = freezeAgentRuntimeProfile({ ...body, extensions: [], system_prompt_ref: null,
    env_refs: body.env_refs.filter(ref => ref.source !== "role_config"),
    native_options: { ...body.native_options,
      pi: body.native_options.pi ? { ...body.native_options.pi, extensions: [], observational_memory: null } : null } });
  return { config_files: configFiles, settings_config_json: cleanSettings, pi_extensions: [], runtime_profile: runtimeProfile,
    agent_runtime_launch: buildAgentRuntimeLaunchSpecification(runtimeProfile, snapshot.runtime_image?.image_key ?? snapshot.runtime_image_key ?? "") };
}
