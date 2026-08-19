#!/usr/bin/env node
import { computeFingerprint, PRESETS } from "./image-build-fingerprint.mjs";

function assert(cond, msg) {
  if (!cond) {
    console.error(msg);
    process.exit(1);
  }
}

const a = computeFingerprint({ preset: "deepsonar-base" });
const b = computeFingerprint({ preset: "deepsonar-base" });
assert(a.fingerprint === b.fingerprint, "fingerprint must be stable");
assert(a.src_tag === `src-${a.fingerprint}`, "src_tag format");
assert(a.fingerprint.length === 32, "fingerprint truncated to 32 hex chars");

const audit = computeFingerprint({ preset: "deepsonar-audit" });
assert(audit.fingerprint !== a.fingerprint, "base and audit fingerprints must differ");

const oh1 = computeFingerprint({
  preset: "deepsonar-openharmony-test",
  buildArgs: ["BASE_IMAGE=ghcr.io/x/deepsonar-base@sha256:aaa"],
});
const oh2 = computeFingerprint({
  preset: "deepsonar-openharmony-test",
  buildArgs: ["BASE_IMAGE=ghcr.io/x/deepsonar-base@sha256:bbb"],
});
assert(oh1.fingerprint !== oh2.fingerprint, "BASE_IMAGE digest must affect openharmony fingerprint");

for (const preset of ["deepsonar-chrome-audit", "deepsonar-chrome-test", "deepsonar-chrome-fuzz"]) {
  const first = computeFingerprint({ preset, buildArgs: ["BASE_IMAGE=ghcr.io/x/deepsonar-base@sha256:aaa"] });
  const second = computeFingerprint({ preset, buildArgs: ["BASE_IMAGE=ghcr.io/x/deepsonar-base@sha256:bbb"] });
  assert(first.fingerprint !== second.fingerprint, `${preset} must include the immutable BASE_IMAGE digest`);
}

const keys = Object.keys(PRESETS);
assert(keys.includes("deepsonar-kali-minimal"), "kali preset required");
assert(keys.includes("deepsonar-scheduler"), "scheduler preset required");
assert(keys.includes("deepsonar-assets-helper"), "assets-helper preset required");
assert(keys.includes("deepsonar-silo"), "silo preset required");
assert(keys.includes("deepsonar-chrome-audit") && keys.includes("deepsonar-chrome-test") && keys.includes("deepsonar-chrome-fuzz"), "Chrome presets required");

console.log(`image-build-fingerprint ok (${keys.length} presets)`);
