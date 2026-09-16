import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  hubRuntimeImageCapability,
  officialHubRuntimeImageCapabilityKeys,
  toHubRuntimeImageCatalogEntry,
} from "./hub-runtime-image-capability.js";

test("Hub catalog capability fields cover official specialty keys Hub must match on", () => {
  const keys = officialHubRuntimeImageCapabilityKeys();
  for (const key of [
    "deepsonar-base",
    "deepsonar-audit",
    "deepsonar-kali-minimal",
    "deepsonar-chrome-test",
    "deepsonar-chrome-audit",
    "deepsonar-chrome-fuzz",
    "deepsonar-clickhouse-test",
    "deepsonar-clickhouse-audit",
    "deepsonar-clickhouse-fuzz",
    "deepsonar-openharmony-test",
    "deepsonar-mobile",
  ]) {
    assert.ok(keys.includes(key), key);
    const cap = hubRuntimeImageCapability(key);
    assert.ok(cap.purpose.length > 8, key);
    assert.ok(cap.tool_summary.length > 4, key);
    assert.ok(cap.not_included.length > 4, key);
    assert.ok(cap.selection_hints.length > 0, key);
    assert.ok(cap.capabilities.length > 0, key);
  }
  assert.match(hubRuntimeImageCapability("deepsonar-mobile").selection_hints.join(" "), /APK/);
  assert.match(hubRuntimeImageCapability("deepsonar-chrome-test").selection_hints.join(" "), /CDP|Chromium/);
  assert.match(hubRuntimeImageCapability("deepsonar-clickhouse-test").selection_hints.join(" "), /ClickHouse/);
});

test("unknown image keys still expose fail-closed capability boundaries for Hub", () => {
  const entry = toHubRuntimeImageCatalogEntry({
    image_key: "deepsonar-base",
    name: "Base",
    description: "base",
    official: true,
    project_opt_in: false,
    source_kind: "official",
  });
  assert.ok(entry);
  assert.equal("image_ref" in entry, false);
  assert.ok(entry.purpose);
  assert.ok(entry.not_included);

  const unknown = hubRuntimeImageCapability("third-party-custom");
  assert.match(unknown.not_included, /未登记|禁止/);
  assert.match(unknown.selection_hints.join(" "), /省略|缺省/);
});

test("matrix doc and platform-tools guide point Hub at the enriched catalog fields", () => {
  const matrix = readFileSync(new URL("../../../docs/RUNTIME_ROLE_IMAGE_MATRIX.md", import.meta.url), "utf8");
  assert.match(matrix, /list_available_runtime_images/);
  assert.match(matrix, /purpose|selection_hints|Hub/);
  const tools = readFileSync(new URL("./platform-tools.ts", import.meta.url), "utf8");
  assert.match(tools, /selection_hints/);
  assert.match(tools, /purpose/);
  assert.match(tools, /不得猜测|禁止.*猜/);
});
