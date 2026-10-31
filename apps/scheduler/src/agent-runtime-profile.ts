import { createHash } from "node:crypto";
import {
  AGENT_RUNTIME_PROFILE_UNSUPPORTED_CONFIG,
  AgentRuntimeProfile,
  type FrozenAgentRuntimeProfile,
  type RuntimeProfileSystemPromptRef,
} from "@deepsonar/shared-types";

type ProfileBody = Omit<FrozenAgentRuntimeProfile, "profile_fingerprint">;

export class UnsupportedAgentRuntimeProfileError extends Error {
  readonly code = AGENT_RUNTIME_PROFILE_UNSUPPORTED_CONFIG;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UnsupportedAgentRuntimeProfileError";
  }
}

function canonicalProfileBody(input: ProfileBody): string {
  return JSON.stringify({
    ...input,
    extensions: [...input.extensions].sort((a, b) => a.id.localeCompare(b.id)),
    env_refs: [...input.env_refs].sort((a, b) => `${a.source}:${a.name}`.localeCompare(`${b.source}:${b.name}`)),
  });
}

export function agentRuntimeProfileFingerprint(input: ProfileBody): string {
  return `sha256:${createHash("sha256").update(canonicalProfileBody(input), "utf8").digest("hex")}`;
}

export function freezeAgentRuntimeProfile(input: ProfileBody): FrozenAgentRuntimeProfile {
  try {
    const normalized = {
      ...input,
      extensions: [...input.extensions],
      env_refs: [...input.env_refs],
      profile_fingerprint: agentRuntimeProfileFingerprint(input),
    };
    return AgentRuntimeProfile.parse(normalized);
  } catch (error) {
    throw new UnsupportedAgentRuntimeProfileError("Agent runtime profile contains unsupported configuration", { cause: error });
  }
}

export function profileSystemPromptRef(input: {
  instructions: string | null | undefined;
  roleConfigId: string | null;
  roleConfigVersion: number | null;
}): RuntimeProfileSystemPromptRef | null {
  const instructions = input.instructions?.trim() ?? "";
  if (!instructions) return null;
  return {
    kind: "role_instructions",
    sha256: `sha256:${createHash("sha256").update(instructions, "utf8").digest("hex")}`,
    role_config_id: input.roleConfigId,
    role_config_version: input.roleConfigVersion,
  };
}
