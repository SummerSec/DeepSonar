import {
  TargetAuthorizationResponse,
  type TargetAuthorizationConfig,
  type TargetAuthorizationRequest,
  resolveTargetAuthorizationSecret,
} from "./contract.js";

export type TargetAuthorizationTransportErrorCode =
  | "target_authorization_secret_unavailable"
  | "target_authorization_timeout"
  | "target_authorization_unavailable"
  | "target_authorization_redirect_rejected"
  | "target_authorization_response_too_large"
  | "target_authorization_malformed";

export type TargetAuthorizationHttpResult =
  | { kind: "response"; response: import("./contract.js").TargetAuthorizationResponse }
  | { kind: "error"; code: TargetAuthorizationTransportErrorCode };

/** Small fetch surface so unit tests can exercise the exact HTTP boundary. */
export type TargetAuthorizationFetch = (
  input: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    redirect: "error";
    signal: AbortSignal;
  },
) => Promise<Response>;

export async function postTargetAuthorization(
  config: TargetAuthorizationConfig,
  request: TargetAuthorizationRequest,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: TargetAuthorizationFetch;
    timeoutMs?: number;
  } = {},
): Promise<TargetAuthorizationHttpResult> {
  const secret = resolveTargetAuthorizationSecret(config, options.env ?? process.env);
  if (!secret) return { kind: "error", code: "target_authorization_secret_unavailable" };
  const fetchImpl = options.fetchImpl ?? (typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis) as TargetAuthorizationFetch
    : undefined);
  if (!fetchImpl) return { kind: "error", code: "target_authorization_unavailable" };

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const timeoutMarker = Symbol("target-authorization-timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(timeoutMarker);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(config.authorityUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(request),
        redirect: "error",
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
    if (response.status >= 300 && response.status < 400) {
      return { kind: "error", code: "target_authorization_redirect_rejected" };
    }
    if (response.status !== 200) return { kind: "error", code: "target_authorization_unavailable" };
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType.trim())) {
      return { kind: "error", code: "target_authorization_malformed" };
    }
    // Keep the same deadline while reading the body.  A fetch can resolve as
    // soon as headers arrive; accepting a response whose body then stalls
    // would turn the authority into an unbounded Scheduler request.
    const body = await Promise.race([
      readBoundedBody(response, config.maxBodyBytes),
      timeoutPromise,
    ]);
    if (body.kind === "error") return body;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.value);
    } catch {
      return { kind: "error", code: "target_authorization_malformed" };
    }
    const checked = TargetAuthorizationResponse.safeParse(parsed);
    return checked.success
      ? { kind: "response", response: checked.data }
      : { kind: "error", code: "target_authorization_malformed" };
  } catch (error) {
    if (error === timeoutMarker || controller.signal.aborted) {
      return { kind: "error", code: "target_authorization_timeout" };
    }
    if (isExplicitRedirectError(error)) {
      // Undici marks redirect rejection with a dedicated cause code. A plain
      // fetch TypeError also represents DNS/refusal failures and must remain
      // unavailable instead of being misclassified as a redirect.
      return { kind: "error", code: "target_authorization_redirect_rejected" };
    }
    return { kind: "error", code: "target_authorization_unavailable" };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function isExplicitRedirectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  return candidate.code === "UND_ERR_REDIRECT" || candidate.cause?.code === "UND_ERR_REDIRECT";
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ kind: "ok"; value: string } | { kind: "error"; code: "target_authorization_response_too_large" }> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { kind: "error", code: "target_authorization_response_too_large" };
  }
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") > maxBytes
      ? { kind: "error", code: "target_authorization_response_too_large" }
      : { kind: "ok", value: text };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "error", code: "target_authorization_response_too_large" };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return { kind: "ok", value: Buffer.concat(chunks, total).toString("utf8") };
}
