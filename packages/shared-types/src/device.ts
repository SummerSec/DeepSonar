import { z } from "zod";

/**
 * 真实设备接入契约（#495）。物理设备不直连沙箱：device broker 把它暴露成可租借网络端点，
 * 沙箱只拿到端点 + 短期租约 token。类型与校验是 Scheduler / broker / 快照投影的单源。
 */

/** Phase 1 只落地 adb；schema 与契约已允许后续 transport。 */
export const DEVICE_TRANSPORTS = ["adb", "hdc", "serial", "ssh", "net"] as const;
export type DeviceTransport = (typeof DEVICE_TRANSPORTS)[number];

/** 冻结进 `jobs.agent_snapshot_json` 的设备需求：任务创建时声明，执行期只认快照。 */
export const DeviceRequirement = z
  .object({
    transport: z.enum(DEVICE_TRANSPORTS),
    /** 指定具体设备 key（默认由 broker 分配匹配设备）。 */
    key: z.string().trim().min(1).max(200).optional(),
    model: z.string().trim().min(1).max(120).optional(),
    /** Phase 1 只有独占语义；共享设备留待 Phase 2。 */
    exclusive: z.boolean().default(true),
    ttl_sec: z.number().int().min(60).max(86_400).default(1800),
    /** 需要设备租约的角色名（缺省只给 test）；Hub/report/verify 不占用设备。 */
    roles: z.array(z.string().trim().min(1).max(64)).min(1).max(16).default(["test"]),
  })
  .strict();
export type DeviceRequirement = z.infer<typeof DeviceRequirement>;

/** 沙箱侧端点投影：只有 host/port 与透明环境变量，不含长期密钥。 */
export const DeviceLeaseEndpoint = z
  .object({
    transport: z.enum(DEVICE_TRANSPORTS),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65_535),
    env: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export type DeviceLeaseEndpoint = z.infer<typeof DeviceLeaseEndpoint>;

/** broker `/lease/acquire` 的成功响应（Scheduler 解析，不盲信 broker 输出）。 */
export const DeviceLeaseGrant = z
  .object({
    lease_id: z.string().trim().min(1).max(200),
    device_key: z.string().trim().min(1).max(200),
    model: z.string().trim().max(120).nullish(),
    transport: z.enum(DEVICE_TRANSPORTS),
    endpoint: DeviceLeaseEndpoint,
    /** 短期租约 token；broker 侧可校验，沙箱内不落长期凭据。 */
    token: z.string().trim().min(1).max(4096),
    expires_at: z.string().trim().min(1).max(64),
  })
  .strict();
export type DeviceLeaseGrant = z.infer<typeof DeviceLeaseGrant>;

/** 稳定失败码：可重试（设备不可用）与不可重试（未授权）分离。 */
export const DEVICE_LEASE_ERROR_CODES = {
  notAuthorized: "device_not_authorized",
  notAvailable: "device_not_available",
} as const;
export type DeviceLeaseErrorCode = (typeof DEVICE_LEASE_ERROR_CODES)[keyof typeof DEVICE_LEASE_ERROR_CODES];

/** 注入沙箱的设备环境变量前缀（adb 场景对 Agent 透明）。 */
export const DEVICE_SANDBOX_ENV_KEYS = {
  transport: "DEEPSONAR_DEVICE_TRANSPORT",
  endpoint: "DEEPSONAR_DEVICE_ENDPOINT",
  token: "DEEPSONAR_DEVICE_LEASE_TOKEN",
  leaseId: "DEEPSONAR_DEVICE_LEASE_ID",
} as const;

/** 把端点投影成沙箱环境变量：adb 走 ANDROID_* 透明变量 + 平台自有变量。 */
export function deviceSandboxEnv(
  grant: Pick<DeviceLeaseGrant, "lease_id" | "transport" | "endpoint" | "token">,
  deviceKey?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    [DEVICE_SANDBOX_ENV_KEYS.transport]: grant.transport,
    [DEVICE_SANDBOX_ENV_KEYS.endpoint]: `${grant.endpoint.host}:${grant.endpoint.port}`,
    [DEVICE_SANDBOX_ENV_KEYS.token]: grant.token,
    [DEVICE_SANDBOX_ENV_KEYS.leaseId]: grant.lease_id,
    ...grant.endpoint.env,
  };
  if (grant.transport === "adb") {
    env.ANDROID_ADB_SERVER_ADDRESS = grant.endpoint.host;
    env.ANDROID_ADB_SERVER_PORT = String(grant.endpoint.port);
    if (deviceKey) env.ANDROID_SERIAL = deviceKey;
  }
  return env;
}

export const DEVICE_LEASE_TOKEN_VERSION = "v1";

export const DeviceLeaseTokenPayload = z
  .object({
    lease_id: z.string().min(1).max(200),
    device_key: z.string().min(1).max(200),
    job_id: z.string().min(1).max(200),
    attempt_id: z.string().min(1).max(200),
    /** epoch 秒。 */
    exp: z.number().int().positive(),
    nonce: z.string().min(8).max(128),
  })
  .strict();
export type DeviceLeaseTokenPayload = z.infer<typeof DeviceLeaseTokenPayload>;

/**
 * 租约 token 是 `v1.<payload b64url>.<hmac b64url>`，HMAC-SHA256 + 共享密钥。
 * 用 WebCrypto 而不是 node:crypto，保证 scheduler 与 broker 同一个实现、可在任意运行时校验。
 */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** WebCrypto 要 ArrayBuffer-backed 视图；这里显式复制，避免 SharedArrayBuffer 类型歧义。 */
function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return bufferSource(new TextEncoder().encode(value));
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function mintDeviceLeaseToken(payload: DeviceLeaseTokenPayload, secret: string): Promise<string> {
  const body = base64url(utf8(JSON.stringify(DeviceLeaseTokenPayload.parse(payload))));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), utf8(body));
  return `${DEVICE_LEASE_TOKEN_VERSION}.${body}.${base64url(new Uint8Array(signature))}`;
}

/** 校验签名与过期时间；任何不合法都返回 null（fail closed，不抛异常给调用方分类）。 */
export async function verifyDeviceLeaseToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<DeviceLeaseTokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== DEVICE_LEASE_TOKEN_VERSION) return null;
  const [, body, signature] = parts;
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      fromBase64url(signature),
      utf8(body),
    );
  } catch {
    return null;
  }
  if (!valid) return null;
  try {
    const payload = DeviceLeaseTokenPayload.parse(JSON.parse(new TextDecoder().decode(fromBase64url(body))));
    return payload.exp * 1000 > nowMs ? payload : null;
  } catch {
    return null;
  }
}
