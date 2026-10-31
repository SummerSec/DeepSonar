import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeProfile, type FrozenAgentRuntimeProfile } from "@deepsonar/shared-types";
import { buildAgentRuntimeLaunchSpecification } from "./agent-runtime-profile-adapters.js";

const digest = `sha256:${"b".repeat(64)}`;

function frozenProfile(agent_cli: "claude-code" | "pi" | "dsh"): FrozenAgentRuntimeProfile {
  const native_options = {
    claude_code: agent_cli === "claude-code"
      ? { model_env: "ANTHROPIC_MODEL", effort_level: "high" }
      : null,
    pi: agent_cli === "pi"
      ? { model: "reasoning-model", provider: "anthropic", extensions: ["code-navigation"] }
      : null,
    dsh: agent_cli === "dsh"
      ? { task_mode: "ptc" as const, provider: "anthropic" }
      : null,
  };
  return AgentRuntimeProfile.parse({
    schema: "deepsonar.agent-runtime-profile/v1",
    profile_version: 1,
    agent_cli,
    provider_ref: { credential_id: "credential-1", provider: "anthropic" },
    model_ref: "reasoning-model",
    reasoning_effort: "high",
    context_window_tokens: 128_000,
    extensions: agent_cli === "pi"
      ? [{ id: "code-navigation", version: "1.0.0", integrity: "sha256-abc" }]
      : [],
    system_prompt_ref: null,
    env_refs: [{ name: "HTTP_PROXY", source: "role_config" }],
    native_options,
    resolution_order: ["global", "project", "role", "task", "job"],
    profile_fingerprint: digest,
  });
}

test("each current CLI gets an adapter-owned launch specification", () => {
  for (const cli of ["claude-code", "pi", "dsh"] as const) {
    const spec = buildAgentRuntimeLaunchSpecification(frozenProfile(cli), "deepsonar-base");
    assert.equal(spec.adapter_id, cli);
    assert.equal(spec.model_ref, "reasoning-model");
    assert.equal(spec.env_refs[0]?.name, "HTTP_PROXY");
    assert.equal(spec.profile_fingerprint, digest);
    assert.equal(spec.schema, "deepsonar.agent-runtime-launch/v1");
  }
});

test("adapter/image incompatibility fails closed", () => {
  assert.throws(
    () => buildAgentRuntimeLaunchSpecification(frozenProfile("pi"), "untrusted-image"),
    /AGENT_CLI_IMAGE_INCOMPATIBLE/,
  );
});

test("launch specification contains references, not provider secret values", () => {
  const spec = buildAgentRuntimeLaunchSpecification(frozenProfile("claude-code"), "deepsonar-base");
  assert.doesNotMatch(JSON.stringify(spec), /sk-live|Bearer\s+|api[_-]?key=/i);
});
