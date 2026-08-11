import { createHash } from "node:crypto";

/** The platform-owned skill name is reserved in every real Agent workspace. */
export const DEEPSONAR_CONTROL_SKILL_NAME = "deepsonar-control" as const;

/** Static, bundled guidance; RoleConfig cannot replace this skill by name. */
export const DEEPSONAR_CONTROL_SKILL = {
  name: DEEPSONAR_CONTROL_SKILL_NAME,
  files: {
    "SKILL.md": `---
name: deepsonar-control
description: Use the governed DeepSonar Job control API or deepsonar-control MCP for runtime proposals and completion.
---

# DeepSonar runtime control

This platform-owned skill is present in every real Job. It cannot be replaced
by a RoleConfig skill with the same name.

## One transport per operation

The local \`deepsonar-control\` MCP and the Job-scoped HTTP control API submit
to the same Scheduler event stream. For each logical operation choose exactly
one transport. Never submit the same operation through both channels or switch
channels after an accepted request. Ordinary text is never a submission.

## Discovery and authorization

\`DEEPSONAR_API_BASE_URL\` already points to \`/control/v1/jobs/:jobId\`. Do not
append another job id and do not guess management routes. First call
\`GET $DEEPSONAR_API_BASE_URL/capabilities\`; for the machine-readable contract
call \`GET $DEEPSONAR_API_BASE_URL/openapi.json\`. Invoke an enabled
operation with \`POST $DEEPSONAR_API_BASE_URL/operations/:operationId\`.
Discovery is authoritative for enabled operations and schemas.

Send \`Authorization: Bearer $DEEPSONAR_API_TOKEN\`, Accept JSON, and JSON
Content-Type for JSON bodies. Never print, log, quote, copy, commit, write, or
put either API environment value into a URL, payload, evidence, or artifact.
The API is not the management API: it cannot create arbitrary Jobs, read the
database, control containers, or change RoleConfig.

## Idempotency and retries

Every API operation request needs a canonical UUID \`Idempotency-Key\` (use a
fresh key for a new read or mutation).
Keep the key unchanged for retries of the same operation and exact payload;
never reuse it for another operation. Retry only discovery-listed transient
errors (normally 429/502/503/504) with bounded backoff and the same key. Do
not retry validation, authorization, duplicate, terminal, or policy errors.
If a request times out, only retry that same request with that same key; do not
switch to MCP or create a new key until a definitive response arrives.

## Operations and completion

Only operations in discovery and this Job's frozen \`platform_tools\` are
authorized. Follow the existing MCP schemas, including safe relative
\`payload_file\` paths below /workspace, current YAML UUID references, and
Hub roles returned by \`list_available_roles\`. A Hub decision must precede
completion. Accepted API responses (or MCP
\`schema_validated / pending_scheduler_validation\`) acknowledge Scheduler
input; after required work finish with exactly one accepted
\`mark_job_done\` (or the equivalent MCP call).\n`,
  },
} as const;

/** Stable content hash used to make the bundled Skill identity auditable. */
export const DEEPSONAR_CONTROL_SKILL_SHA256 = createHash("sha256")
  .update(JSON.stringify(DEEPSONAR_CONTROL_SKILL))
  .digest("hex");

/** Remove any RoleConfig copy, then append the immutable platform skill. */
export function injectPlatformControlSkill(skills: readonly unknown[]): unknown[] {
  return [
    ...skills.filter((skill) => !skill || typeof skill !== "object" || Array.isArray(skill)
      || String((skill as { name?: unknown }).name ?? "") !== DEEPSONAR_CONTROL_SKILL_NAME),
    DEEPSONAR_CONTROL_SKILL,
  ];
}

/** Preserve the exact frozen operation list; the API domain must not widen it. */
export function frozenPlatformOperations(snapshotTools: readonly string[]): string[] {
  return [...snapshotTools];
}

export interface PlatformApiBaseOptions {
  baseUrl: string;
  jobId: string;
}

/** Build the Job-scoped discovery URL injected into the sandbox. */
export function platformApiBaseUrl(input: PlatformApiBaseOptions): string {
  const raw = input.baseUrl.trim().replace(/\/+$/, "");
  if (!raw) throw new Error("platform control API base URL is empty");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("platform control API base URL is invalid"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("platform control API base URL must use HTTP(S)");
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error("platform control API base URL must be sandbox-reachable, not localhost");
  }
  if (!url.pathname.endsWith("/control/v1")) throw new Error("platform control API base URL must end in /control/v1");
  return `${raw}/jobs/${encodeURIComponent(input.jobId)}`;
}

export interface FrozenSharedAsset { [key: string]: unknown; scope?: string; key?: string; mount_path?: string; read_path?: string; }

/** Filter an already sanitized, frozen shared-asset catalog for API JSON. */
export function filterFrozenSharedAssets(
  catalog: Record<string, unknown>,
  input: { scope?: unknown; prefix?: unknown; limit?: unknown; offset?: unknown } = {},
): Record<string, unknown> {
  const scope = typeof input.scope === "string" ? input.scope : undefined;
  const prefix = typeof input.prefix === "string" ? input.prefix : undefined;
  const all = Array.isArray(catalog.assets) ? catalog.assets : [];
  const matched = all.filter((asset): asset is FrozenSharedAsset => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) return false;
    const candidate = asset as FrozenSharedAsset;
    return (!scope || candidate.scope === scope) && (!prefix || String(candidate.key ?? "").startsWith(prefix));
  });
  const rawLimit = Number.isSafeInteger(input.limit) ? Number(input.limit) : 100;
  const rawOffset = Number.isSafeInteger(input.offset) ? Number(input.offset) : 0;
  const limit = Math.max(0, Math.min(rawLimit, 500));
  const offset = Math.max(0, rawOffset);
  const assets = matched.slice(offset, offset + limit).map((asset) => ({
    ...asset,
    mount_path: asset.mount_path ?? asset.read_path ?? null,
    read_path: asset.read_path ?? asset.mount_path ?? null,
  }));
  return { ...catalog, readonly: true, assets, total: matched.length, limit, offset,
    next_offset: offset + assets.length < matched.length ? offset + assets.length : null };
}
