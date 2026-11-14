import { shellQuote, type RuntimeHost } from "./runtime-host.js";

/**
 * #1032 P0-2 A1 片：Pi 主请求令牌的沙箱私有通道。
 *
 * 令牌只落在 0700 目录下的 0600 文件里，CLI 与工具子进程的环境中只保留路径
 * `DEEPSONAR_GATEWAY_TOKEN_FILE`。Pi 认证由 `auth.json` 的已存凭据承担（已存凭据
 * 优先于 ambient/env），预算扩展与准入策略进程改读该文件。
 *
 * 这不是操作系统身份隔离：同 UID 的工具进程仍能读取该文件。
 */
export const GATEWAY_TOKEN_DIR = "/workspace/.deepsonar";
export const GATEWAY_TOKEN_FILE = `${GATEWAY_TOKEN_DIR}/gateway-token`;

export async function preparePiGatewayTokenFile(
  host: Pick<RuntimeHost, "run" | "uploadFile">,
  provider: string,
  env: Record<string, string>,
): Promise<void> {
  const token = env.DEEPSONAR_GATEWAY_TOKEN;
  if (provider !== "pi" || !token) return;
  await host.run(`mkdir -p -m 0700 -- ${shellQuote(GATEWAY_TOKEN_DIR)}`);
  await host.uploadFile(`${token}\n`, GATEWAY_TOKEN_FILE);
  await host.run(`chmod 0600 -- ${shellQuote(GATEWAY_TOKEN_FILE)}`);
  env.DEEPSONAR_GATEWAY_TOKEN_FILE = GATEWAY_TOKEN_FILE;
  delete env.DEEPSONAR_GATEWAY_TOKEN;
}