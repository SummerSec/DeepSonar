import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "../../db.js";
import {
  PLATFORM_OPERATION_IDS,
  operationIdsFromSnapshot,
} from "./operations.js";

export const CAPABILITY_TOKEN_PREFIX = "deepsonarcap_";
export const DEFAULT_CAPABILITY_TTL_SEC = 15 * 60;

export const MINTABLE_JOB_STATUSES = new Set([
  "provisioning",
  "running",
]);

export const ACTIVE_JOB_STATUSES = new Set([
  "running",
]);

export const CAPABILITY_TOKEN_PATTERN = /^deepsonarcap_([0-9a-f]{8})_([A-Za-z0-9_-]{32,})$/;

export type CapabilityTokenErrorCode =
  | "CAPABILITY_TOKEN_INVALID"
  | "CAPABILITY_TOKEN_EXPIRED"
  | "CAPABILITY_TOKEN_REVOKED"
  | "CAPABILITY_JOB_NOT_ACTIVE"
  | "CAPABILITY_JOB_NOT_FOUND"
  | "CAPABILITY_OPERATION_NOT_ALLOWED"
  | "CAPABILITY_OPERATION_SNAPSHOT_INVALID";

export class CapabilityTokenError extends Error {
  readonly code: CapabilityTokenErrorCode;
  readonly statusCode: number;

  constructor(code: CapabilityTokenErrorCode, message: string, statusCode = 401) {
    super(message);
    this.name = "CapabilityTokenError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface CapabilityMintOptions {
  /** A caller may narrow a snapshot allowlist, but can never expand it. */
  operationIds?: readonly string[];
  /** Alias retained for executor adapters that call the field `operations`. */
  operations?: readonly string[];
  ttlSec?: number;
  now?: Date;
}

export interface CapabilityMintRequest extends CapabilityMintOptions {
  jobId: string;
}

export interface CapabilityTokenGrant {
  id: string;
  token: string;
  token_prefix: string;
  job_id: string;
  project_id: string;
  canvas_id: string | null;
  role_name: string;
  role_config_id: string | null;
  role_config_version: number | null;
  operation_ids: string[];
  issued_at: string;
  expires_at: string;
}

export interface CapabilityPrincipal {
  tokenId: string;
  tokenPrefix: string;
  jobId: string;
  projectId: string;
  canvasId: string | null;
  roleName: string;
  roleConfigId: string | null;
  roleConfigVersion: number | null;
  snapshotSha256: string;
  operationIds: readonly string[];
  issuedAt: string;
  expiresAt: string;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function hashJobSnapshot(snapshot: unknown): string {
  return createHash("sha256").update(stableJson(snapshot)).digest("hex");
}

export function generateCapabilityToken(): { plaintext: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${CAPABILITY_TOKEN_PREFIX}${prefix}_${secret}`;
  return {
    plaintext,
    prefix,
    hash: createHash("sha256").update(plaintext).digest("hex"),
  };
}

export function parseCapabilityToken(token: unknown): { prefix: string } | null {
  if (typeof token !== "string" || token.length > 512) return null;
  const match = CAPABILITY_TOKEN_PATTERN.exec(token);
  return match ? { prefix: match[1]! } : null;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function equalHash(expected: unknown, actual: string): boolean {
  if (typeof expected !== "string") return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function asDate(value: unknown, fallback: Date): Date {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function asNullableUuid(value: unknown): string | null {
  return isUuid(value) ? value : null;
}

function asSnapshotObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityTokenError("CAPABILITY_OPERATION_SNAPSHOT_INVALID", "Job capability snapshot is invalid", 409);
  }
  return value as Record<string, unknown>;
}

function resolveMintOptions(input: CapabilityMintOptions | readonly string[] | number | undefined): CapabilityMintOptions {
  if (Array.isArray(input)) return { operationIds: input };
  if (typeof input === "number") return { ttlSec: input };
  return input && typeof input === "object" ? input as CapabilityMintOptions : {};
}

function boundedTtlSeconds(value: unknown): number {
  if (value === undefined) return DEFAULT_CAPABILITY_TTL_SEC;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new CapabilityTokenError("CAPABILITY_OPERATION_SNAPSHOT_INVALID", "Capability token TTL is invalid", 400);
  }
  return value;
}

export interface CapabilityExpiryInput {
  now: Date;
  startedAt: Date | string | null | undefined;
  timeoutSec: number | string | null | undefined;
  leaseExpiresAt?: Date | string | null;
  ttlSec?: number;
}

/** Resolve a token expiry that never outlives the immutable Job deadline. */
export function capabilityExpiryForJob(input: CapabilityExpiryInput): Date {
  const startedAt = asDate(input.startedAt, input.now);
  const timeoutSec = typeof input.timeoutSec === "number" ? input.timeoutSec : Number(input.timeoutSec);
  const absoluteDeadline = Number.isFinite(timeoutSec) && timeoutSec > 0
    ? new Date(startedAt.getTime() + timeoutSec * 1000)
    : input.leaseExpiresAt
      ? asDate(input.leaseExpiresAt, new Date(input.now.getTime() + DEFAULT_CAPABILITY_TTL_SEC * 1000))
      : new Date(input.now.getTime() + DEFAULT_CAPABILITY_TTL_SEC * 1000);
  const ttlSec = boundedTtlSeconds(input.ttlSec);
  const requestedExpiry = input.ttlSec === undefined
    ? absoluteDeadline
    : new Date(input.now.getTime() + ttlSec * 1000);
  return new Date(Math.min(requestedExpiry.getTime(), absoluteDeadline.getTime()));
}

function requestedOperations(options: CapabilityMintOptions, available: readonly string[]): string[] {
  const requested = options.operationIds ?? options.operations;
  if (requested === undefined) return [...available];
  const requestedSet = new Set(requested);
  if ([...requestedSet].some((operationId) => !available.includes(operationId))) {
    throw new CapabilityTokenError("CAPABILITY_OPERATION_NOT_ALLOWED", "Requested operation is not enabled for this Job", 403);
  }
  return available.filter((operationId) => requestedSet.has(operationId));
}

function safeOperations(snapshot: Record<string, unknown>): string[] {
  const raw = snapshot.platform_tools;
  if (!Array.isArray(raw) || raw.some((value) => typeof value !== "string")) {
    throw new CapabilityTokenError("CAPABILITY_OPERATION_SNAPSHOT_INVALID", "Job capability snapshot is invalid", 409);
  }
  const values = operationIdsFromSnapshot(snapshot);
  // A snapshot containing an unknown operation must fail closed rather than
  // silently turning an authorization typo into a different projection.
  if (values.length !== new Set(raw).size || raw.some((value) => !PLATFORM_OPERATION_IDS.includes(value))) {
    throw new CapabilityTokenError("CAPABILITY_OPERATION_SNAPSHOT_INVALID", "Job capability snapshot is invalid", 409);
  }
  return values;
}

function outputRow(row: Record<string, unknown>, plaintext: string): CapabilityTokenGrant {
  const issuedAt = asDate(row.issued_at, new Date(0));
  const expiresAt = asDate(row.expires_at, new Date(0));
  return {
    id: String(row.id),
    token: plaintext,
    token_prefix: String(row.token_prefix),
    job_id: String(row.job_id),
    project_id: String(row.project_id),
    canvas_id: (row.canvas_id as string | null) ?? null,
    role_name: String(row.role_name),
    role_config_id: (row.role_config_id as string | null) ?? null,
    role_config_version: typeof row.role_config_version === "number" ? row.role_config_version : row.role_config_version == null ? null : Number(row.role_config_version),
    operation_ids: Array.isArray(row.operation_ids) ? row.operation_ids.map(String) : [],
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
}

/** Mint a capability token from the immutable Job snapshot. */
export function mintJobCapabilityToken(jobId: string, input?: CapabilityMintOptions | readonly string[] | number): Promise<CapabilityTokenGrant>;
export function mintJobCapabilityToken(input: CapabilityMintRequest): Promise<CapabilityTokenGrant>;
export async function mintJobCapabilityToken(
  jobIdOrInput: string | CapabilityMintRequest,
  input?: CapabilityMintOptions | readonly string[] | number,
): Promise<CapabilityTokenGrant> {
  const jobId = typeof jobIdOrInput === "string" ? jobIdOrInput : jobIdOrInput.jobId;
  const options = resolveMintOptions(typeof jobIdOrInput === "string" ? input : jobIdOrInput);
  const [job] = await sql`
    SELECT id, project_id, canvas_id, type, status, agent_snapshot_json,
           started_at, timeout_sec, lease_expires_at
    FROM jobs
    WHERE id = ${jobId}`;
  if (!job) throw new CapabilityTokenError("CAPABILITY_JOB_NOT_FOUND", "Job not found", 404);
  if (!MINTABLE_JOB_STATUSES.has(String(job.status))) {
    throw new CapabilityTokenError("CAPABILITY_JOB_NOT_ACTIVE", "Job is not ready for capability minting", 409);
  }
  const snapshot = asSnapshotObject(job.agent_snapshot_json);
  const available = safeOperations(snapshot);
  const operationIds = requestedOperations(options, available);
  if (operationIds.length === 0) {
    throw new CapabilityTokenError("CAPABILITY_OPERATION_NOT_ALLOWED", "No platform operation is enabled for this Job", 403);
  }
  const now = options.now ?? new Date();
  // The default grant covers the rest of this Job's immutable deadline. An
  // executor may explicitly request a shorter token, but never a token that
  // outlives the Job timeout.
  const expiresAt = capabilityExpiryForJob({
    now,
    startedAt: job.started_at,
    timeoutSec: job.timeout_sec,
    leaseExpiresAt: job.lease_expires_at,
    ttlSec: options.ttlSec,
  });
  if (expiresAt.getTime() <= now.getTime()) {
    throw new CapabilityTokenError("CAPABILITY_JOB_NOT_ACTIVE", "Job lease has expired", 409);
  }
  const generated = generateCapabilityToken();
  const [row] = await sql`
    INSERT INTO job_capability_tokens ${sql({
      job_id: job.id as string,
      project_id: job.project_id as string,
      canvas_id: (job.canvas_id as string | null) ?? null,
      role_name: String(snapshot.name ?? job.type),
      role_config_id: asNullableUuid(snapshot.role_config_id),
      role_config_version: typeof snapshot.role_config_version === "number" ? snapshot.role_config_version : null,
      snapshot_sha256: hashJobSnapshot(snapshot),
      token_prefix: generated.prefix,
      token_hash: generated.hash,
      operation_ids: operationIds as never,
      issued_at: now,
      expires_at: expiresAt,
    })}
    RETURNING id, job_id, project_id, canvas_id, role_name, role_config_id,
              role_config_version, token_prefix, operation_ids, issued_at, expires_at`;
  return outputRow(row as Record<string, unknown>, generated.plaintext);
}

/** Align grants minted during provisioning to the real deadline once the Job starts. */
export async function activateProvisionedJobCapabilityTokens(jobId: string, now = new Date()): Promise<number> {
  const [job] = await sql`
    SELECT status, started_at, timeout_sec, lease_expires_at
    FROM jobs
    WHERE id = ${jobId}`;
  if (!job) throw new CapabilityTokenError("CAPABILITY_JOB_NOT_FOUND", "Job not found", 404);
  if (!ACTIVE_JOB_STATUSES.has(String(job.status))) {
    throw new CapabilityTokenError("CAPABILITY_JOB_NOT_ACTIVE", "Job is no longer active", 409);
  }
  const expiresAt = capabilityExpiryForJob({
    now,
    startedAt: job.started_at,
    timeoutSec: job.timeout_sec,
    leaseExpiresAt: job.lease_expires_at,
  });
  const rows = await sql`
    UPDATE job_capability_tokens
    SET expires_at = ${expiresAt}
    WHERE job_id = ${jobId} AND revoked_at IS NULL
    RETURNING id`;
  return rows.length;
}

export const mintCapabilityToken = mintJobCapabilityToken;

export async function mintPlatformCapabilityToken(input: CapabilityMintRequest): Promise<CapabilityTokenGrant> {
  return mintJobCapabilityToken(input);
}

/** Validate a plaintext capability token and return only non-secret metadata. */
export async function authenticateJobCapabilityToken(jobId: string, plaintext: string): Promise<CapabilityPrincipal> {
  const parsed = parseCapabilityToken(plaintext);
  if (!parsed) throw new CapabilityTokenError("CAPABILITY_TOKEN_INVALID", "Capability token is invalid");
  const [row] = await sql`
    SELECT t.id, t.job_id, t.project_id, t.canvas_id, t.role_name, t.role_config_id,
           t.role_config_version, t.snapshot_sha256, t.token_prefix, t.token_hash,
           t.operation_ids, t.issued_at, t.expires_at, t.revoked_at,
           j.project_id AS job_project_id, j.canvas_id AS job_canvas_id,
           j.status AS job_status, j.agent_snapshot_json
    FROM job_capability_tokens t
    JOIN jobs j ON j.id = t.job_id
    WHERE t.token_prefix = ${parsed.prefix} AND t.job_id = ${jobId}`;
  if (!row || !equalHash(row.token_hash, tokenHash(plaintext))) {
    throw new CapabilityTokenError("CAPABILITY_TOKEN_INVALID", "Capability token is invalid");
  }
  if (row.revoked_at) throw new CapabilityTokenError("CAPABILITY_TOKEN_REVOKED", "Capability token is revoked");
  if (!ACTIVE_JOB_STATUSES.has(String(row.job_status))) {
    throw new CapabilityTokenError("CAPABILITY_JOB_NOT_ACTIVE", "Job is no longer active", 409);
  }
  if (String(row.project_id).toLowerCase() !== String(row.job_project_id).toLowerCase()) {
    throw new CapabilityTokenError("CAPABILITY_TOKEN_INVALID", "Capability token is invalid");
  }
  if ((row.canvas_id ?? null) !== null && String(row.canvas_id) !== String(row.job_canvas_id ?? "")) {
    throw new CapabilityTokenError("CAPABILITY_TOKEN_INVALID", "Capability token is invalid");
  }
  const expiresAt = asDate(row.expires_at, new Date(0));
  if (expiresAt.getTime() <= Date.now()) throw new CapabilityTokenError("CAPABILITY_TOKEN_EXPIRED", "Capability token is expired");
  const currentSnapshot = asSnapshotObject(row.agent_snapshot_json);
  if (hashJobSnapshot(currentSnapshot) !== String(row.snapshot_sha256)) {
    throw new CapabilityTokenError("CAPABILITY_TOKEN_INVALID", "Capability token is invalid");
  }
  const operationIds = Array.isArray(row.operation_ids) ? row.operation_ids.map(String) : [];
  if (operationIds.length === 0 || operationIds.some((operationId) => !PLATFORM_OPERATION_IDS.includes(operationId))) {
    throw new CapabilityTokenError("CAPABILITY_TOKEN_INVALID", "Capability token is invalid");
  }
  return {
    tokenId: String(row.id),
    tokenPrefix: String(row.token_prefix),
    jobId: String(row.job_id),
    projectId: String(row.project_id),
    canvasId: (row.canvas_id as string | null) ?? null,
    roleName: String(row.role_name),
    roleConfigId: (row.role_config_id as string | null) ?? null,
    roleConfigVersion: typeof row.role_config_version === "number" ? row.role_config_version : row.role_config_version == null ? null : Number(row.role_config_version),
    snapshotSha256: String(row.snapshot_sha256),
    operationIds,
    issuedAt: asDate(row.issued_at, new Date(0)).toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export const verifyJobCapabilityToken = authenticateJobCapabilityToken;

/** Revoke every capability for a Job; safe to call from terminal/reaper paths. */
export async function revokeJobCapabilityTokens(jobId: string, reason = "job_terminal"): Promise<number> {
  const rows = await sql`
    UPDATE job_capability_tokens
    SET revoked_at = now(), revoke_reason = ${reason.slice(0, 200)}
    WHERE job_id = ${jobId} AND revoked_at IS NULL
    RETURNING id`;
  return rows.length;
}

export async function revokeJobCapabilityToken(tokenId: string, reason = "revoked"): Promise<boolean> {
  const [row] = await sql`
    UPDATE job_capability_tokens
    SET revoked_at = now(), revoke_reason = ${reason.slice(0, 200)}
    WHERE id = ${tokenId} AND revoked_at IS NULL
    RETURNING id`;
  return Boolean(row);
}

export async function revokeCapabilityTokenByPlaintext(plaintext: string, reason = "revoked"): Promise<boolean> {
  const parsed = parseCapabilityToken(plaintext);
  if (!parsed) return false;
  const [row] = await sql`
    SELECT id, token_hash FROM job_capability_tokens
    WHERE token_prefix = ${parsed.prefix} AND revoked_at IS NULL`;
  if (!row || !equalHash(row.token_hash, tokenHash(plaintext))) return false;
  return revokeJobCapabilityToken(String(row.id), reason);
}

export const revokeCapabilityTokensForJob = revokeJobCapabilityTokens;
export const revokeCapabilityToken = revokeJobCapabilityToken;

export async function revokeCapabilityTokens(jobId: string, reason = "job_terminal"): Promise<void> {
  await revokeJobCapabilityTokens(jobId, reason);
}
