import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_CLI_BUILTIN_DEFAULT_MODELS,
  ModelCatalogMismatchError,
  assertResolvedModelInCredentialCatalog,
  bareUpstreamModelId,
  formatCliDefaultUpstreamModel,
  isCliDefaultUpstreamModel,
  modelMatchesCredentialCatalog,
  resolveModelSource,
  resolveRequestedModel,
  snapshotUpstreamModel,
} from "./provider-effective-model.js";
import { projectProviderRuntimeSnapshot } from "./provider-settings.js";

test("claude-code builtin default is pinned for empty RoleConfig/settings", () => {
  assert.equal(AGENT_CLI_BUILTIN_DEFAULT_MODELS["claude-code"], "claude-opus-5");
  assert.equal(
    resolveRequestedModel({
      roleModel: null,
      agentCli: "claude-code",
      settingsConfig: {},
      includeCliDefault: true,
    }),
    "claude-opus-5",
  );
  assert.equal(
    resolveModelSource({ roleModel: null, agentCli: "claude-code", settingsConfig: {} }),
    "cli_default",
  );
});

test("projectProviderRuntimeSnapshot freezes cli-default marker when model unspecified", () => {
  const projection = projectProviderRuntimeSnapshot({
    agentCli: "claude-code",
    roleModel: null,
    settingsConfig: {},
    defaultModel: null,
  });
  assert.equal(projection.model, null);
  assert.equal(projection.upstream_model, "cli-default:claude-opus-5");
  assert.equal(isCliDefaultUpstreamModel(projection.upstream_model), true);
  assert.equal(snapshotUpstreamModel(projection), "claude-opus-5");
  assert.equal(bareUpstreamModelId(projection.upstream_model), "claude-opus-5");
  assert.equal(formatCliDefaultUpstreamModel("claude-opus-5"), "cli-default:claude-opus-5");
});

test("catalog fail-closed when CLI default not in credential catalog", () => {
  assert.throws(
    () => assertResolvedModelInCredentialCatalog({
      resolvedModel: "claude-opus-5",
      catalogJson: ["deepseek-chat", "glm-4.6"],
      allowPassthrough: false,
      modelSource: "cli_default",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ModelCatalogMismatchError);
      assert.match(error.message, /角色未指定 model，CLI 默认 claude-opus-5 不在凭据模型目录/);
      assert.match(error.message, /deepseek-chat/);
      assert.match(error.message, /glm-4\.6/);
      assert.equal(error.code, "model_not_in_catalog");
      assert.equal(error.repair.code, "model_not_in_catalog");
      assert.equal(error.repair.category, "model_correctable");
      assert.ok(error.repair.next_action);
      return true;
    },
  );
});

test("catalog allow-passthrough skips fail-closed for alias gateways", () => {
  assert.doesNotThrow(() => assertResolvedModelInCredentialCatalog({
    resolvedModel: "claude-opus-5",
    catalogJson: ["deepseek-chat"],
    allowPassthrough: true,
    modelSource: "cli_default",
  }));
});

test("empty catalog soft-degrades and does not fail closed", () => {
  assert.doesNotThrow(() => assertResolvedModelInCredentialCatalog({
    resolvedModel: "claude-opus-5",
    catalogJson: [],
    allowPassthrough: false,
    modelSource: "cli_default",
  }));
  assert.equal(modelMatchesCredentialCatalog("claude-opus-5", []), false);
});

test("catalog match annotation uses bare model id", () => {
  assert.equal(
    modelMatchesCredentialCatalog("cli-default:deepseek-chat", ["deepseek-chat", "glm-4.6"]),
    true,
  );
  assert.equal(modelMatchesCredentialCatalog("claude-opus-5", ["deepseek-chat"]), false);
});

test("settings-declared model still wins over CLI default", () => {
  assert.equal(
    resolveRequestedModel({
      roleModel: null,
      agentCli: "claude-code",
      settingsConfig: { env: { ANTHROPIC_MODEL: "grok-4.6" } },
      includeCliDefault: true,
    }),
    "grok-4.6",
  );
  assert.equal(
    resolveModelSource({
      roleModel: null,
      agentCli: "claude-code",
      settingsConfig: { env: { ANTHROPIC_MODEL: "grok-4.6" } },
    }),
    "settings",
  );
});
