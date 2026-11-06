import assert from "node:assert/strict";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import test from "node:test";
import { appendGatewayHeaders, gatewayEndToEndHeaders, requestGatewayHttp } from "./gateway-transparent-http.js";
import { createGatewayResponseGuard } from "./gateway-response-guard.js";

async function body(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function fixture(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test("end-to-end field lines retain empty, unknown and repeated values and consume only transport/control boundaries", () => {
  assert.deepEqual(gatewayEndToEndHeaders([
    "Connection", "keep-alive, X-Hop", "X-Hop", "consumed", "Keep-Alive", "timeout=3",
    "Host", "untrusted.invalid", "Authorization", "Bearer job", "x-api-key", "job",
    "anthropic-api-key", "job", "proxy-authorization", "job", "x-deepsonar-job", "job",
    "X-Traffic-Type", "eval", "X-Future", "", "X-Future", "second", "x-deepsonar-extension", "business",
    "Content-Type", "application/octet-stream", "Content-Length", "4",
  ], { request: true }), [
    "X-Traffic-Type", "eval", "X-Future", "", "X-Future", "second", "x-deepsonar-extension", "business",
    "Content-Type", "application/octet-stream", "Content-Length", "4",
  ]);
  assert.deepEqual(gatewayEndToEndHeaders(["Set-Cookie", "a=1", "Set-Cookie", "b=2", "Retry-After", "5"]),
    ["Set-Cookie", "a=1", "Set-Cookie", "b=2", "Retry-After", "5"]);
});

test("illegal field names, values, Connection lists and ambiguous framing are rejected", () => {
  for (const invalid of [
    ["missing-value"], ["bad name", "x"], ["x-name", "value\r\ninjected: true"],
    ["connection", "valid,invalid name"], ["content-length", "-1"],
    ["content-length", "1", "Content-Length", "1"],
    ["content-length", "1", "transfer-encoding", "chunked"],
    ["transfer-encoding", "gzip, chunked"],
  ]) assert.throws(() => gatewayEndToEndHeaders(invalid));
});

test("inbound business headers override defaults while authentication comes only from the bound credential", () => {
  assert.deepEqual(appendGatewayHeaders(
    { "x-traffic-type": "configured", accept: "application/json", authorization: "bad-config" },
    ["X-Traffic-Type", "client", "X-Traffic-Type", "again", "authorization", "Bearer job"],
    { authorization: "Bearer synthetic-upstream-key" },
  ), ["accept", "application/json", "X-Traffic-Type", "client", "X-Traffic-Type", "again",
    "authorization", "Bearer synthetic-upstream-key"]);
  assert.deepEqual(appendGatewayHeaders(
    { "x-hop": "must-not-reappear", accept: "application/json" },
    ["connection", "x-hop, authorization", "authorization", "Bearer job", "x-deepsonar-request-id", "internal"],
    { authorization: "Bearer bound-key" },
  ), ["accept", "application/json", "authorization", "Bearer bound-key"]);
});

test("raw HTTP transport preserves opaque path/query, repeated headers and raw binary for every supported method", async () => {
  const seen: Array<{ method: string; url: string; headers: string[]; body: Buffer }> = [];
  const upstream = await fixture(async (request, response) => {
    seen.push({ method: request.method!, url: request.url!, headers: request.rawHeaders, body: await body(request) });
    response.writeHead(200, { "content-length": "0" }).end();
  });
  try {
    const raw = Buffer.from([0, 255, 13, 10, 123]);
    const path = "/prefix/a/../%2E/%2f?empty=&repeat=1&repeat=2&encoded=%2f&bare";
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      const response = await requestGatewayHttp({ url: `${upstream.url}${path}`, method,
        headers: ["X-Repeated", "one", "X-Repeated", "two", "Content-Type", "application/octet-stream"],
        body: raw, signal: AbortSignal.timeout(5_000) });
      await body(response);
      const last = seen.at(-1)!;
      assert.equal(last.method, method);
      assert.equal(last.url, path);
      assert.deepEqual(last.body, raw);
      assert.deepEqual(last.headers.slice(0, 4), ["X-Repeated", "one", "X-Repeated", "two"]);
    }
  } finally { await upstream.close(); }
});

test("status, repeated response headers and compressed bytes are untouched; redirects and errors are one exchange", async () => {
  const compressed = gzipSync(Buffer.from("synthetic error response"));
  let count = 0;
  const upstream = await fixture((request, response) => {
    count += 1;
    response.writeHead(Number(request.url!.slice(1)), [
      "Content-Encoding", "gzip", "Content-Length", String(compressed.length),
      "Retry-After", "3", "X-Request-ID", "synthetic-id", "Set-Cookie", "a=1", "Set-Cookie", "b=2",
      "Location", "/must-not-follow",
    ]).end(compressed);
  });
  try {
    for (const status of [302, 307, 400, 401, 429, 500, 503]) {
      const before = count;
      const response = await requestGatewayHttp({ url: `${upstream.url}/${status}`, method: "POST", headers: [],
        body: Buffer.from("request"), signal: AbortSignal.timeout(5_000) });
      assert.equal(response.statusCode, status);
      assert.equal(response.headers["content-encoding"], "gzip");
      assert.equal(response.headers["content-length"], String(compressed.length));
      assert.equal(response.headers["retry-after"], "3");
      assert.deepEqual(response.headers["set-cookie"], ["a=1", "b=2"]);
      assert.deepEqual(await body(response), compressed);
      assert.equal(count, before + 1);
    }
  } finally { await upstream.close(); }
});

test("stream first bytes arrive before upstream completion; cancellation tears down the exchange", { timeout: 5_000 }, async () => {
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  const upstream = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: unknown\ndata: {\"extension\":true}\n\n");
    response.on("close", finish);
  });
  try {
    const abort = new AbortController();
    const response = await requestGatewayHttp({ url: `${upstream.url}/sse`, method: "GET", headers: [], body: null, signal: abort.signal });
    const chunks = response[Symbol.asyncIterator]();
    const first = await chunks.next();
    assert.equal(Buffer.from(first.value).toString(), "event: unknown\ndata: {\"extension\":true}\n\n");
    abort.abort();
    await assert.rejects(async () => { await chunks.next(); });
    await closed;
  } finally { await upstream.close(); }
});

test("upstream truncation is an interrupted body, never a successful complete response", { timeout: 5_000 }, async () => {
  let truncate!: () => void;
  const upstream = await fixture((_request, response) => {
    response.writeHead(200, { "content-length": "100" });
    response.write("first");
    truncate = () => response.destroy();
  });
  try {
    const response = await requestGatewayHttp({ url: `${upstream.url}/truncated`, method: "GET", headers: [],
      body: null, signal: AbortSignal.timeout(4_000) });
    const chunks = response[Symbol.asyncIterator]();
    assert.equal(Buffer.from((await chunks.next()).value).toString(), "first");
    truncate();
    await assert.rejects(async () => { await chunks.next(); });
    assert.equal(response.complete, false);
  } finally { await upstream.close(); }
});

test("target userinfo, non HTTP schemes, fragments and mismatched Content-Length fail before network", async () => {
  for (const url of ["file:///tmp/test", "http://user:password@127.0.0.1/", "http://127.0.0.1/#fragment"]) {
    await assert.rejects(requestGatewayHttp({ url, method: "POST", headers: [], body: null, signal: new AbortController().signal }));
  }
  await assert.rejects(requestGatewayHttp({ url: "http://127.0.0.1:1/", method: "GET", headers: ["content-length", "99"],
    body: Buffer.from("x"), signal: new AbortController().signal }), /invalid_gateway_content_length/u);
});

test("request trailers preserve repeated business values with correct chunked framing and consume authentication", async () => {
  const received: Array<{ headers: http.IncomingHttpHeaders; trailers: string[]; bytes: Buffer }> = [];
  const upstream = await fixture(async (request, response) => {
    const bytes = await body(request);
    received.push({ headers: request.headers, trailers: request.rawTrailers, bytes });
    response.end("ok");
  });
  try {
    const response = await requestGatewayHttp({ url: `${upstream.url}/trailer`, method: "POST",
      headers: ["content-length", "4", "authorization", "Bearer bound-key"], body: Buffer.from("body"),
      trailers: ["X-Checksum", "one", "X-Checksum", "two", "X-Extra", "",
        "authorization", "Bearer job-token", "x-api-key", "job-token", "x-deepsonar-request-id", "internal"],
      signal: AbortSignal.timeout(5_000) });
    await body(response);
    const observed = received[0];
    assert.ok(observed);
    assert.equal(observed.headers["content-length"], undefined);
    assert.equal(observed.headers["transfer-encoding"], "chunked");
    assert.equal(observed.headers.trailer, "x-checksum, x-extra");
    assert.equal(observed.headers.authorization, "Bearer bound-key");
    assert.deepEqual(observed.bytes, Buffer.from("body"));
    assert.deepEqual(observed.trailers, ["X-Checksum", "one", "X-Checksum", "two", "X-Extra", ""]);
    await assert.rejects(requestGatewayHttp({ url: `${upstream.url}/trailer`, method: "POST", headers: [],
      body: Buffer.from("body"), trailers: ["content-length", "4"], signal: AbortSignal.timeout(5_000) }), /invalid_gateway_trailer/u);
  } finally { await upstream.close(); }
});

test("credential echo guard scans a decoded side copy across compressed chunks without changing the wire bytes", async () => {
  const secret = "synthetic-credential-only";
  for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync]] as const) {
    const compressed = compress(Buffer.from(`prefix:${secret}:suffix`));
    const original = Buffer.from(compressed);
    const guard = createGatewayResponseGuard(secret, encoding);
    try {
      await assert.rejects(async () => {
        for (let offset = 0; offset < compressed.length; offset++) await guard.inspect(compressed.subarray(offset, offset + 1));
        await guard.finish();
      }, /gateway_upstream_credential_echo/u);
      assert.deepEqual(compressed, original);
    } finally { guard.destroy(); }
  }
  const plain = createGatewayResponseGuard(secret, "identity");
  try {
    await plain.inspect(Buffer.from("prefix:synthetic-cred"));
    await assert.rejects(plain.inspect(Buffer.from("ential-only:suffix")), /gateway_upstream_credential_echo/u);
  } finally { plain.destroy(); }
});

test("response guard accepts compressed safe bytes and rejects corrupt, unsupported or oversized decoded content", async () => {
  const safe = createGatewayResponseGuard("synthetic-credential-only", "gzip");
  try { await safe.inspect(gzipSync(Buffer.from("safe"))); await safe.finish(); } finally { safe.destroy(); }
  assert.throws(() => createGatewayResponseGuard("synthetic-key", "unsupported"), /unsupported_gateway_response_encoding/u);
  for (const bytes of [Buffer.from("not gzip"), gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1))]) {
    const guard = createGatewayResponseGuard("synthetic-key", "gzip");
    try {
      await assert.rejects(async () => { await guard.inspect(bytes); await guard.finish(); });
    } finally { guard.destroy(); }
  }
});

test("loopback compressed credential echo is blocked by the response guard before forwarding its completing chunk", async () => {
  const secret = "synthetic-upstream-key";
  const compressed = gzipSync(Buffer.from(`{"echo":"${secret}"}`));
  const upstream = await fixture((_request, response) => {
    response.writeHead(200, { "content-encoding": "gzip" });
    response.end(compressed);
  });
  const guard = createGatewayResponseGuard(secret, "gzip");
  try {
    const response = await requestGatewayHttp({ url: `${upstream.url}/echo`, method: "GET", headers: [],
      body: null, signal: AbortSignal.timeout(5_000) });
    await assert.rejects(async () => {
      for await (const chunk of response) {
        const bytes = Buffer.from(chunk);
        for (let offset = 0; offset < bytes.length; offset++) await guard.inspect(bytes.subarray(offset, offset + 1));
      }
      await guard.finish();
    }, /gateway_upstream_credential_echo/u);
  } finally { guard.destroy(); await upstream.close(); }
});
