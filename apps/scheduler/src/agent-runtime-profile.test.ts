import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentRuntimeProfile,
} from "@deepsonar/shared-types";
import {
  agentRuntimeProfileFingerprint,
  freezeAgentRuntimeProfile,
  profileSystemPromptRef,
  UnsupportedAgentRuntimeProfileError,
} from "./agent-runtime-profile.js";

function profile(overrides: Record<string, unknown> = {}) {
  return {
    schema: "deepsonar.agent-runtime-profile/v1",
    profile_version: 1,
    agent_cli: "claude-code",
    provider_ref: { credential_id: "credential-1", provider: "anthropic" },
    model_ref: "claude-sonnet-4-5",
    reasoning_effort: "high",
    context_window_tokens: 200_000,
    extensions: [],
    system_prompt_ref: null,
    env_refs: [{ name: "ANTHROPIC_MODEL", source: "provider_profile" }],
    native_options: {
      claude_code: { model_env: "ANTHROPIC_MODEL", effort_level: "high" },
      pi: null,
      dsh: null,
    },
    resolution_order: ["global", "project", "role", "task", "job"],
    ...overrides,
  } as Parameters<typeof freezeAgentRuntimeProfile>[0];
}

test("runtime profile is strict, secret-free, and fingerprinted", () => {
  const frozen = freezeAgentRuntimeProfile(profile());
  assert.match(frozen.profile_fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(AgentRuntimeProfile.parse(frozen).provider_ref?.credential_id, "credential-1");
  assert.throws(() => AgentRuntimeProfile.parse({ ...frozen, api_key: "secret" }));
  const { profile_fingerprint: _, ...body } = frozen;
  assert.equal(frozen.profile_fingerprint, agentRuntimeProfileFingerprint(body));
});

test("profile fingerprint is independent of extension and env reference order", () => {
  const first = freezeAgentRuntimeProfile(profile({
    extensions: [{ id: "b", version: "1", integrity: "sha256:b" }, { id: "a", version: "1", integrity: "sha256:a" }],
    env_refs: [
      { name: "ZED", source: "role_config" },
      { name: "ANTHROPIC_MODEL", source: "provider_profile" },
    ],
  }));
  const second = freezeAgentRuntimeProfile(profile({
    extensions: [{ id: "a", version: "1", integrity: "sha256:a" }, { id: "b", version: "1", integrity: "sha256:b" }],
    env_refs: [
      { name: "ANTHROPIC_MODEL", source: "provider_profile" },
      { name: "ZED", source: "role_config" },
    ],
  }));
  assert.equal(first.profile_fingerprint, second.profile_fingerprint);
});

test("system prompt reference contains only an immutable digest", () => {
  const ref = profileSystemPromptRef({
    instructions: "system prompt with no secret value",
    roleConfigId: "role-config-1",
    roleConfigVersion: 3,
  });
  assert.equal(ref?.kind, "role_instructions");
  assert.match(ref?.sha256 ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(ref).includes("system prompt"), false);
  assert.equal(profileSystemPromptRef({ instructions: "   ", roleConfigId: null, roleConfigVersion: null }), null);
});

test("unsupported profile configuration has a stable error code", () => {
  assert.throws(
    () => freezeAgentRuntimeProfile(profile({ agent_cli: "unknown-cli" })),
    (error: unknown) => error instanceof UnsupportedAgentRuntimeProfileError && error.code === "unsupported_config",
  );
});
