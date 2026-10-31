import { AGENT_CLI_RUNTIME_ADAPTERS } from "@deepsonar/runtime-sandbox";

/**
 * Claude Code 运行时的客户端指纹（#736）。
 *
 * 部分 new-api 架构的第三方中转在 Anthropic Messages 路径上只按 `User-Agent`
 * 是否以 `claude-cli` 开头判定客户端，否则返回 401 `unauthorized client detected`。
 * 真实沙箱 Job 由 Claude CLI 自带该 UA（经网关透传），但 scheduler 自发的推理探测 /
 * 模型目录发现请求没有，导致 UI 把可用凭据误报成认证失败。
 *
 * 版本直接取受治理的 claude-code runtime adapter pin（与 runtime-images.json /
 * Dockerfile `CLAUDE_CODE_VERSION` 由 check-runtime-image-consistency 校验同一口径），
 * 避免探测、网关与运行时 CLI 的指纹静默漂移。
 *
 * 与 #321 不同：#321 是同一上游在 OpenAI-responses 路径上按 body `input[0]`
 * 识别客户端；本指纹只用于 Anthropic Messages 路径。
 */
export const CLAUDE_CLI_VERSION = AGENT_CLI_RUNTIME_ADAPTERS["claude-code"].version;

export const CLAUDE_CLI_USER_AGENT = `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`;

/** Anthropic Messages 上游请求应携带的 Claude CLI 指纹头（小写键，每次返回新对象）。 */
export function claudeCliFingerprintHeaders(): Record<string, string> {
  return { "user-agent": CLAUDE_CLI_USER_AGENT, "x-app": "cli" };
}
