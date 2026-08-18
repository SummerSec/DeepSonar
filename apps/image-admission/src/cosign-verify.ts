function trimEnv(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() ?? "";
}

export type CosignVerifyPolicy =
  | { mode: "skip"; reason: "unsigned_policy" }
  | { mode: "misconfigured"; reason: string }
  | { mode: "key"; key: string }
  | {
      mode: "keyless";
      identity?: string;
      identityRegexp?: string;
      issuer?: string;
      issuerRegexp?: string;
    };

/** Cosign 3 keyless verify requires identity (or regexp) plus OIDC issuer (or regexp). */
export function resolveCosignVerifyPolicy(env: NodeJS.ProcessEnv = process.env): CosignVerifyPolicy {
  const key = trimEnv(env, "DEEPSONAR_COSIGN_KEY");
  const identity = trimEnv(env, "DEEPSONAR_COSIGN_CERTIFICATE_IDENTITY");
  const identityRegexp = trimEnv(env, "DEEPSONAR_COSIGN_CERTIFICATE_IDENTITY_REGEXP");
  const issuer = trimEnv(env, "DEEPSONAR_COSIGN_CERTIFICATE_OIDC_ISSUER");
  const issuerRegexp = trimEnv(env, "DEEPSONAR_COSIGN_CERTIFICATE_OIDC_ISSUER_REGEXP");
  const hasKeyless = Boolean(identity || identityRegexp || issuer || issuerRegexp);

  if (key && hasKeyless) {
    return { mode: "misconfigured", reason: "DEEPSONAR_COSIGN_KEY cannot be combined with certificate identity/issuer" };
  }
  if (key) return { mode: "key", key };

  const hasIdentity = Boolean(identity || identityRegexp);
  const hasIssuer = Boolean(issuer || issuerRegexp);
  if (hasIdentity && hasIssuer) {
    return {
      mode: "keyless",
      ...(identity ? { identity } : {}),
      ...(identityRegexp ? { identityRegexp } : {}),
      ...(issuer ? { issuer } : {}),
      ...(issuerRegexp ? { issuerRegexp } : {}),
    };
  }
  if (hasIdentity || hasIssuer) {
    return {
      mode: "misconfigured",
      reason: "keyless Cosign 3 verify needs identity (or regexp) and OIDC issuer (or regexp)",
    };
  }
  return { mode: "skip", reason: "unsigned_policy" };
}

export function buildCosignVerifyArgs(imageRef: string, policy: CosignVerifyPolicy): string[] {
  if (policy.mode === "skip" || policy.mode === "misconfigured") {
    throw new Error("scanner_misconfigured: Cosign 3 verify must not run without --key or certificate identity");
  }
  const args = ["verify", "--output", "json"];
  if (policy.mode === "key") {
    args.push("--key", policy.key);
  } else {
    if (policy.identity) args.push("--certificate-identity", policy.identity);
    if (policy.identityRegexp) args.push("--certificate-identity-regexp", policy.identityRegexp);
    if (policy.issuer) args.push("--certificate-oidc-issuer", policy.issuer);
    if (policy.issuerRegexp) args.push("--certificate-oidc-issuer-regexp", policy.issuerRegexp);
    if (!policy.identity && !policy.identityRegexp) {
      throw new Error("scanner_misconfigured: Cosign 3 keyless verify is missing --certificate-identity");
    }
    if (!policy.issuer && !policy.issuerRegexp) {
      throw new Error("scanner_misconfigured: Cosign 3 keyless verify is missing --certificate-oidc-issuer");
    }
  }
  args.push(imageRef);
  return args;
}

export function execErrorText(error: unknown): string {
  const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
  return [value?.stderr, value?.stdout, value?.message, error]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 800);
}

export function wrapCosignVerifyError(error: unknown): Error {
  const text = execErrorText(error);
  if (/no matching signatures|no signatures found|error verifying signature/i.test(text)) {
    return new Error(`unsigned: ${text}`);
  }
  return new Error(`scanner_misconfigured: ${text}`);
}

export type SignatureScanResult = {
  signature: unknown;
  status: "verified" | "skipped";
};

export function skippedSignatureResult(reason: "unsigned_policy"): SignatureScanResult {
  return {
    signature: { skipped: true, reason },
    status: "skipped",
  };
}
