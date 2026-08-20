import assert from "node:assert/strict";
import test from "node:test";
import {
  admissionPolicyFailureMessage,
  isAdmissionPolicyFailure,
  shouldRejectVulnerabilityFindings,
  shouldRevokeOnScanFailure,
} from "./trust-policy.js";

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

test("official catalog versions are not revoked for distro CRITICAL or secrets", () => {
  assert.equal(shouldRevokeOnScanFailure({
    sourceKind: "official",
    trustStatus: "trusted",
    restoreOfficialTrust: false,
    errorMessage: admissionPolicyFailureMessage(19, 0),
  }), false);
  assert.equal(shouldRevokeOnScanFailure({
    sourceKind: "official",
    trustStatus: "quarantined",
    restoreOfficialTrust: true,
    errorMessage: admissionPolicyFailureMessage(2, 3),
  }), false);
  assert.equal(shouldRejectVulnerabilityFindings({
    sourceKind: "official",
    criticalCount: 19,
    secretCount: 3,
  }), false);
});

test("third-party images still fail closed on CRITICAL or secrets", () => {
  assert.equal(shouldRejectVulnerabilityFindings({
    sourceKind: "third_party",
    criticalCount: 1,
    secretCount: 0,
  }), true);
  assert.equal(shouldRejectVulnerabilityFindings({
    sourceKind: "third_party",
    criticalCount: 0,
    secretCount: 1,
  }), true);
  assert.equal(shouldRejectVulnerabilityFindings({
    sourceKind: "third_party",
    criticalCount: 0,
    secretCount: 0,
  }), false);
  assert.equal(isAdmissionPolicyFailure(admissionPolicyFailureMessage(1, 0)), true);
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
    errorMessage: admissionPolicyFailureMessage(1, 0),
  }), true);
  assert.equal(shouldRevokeOnScanFailure({
    sourceKind: "third_party",
    trustStatus: "quarantined",
    restoreOfficialTrust: false,
    errorMessage: admissionPolicyFailureMessage(1, 0),
  }), false);
});
