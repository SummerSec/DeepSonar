import { createHash } from "node:crypto";
import { z } from "zod";
import type { TaskContract } from "@deepsonar/shared-types";
import { taskContractDigest } from "../../task-outcome-snapshot.js";

/**
 * Scheduler-owned, read-only target authorization protocol.  The reference
 * adapter is intentionally small: it describes the save -> publish -> trigger
 * chain without performing any target write as part of authorization.
 */
export const TARGET_AUTHORIZATION_PROTOCOL = "deepsonar.target-authorization/v1" as const;
export const REFERENCE_TARGET_ADAPTER = "reference-http/v1" as const;
export const REFERENCE_TARGET_ACTIONS = [
  "reference-http.save",
  "reference-http.publish",
  "reference-http.trigger",
] as const;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REFERENCE_TARGET = /^reference-http\/v1:([a-z0-9][a-z0-9._-]{0,63})\/([a-z0-9][a-z0-9._-]{0,127})$/;

const token = z.string().trim().min(1).max(200).regex(TOKEN);
const hash = z.string().regex(SHA256);
const action = z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9.-]{0,79}$/);

const targetSchema = z.object({
  adapter: z.literal(REFERENCE_TARGET_ADAPTER),
  target_id: token,
}).strict();

const identitySchema = z.object({
  tenant: token,
  role: token,
  resource: token,
}).strict();

const bindingSchema = z.object({
  content_sha256: hash,
  task_contract_sha256: hash,
  revision: hash,
}).strict();

const freshnessSchema = z.object({
  requested_at: z.string().datetime({ offset: true }),
  max_age_seconds: z.number().int().positive().max(300),
}).strict();

const prerequisiteRequestSchema = z.object({
  id: token,
  state: z.literal("declared"),
}).strict();

const scopeSchema = z.object({
  project_id: token,
  target: targetSchema,
  principal_id: token,
  tenant: token,
  role: token,
  resource: token,
}).strict();

export const TargetAuthorizationRequest = z.object({
  protocol: z.literal(TARGET_AUTHORIZATION_PROTOCOL),
  authority_id: token,
  config_identity: hash,
  project_id: token,
  target: targetSchema,
  principal: z.object({ id: token }).strict(),
  identity: identitySchema,
  requested_actions: z.array(action).min(1).max(16),
  prerequisites: z.array(prerequisiteRequestSchema).max(100),
  binding: bindingSchema,
  freshness: freshnessSchema,
  expected_authority_revision: token.optional(),
}).strict();
export type TargetAuthorizationRequest = z.infer<typeof TargetAuthorizationRequest>;

const responseActionSchema = z.object({
  action,
  effect: z.enum(["allow", "deny"]),
}).strict();

const responsePrerequisiteSchema = z.object({
  id: token,
  status: z.enum(["satisfied", "unavailable", "unknown"]),
}).strict();

export const TargetAuthorizationResponse = z.object({
  protocol: z.literal(TARGET_AUTHORIZATION_PROTOCOL),
  authority_id: token,
  config_identity: hash,
  decision: z.enum(["allow", "deny"]),
  reason_code: z.enum([
    "not_authorized",
    "scope_mismatch",
    "prerequisite_unavailable",
    "revoked",
    "expired",
    "policy_changed",
  ]).optional(),
  authority_revision: token,
  expires_at: z.string().datetime({ offset: true }),
  scope: scopeSchema,
  actions: z.array(responseActionSchema).max(16),
  prerequisites: z.array(responsePrerequisiteSchema).max(100),
  binding: bindingSchema,
}).strict().superRefine((response, ctx) => {
  if (response.decision === "allow" && response.reason_code !== undefined) {
    ctx.addIssue({ code: "custom", path: ["reason_code"], message: "allow responses cannot carry reason_code" });
  }
  if (response.decision === "deny" && response.reason_code === undefined) {
    ctx.addIssue({ code: "custom", path: ["reason_code"], message: "deny responses require reason_code" });
  }
});
export type TargetAuthorizationResponse = z.infer<typeof TargetAuthorizationResponse>;

/** Secret-free identity of the authority configuration frozen with a Job. */
export interface TargetAuthorizationConfig {
  authorityUrl: string;
  authorityId: string;
  adapter: typeof REFERENCE_TARGET_ADAPTER;
  secretRef: string;
  requestedActions: readonly string[];
  maxAgeSeconds: number;
  timeoutMs: number;
  maxBodyBytes: number;
  configIdentity: string;
}

export class TargetAuthorizationConfigurationError extends Error {
  readonly code = "target_authorization_configuration_invalid" as const;
  constructor() {
    super("target authorization authority configuration is invalid");
    this.name = "TargetAuthorizationConfigurationError";
  }
}

/** Build a config from platform-owned values. Task/Job/Agent input never enters this function. */
export function createTargetAuthorizationConfig(input: {
  authorityUrl: string;
  authorityId: string;
  secretRef: string;
  requestedActions?: readonly string[];
  maxAgeSeconds?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
}): TargetAuthorizationConfig {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.authorityUrl);
  } catch {
    throw new TargetAuthorizationConfigurationError();
  }
  if (!(["http:", "https:"].includes(parsedUrl.protocol))
    || parsedUrl.username || parsedUrl.password || parsedUrl.hash
    || !TOKEN.test(input.authorityId)
    || !/^[A-Z][A-Z0-9_]{2,63}$/.test(input.secretRef)) {
    throw new TargetAuthorizationConfigurationError();
  }
  const requestedActions = (input.requestedActions ?? REFERENCE_TARGET_ACTIONS).map((value) => value.trim());
  if (requestedActions.length === 0
    || requestedActions.length > 16
    || requestedActions.some((value) => !REFERENCE_TARGET_ACTIONS.includes(value as typeof REFERENCE_TARGET_ACTIONS[number]))
    || requestedActions.length !== REFERENCE_TARGET_ACTIONS.length
    || requestedActions.some((value, index) => value !== REFERENCE_TARGET_ACTIONS[index])) {
    throw new TargetAuthorizationConfigurationError();
  }
  const maxAgeSeconds = input.maxAgeSeconds ?? 60;
  const timeoutMs = input.timeoutMs ?? 1500;
  const maxBodyBytes = input.maxBodyBytes ?? 64 * 1024;
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 300
    || !Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10_000
    || !Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 1024 * 1024) {
    throw new TargetAuthorizationConfigurationError();
  }
  const authorityUrl = parsedUrl.toString();
  const identityInput = JSON.stringify({
    protocol: TARGET_AUTHORIZATION_PROTOCOL,
    authority_id: input.authorityId,
    authority_url: authorityUrl,
    adapter: REFERENCE_TARGET_ADAPTER,
    secret_ref: input.secretRef,
    requested_actions: requestedActions,
    max_age_seconds: maxAgeSeconds,
    timeout_ms: timeoutMs,
    max_body_bytes: maxBodyBytes,
  });
  const configIdentity = `sha256:${createHash("sha256").update(identityInput).digest("hex")}`;
  return Object.freeze({
    authorityUrl,
    authorityId: input.authorityId,
    adapter: REFERENCE_TARGET_ADAPTER,
    secretRef: input.secretRef,
    requestedActions: Object.freeze(requestedActions),
    maxAgeSeconds,
    timeoutMs,
    maxBodyBytes,
    configIdentity,
  });
}

/** Read only platform-owned environment configuration. No task field is consulted. */
export function readTargetAuthorizationConfig(
  env: NodeJS.ProcessEnv = process.env,
): TargetAuthorizationConfig | undefined {
  const authorityUrl = env.DEEPSONAR_TARGET_AUTHORITY_URL?.trim() ?? "";
  if (!authorityUrl) return undefined;
  return createTargetAuthorizationConfig({
    authorityUrl,
    authorityId: env.DEEPSONAR_TARGET_AUTHORITY_ID?.trim() ?? "",
    secretRef: env.DEEPSONAR_TARGET_AUTHORITY_SECRET_REF?.trim() ?? "",
    requestedActions: env.DEEPSONAR_TARGET_AUTHORITY_ACTIONS
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    maxAgeSeconds: parseEnvInt(env.DEEPSONAR_TARGET_AUTHORITY_MAX_AGE_SECONDS, 60),
    timeoutMs: parseEnvInt(env.DEEPSONAR_TARGET_AUTHORITY_TIMEOUT_MS, 1500),
    maxBodyBytes: parseEnvInt(env.DEEPSONAR_TARGET_AUTHORITY_MAX_BODY_BYTES, 64 * 1024),
  });
}

function parseEnvInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

export function resolveTargetAuthorizationSecret(
  config: TargetAuthorizationConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env[config.secretRef];
  return value && value.length > 0 ? value : undefined;
}

export interface ReferenceTarget {
  adapter: typeof REFERENCE_TARGET_ADAPTER;
  tenant: string;
  resource: string;
  targetId: string;
}

/** The first supported target adapter has one canonical, non-URL descriptor. */
export function parseReferenceTarget(targets: readonly string[]): ReferenceTarget | undefined {
  if (targets.length !== 1) return undefined;
  const match = REFERENCE_TARGET.exec(targets[0] ?? "");
  if (!match) return undefined;
  const [, tenant, resource] = match;
  return {
    adapter: REFERENCE_TARGET_ADAPTER,
    tenant,
    resource,
    targetId: `${tenant}/${resource}`,
  };
}

export function targetBindingFromDigest(contentSha256: string, contractSha256: string) {
  if (!SHA256.test(contentSha256) || !SHA256.test(contractSha256)) {
    throw new Error("target authorization binding digest is invalid");
  }
  const revision = `sha256:${createHash("sha256").update(JSON.stringify({ content_sha256: contentSha256, task_contract_sha256: contractSha256 })).digest("hex")}`;
  return {
    content_sha256: contentSha256,
    task_contract_sha256: contractSha256,
    revision,
  } as const;
}

export function targetBinding(content: string, contract: TaskContract) {
  const contentSha256 = `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
  return targetBindingFromDigest(contentSha256, taskContractDigest(contract));
}

export type TargetAuthorizationScope = z.infer<typeof scopeSchema>;

export const TargetAuthorizationSnapshot = z.object({
  protocol: z.literal(TARGET_AUTHORIZATION_PROTOCOL),
  authority_id: token,
  config_identity: hash,
  adapter: z.literal(REFERENCE_TARGET_ADAPTER),
  project_id: token,
  target_id: token,
  principal_id: token,
  tenant: token,
  role: token,
  resource: token,
  requested_actions: z.array(action).min(1).max(16),
  prerequisite_ids: z.array(token).max(100),
  content_sha256: hash,
  task_contract_sha256: hash,
  revision: hash,
  authority_revision: token,
  decision_expires_at: z.string().datetime({ offset: true }),
}).strict();
export type TargetAuthorizationSnapshot = z.infer<typeof TargetAuthorizationSnapshot>;

export function makeTargetAuthorizationSnapshot(
  request: TargetAuthorizationRequest,
  response: TargetAuthorizationResponse,
): TargetAuthorizationSnapshot {
  return TargetAuthorizationSnapshot.parse({
    protocol: TARGET_AUTHORIZATION_PROTOCOL,
    authority_id: request.authority_id,
    config_identity: request.config_identity,
    adapter: request.target.adapter,
    project_id: request.project_id,
    target_id: request.target.target_id,
    principal_id: request.principal.id,
    tenant: request.identity.tenant,
    role: request.identity.role,
    resource: request.identity.resource,
    requested_actions: [...request.requested_actions],
    prerequisite_ids: request.prerequisites.map((item) => item.id),
    content_sha256: request.binding.content_sha256,
    task_contract_sha256: request.binding.task_contract_sha256,
    revision: request.binding.revision,
    authority_revision: response.authority_revision,
    decision_expires_at: response.expires_at,
  });
}

export function snapshotMatchesRequest(
  snapshot: TargetAuthorizationSnapshot,
  request: TargetAuthorizationRequest,
): boolean {
  return snapshot.protocol === request.protocol
    && snapshot.authority_id === request.authority_id
    && snapshot.config_identity === request.config_identity
    && snapshot.adapter === request.target.adapter
    && snapshot.project_id === request.project_id
    && snapshot.target_id === request.target.target_id
    && snapshot.principal_id === request.principal.id
    && snapshot.tenant === request.identity.tenant
    && snapshot.role === request.identity.role
    && snapshot.resource === request.identity.resource
    && JSON.stringify(snapshot.requested_actions) === JSON.stringify(request.requested_actions)
    && JSON.stringify(snapshot.prerequisite_ids) === JSON.stringify(request.prerequisites.map((item) => item.id))
    && snapshot.content_sha256 === request.binding.content_sha256
    && snapshot.task_contract_sha256 === request.binding.task_contract_sha256
    && snapshot.revision === request.binding.revision;
}
