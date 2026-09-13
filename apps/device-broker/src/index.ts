import { brokerConfigFromEnv } from "./config.js";
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
if (config.allowedKeys.length === 0) {
  console.warn("[device-broker] DEVICE_BROKER_ALLOWED_KEYS 为空：所有设备请求都会失败（fail closed）。");
}
if (!config.adbEndpointHost) {
  console.warn("[device-broker] DEVICE_BROKER_ADB_HOST 未配置：租约不会下发端点，设备不可用。");
}

const app = buildBrokerServer({ config });
await app.listen({ host: config.host, port: config.port });
console.log(`[device-broker] listening on ${config.host}:${config.port}`);
