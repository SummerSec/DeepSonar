/** OpenSandbox upgrade pin (#162). Bump this file to upgrade; never use mutable latest. */

export const OPENSANDBOX_PIN_SCHEMA = "deepsonar.opensandbox/v1" as const;
export const OPENSANDBOX_SDK_VERSION = "0.1.11";
export const OPENSANDBOX_JOB_META = "deepsonar.job";
export const OPENSANDBOX_ATTEMPT_META = "deepsonar.attempt";

const IMMUTABLE_OCI_RE = /^.+@sha256:[0-9a-f]{64}$/;

export interface OpenSandboxPin {
  schema: typeof OPENSANDBOX_PIN_SCHEMA;
  sdk: string;
  serverImage: string | null;
  execdImage: string | null;
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
}): OpenSandboxPin {
  return {
    schema: OPENSANDBOX_PIN_SCHEMA,
    sdk: assertOpenSandboxSdkVersion(input.sdk ?? OPENSANDBOX_SDK_VERSION),
    serverImage: input.serverImage ? assertOpenSandboxImmutableRef(input.serverImage, "server") : null,
    execdImage: input.execdImage ? assertOpenSandboxImmutableRef(input.execdImage, "execd") : null,
  };
}
