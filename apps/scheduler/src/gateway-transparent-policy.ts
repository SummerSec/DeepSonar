import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { RepairTokenBudgetError, boundRepairOutput } from "./domains/event-ingestion/repair-token-budget.js";

/** Reject policy ambiguity without changing any JSON bytes or unknown business members. */
export function assertGatewayUnambiguousPolicyJson(bytes: Buffer): void {
  const source = bytes.toString("utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { return; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const policy = new Set(["model", "max_tokens", "max_completion_tokens", "max_output_tokens", "n", "best_of", "stream", "stream_options"]);
  const skipWhitespace = (offset: number): number => {
    while (offset < source.length && /\s/u.test(source[offset]!)) offset++;
    return offset;
  };
  const skipString = (offset: number): number => {
    offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "\\") offset++;
      else if (char === '"') return offset;
    }
    return offset;
  };
  const skipValue = (offset: number): number => {
    if (source[offset] === '"') return skipString(offset);
    if (source[offset] !== "{" && source[offset] !== "[") {
      while (offset < source.length && !/[,}\]\s]/u.test(source[offset]!)) offset++;
      return offset;
    }
    // Iterative nesting avoids overflowing the JS stack on deep unknown extensions.
    let depth = 0;
    do {
      const char = source[offset];
      if (char === '"') { offset = skipString(offset); continue; }
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
      offset++;
    } while (offset < source.length && depth > 0);
    return offset;
  };
  const inspectObject = (start: number, keys: ReadonlySet<string>, root: boolean): void => {
    let offset = skipWhitespace(start + 1);
    const seen = new Set<string>();
    while (offset < source.length && source[offset] !== "}") {
      const keyStart = offset;
      offset = skipString(offset);
      const key = JSON.parse(source.slice(keyStart, offset)) as string;
      if (keys.has(key)) {
        if (seen.has(key)) throw new Error("ambiguous_gateway_policy_json");
        seen.add(key);
      }
      offset = skipWhitespace(skipWhitespace(offset) + 1); // colon
      if (root && key === "stream_options" && source[offset] === "{") {
        inspectObject(offset, new Set(["include_usage"]), false);
      }
      offset = skipWhitespace(skipValue(offset));
      if (source[offset] === ",") offset = skipWhitespace(offset + 1);
    }
  };
  inspectObject(skipWhitespace(0), policy, true);
}

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
