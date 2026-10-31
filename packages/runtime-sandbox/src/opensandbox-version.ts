/** OpenSandbox upgrade pin (#162; bump #661). Bump this file to upgrade; never use mutable latest. */

export const OPENSANDBOX_PIN_SCHEMA = "deepsonar.opensandbox/v1" as const;
export const OPENSANDBOX_SDK_VERSION = "1.1.0";
export const OPENSANDBOX_JOB_META = "deepsonar.job";
export const OPENSANDBOX_ATTEMPT_META = "deepsonar.attempt";

/** Same canonical UUID guard as Docker leftover enumeration. */
export const CANONICAL_RUNTIME_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isManagedRuntimeResource(resource: { jobId?: string | null; attemptId?: string | null }): boolean {
  return CANONICAL_RUNTIME_UUID_RE.test(String(resource.jobId ?? ""))
    && CANONICAL_RUNTIME_UUID_RE.test(String(resource.attemptId ?? ""));
}

/** Official multi-arch index digests. Bump with SDK; never latest. */
export const OPENSANDBOX_SERVER_IMAGE =
  "docker.io/opensandbox/server@sha256:68ca0212a2749b2c73096ce2ec0264455c64442c45f81007db442f52bf84c9d1";
export const OPENSANDBOX_EXECD_IMAGE =
  "docker.io/opensandbox/execd@sha256:e11fdd6fa641329a1fe5298e71c8dd2afca742674fe48bc855b2ff6715512829";
export const OPENSANDBOX_EGRESS_IMAGE =
  "docker.io/opensandbox/egress@sha256:56429c89b7175c2a24af62ca93a99776f03ea67a0beb74d63c8ddb34ff16fd97";

const IMMUTABLE_OCI_RE = /^.+@sha256:[0-9a-f]{64}$/;

export interface OpenSandboxPin {
  schema: typeof OPENSANDBOX_PIN_SCHEMA;
  sdk: string;
  serverImage: string;
  execdImage: string;
  egressImage: string;
}

export function assertOpenSandboxSdkVersion(version: string): string {
  const trimmed = version.trim();
  if (!trimmed || trimmed === "latest" || trimmed.startsWith("latest") || trimmed.endsWith("@latest")) {
    throw new Error("OPENSANDBOX_SDK_UNPINNED");
  }
  return trimmed;
}

export function assertOpenSandboxImmutableRef(ref: string, label: string): string {
  const trimmed = ref.trim();
  if (!trimmed || /(?:^|[/:])latest$/i.test(trimmed) || !IMMUTABLE_OCI_RE.test(trimmed)) {
    throw new Error(`OPENSANDBOX_PIN_UNPINNED: ${label}`);
  }
  return trimmed;
}

export function readOpenSandboxPin(input: {
  sdk?: string;
  serverImage?: string;
  execdImage?: string;
  egressImage?: string;
}): OpenSandboxPin {
  return {
    schema: OPENSANDBOX_PIN_SCHEMA,
    sdk: assertOpenSandboxSdkVersion(input.sdk ?? OPENSANDBOX_SDK_VERSION),
    serverImage: assertOpenSandboxImmutableRef(input.serverImage || OPENSANDBOX_SERVER_IMAGE, "server"),
    execdImage: assertOpenSandboxImmutableRef(input.execdImage || OPENSANDBOX_EXECD_IMAGE, "execd"),
    egressImage: assertOpenSandboxImmutableRef(input.egressImage || OPENSANDBOX_EGRESS_IMAGE, "egress"),
  };
}
