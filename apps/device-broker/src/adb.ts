import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrokerDevice, DeviceRunner } from "./device.js";

const execFileAsync = promisify(execFile);

/** 默认执行真实 adb；测试用 stub 脚本替换，避免在 CI 里依赖真机。 */
export function adbRunner(adbBin: string): DeviceRunner {
  return async (args, timeoutMs = 10_000) => {
    const { stdout } = await execFileAsync(adbBin, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  };
}

/** 解析 `adb devices -l` 输出；只接受 device 状态（offline/unauthorized 不上架）。 */
export function parseAdbDevices(stdout: string): BrokerDevice[] {
  const devices: BrokerDevice[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("List of devices")) continue;
    const [key, state] = line.split(/\s+/u);
    if (!key || !state) continue;
    const model = /model:(\S+)/u.exec(line)?.[1] ?? null;
    devices.push({ key, model, state, transport: "adb" });
  }
  return devices;
}

export async function adbDevices(run: DeviceRunner): Promise<BrokerDevice[]> {
  const parsed = parseAdbDevices(await run(["devices", "-l"]));
  return parsed.filter((device) => device.state === "device");
}
