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
  const baseUrl = (meta.base_url ?? mapping.defaultBaseUrl ?? "").replace(/\/+$/, "");
  // base_url 常见两种写法：主机根（https://api.openai.com）或已带 /v1（OpenAI SDK 习惯）
  // 统一拼出 .../v1/models，避免 /v1/v1/models
  const modelsUrl = (root: string) => {
    const r = root.replace(/\/+$/, "");
    if (/\/v\d+$/i.test(r)) return `${r}/models`;
    return `${r}/v1/models`;
  };
  const summarize = async (url: string, res: Response) => {
    if (res.ok) return { ok: true as const, detail: `连接成功（HTTP ${res.status} · ${url}）` };
    let bodyHint = "";
    try {
      const t = (await res.text()).trim().slice(0, 80);
      if (t) bodyHint = ` · ${t}`;
    } catch {
      /* ignore */
    }
    return { ok: false as const, detail: `HTTP ${res.status} · ${url}${bodyHint}` };
  };

  try {
    switch (cred.provider) {
      case "anthropic":
      case "kimi": {
        if (!baseUrl) return { ok: false, detail: "缺 base_url（可在凭据编辑里补）" };
        const url = modelsUrl(baseUrl);
        const res = await fetch(url, {
          headers: { "x-api-key": secret, Authorization: `Bearer ${secret}`, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(10_000),
        });
        return summarize(url, res);
      }
      case "openai": {
        const url = modelsUrl(baseUrl || "https://api.openai.com");
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(10_000),
        });
        return summarize(url, res);
      }
      case "openrouter": {
        const url = "https://openrouter.ai/api/v1/models";
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(10_000),
        });
        return summarize(url, res);
      }
      default:
        return { ok: false, detail: `${cred.provider} 的连接测试暂未实现` };
    }
  } catch (e) {
    return { ok: false, detail: `连接失败: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` };
  }
}
