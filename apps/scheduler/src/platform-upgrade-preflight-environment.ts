import { parseOciDigestRef } from "./runtime-image-registry-contract.js";
import type { PreflightSnapshot } from "./platform-upgrade-preflight-contract.js";

export type HostFileEvidence = { key: string; path: string; exists: boolean; regular_file: boolean; readable: boolean; read_only: boolean; mode: number };
const URL_KEYS = ["DATABASE_URL", "DEEPSONAR_GATEWAY_SANDBOX_URL", "DEEPSONAR_GATEWAY_PROXY_UPSTREAM_URL", "DEEPSONAR_API_SANDBOX_URL", "DEEPSONAR_DEVICE_BROKER_URL", "BLOB_S3_ENDPOINT"];
export function validConfigurationUrl(value: unknown, protocols = ["http:", "https:"]): boolean {
  if (typeof value !== "string" || value !== value.trim() || /[\s\x00-\x1f]/.test(value)) return false;
  try { const url = new URL(value); return protocols.includes(url.protocol) && Boolean(url.hostname) && !url.hash; } catch { return false; }
}
/** Pure checks only. No secret values are returned in errors. */
export function validatePreflightEnvironment(snapshot: PreflightSnapshot, block: (code: string, location: string) => void): void {
  const env = snapshot.environment;
  const invalid = (key: string) => block("INVALID_ENVIRONMENT_VALUE", `environment.${key}`);
  if (env.DATABASE_URL === "") invalid("DATABASE_URL");
  for (const key of URL_KEYS) if (env[key] && !validConfigurationUrl(env[key], key === "DATABASE_URL" ? ["postgres:", "postgresql:"] : undefined)) invalid(key);
  for (const [key, allowed] of Object.entries({ AGENT_MODE: ["real", "fake"], SANDBOX_PROVIDER: ["opensandbox"], OPEN_SANDBOX_PROTOCOL: ["http", "https"], MIN_VERIFY_SEVERITY: ["critical", "high", "medium", "low", "info"] })) {
    if (env[key] !== undefined && !allowed.includes(env[key])) invalid(key);
  }
  if (env.BLOB_STORE && !["fs", "s3"].includes(env.BLOB_STORE.toLowerCase())) invalid("BLOB_STORE");
  if (env.BLOB_S3_FORCE_PATH_STYLE && !/^(1|0|true|false|yes|no|on|off)$/i.test(env.BLOB_S3_FORCE_PATH_STYLE)) invalid("BLOB_S3_FORCE_PATH_STYLE");
  if (env.OPEN_SANDBOX_DOMAIN && (!validConfigurationUrl(`http://${env.OPEN_SANDBOX_DOMAIN}`) || /[/?#@]/.test(env.OPEN_SANDBOX_DOMAIN))) invalid("OPEN_SANDBOX_DOMAIN");
  for (const key of ["SCHEDULER_HOST", "DEEPSONAR_WORKER_LOCAL_ID", "OPEN_SANDBOX_CONTAINER_NAME", "DEEPSONAR_SCHEDULER_CONTAINER_NAME"]) {
    if (env[key] !== undefined && (!env[key].trim() || /[\s\x00-\x1f/]/.test(env[key]))) invalid(key);
  }
  if (env.BLOB_STORE?.toLowerCase() === "s3" && !env.BLOB_S3_BUCKET?.trim()) invalid("BLOB_S3_BUCKET");
  for (const key of ["DEEPSONAR_OFFICIAL_BASE_IMAGE", "DEEPSONAR_OFFICIAL_AUDIT_IMAGE", "DEEPSONAR_OFFICIAL_KALI_MINIMAL_IMAGE"]) {
    if (env[key]) try { parseOciDigestRef(env[key]); } catch { invalid(key); }
  }
  for (const key of ["BLOB_DIR", "BLOB_S3_CACHE_DIR", "DEEPSONAR_HOST_DISK_PATH", "DEEPSONAR_MASTER_KEY_FILE"]) {
    if (env[key] !== undefined && /[\x00-\x1f]/.test(env[key])) invalid(key);
  }
  if (env.DEEPSONAR_TOKEN_ENV !== undefined && !/^[a-z0-9]+$/.test(env.DEEPSONAR_TOKEN_ENV)) invalid("DEEPSONAR_TOKEN_ENV");
  const file = env.DEEPSONAR_MASTER_KEY_FILE;
  if (file) {
    const evidence = (snapshot.host_files ?? []).filter(item => item.key === "DEEPSONAR_MASTER_KEY_FILE" && item.path === file);
    if (evidence.length !== 1 || !evidence[0].exists || !evidence[0].regular_file || !evidence[0].readable || !evidence[0].read_only || (evidence[0].mode & 0o022)) {
      block("REQUIRED_HOST_FILE_UNVERIFIED", "environment.DEEPSONAR_MASTER_KEY_FILE");
    }
  } else if (env.DEEPSONAR_MASTER_KEY) {
    const raw = env.DEEPSONAR_MASTER_KEY.trim();
    if (!/^[a-fA-F0-9]{64}$/.test(raw) && !(Buffer.from(raw, "base64").length === 32 && Buffer.from(raw, "base64").toString("base64") === raw)) invalid("DEEPSONAR_MASTER_KEY");
  } else if (snapshot.credentials.length) block("CREDENTIAL_MASTER_KEY_MISSING", "environment.DEEPSONAR_MASTER_KEY");
}

/** Validate supported native structures, preserving provider-owned extension keys. */
export function validateNativeProviderStructure(value: Record<string, unknown>): boolean {
  const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  if (value.env !== undefined && (!object(value.env) || Object.values(value.env).some(v => typeof v !== "string"))) return false;
  for (const key of ["baseUrl", "baseURL", "base_url"]) if (value[key] !== undefined && !validConfigurationUrl(value[key])) return false;
  if (object(value.env)) for (const key of ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]) if (value.env[key] !== undefined && !validConfigurationUrl(value.env[key])) return false;
  if (value.options !== undefined && (!object(value.options) || !validateNativeProviderStructure(value.options))) return false;
  if (value.providers !== undefined) {
    if (!object(value.providers)) return false;
    for (const provider of Object.values(value.providers)) {
      if (!object(provider) || !validateNativeProviderStructure(provider)) return false;
      if (provider.models !== undefined && !Array.isArray(provider.models)) return false;
    }
  }
  return true;
}
