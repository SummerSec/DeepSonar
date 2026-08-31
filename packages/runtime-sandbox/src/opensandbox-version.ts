/** OpenSandbox upgrade pin (#162). Bump this file to upgrade; never use mutable latest. */

export const OPENSANDBOX_PIN_SCHEMA = "deepsonar.opensandbox/v1" as const;
export const OPENSANDBOX_SDK_VERSION = "0.1.11";
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
  "docker.io/opensandbox/server@sha256:ae8dfbb277f40a39ff01ef35e5e1c10675acfe0fa9db15259b8f323e5efab778";
export const OPENSANDBOX_EXECD_IMAGE =
  "docker.io/opensandbox/execd@sha256:d358f23cb268779eaa71433ce0654a71cd9d016d429e57d7f245ad8f91b8ff7a";
export const OPENSANDBOX_EGRESS_IMAGE =
  "docker.io/opensandbox/egress@sha256:db7345d567b0970f384b8e3fa7a93a71b7f43d4b16bb2009de34096e9a87b3b5";

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
