import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AgentCliWriteSchema,
  CURRENT_AGENT_CLIS,
  leftoverAgentCliMigrationHint,
  rejectNonCurrentAgentCli,
} from "@deepsonar/shared-types";
import { AGENT_CLI_RUNTIME_ADAPTERS } from "@deepsonar/runtime-sandbox";
import { validateCredentialCompatibility } from "./credentials.js";
import { isProviderAgentCli, materializeProviderSettings } from "./provider-settings.js";

test("new RoleConfig writes accept only the current three CLIs", () => {
  assert.deepEqual([...CURRENT_AGENT_CLIS], ["claude-code", "pi", "dsh"]);
  for (const cli of CURRENT_AGENT_CLIS) {
    assert.equal(AgentCliWriteSchema.safeParse(cli).success, true);
    assert.equal(rejectNonCurrentAgentCli(cli), null);
  }
});

test("saving leftover agent_cli is rejected with a migration hint", () => {
  for (const leftover of ["codex", "open-code"] as const) {
    const parsed = AgentCliWriteSchema.safeParse(leftover);
    assert.equal(parsed.success, false);
    assert.match(rejectNonCurrentAgentCli(leftover) ?? "", /不再支持新配置/);
    assert.match(leftoverAgentCliMigrationHint(leftover), /claude-code（默认）、pi 或 dsh/);
    assert.match(leftoverAgentCliMigrationHint(leftover), /不会自动改写/);
  }
  assert.match(rejectNonCurrentAgentCli("custom-cli") ?? "", /未知 agent_cli/);
});

test("runtime adapter registry stays open but currently lists only three CLIs", () => {
  assert.deepEqual(Object.keys(AGENT_CLI_RUNTIME_ADAPTERS).sort(), ["claude-code", "dsh", "pi"]);
  const adaptersDoc = readFileSync(new URL("../../../docs/AGENT_CLI_RUNTIME_ADAPTERS.md", import.meta.url), "utf8");
  assert.match(adaptersDoc, /New adapter onboarding/);
  assert.match(adaptersDoc, /AGENT_CLI_RUNTIME_ADAPTERS/);
  assert.match(adaptersDoc, /RuntimeHost/);
  assert.match(adaptersDoc, /leftover|retired|已停用/);
  assert.doesNotMatch(adaptersDoc, /^\| `codex` \| Codex CLI /m);
  assert.doesNotMatch(adaptersDoc, /^\| `open-code` \| OpenCode /m);
});

test("leftover CLIs cannot materialize or bind new credentials", () => {
  assert.equal(isProviderAgentCli("codex"), false);
  assert.equal(isProviderAgentCli("open-code"), false);
  assert.equal(isProviderAgentCli("claude-code"), true);
  assert.match(validateCredentialCompatibility("codex", "openai") ?? "", /不再支持新配置/);
  assert.match(validateCredentialCompatibility("open-code", "anthropic") ?? "", /不再支持新配置/);
  assert.throws(
    () => materializeProviderSettings({ agentCli: "codex", settingsConfig: { auth: { OPENAI_API_KEY: "x" } } }),
    /不再支持新配置/,
  );
});
