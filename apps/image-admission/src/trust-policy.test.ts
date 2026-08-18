import assert from "node:assert/strict";
import test from "node:test";
import { shouldRevokeOnScanFailure } from "./trust-policy.js";

test("official trusted versions survive Cosign CLI, unsigned, and scanner config failures", () => {
  for (const errorMessage of [
    "scanner_misconfigured: --certificate-identity or --certificate-identity-regexp is required",
    "unsigned: no matching signatures",
    "Get https://ghcr.io/: dial tcp: i/o timeout",
  ]) {
    assert.equal(shouldRevokeOnScanFailure({
      sourceKind: "official",
      trustStatus: "trusted",
      restoreOfficialTrust: false,
      errorMessage,
    }), false);
  }
});

test("official trusted versions survive network or pull failures", () => {
  assert.equal(shouldRevokeOnScanFailure({
    sourceKind: "official",
    trustStatus: "trusted",
    restoreOfficialTrust: false,
    errorMessage: "official registry unavailable; using bundled fallback",
  }), false);
  assert.equal(shouldRevokeOnScanFailure({
    sourceKind: "official",
    trustStatus: "trusted",
    restoreOfficialTrust: true,
    errorMessage: "Get https://ghcr.io/: dial tcp: i/o timeout",
  }), false);
});

test("official trusted versions still revoke on admission policy failure", () => {
  assert.equal(shouldRevokeOnScanFailure({
    sourceKind: "official",
    trustStatus: "trusted",
    restoreOfficialTrust: false,
    errorMessage: "admission policy failed: critical=2, secrets=0",
  }), true);
});

test("third-party trusted versions still revoke on any scan failure", () => {
  assert.equal(shouldRevokeOnScanFailure({
    sourceKind: "third_party",
    trustStatus: "trusted",
    restoreOfficialTrust: false,
    errorMessage: "registry not allowed: example.com",
  }), true);
});
