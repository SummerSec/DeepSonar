import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { RepairTokenBudgetError, boundRepairOutput } from "./domains/event-ingestion/repair-token-budget.js";

/** Decode an observation copy only; the forwarded representation is never replaced. */
export function gatewayObservationBytes(bytes: Buffer, encoding: string | undefined): Buffer {
  const options = { maxOutputLength: 16 * 1024 * 1024 };
  switch (encoding?.trim().toLowerCase()) {
    case undefined: case "": case "identity": return bytes;
    case "gzip": return gunzipSync(bytes, options);
    case "deflate": return inflateSync(bytes, options);
    case "br": return brotliDecompressSync(bytes, options);
    default: throw new Error("unsupported_content_encoding");
  }
}

/** Budget policy rejects requests requiring adaptation, instead of silently rewriting them. */
export function assertGatewayOutputBudget(body: unknown, path: string, remaining: number | null): void {
  const bounded = boundRepairOutput(body, path, remaining);
  if (JSON.stringify(bounded) !== JSON.stringify(body)) {
    throw new RepairTokenBudgetError("GATEWAY_OUTPUT_BUDGET_REQUIRED",
      "Request must supply an output limit within the remaining allowance and terminal usage; Gateway does not rewrite requests");
  }
}

/** Exact base-path overlap is the only mapping rule; no version or provider guessing. */
export function transparentGatewayUrl(baseUrl: string, upstreamPath: string, query = ""): string {
  const parts = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/iu.exec(baseUrl);
  if (!parts || /[\\\s]/u.test(parts[2]!)) throw new Error("invalid_gateway_base_url");
  const authority = new URL(`${parts[1]}://${parts[2]}`);
  if (authority.username || authority.password) throw new Error("invalid_gateway_base_url");
  const prefix = (parts[3] ?? "").replace(/\/$/u, "");
  const path = upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`;
  if (path.startsWith("//") || path.includes("?") || (query !== "" && !query.startsWith("?"))
    || /[\x00-\x20\x7f#\\]/u.test(prefix + path + query)) throw new Error("invalid_gateway_path");
  const mapped = prefix && (path === prefix || path.startsWith(`${prefix}/`)) ? path : `${prefix}${path}`;
  return `${authority.origin}${mapped}${query}`;
}
