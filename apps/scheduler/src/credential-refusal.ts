/**
 * Model Gateway 出站凭据守卫的稳定分类（#1032 P1-3）。
 *
 * Gateway 在凭据进入模型请求 body / target / trailers 时以 400
 * `credential_in_business_data` fail-closed，此时不产生任何用量；
 * Pi CLI 把该拒绝折叠成进程退出短语，文本形态取决于 provider 适配：
 * Anthropic 路径是 `error: 400: Job credential in body`；锁定的 Pi 1.5.2
 * 对 `openai-responses`（非 Anthropic Pi 配置的默认 provider）经
 * `formatProviderError` 产出 `<provider> API error (400): <body>`。Claude 保留
 * HTTP 400 JSON 外壳时按精确 error.type 识别。上述封装均映射为稳定错误码，并且该失败
 * **永不进入任何自动重试预算**（provision / 流截断 / 上下文窗口）。宿主须先
 * 修复对应工具/SDK 投影或认证材料，再按原恢复门决定后继。模型是否实际接收
 * 内容以 Gateway 的接受与出站事实为准。
 */
export const CREDENTIAL_IN_BUSINESS_DATA_REASON = "credential_in_business_data";

/**
 * 必须是显式 400：裸 `400:`（Anthropic / CLI 折叠）或 provider 封装
 * `(400):`（`<provider> API error (400):`）；两者后面紧跟 deny 文案。
 * 其它状态码（`500:`、`(500):`）不进入该分类。
 */
const CREDENTIAL_IN_BUSINESS_DATA_RE =
  /(?:(?:^|: )400:|\(\s*400\s*\)\s*:)\s*Job credential in (?:request target|body|upstream target|business data|trailers)(?:[:\s]|$)/i;

export function isCredentialInBusinessDataMessage(text: string): boolean {
  if (CREDENTIAL_IN_BUSINESS_DATA_RE.test(text)) return true;
  // Claude can retain the HTTP error body instead of folding error.message.
  // Require both HTTP 400 and the exact JSON type, never a bare code mention.
  const body = /\b400:?\s+(\{[\s\S]*\})\s*$/u.exec(text)?.[1];
  if (!body) return false;
  try {
    return JSON.parse(body)?.error?.type === CREDENTIAL_IN_BUSINESS_DATA_REASON;
  } catch {
    return false;
  }
}

export function formatCredentialInBusinessDataMessage(message: string): string {
  return `${CREDENTIAL_IN_BUSINESS_DATA_REASON}: ${message}`;
}
