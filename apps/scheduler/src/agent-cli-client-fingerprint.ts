import { CURRENT_AGENT_CLI_DEFAULT } from "@deepsonar/shared-types";
import type { InferenceWireProtocol } from "./provider-settings.js";

/**
 * Claude Code CLI 的版本号，必须与 `deploy/Dockerfile.agent` 的 `CLAUDE_CODE_VERSION`
 * 同步升级。做法与 packages/runtime-sandbox/src/dsh-profile.ts 的 `DSH_VERSION` 一致：
 * 运行时组件在 TS 侧复述镜像里固定的版本字面量。
 */
export const CLAUDE_CODE_VERSION = "2.1.296";

/**
 * Agent CLI 的客户端指纹（#736）。
 *
 * 部分第三方中转（new-api 架构）在 Anthropic Messages 路径上按 `user-agent` 是否以
 * `claude-cli` 开头识别客户端，与凭据是否有效无关：不带指纹的请求会被判成
 * `401 unauthorized client detected`，而带指纹的同一把凭据会走到模型授权层（403/200）。
 * Scheduler 自发的推理探测与模型目录发现因此必须带上与运行时 CLI 同口径的指纹，
 * 否则会把「上游防滥用层拦了非 CLI 客户端」误报成凭据认证失败。
 *
 * 指纹按凭据绑定的 Agent CLI 决定，而不是无条件伪装：只有 claude-code 才发这组头，
 * Pi / DSH 绑定的凭据保持原样（它们走的是各自的客户端标识，发了反而是假的通过）。
 * 未绑定具体 CLI 的存量凭据按平台默认（claude-code）处理，与写入路径的默认一致。
 */
export function agentCliClientHeaders(
  agentCli: string | null | undefined,
  protocol: InferenceWireProtocol,
): Record<string, string> {
  // Claude Code 只用 Anthropic Messages 这一条线协议，其余协议不加这组头。
  if (protocol !== "anthropic-messages") return {};
  if ((agentCli ?? CURRENT_AGENT_CLI_DEFAULT) !== "claude-code") return {};
  return {
    "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
    "x-app": "cli",
  };
}
