/**
 * Model Gateway 出站凭据守卫的稳定分类（#1032 P1-3）。
 *
 * Gateway 在凭据进入模型请求 body / target / trailers 时以 400
 * `credential_in_business_data` fail-closed，此时不产生任何用量；
 * Pi CLI 把该拒绝折叠为自己的进程退出短语（`Pi message ended: error:
 * 400: Job credential in body`）。这里把五种 deny 文案识别回平台的稳定
 * 错误码，使 Job 失败不再是 CLI 黑话，并且该失败**永不进入任何自动重试
 * 预算**（provision / 流截断 / 上下文窗口）：token 一旦进入模型可见面
 * 对当前 Attempt 即为永久拒绝，只有平台侧（后续 #1032 P0-1/P0-2）能
 * 修复发生条件，模型无法 un-see。
 */
export const CREDENTIAL_IN_BUSINESS_DATA_REASON = "credential_in_business_data";

/** gateway `deny(400, "Job credential in …", "credential_in_business_data")` 的五种文案。 */
const CREDENTIAL_IN_BUSINESS_DATA_RE =
  /(?:^|: )400: Job credential in (?:request target|body|upstream target|business data|trailers)(?:[:\s]|$)/i;

export function isCredentialInBusinessDataMessage(text: string): boolean {
  return CREDENTIAL_IN_BUSINESS_DATA_RE.test(text);
}

export function formatCredentialInBusinessDataMessage(message: string): string {
  return `${CREDENTIAL_IN_BUSINESS_DATA_REASON}: ${message}`;
}
