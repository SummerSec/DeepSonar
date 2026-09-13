/**
 * Device broker 配置（#495）。全部来自 env；broker 只持自己的入站 token 与租约签名密钥，
 * 不接触模型/Provider 凭据。
 */
export type BrokerDependencies = {
  adbBin: string;
  /** hdc 可执行文件；不在 PATH 或未安装时 hdc 枚举返回空（fail closed）。 */
  hdcBin: string;
  /** 允许上架的设备 key 白名单；空 = 拒绝所有设备（fail closed）。 */
  allowedKeys: string[];
  leaseTtlSecDefault: number;
  leaseTtlSecMax: number;
  /** 沙箱可达的 adb server 端点主机（rig 地址）；为空时不下发 adb 租约。 */
  adbEndpointHost: string;
  adbServerPort: number;
  /** 沙箱可达的 hdc server 端点主机（rig 地址）；为空时不下发 hdc 租约。 */
  hdcEndpointHost: string;
  hdcServerPort: number;
  /** 租约 token 的 HMAC 共享密钥；为空时 broker refuse 启动。 */
  leaseSecret: string;
  /**
   * rig 是否信任平台的准入集合（#505 a-lite）；**默认 true**。
   * 显式设置 `DEVICE_BROKER_ALLOWED_KEYS` 时它作为硬上限（与平台集合取交集）。
   */
  trustPlatform: boolean;
  /** 平台 push 的期望集合落盘位置；null 表示不持久化（测试用）。 */
  statePath: string | null;
  /** Scheduler → broker 的入站 Bearer token；为空时 broker refuse 启动。 */
  inboundToken: string;
  auditLogPath: string;
  port: number;
  host: string;
};

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** 布尔 env；缺省/空取 fallback（#505：trustPlatform 默认 true）。 */
function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function brokerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BrokerDependencies {
  return {
    adbBin: env.DEVICE_BROKER_ADB_BIN?.trim() || "adb",
    hdcBin: env.DEVICE_BROKER_HDC_BIN?.trim() || "hdc",
    // 白名单默认空 = 拒绝所有设备（fail closed）；没有显式登记的 rig 不会被借用。
    allowedKeys: (env.DEVICE_BROKER_ALLOWED_KEYS ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter(Boolean),
    leaseTtlSecDefault: positiveInt(env.DEVICE_BROKER_LEASE_TTL_SEC, 1800),
    leaseTtlSecMax: positiveInt(env.DEVICE_BROKER_LEASE_TTL_SEC_MAX, 86_400),
    adbEndpointHost: env.DEVICE_BROKER_ADB_HOST?.trim() || "",
    adbServerPort: positiveInt(env.DEVICE_BROKER_ADB_PORT, 5037),
    hdcEndpointHost: env.DEVICE_BROKER_HDC_HOST?.trim() || "",
    // OpenHarmony hdc server 默认端口。
    hdcServerPort: positiveInt(env.DEVICE_BROKER_HDC_PORT, 8710),
    leaseSecret: env.DEVICE_BROKER_LEASE_SECRET?.trim() || "",
    trustPlatform: boolEnv(env.DEVICE_BROKER_TRUST_PLATFORM, true),
    statePath:
      env.DEVICE_BROKER_STATE_FILE?.trim() ||
      "/var/lib/deepsonar/device-broker-state.json",
    inboundToken: env.DEVICE_BROKER_TOKEN?.trim() || "",
    auditLogPath:
      env.DEVICE_BROKER_AUDIT_LOG?.trim() ||
      "/var/log/deepsonar/device-broker.jsonl",
    port: positiveInt(env.DEVICE_BROKER_PORT, 8788),
    host: env.DEVICE_BROKER_HOST?.trim() || "0.0.0.0",
  };
}
