import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCosignVerifyArgs,
  resolveCosignVerifyPolicy,
  wrapCosignVerifyError,
} from "./cosign-verify.js";

const image = "ghcr.io/example/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("unconfigured Cosign 3 skips verify instead of emitting keyless verify", () => {
  const policy = resolveCosignVerifyPolicy({});
  assert.deepEqual(policy, { mode: "skip", reason: "unsigned_policy" });
  assert.throws(
    () => buildCosignVerifyArgs(image, policy),
    /must not run without --key or certificate identity/,
  );
});

test("partial keyless env is scanner_misconfigured and never builds verify args", () => {
  const policy = resolveCosignVerifyPolicy({
    DEEPSONAR_COSIGN_CERTIFICATE_IDENTITY: "https://github.com/org/repo/.github/workflows/release.yml@refs/tags/v1",
  });
  assert.equal(policy.mode, "misconfigured");
  assert.throws(() => buildCosignVerifyArgs(image, policy), /must not run/);
});

test("keyless Cosign 3 verify always includes identity and issuer", () => {
  const policy = resolveCosignVerifyPolicy({
    DEEPSONAR_COSIGN_CERTIFICATE_IDENTITY: "https://github.com/org/repo/.github/workflows/release.yml@refs/tags/v1",
    DEEPSONAR_COSIGN_CERTIFICATE_OIDC_ISSUER: "https://token.actions.githubusercontent.com",
  });
  const args = buildCosignVerifyArgs(image, policy);
  assert.equal(args[0], "verify");
  assert.ok(args.includes("--certificate-identity"));
  assert.ok(args.includes("--certificate-oidc-issuer"));
  assert.equal(args.at(-1), image);
  assert.equal(args.includes("--key"), false);
});

test("keyless regexp identity still requires an issuer and never omits identity flags", () => {
  const policy = resolveCosignVerifyPolicy({
    DEEPSONAR_COSIGN_CERTIFICATE_IDENTITY_REGEXP: "https://github.com/org/.*",
    DEEPSONAR_COSIGN_CERTIFICATE_OIDC_ISSUER_REGEXP: "https://token\\.actions\\.githubusercontent\\.com",
  });
  const args = buildCosignVerifyArgs(image, policy);
  assert.ok(args.includes("--certificate-identity-regexp"));
  assert.ok(args.includes("--certificate-oidc-issuer-regexp"));
  assert.equal(args.includes("--certificate-identity"), false);
});

test("public-key verify uses --key and does not require identity", () => {
  const policy = resolveCosignVerifyPolicy({ DEEPSONAR_COSIGN_KEY: "https://example.com/cosign.pub" });
  const args = buildCosignVerifyArgs(image, policy);
  assert.deepEqual(args, ["verify", "--output", "json", "--key", "https://example.com/cosign.pub", image]);
});

test("Cosign unsigned vs CLI/identity errors are classified separately from admission policy", () => {
  const unsigned = wrapCosignVerifyError(new Error("no matching signatures:\n..."));
  assert.match(unsigned.message, /^unsigned:/);
  const misconfigured = wrapCosignVerifyError({
    stderr: "--certificate-identity or --certificate-identity-regexp is required for verification in keyless mode",
  });
  assert.match(misconfigured.message, /^scanner_misconfigured:/);
  assert.equal(unsigned.message.startsWith("admission policy failed"), false);
  assert.equal(misconfigured.message.startsWith("admission policy failed"), false);
});
