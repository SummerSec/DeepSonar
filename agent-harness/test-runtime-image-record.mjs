import assert from "node:assert/strict";
import { buildRegistryRecord } from "./runtime-image-record.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"b".repeat(64)}`;
const githubRef = "ghcr.io/summersec/deepsonar-base:0.1.0";

const available = buildRegistryRecord({
  channel: "github",
  configured: true,
  reference: githubRef,
  canonicalDigest: digest,
  inspectedDigest: digest,
});
assert.deepEqual(available, {
  available: true,
  ref: `ghcr.io/summersec/deepsonar-base@${digest}`,
  inspect_digest: digest,
  provenance: "build-push+inspect",
});

assert.throws(() => buildRegistryRecord({
  channel: "dockerhub",
  configured: true,
  reference: "docker.io/summersec/deepsonar-base:0.1.0",
  canonicalDigest: digest,
  inspectedDigest: otherDigest,
}), /does not equal canonical|digest/i);

assert.throws(() => buildRegistryRecord({
  channel: "dockerhub",
  configured: true,
  reference: "docker.io/summersec/deepsonar-base:0.1.0",
  canonicalDigest: digest,
  inspectError: new Error("registry fetch failed"),
}), /inspect failed/i);

const unavailable = buildRegistryRecord({
  channel: "aliyun-acr",
  configured: false,
  reference: "",
  canonicalDigest: digest,
  unavailableReason: "credentials_missing",
});
assert.deepEqual(unavailable, {
  available: false,
  provenance: "unavailable",
  reason: "credentials_missing",
});

assert.throws(() => buildRegistryRecord({
  channel: "dockerhub",
  configured: false,
  reference: "docker.io/summersec/deepsonar-base@" + digest,
  canonicalDigest: digest,
  unavailableReason: "credentials_missing",
}), /unavailable.*reference/i);
assert.throws(() => buildRegistryRecord({
  channel: "dockerhub",
  configured: true,
  reference: "docker.io/summersec/deepsonar-base:0.1.0",
  canonicalDigest: digest,
}), /inspect did not return a digest/i);

console.log("runtime image record equality, mismatch, inspect failure, unavailable, and reference fixtures passed");
