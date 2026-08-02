import { decryptSecret, PROVIDER_ENV_MAP } from "./credentials.js";

type CredentialProbe = {
  provider: string;
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  public_metadata_json: unknown;
};

function modelsUrl(root: string): string {
  const normalized = root.replace(/\/+$/, "");
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/models`;
  return `${normalized}/v1/models`;
}

function modelRequest(cred: CredentialProbe, secret: string): { url: string; headers: Record<string, string> } {
  const mapping = PROVIDER_ENV_MAP[cred.provider];
  if (!mapping) throw new Error(`未知 provider: ${cred.provider}`);
  const meta = (cred.public_metadata_json ?? {}) as { base_url?: string };
  const baseUrl = (meta.base_url ?? mapping.defaultBaseUrl ?? "").replace(/\/+$/, "");
  if (cred.provider === "openrouter") {
    return { url: "https://openrouter.ai/api/v1/models", headers: { Authorization: `Bearer ${secret}` } };
  }
  if (!baseUrl && cred.provider !== "openai") throw new Error("缺 base_url（可在凭据编辑里补）");
  return {
    url: modelsUrl(baseUrl || "https://api.openai.com"),
    headers: cred.provider === "anthropic" || cred.provider === "kimi"
      ? { "x-api-key": secret, Authorization: `Bearer ${secret}`, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${secret}` },
  };
}

/** 从 Provider 的只读 models 接口发现可用模型 ID；不回传响应正文或凭据。 */
export async function listCredentialModels(cred: CredentialProbe): Promise<{
  models: string[];
  source_url: string;
  fetched_at: string;
}> {
  if (!["anthropic", "kimi", "openai", "openrouter"].includes(cred.provider)) {
    throw new Error(`${cred.provider} 不支持模型目录`);
  }
  const secret = decryptSecret(cred);
  const request = modelRequest(cred, secret);
  const res = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`模型目录请求失败：HTTP ${res.status}`);
  const payload = await res.json() as { data?: unknown; models?: unknown };
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const models = [...new Set(rows.map((row) => {
    if (typeof row === "string") return row.trim();
    if (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string") {
      return String((row as { id: string }).id).trim();
    }
    return "";
  }).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (models.length === 0) throw new Error("Provider 返回成功，但没有可识别的模型 ID");
  return { models, source_url: request.url, fetched_at: new Date().toISOString() };
}

/**
 * Credential 连接测试（§6.2：支持连接测试）：用解密后的凭据对 provider 做一次
 * 轻量只读调用。明文不出进程；结果只回 ok/状态码/错误摘要（绝不回显密钥）。
 */
export async function testCredential(cred: CredentialProbe): Promise<{ ok: boolean; detail: string }> {
  const mapping = PROVIDER_ENV_MAP[cred.provider];
  if (!mapping) return { ok: false, detail: `未知 provider: ${cred.provider}` };

  let secret: string;
  try {
    secret = decryptSecret(cred);
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "解密失败" };
  }

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
    if (!["anthropic", "kimi", "openai", "openrouter"].includes(cred.provider)) {
      return { ok: false, detail: `${cred.provider} 的连接测试暂未实现` };
    }
    const request = modelRequest(cred, secret);
    const res = await fetch(request.url, { headers: request.headers, signal: AbortSignal.timeout(10_000) });
    return summarize(request.url, res);
  } catch (e) {
    return { ok: false, detail: `连接失败: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}` };
  }
}
