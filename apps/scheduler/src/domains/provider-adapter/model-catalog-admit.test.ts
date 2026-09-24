import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MODEL_ALLOWLIST_UNCONFIGURED,
  MODEL_NOT_IN_CATALOG,
  MODEL_PASSTHROUGH_DISABLED,
  admitModelAgainstCatalog,
  gatewayFrozenModelRepair,
} from "./model-catalog-admit.js";

test("admitModelAgainstCatalog soft-degrades on empty configured allowlist", () => {
  const result = admitModelAgainstCatalog({
    resolvedModel: "claude-opus-5",
    catalogJson: [],
    allowPassthrough: false,
  });
  assert.equal(result.ok, true);
});

test("admitModelAgainstCatalog allows passthrough for emergency alias", () => {
  const result = admitModelAgainstCatalog({
    resolvedModel: "alias-model",
    catalogJson: ["deepseek-chat"],
    allowPassthrough: true,
  });
  assert.equal(result.ok, true);
});

test("admitModelAgainstCatalog fail-closed when outside configured allowlist", () => {
  const result = admitModelAgainstCatalog({
    resolvedModel: "claude-opus-5",
    catalogJson: ["deepseek-chat", "glm-4.6"],
    allowPassthrough: false,
    modelSourceHint: "cli_default",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, MODEL_NOT_IN_CATALOG);
  assert.equal(result.repair.code, MODEL_NOT_IN_CATALOG);
  assert.equal(result.repair.category, "model_correctable");
  assert.match(result.repair.message, /claude-opus-5/);
  assert.match(result.repair.next_action ?? "", /account_configured_model_id|passthrough/);
});

test("admitModelAgainstCatalog uses model_passthrough_disabled when emphasized", () => {
  const result = admitModelAgainstCatalog({
    resolvedModel: "free-form-alias",
    catalogJson: ["deepseek-chat"],
    allowPassthrough: false,
    modelSourceHint: "role",
    emphasizePassthrough: true,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, MODEL_PASSTHROUGH_DISABLED);
  assert.equal(result.repair.code, MODEL_PASSTHROUGH_DISABLED);
});

test("admitModelAgainstCatalog strips [1m] before configured-allowlist match", () => {
  const result = admitModelAgainstCatalog({
    resolvedModel: "deepseek-chat[1m]",
    catalogJson: ["deepseek-chat"],
    allowPassthrough: false,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.resolved, "deepseek-chat");
});

test("gatewayFrozenModelRepair is permanent_failure with model_not_in_catalog", () => {
  const repair = gatewayFrozenModelRepair({
    requestModel: "other",
    allowed: ["deepseek-chat"],
  });
  assert.equal(repair.code, MODEL_NOT_IN_CATALOG);
  assert.equal(repair.category, "permanent_failure");
  assert.match(repair.message, /other/);
});


test("empty configured allowlist fails when explicit role model is set (#679)", () => {
  const result = admitModelAgainstCatalog({
    resolvedModel: "DeepSeek-V4-Pro-0813",
    catalogJson: [],
    allowPassthrough: false,
    modelSourceHint: "role",
    emphasizePassthrough: true,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, MODEL_ALLOWLIST_UNCONFIGURED);
  assert.equal(result.repair.category, "model_correctable");
  assert.match(result.repair.message, /尚未配置 models/);
  assert.match(result.repair.message, /DeepSeek-V4-Pro-0813/);
});

test("empty configured allowlist still soft-degrades for CLI default (#679)", () => {
  const result = admitModelAgainstCatalog({
    resolvedModel: "claude-opus-5",
    catalogJson: [],
    allowPassthrough: false,
    modelSourceHint: "cli_default",
  });
  assert.equal(result.ok, true);
});

test("non-empty catalog mismatch lists sample models (#679)", () => {
  const result = admitModelAgainstCatalog({
    resolvedModel: "missing-model",
    catalogJson: ["DeepSeek-V4.1-Flash", "GLM-5.3", "GLM-5.3-Flash"],
    allowPassthrough: false,
    modelSourceHint: "role",
    emphasizePassthrough: true,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, MODEL_PASSTHROUGH_DISABLED);
  assert.match(result.repair.message, /DeepSeek-V4\.1-Flash/);
  assert.match(result.repair.message, /GLM-5\.3/);
  assert.deepEqual((result.repair.expected as { sample?: string[] } | undefined)?.sample, ["DeepSeek-V4.1-Flash", "GLM-5.3", "GLM-5.3-Flash"]);
});
