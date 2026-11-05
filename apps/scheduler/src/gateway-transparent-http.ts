import http, { type IncomingMessage, validateHeaderName, validateHeaderValue } from "node:http";
import https from "node:https";

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
const AUTH = new Set(["authorization", "x-api-key", "anthropic-api-key", "proxy-authorization"]);
const CONTROL = new Set([
  "x-deepsonar-request-id", "x-deepsonar-job", "x-deepsonar-workload", "x-deepsonar-effect-status", "x-deepsonar-proposal-revision",
]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/** Keep repeated field lines; never turn raw headers into a lossy object. */
export function gatewayEndToEndHeaders(rawHeaders: string[], options: { request?: boolean } = {}): string[] {
  if (rawHeaders.length % 2 !== 0) throw new Error("invalid_gateway_headers");
  const connectionFields = new Set<string>();
  let lengths = 0;
  let transferEncoding = false;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!;
    const value = rawHeaders[index + 1]!;
    validateHeaderName(name);
    validateHeaderValue(name, value);
    const lower = name.toLowerCase();
    if (lower === "content-length") {
      lengths += 1;
      if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("invalid_gateway_content_length");
    }
    if (lower === "transfer-encoding") {
      if (transferEncoding || value.trim().toLowerCase() !== "chunked") throw new Error("unsupported_gateway_transfer_encoding");
      transferEncoding = true;
    }
    if (lower === "connection") {
      for (const field of value.split(",")) {
        const token = field.trim().toLowerCase();
        if (!TOKEN.test(token)) throw new Error("invalid_gateway_connection");
        connectionFields.add(token);
      }
    }
  }
  if (lengths > 1 || (lengths > 0 && transferEncoding)) throw new Error("invalid_gateway_framing");
  const output: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connectionFields.has(lower)) continue;
    if (options.request && (lower === "host" || AUTH.has(lower) || CONTROL.has(lower))) continue;
    output.push(name, rawHeaders[index + 1]!);
  }
  return output;
}

/** Client field lines override server defaults; only bound authentication is authoritative. */
export function appendGatewayHeaders(defaults: Record<string, string>, inbound: string[], auth: Record<string, string>): string[] {
  const present = new Set(inbound.filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase()));
  const headers: string[] = [];
  for (const [name, value] of Object.entries(defaults)) {
    if (!present.has(name.toLowerCase())) headers.push(name, value);
  }
  headers.push(...inbound);
  // Validate/filter defaults as well. A configured authentication carrier cannot win.
  const safe = gatewayEndToEndHeaders(headers, { request: true });
  for (const [name, value] of Object.entries(auth)) {
    validateHeaderName(name);
    validateHeaderValue(name, value);
    if (!AUTH.has(name.toLowerCase())) throw new Error("invalid_gateway_auth_header");
    safe.push(name, value);
  }
  return safe;
}

/** Single HTTP exchange. No redirect, retry, decompression, JSON conversion or event parsing. */
export async function requestGatewayHttp(input: {
  url: string;
  method: string;
  headers: string[];
  body: Buffer | null;
  trailers?: string[];
  signal: AbortSignal;
}): Promise<IncomingMessage> {
  // Parse only the authority with WHATWG URL: parsing the full URL would remove dot
  // segments and change an otherwise legal opaque upstream path/query.
  const parts = /^(https?):\/\/([^/?#]+)([^#]*)$/iu.exec(input.url);
  if (!parts || /[\\\s]/u.test(parts[2]!)) throw new Error("invalid_gateway_target");
  const authority = new URL(`${parts[1]}://${parts[2]}`);
  if (authority.username || authority.password) throw new Error("invalid_gateway_target");
  const path = parts[3]!.startsWith("/") ? parts[3]! : `/${parts[3]!}`;
  if (/[^\x21-\x7e]/u.test(path) || !TOKEN.test(input.method)) throw new Error("invalid_gateway_request_target");
  // Validate caller framing without stripping final authentication. Host is always
  // rebuilt from the bound target, even if a caller accidentally supplies one.
  const headers = gatewayEndToEndHeaders(input.headers);
  const trailers = gatewayEndToEndHeaders(input.trailers ?? [], { request: true });
  const trailerPairs: Array<[string, string]> = [];
  for (let index = 0; index < trailers.length; index += 2) {
    const name = trailers[index]!;
    // These fields must describe the representation before its bytes are read.
    if (["content-length", "content-type", "content-encoding", "content-range"].includes(name.toLowerCase())) {
      throw new Error("invalid_gateway_trailer");
    }
    trailerPairs.push([name, trailers[index + 1]!]);
  }
  const output: string[] = [];
  let contentLength: number | null = null;
  for (let index = 0; index < headers.length; index += 2) {
    const name = headers[index]!;
    if (name.toLowerCase() === "host") continue;
    if (name.toLowerCase() === "content-length") {
      contentLength = Number(headers[index + 1]);
      if (trailerPairs.length > 0) continue;
    }
    output.push(name, headers[index + 1]!);
  }
  const length = input.body?.byteLength ?? 0;
  if (contentLength !== null && contentLength !== length) throw new Error("invalid_gateway_content_length");
  if (trailerPairs.length > 0) {
    output.push("transfer-encoding", "chunked", "trailer", [...new Set(trailerPairs.map(([name]) => name.toLowerCase()))].join(", "));
  } else if (contentLength === null && input.body !== null) output.push("content-length", String(length));
  output.push("host", authority.host);
  const transport = authority.protocol === "https:" ? https : http;
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const request = transport.request({
      protocol: authority.protocol,
      hostname: authority.hostname.replace(/^\[|\]$/gu, ""),
      port: authority.port || undefined,
      path,
      method: input.method,
      headers: output,
      signal: input.signal,
      insecureHTTPParser: false,
      agent: false,
    }, (response) => {
      response.once("close", () => request.destroy());
      resolve(response);
    });
    request.on("error", reject);
    // A protocol upgrade is not a transparent HTTP response body; do not leave an
    // upgraded socket alive outside Job cancellation and accounting.
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      request.destroy();
      reject(new Error("gateway_upgrade_unsupported"));
    });
    if (trailerPairs.length > 0) {
      if (input.body) request.write(input.body);
      request.addTrailers(trailerPairs);
      request.end();
    } else request.end(input.body ?? undefined);
  });
}
