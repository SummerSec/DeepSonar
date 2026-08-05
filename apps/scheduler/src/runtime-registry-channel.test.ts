import assert from "node:assert/strict";
import test from "node:test";
import { requiredScopeForRoute } from "./auth.js";
import { RUNTIME_IMAGE_REGISTRY_CHANNELS } from "./runtime-image-registry-contract.js";
import { RuntimeImageRegistryChannelBody } from "./routes.js";

test("runtime registry channel route requires the management scope", () => {
  assert.equal(requiredScopeForRoute("PATCH", "/runtime-images/registry/channel"), "images:manage");
  assert.equal(requiredScopeForRoute("GET", "/runtime-images/registry"), "images:read");
});

test("runtime registry channel body is exactly one supported channel", () => {
  for (const channel of RUNTIME_IMAGE_REGISTRY_CHANNELS) {
    assert.equal(RuntimeImageRegistryChannelBody.safeParse({ channel }).success, true);
  }
  assert.equal(RuntimeImageRegistryChannelBody.safeParse({ channel: "ghcr" }).success, false);
  assert.equal(RuntimeImageRegistryChannelBody.safeParse({ channel: "github", extra: true }).success, false);
  assert.equal(RuntimeImageRegistryChannelBody.safeParse({}).success, false);
});
