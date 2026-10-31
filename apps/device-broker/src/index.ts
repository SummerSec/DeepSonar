import { brokerConfigFromEnv } from "./config.js";
import { DeviceRegistry } from "./registry.js";
import { buildBrokerServer } from "./server.js";

/**
 * Device broker 入口（#495）。必须显式配置入站 token 与租约密钥——缺任何一项
 * 都 refuse 启动，避免一个无鉴权、可任意占用真机的服务被误部署。
 */
const config = brokerConfigFromEnv();
if (!config.inboundToken || !config.leaseSecret) {
 console.error(
  "[device-broker] DEVICE_BROKER_TOKEN 与 DEVICE_BROKER_LEASE_SECRET 都必须配置；拒绝启动。",
 );
 process.exit(1);
}
if (config.allowedKeys.length === 0 && !config.trustPlatform) {
 console.warn(
  "[device-broker] DEVICE_BROKER_ALLOWED_KEYS 为空且 DEVICE_BROKER_TRUST_PLATFORM=0：平台下发的集合也不会生效（deny-all）。",
 );
}
if (!config.adbEndpointHost) {
 console.warn(
  "[device-broker] DEVICE_BROKER_ADB_HOST 未配置：租约不会下发端点，设备不可用。",
 );
}

// 启动时恢复上一次平台 push 的期望集合；文件缺失/损坏则空集合（fail closed），等平台重推。
const registry = new DeviceRegistry({
 ceilingKeys: config.allowedKeys,
 trustPlatform: config.trustPlatform,
 statePath: config.statePath,
});
registry.load();
const admission = registry.snapshot();
console.log(
 `[device-broker] 准入模式=${admission.mode} reconciled=${registry.reconciled()} 期望设备=${admission.devices.length} revision=${admission.revision}`,
);

const app = buildBrokerServer({ config, registry });
await app.listen({ host: config.host, port: config.port });
console.log(`[device-broker] listening on ${config.host}:${config.port}`);
