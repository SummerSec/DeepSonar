import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CREDENTIAL_BINDING_DEPRECATED,
  MODEL_NOT_IN_CATALOG,
  MODEL_PASSTHROUGH_DISABLED,
  admitModelAgainstCatalog,
  credentialBindingDeprecatedWarning,
  gatewayFrozenModelRepair,
} from "./model-catalog-admit.js";

test("admitModelAgainstCatalog soft-degrades on empty catalog", () => {
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

test("admitModelAgainstCatalog fail-closed with model_not_in_catalog", () => {
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
  assert.match(result.repair.next_action ?? "", /catalog_model_id|passthrough/);
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

test("admitModelAgainstCatalog strips [1m] before catalog match", () => {
  const result = admitModelAgainstCatalog({
    resolvedModel: "deepseek-chat[1m]",
    catalogJson: ["deepseek-chat"],
    allowPassthrough: false,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.resolved, "deepseek-chat");
});

test("credentialBindingDeprecatedWarning uses stable code", () => {
  const repair = credentialBindingDeprecatedWarning({ bindingCount: 1 });
  assert.equal(repair.code, CREDENTIAL_BINDING_DEPRECATED);
  assert.match(repair.message, /弃用/);
  assert.match(repair.next_action ?? "", /allowlist/);
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
