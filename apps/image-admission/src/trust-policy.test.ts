import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateVulnerabilityAdmissionPolicy,
  shouldRevokeOnScanFailure,
} from "./trust-policy.js";

test("official 0.1.41-style Trivy critical>0 is not an admission gate", () => {
  assert.deepEqual(evaluateVulnerabilityAdmissionPolicy({
    sourceKind: "official",
    criticalCount: 19,
    secretCount: 0,
  }), { ok: true });
  assert.deepEqual(evaluateVulnerabilityAdmissionPolicy({
    sourceKind: "official",
    criticalCount: 2,
    secretCount: 3,
  }), { ok: true });
});

test("third-party still fails closed on CRITICAL or secrets", () => {
  assert.deepEqual(evaluateVulnerabilityAdmissionPolicy({
    sourceKind: "third_party",
    criticalCount: 1,
    secretCount: 0,
  }), { ok: false, message: "admission policy failed: critical=1, secrets=0" });
  assert.deepEqual(evaluateVulnerabilityAdmissionPolicy({
    sourceKind: "third_party",
    criticalCount: 0,
    secretCount: 2,
  }), { ok: false, message: "admission policy failed: critical=0, secrets=2" });
  assert.deepEqual(evaluateVulnerabilityAdmissionPolicy({
    sourceKind: "third_party",
    criticalCount: 0,
    secretCount: 0,
  }), { ok: true });
});

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

test("official trusted versions are not auto-revoked on admission policy / distro CRITICAL", () => {
  assert.equal(shouldRevokeOnScanFailure({
    sourceKind: "official",
    trustStatus: "trusted",
    restoreOfficialTrust: false,
    errorMessage: "admission policy failed: critical=19, secrets=0",
  }), false);
  assert.equal(shouldRevokeOnScanFailure({
    sourceKind: "official",
    trustStatus: "trusted",
    restoreOfficialTrust: true,
    errorMessage: "admission policy failed: critical=2, secrets=3",
  }), false);
});

test("third-party trusted versions still revoke on any scan failure", () => {
  assert.equal(shouldRevokeOnScanFailure({
    sourceKind: "third_party",
    trustStatus: "trusted",
    restoreOfficialTrust: false,
    errorMessage: "registry not allowed: example.com",
  }), true);
  assert.equal(shouldRevokeOnScanFailure({
    sourceKind: "third_party",
    trustStatus: "trusted",
    restoreOfficialTrust: false,
    errorMessage: "admission policy failed: critical=1, secrets=0",
  }), true);
});

test("third-party quarantined versions are not revoked by scan failure", () => {
  assert.equal(shouldRevokeOnScanFailure({
    sourceKind: "third_party",
    trustStatus: "scanning",
    restoreOfficialTrust: false,
    errorMessage: "admission policy failed: critical=1, secrets=0",
  }), false);
});
