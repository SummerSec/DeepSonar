import { decryptSecret, PROVIDER_ENV_MAP } from "./credentials.js";

/**
 * Credential 连接测试（§6.2：支持连接测试）：用解密后的凭据对 provider 做一次
 * 轻量只读调用。明文不出进程；结果只回 ok/状态码/错误摘要（绝不回显密钥）。
 */
export async function testCredential(cred: {
  provider: string;
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  public_metadata_json: unknown;
}): Promise<{ ok: boolean; detail: string }> {
  const mapping = PROVIDER_ENV_MAP[cred.provider];
  if (!mapping) return { ok: false, detail: `未知 provider: ${cred.provider}` };

  let secret: string;
  try {
    secret = decryptSecret(cred);
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "解密失败" };
  }

  const meta = (cred.public_metadata_json ?? {}) as { base_url?: string };
  const baseUrl = (meta.base_url ?? mapping.defaultBaseUrl ?? "").replace(/\/$/, "");

  try {
    switch (cred.provider) {
      case "anthropic":
      case "kimi": {
        if (!baseUrl) return { ok: false, detail: "缺 base_url" };
        const res = await fetch(`${baseUrl}/v1/models`, {
          headers: { "x-api-key": secret, Authorization: `Bearer ${secret}`, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(10_000),
        });
        return res.ok
          ? { ok: true, detail: `连接成功（HTTP ${res.status}）` }
          : { ok: false, detail: `HTTP ${res.status}` };
      }
      case "openai": {
        const url = (baseUrl || "https://api.openai.com") + "/v1/models";
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(10_000),
        });
        return res.ok
          ? { ok: true, detail: `连接成功（HTTP ${res.status}）` }
          : { ok: false, detail: `HTTP ${res.status}` };
      }
      case "openrouter": {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(10_000),
        });
        return res.ok
          ? { ok: true, detail: `连接成功（HTTP ${res.status}）` }
          : { ok: false, detail: `HTTP ${res.status}` };
      }
      default:
        return { ok: false, detail: `${cred.provider} 的连接测试暂未实现` };
    }
  } catch (e) {
    return { ok: false, detail: `连接失败: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` };
  }
}
