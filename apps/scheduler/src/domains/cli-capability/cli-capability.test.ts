import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLI_UNAVAILABLE_CODE,
  FrozenCliCapability,
  FrozenCliCapabilityPack,
} from "@deepsonar/shared-types";
import { buildCapabilityCatalog, describeCapability, listCapabilities, searchCapabilities } from "../capability-pack/discovery.js";
import {
  PHASE1_CLI_CAPABILITY_IDS,
  admitCliCapabilities,
  admitCliCapability,
  availableCliCapabilityIdsForImage,
  cliCapabilityPackDigest,
  cliPackFingerprint,
  findCliCapability,
  freezeCliCapability,
  listCliCapabilities,
} from "./index.js";

const EXPECTED_IDS = [
  "text.search.rg",
  "file.discovery.fd",
  "json.query.jq",
  "yaml.query.yq",
  "source.control.git",
  "file.inspect.file",
  "evidence.hash.sha256sum",
  "patch.diff",
  "execution.timeout",
  "archive.extract",
] as const;

test("catalog registers exactly the 10 phase-1 CLI capability ids (offline)", () => {
  const listed = listCliCapabilities();
  assert.equal(listed.length, 10);
  assert.deepEqual([...PHASE1_CLI_CAPABILITY_IDS].sort(), [...EXPECTED_IDS].sort());
  for (const id of EXPECTED_IDS) {
    const module = findCliCapability(id);
    assert.ok(module, id);
    assert.equal(module.schema, "deepsonar.cli-capability/v1");
    assert.ok(module.binaries.length >= 1);
    assert.equal(module.network, "disabled");
    assert.ok(module.non_inferable_conclusions.length >= 1);
    assert.match(module.summary, /Governed|governed|phase 1/i);
  }
  assert.equal(findCliCapability("text.search.rg")?.tool, "rg");
  assert.equal(findCliCapability("text.search.rg")?.default_available, true);
  assert.equal(findCliCapability("file.discovery.fd")?.default_available, false);
  assert.equal(findCliCapability("yaml.query.yq")?.default_available, false);
  assert.equal(findCliCapability("patch.diff")?.default_available, false);
});

test("list_capabilities / search_capabilities / describe_capability expose CLI packs offline", () => {
  const catalog = buildCapabilityCatalog({});
  const listed = listCapabilities(catalog, { scope: "builtin", limit: 100 });
  for (const id of EXPECTED_IDS) {
    assert.ok(listed.capabilities.some((item) => item.id === id), `list missing ${id}`);
  }

  const searched = searchCapabilities(catalog, { query: "text.search", scope: "builtin" });
  assert.ok(searched.capabilities.some((item) => item.id === "text.search.rg"));

  const described = describeCapability(catalog, { id: "text.search.rg" });
  assert.equal(described.repair.length, 0);
  assert.equal(described.capability?.id, "text.search.rg");
  assert.equal(described.cli_capability?.tool, "rg");
  assert.equal(described.cli_capability?.default_available, true);
  assert.ok(cliCapabilityPackDigest("text.search.rg")?.startsWith("sha256:"));
});

test("admission rejects unregistered, install, tool_missing, and incompatible image", () => {
  const unregistered = admitCliCapability({
    capabilityId: "cli.unknown.tool",
    imageKey: "deepsonar-base",
  });
  assert.equal(unregistered.ok, false);
  if (!unregistered.ok) {
    assert.equal(unregistered.code, CLI_UNAVAILABLE_CODE);
    assert.equal(unregistered.reason, "unregistered");
  }

  const install = admitCliCapability({
    capabilityId: "text.search.rg",
    imageKey: "deepsonar-base",
    installRequested: true,
  });
  assert.equal(install.ok, false);
  if (!install.ok) assert.equal(install.reason, "install_forbidden");

  const missing = admitCliCapability({
    capabilityId: "file.discovery.fd",
    imageKey: "deepsonar-base",
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, "tool_missing");
    assert.equal(missing.repair.category, "model_correctable");
  }

  const yq = admitCliCapability({
    capabilityId: "yaml.query.yq",
    imageKey: "deepsonar-base",
  });
  assert.equal(yq.ok, false);
  if (!yq.ok) assert.equal(yq.reason, "tool_missing");

  // Force incompatible by admitting an available id against a nonsense image key.
  const badImage = admitCliCapability({
    capabilityId: "text.search.rg",
    imageKey: "not-a-real-image",
  });
  assert.equal(badImage.ok, false);
  if (!badImage.ok) assert.equal(badImage.reason, "incompatible_image");
});

test("admission freezes id/version/image/config fingerprint; pack fingerprint is stable", () => {
  const admitted = admitCliCapability({
    capabilityId: "json.query.jq",
    imageKey: "deepsonar-audit",
  });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;

  const frozen = FrozenCliCapability.parse(admitted.frozen);
  assert.equal(frozen.id, "json.query.jq");
  assert.equal(frozen.tool, "jq");
  assert.equal(frozen.image_key, "deepsonar-audit");
  assert.match(frozen.config_fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(frozen.network, "disabled");

  const module = findCliCapability("json.query.jq")!;
  const again = freezeCliCapability({ module, imageKey: "deepsonar-audit" });
  assert.equal(again.config_fingerprint, frozen.config_fingerprint);

  const set = admitCliCapabilities({
    ids: ["text.search.rg", "json.query.jq", "source.control.git"],
    imageKey: "deepsonar-base",
  });
  assert.equal(set.ok, true);
  if (!set.ok) return;
  const pack = FrozenCliCapabilityPack.parse(set.pack);
  assert.equal(pack.capabilities.length, 3);
  assert.match(pack.pack_fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(cliPackFingerprint(set.frozen), pack.pack_fingerprint);
  assert.equal(cliPackFingerprint([...set.frozen].reverse()), pack.pack_fingerprint);
});

test("Hub-facing available ids for base/audit include shipped CLI capabilities only", () => {
  const base = availableCliCapabilityIdsForImage("deepsonar-base");
  assert.ok(base.includes("text.search.rg"));
  assert.ok(base.includes("json.query.jq"));
  assert.ok(base.includes("source.control.git"));
  assert.ok(base.includes("archive.extract"));
  assert.ok(!base.includes("file.discovery.fd"));
  assert.ok(!base.includes("yaml.query.yq"));
  assert.ok(!base.includes("patch.diff"));
  assert.deepEqual(
    availableCliCapabilityIdsForImage("deepsonar-audit").sort(),
    base.sort(),
  );
});
