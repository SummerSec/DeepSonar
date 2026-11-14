/**
 * #1032 P0-2 A1（控制通道片）：Job 级 control capability token 以 0600 文件进沙箱，
 * 不再作为 env 值交给 CLI 与工具子进程；容器 env 只保留路径变量，Skill 按固定路径读取。
 */
import { shellQuote, type RuntimeHost } from "./runtime-host.js";

export const CONTROL_TOKEN_DIR = "/workspace/.deepsonar";
export const CONTROL_TOKEN_FILE = `${CONTROL_TOKEN_DIR}/control-token`;

export async function prepareControlTokenFile(
  host: Pick<RuntimeHost, "run" | "uploadFile">,
  env: Record<string, string | undefined>,
): Promise<void> {
  const token = env.DEEPSONAR_API_TOKEN;
  if (!token) return;
  await host.run(`mkdir -p -m 0700 -- ${shellQuote(CONTROL_TOKEN_DIR)}`);
  await host.uploadFile(`${token}\n`, CONTROL_TOKEN_FILE);
  await host.run(`chmod 0600 -- ${shellQuote(CONTROL_TOKEN_FILE)}`);
  env.DEEPSONAR_CONTROL_TOKEN_FILE = CONTROL_TOKEN_FILE;
  delete env.DEEPSONAR_API_TOKEN;
}