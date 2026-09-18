import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LANGUAGE_SERVER_UNAVAILABLE_CODE,
  FrozenLanguageServerCapability,
} from "@deepsonar/shared-types";
import { buildCapabilityCatalog, describeCapability, listCapabilities } from "../capability-pack/discovery.js";
import {
  LANGUAGE_SERVER_CLANGD_ID,
  admitLanguageServerCapability,
  findLanguageServerCapability,
  freezeLanguageServerCapability,
  languageServerPackDigest,
  listLanguageServerCapabilities,
} from "./index.js";

test("catalog registers language-server.clangd with clangd metadata for C/C++ audit images", () => {
  const module = findLanguageServerCapability(LANGUAGE_SERVER_CLANGD_ID);
  assert.ok(module);
  assert.equal(module.server, "clangd");
  assert.deepEqual(module.languages, ["c", "cpp"]);
  assert.deepEqual(module.compatible_images, [
    "deepsonar-chrome-audit",
    "deepsonar-clickhouse-audit",
  ]);
  assert.deepEqual(module.operations, [
    "definition",
    "references",
    "hover",
    "document_symbol",
    "workspace_symbol",
    "diagnostics",
  ]);
  assert.equal(module.read_only, true);
  assert.equal(module.network, "disabled");
  assert.ok(module.requires.includes("compile_commands.json"));
  assert.ok(listLanguageServerCapabilities().some((item) => item.id === LANGUAGE_SERVER_CLANGD_ID));
});

test("list_capabilities / describe_capability expose language-server.clangd", () => {
  const catalog = buildCapabilityCatalog({});
  const listed = listCapabilities(catalog, { scope: "builtin" });
  assert.ok(listed.capabilities.some((item) => item.id === LANGUAGE_SERVER_CLANGD_ID));

  const described = describeCapability(catalog, { id: LANGUAGE_SERVER_CLANGD_ID });
  assert.equal(described.repair.length, 0);
  assert.equal(described.capability?.id, LANGUAGE_SERVER_CLANGD_ID);
  assert.equal(described.language_server?.server, "clangd");
  assert.equal(described.language_server?.read_only, true);
  assert.ok(languageServerPackDigest(LANGUAGE_SERVER_CLANGD_ID)?.startsWith("sha256:"));
});

test("admission rejects unregistered, incompatible image, missing precondition, and install attempts", () => {
  const unregistered = admitLanguageServerCapability({
    capabilityId: "language-server.unknown",
    imageKey: "deepsonar-chrome-audit",
    hasCompileCommands: true,
  });
  assert.equal(unregistered.ok, false);
  if (!unregistered.ok) {
    assert.equal(unregistered.code, LANGUAGE_SERVER_UNAVAILABLE_CODE);
    assert.equal(unregistered.reason, "unregistered");
    assert.equal(unregistered.repair.code, LANGUAGE_SERVER_UNAVAILABLE_CODE);
  }

  const badImage = admitLanguageServerCapability({
    capabilityId: LANGUAGE_SERVER_CLANGD_ID,
    imageKey: "deepsonar-base",
    hasCompileCommands: true,
  });
  assert.equal(badImage.ok, false);
  if (!badImage.ok) assert.equal(badImage.reason, "incompatible_image");

  const missing = admitLanguageServerCapability({
    capabilityId: LANGUAGE_SERVER_CLANGD_ID,
    imageKey: "deepsonar-chrome-audit",
    hasCompileCommands: false,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, "missing_precondition");
    assert.equal(missing.repair.category, "model_correctable");
  }

  const install = admitLanguageServerCapability({
    capabilityId: LANGUAGE_SERVER_CLANGD_ID,
    imageKey: "deepsonar-chrome-audit",
    hasCompileCommands: true,
    installRequested: true,
  });
  assert.equal(install.ok, false);
  if (!install.ok) assert.equal(install.reason, "install_forbidden");
});

test("admission freezes id/version/image/config fingerprint into job snapshot shape", () => {
  const admitted = admitLanguageServerCapability({
    capabilityId: LANGUAGE_SERVER_CLANGD_ID,
    imageKey: "deepsonar-clickhouse-audit",
    hasCompileCommands: true,
  });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;

  const frozen = FrozenLanguageServerCapability.parse(admitted.frozen);
  assert.equal(frozen.id, LANGUAGE_SERVER_CLANGD_ID);
  assert.equal(frozen.image_key, "deepsonar-clickhouse-audit");
  assert.equal(frozen.server, "clangd");
  assert.match(frozen.config_fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(frozen.read_only, true);
  assert.equal(frozen.network, "disabled");

  const module = findLanguageServerCapability(LANGUAGE_SERVER_CLANGD_ID)!;
  const again = freezeLanguageServerCapability({
    module,
    imageKey: "deepsonar-clickhouse-audit",
  });
  assert.equal(again.config_fingerprint, frozen.config_fingerprint);
});
