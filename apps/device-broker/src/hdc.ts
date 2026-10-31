import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrokerDevice, DeviceRunner } from "./device.js";

const execFileAsync = promisify(execFile);

/** 默认执行真实 hdc；测试用 stub 脚本替换，避免在 CI 里依赖真机或 OH SDK。 */
export function hdcRunner(hdcBin: string): DeviceRunner {
  return async (args, timeoutMs = 10_000) => {
    const { stdout } = await execFileAsync(hdcBin, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  };
}

/**
 * 解析 `hdc list targets` 输出。
 *
 * hdc 会把环境噪声打在同一路 stdout 上（`[Empty]`、`Connect server failed`、
 * `[Fail]...`），与 `deploy/mobile-hdc.sh` 的过滤口径保持一致：只接受单 token 的
 * 目标 key（USB 序列号或 `host:port`），其余一律丢弃，不猜设备。
 */
export function parseHdcTargets(stdout: string): BrokerDevice[] {
  const devices: BrokerDevice[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/u, "").trim();
    if (!line || line === "[Empty]") continue;
    if (/connect server failed/iu.test(line)) continue;
    if (/^\[?(fail|error)/iu.test(line)) continue;
    // 目标 key 是单个 token；带空格的行是提示/告警，不是目标。
    if (/\s/u.test(line)) continue;
    devices.push({ key: line, model: null, state: "device", transport: "hdc" });
  }
  return devices;
}

export async function hdcDevices(run: DeviceRunner): Promise<BrokerDevice[]> {
  return parseHdcTargets(await run(["list", "targets"]));
}
