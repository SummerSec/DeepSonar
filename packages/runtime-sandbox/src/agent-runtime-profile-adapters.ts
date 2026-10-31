import type {
  FrozenAgentRuntimeProfile,
  RuntimeProfileExtensionRefType,
} from "@deepsonar/shared-types";
import { requireAgentCliRuntimeAdapter } from "./runtime-adapters.js";

export const AGENT_RUNTIME_LAUNCH_SPEC_SCHEMA = "deepsonar.agent-runtime-launch/v1" as const;

export interface AgentRuntimeLaunchSpecification {
  schema: typeof AGENT_RUNTIME_LAUNCH_SPEC_SCHEMA;
  adapter_id: FrozenAgentRuntimeProfile["agent_cli"];
  adapter_version: string;
  profile_fingerprint: string;
  model_ref: string | null;
  reasoning_effort: string | null;
  context_window_tokens: number | null;
  env_refs: FrozenAgentRuntimeProfile["env_refs"];
  extensions: RuntimeProfileExtensionRefType[];
  /** Only the selected adapter namespace is emitted; unknown options fail before launch. */
  native_options: Record<string, unknown>;
}

function nativeOptionsKey(
  agentCli: FrozenAgentRuntimeProfile["agent_cli"],
): keyof FrozenAgentRuntimeProfile["native_options"] {
  return agentCli === "claude-code" ? "claude_code" : agentCli;
}

function selectedNativeOptions(profile: FrozenAgentRuntimeProfile): Record<string, unknown> {
  const options = profile.native_options[nativeOptionsKey(profile.agent_cli)];
  return options ? structuredClone(options) as Record<string, unknown> : {};
}

function assertSecretFree(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertSecretFree(entry);
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /(?:sk-|bearer\s|api[_-]?key|secret|token=)/iu.test(value)) {
      throw new Error("unsupported_config: runtime launch specification contains secret material");
    }
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:api[_-]?key|access[_-]?token|secret|password|authorization)/iu.test(key)) {
      throw new Error("unsupported_config: runtime launch specification contains secret field");
    }
    assertSecretFree(entry);
  }
}

/**
 * Adapter boundary used by Scheduler before provisioning. It projects a frozen
 * Runtime Profile into a secret-free launch specification; credentials stay in
 * the Gateway and never become part of this contract.
 */
export function buildAgentRuntimeLaunchSpecification(
  profile: FrozenAgentRuntimeProfile,
  runtimeImageKey: string,
): AgentRuntimeLaunchSpecification {
  if (!profile.profile_fingerprint.startsWith("sha256:")) {
    throw new Error("AGENT_RUNTIME_LAUNCH_FINGERPRINT_INVALID");
  }
  const adapter = requireAgentCliRuntimeAdapter(profile.agent_cli, runtimeImageKey);
  const launch: AgentRuntimeLaunchSpecification = {
    schema: AGENT_RUNTIME_LAUNCH_SPEC_SCHEMA,
    adapter_id: adapter.id,
    adapter_version: adapter.version,
    profile_fingerprint: profile.profile_fingerprint,
    model_ref: profile.model_ref,
    reasoning_effort: profile.reasoning_effort,
    context_window_tokens: profile.context_window_tokens,
    env_refs: structuredClone(profile.env_refs),
    extensions: structuredClone(profile.extensions),
    native_options: selectedNativeOptions(profile),
  };
  assertSecretFree(launch);
  return launch;
}
