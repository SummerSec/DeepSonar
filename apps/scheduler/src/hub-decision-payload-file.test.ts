import assert from "node:assert/strict";
import test from "node:test";
import { HubDecisionPayload, HubDecisionPayloadFile } from "@deepsonar/shared-types";

const rootId = "8b82371b-8e33-447f-98f9-013208f714c5";

test("HubDecisionPayloadFile accepts safe relative workspace paths", () => {
  assert.equal(HubDecisionPayloadFile.safeParse("hub_decision_payload.json").success, true);
  assert.equal(HubDecisionPayloadFile.safeParse("dir/decision.json").success, true);
});

test("HubDecisionPayloadFile rejects traversal and absolute paths", () => {
  assert.equal(HubDecisionPayloadFile.safeParse("../etc/passwd").success, false);
  assert.equal(HubDecisionPayloadFile.safeParse("/workspace/x.json").success, false);
  assert.equal(HubDecisionPayloadFile.safeParse("..\\x.json").success, false);
});

test("HubDecisionPayload accepts payload_file alone (tool_use truncation bypass)", () => {
  const parsed = HubDecisionPayload.safeParse({ payload_file: "hub_decision_payload.json" });
  assert.equal(parsed.success, true);
});

test("HubDecisionPayload rejects mixing payload_file with intents", () => {
  const parsed = HubDecisionPayload.safeParse({
    payload_file: "hub_decision_payload.json",
    intents: [
      {
        from: [rootId],
        role: "explore",
        description: "12345678",
        prompt: "p".repeat(40),
      },
    ],
  });
  assert.equal(parsed.success, false);
});

test("HubDecisionPayload still accepts normal intents without payload_file", () => {
  const parsed = HubDecisionPayload.safeParse({
    intents: [
      {
        from: [rootId],
        role: "explore",
        description: "12345678",
        prompt: "p".repeat(40),
      },
    ],
  });
  assert.equal(parsed.success, true);
});

test("HubIntentPayload accepts a marketplace runtime_image_key and rejects OCI references", () => {
  const withKey = HubDecisionPayload.safeParse({
    intents: [
      {
        from: [rootId],
        role: "test",
        description: "12345678",
        prompt: "p".repeat(40),
        runtime_image_key: "deepsonar-kali-minimal",
      },
    ],
  });
  assert.equal(withKey.success, true);
  for (const bad of [
    "ghcr.io/summersec/deepsonar-base:latest",
    "deepsonar-base@sha256:" + "a".repeat(64),
    "Deepsonar-Base",
    "a",
    "deepsonar_base",
  ]) {
    const parsed = HubDecisionPayload.safeParse({
      intents: [
        {
          from: [rootId],
          role: "test",
          description: "12345678",
          prompt: "p".repeat(40),
          runtime_image_key: bad,
        },
      ],
    });
    assert.equal(parsed.success, false, `must reject ${bad}`);
  }
});

test("HubIntentPayload accepts optional agent_cli and credential_id from Hub composition", () => {
  const cred = "11111111-1111-4111-8111-111111111111";
  const ok = HubDecisionPayload.safeParse({
    intents: [
      {
        from: [rootId],
        role: "explore",
        description: "12345678",
        prompt: "p".repeat(40),
        agent_cli: "dsh",
        credential_id: cred,
        runtime_image_key: "deepsonar-chrome-fuzz",
      },
    ],
  });
  assert.equal(ok.success, true);
  assert.equal(ok.success && ok.data.intents?.[0]?.agent_cli, "dsh");
  assert.equal(ok.success && ok.data.intents?.[0]?.credential_id, cred);

  for (const bad of ["codex", "claude", "", "DSH"]) {
    const parsed = HubDecisionPayload.safeParse({
      intents: [
        {
          from: [rootId],
          role: "explore",
          description: "12345678",
          prompt: "p".repeat(40),
          agent_cli: bad,
        },
      ],
    });
    assert.equal(parsed.success, false, `must reject agent_cli=${bad}`);
  }

  const badCred = HubDecisionPayload.safeParse({
    intents: [
      {
        from: [rootId],
        role: "explore",
        description: "12345678",
        prompt: "p".repeat(40),
        credential_id: "not-a-uuid",
      },
    ],
  });
  assert.equal(badCred.success, false);
});

test("HubIntentPayload accepts governed model proposals and capability requirements", () => {
  const parsed = HubDecisionPayload.safeParse({
    intents: [{
      from: [rootId],
      role: "explore",
      description: "选择满足能力的模型",
      prompt: "p".repeat(40),
      model_ref: "claude-sonnet-4-5",
      model_requirements: {
        min_context_window: 100_000,
        require_tools: true,
        reasoning_effort: "high",
      },
    }],
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.success && parsed.data.intents?.[0]?.model_ref, "claude-sonnet-4-5");
});
