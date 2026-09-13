import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `adb devices -l` 的一行解析结果（Phase 1 只用 serial/model/transport）。 */
export type BrokerAdbDevice = {
  key: string;
  model: string | null;
  state: string;
  transport: "adb";
};

export type AdbRunner = (args: string[], timeoutMs?: number) => Promise<string>;

/** 默认执行真实 adb；测试用 stub 脚本替换，避免在 CI 里依赖真机。 */
export function adbRunner(adbBin: string): AdbRunner {
  return async (args, timeoutMs = 10_000) => {
    const { stdout } = await execFileAsync(adbBin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    return stdout;
  };
}

/** 解析 `adb devices -l` 输出；只接受 device 状态（offline/unauthorized 不上架）。 */
export function parseAdbDevices(stdout: string): BrokerAdbDevice[] {
  const devices: BrokerAdbDevice[] = [];
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

export async function adbDevices(run: AdbRunner): Promise<BrokerAdbDevice[]> {
  const parsed = parseAdbDevices(await run(["devices", "-l"]));
  return parsed.filter((device) => device.state === "device");
}

/** 沙箱侧端点：adb server 的 TCP 地址（rig 主机 + 端口）。 */
export function adbServerEndpoint(input: { host: string; port: number }): {
  transport: "adb";
  host: string;
  port: number;
  env: Record<string, string>;
} {
  return {
    transport: "adb",
    host: input.host,
    port: input.port,
    env: {},
  };
}
