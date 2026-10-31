/**
 * Broker 侧设备候选的共享形状（#504）。adb 与 hdc 枚举器产出同一种结构，
 * 差别只在 `transport` 与端点（host/port）来源。
 */
export type BrokerDevice = {
 key: string;
 model: string | null;
 state: string;
 transport: "adb" | "hdc";
};

/** 执行设备枚举命令的统一签名；测试用 stub 替换，避免 CI 依赖真机。 */
export type DeviceRunner = (
 args: string[],
 timeoutMs?: number,
) => Promise<string>;
