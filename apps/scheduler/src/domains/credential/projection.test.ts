import assert from "node:assert/strict";
import test from "node:test";
import { MASKED_SECRET_PLACEHOLDER } from "../../credential-secret-projection.js";
import { projectJobSnapshot } from "./projection.js";

test("job snapshot projection keeps safe fields and recursively redacts settings/config files", () => {
  const projected = projectJobSnapshot({
    agent_cli: "claude-code",
    model: "claude-sonnet-4-5",
    credential_id: "cred-1",
    settings_config_json: {
      env: {
        ANTHROPIC_API_KEY: "long-lived-key",
        ANTHROPIC_BASE_URL: "https://gateway.example",
      },
      nested: [{ token: "nested-secret", value: "safe" }],
    },
    config_files: [{
      path: ".claude/settings.json",
      content: JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "long-lived-key", model: "claude-sonnet-4-5" } }),
      content_sha256: "hash",
    }],
  }) as Record<string, unknown>;

  assert.equal(projected.model, "claude-sonnet-4-5");
  assert.equal(projected.credential_id, "cred-1");
  const encoded = JSON.stringify(projected);
  assert.equal(encoded.includes("long-lived-key"), false);
  assert.ok(encoded.includes(MASKED_SECRET_PLACEHOLDER));
  const fileContent = String((projected.config_files as Array<Record<string, unknown>>)[0]?.content ?? "");
  assert.equal(fileContent.includes("long-lived-key"), false);
});
