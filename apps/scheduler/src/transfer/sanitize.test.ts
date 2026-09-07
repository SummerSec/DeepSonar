import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { archiveJobStatus, parseTransferredAgentCli, parseTransferredDshTaskMode } from "./sanitize.js";

test("active imported Jobs archive to cancelled and keep original_status", () => {
  assert.deepEqual(archiveJobStatus("running"), { status: "cancelled", original_status: "running" });
  assert.deepEqual(archiveJobStatus("waiting_human"), { status: "cancelled", original_status: "waiting_human" });
  assert.deepEqual(archiveJobStatus("failed"), { status: "failed", original_status: "failed" });
});

test("transfer preserves valid DSH task modes and defaults legacy packs", () => {
  assert.equal(parseTransferredDshTaskMode(undefined, "role"), "standard");
  assert.equal(parseTransferredDshTaskMode("ptc", "role"), "ptc");
  assert.throws(() => parseTransferredDshTaskMode("auto", "role"), /dsh_task_mode/);
});

test("RoleConfig import accepts current CLIs and defaults missing values", () => {
  assert.equal(parseTransferredAgentCli(undefined, "role"), "claude-code");
  assert.equal(parseTransferredAgentCli("", "role"), "claude-code");
  assert.equal(parseTransferredAgentCli("pi", "role"), "pi");
  assert.equal(parseTransferredAgentCli("dsh", "全局 RoleConfig hub_reason"), "dsh");
});

test("RoleConfig import rejects leftover and unknown agent_cli", () => {
  assert.throws(() => parseTransferredAgentCli("codex", "RoleConfig audit"), /不再支持新配置/);
  assert.throws(() => parseTransferredAgentCli("open-code", "全局 RoleConfig explore"), /不再支持新配置/);
  assert.throws(() => parseTransferredAgentCli("custom-cli", "RoleConfig review"), /未知 agent_cli/);
});

test("project and platform rules import physically scrub leftover keys", () => {
  const importSource = readFileSync(new URL("./import.ts", import.meta.url), "utf8");
  const platformSource = readFileSync(new URL("./platform.ts", import.meta.url), "utf8");
  assert.match(importSource, /scrubLeftoverRulesJson/);
  assert.match(platformSource, /scrubLeftoverRulesJson/);
  assert.doesNotMatch(importSource, /cfg\.rules = \{ \.\.\.\(\(cfg\.rules as object\) \?\? \{\}\), \.\.\.rulesFile\.rules \}/);
});

test("project and platform RoleConfig import share the fail-closed CLI parser", () => {
  const importSource = readFileSync(new URL("./import.ts", import.meta.url), "utf8");
  const platformSource = readFileSync(new URL("./platform.ts", import.meta.url), "utf8");
  assert.match(importSource, /parseTransferredAgentCli\(rc\.agent_cli, `RoleConfig \$\{roleName\}`\)/);
  assert.match(platformSource, /parseTransferredAgentCli\(rc\.agent_cli, `全局 RoleConfig \$\{roleName\}`\)/);
  assert.doesNotMatch(importSource, /typeof rc\.agent_cli === "string" && rc\.agent_cli \? rc\.agent_cli : "claude-code"/);
  assert.doesNotMatch(platformSource, /typeof rc\.agent_cli === "string" && rc\.agent_cli \? rc\.agent_cli : "claude-code"/);
});
