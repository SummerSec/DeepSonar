import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MODEL_REQUEST_POLICY_SOURCE } from "@deepsonar/runtime-sandbox";
import { createServer, request, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { gzipSync } from "node:zlib";
import test from "node:test";
import postgres from "postgres";

const databaseUrl = process.env.TEST_DATABASE_URL;
type Captured = { method: string; path: string; headers: string[]; body: Buffer };
type Response = { status: number; headers: string[]; body: Buffer };
const values = (headers: string[], name: string) => headers.flatMap((value, i) =>
  i % 2 === 0 && value.toLowerCase() === name.toLowerCase() ? [headers[i + 1]!] : []);
const read = async (stream: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
function send(port: number, path: string, method: string, headers: string[], chunks: Buffer[] = []): Promise<Response> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path, method, headers: ["host", `127.0.0.1:${port}`, ...headers] }, (response) => {
      void read(response).then(body => resolve({ status: response.statusCode!, headers: response.rawHeaders, body }), reject);
    });
    outgoing.on("error", reject);
    for (const chunk of chunks) outgoing.write(chunk);
    outgoing.end();
  });
}

function rawExchange(port: number, path: string, bearer: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.setTimeout(5_000, () => socket.destroy(new Error("Raw HTTP exchange deadline exceeded")));
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    socket.on("error", error => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    socket.on("connect", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${bearer}\r\nConnection: close\r\n\r\n`));
  });
}

// Real TCP and an isolated database: assertions compare what a synthetic upstream sees,
// not configuration projections. No production endpoint, model or credential is used.
test("transparent Gateway preserves admitted HTTP requests and responses", { skip: !databaseUrl, timeout: 60_000 }, async (t) => {
  const adminUrl = new URL(databaseUrl!);
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const name = `gateway_transparent_${process.pid}_${Date.now()}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const target = new URL(databaseUrl!);
  target.pathname = `/${name}`;
  target.search = "";
  process.env.DATABASE_URL = target.toString();
  process.env.AGENT_MODE = "fake";
  process.env.DEEPSONAR_MASTER_KEY = "00".repeat(32);
  const [{ default: Fastify }, { sql, migrate }, gateway, { encryptSecret }, { createAttempt }] = await Promise.all([
    import("fastify"), import("./db.js"), import("./gateway.js"), import("./credentials.js"),
    import("./domains/job-attempt/application.js"),
  ]);
  const { freezeGatewayProviderBinding } = await import("./gateway-provider-binding.js");
  const captured: Captured[] = [];
  const secret = "synthetic-upstream-key";
  let finishEcho: (() => void) | undefined;
  const payload = Buffer.from([0, 255, 13, 10, 128, 65]);
  const compressed = gzipSync(payload);
  const slowPayload = Buffer.alloc(4 * 1024 * 1024, 0x65);
  let finishSse: (() => void) | undefined;
  let cancelSeen: (() => void) | undefined;
  const sseFirst = Buffer.from('event: extension\r\ndata: {"unknown":true}\r\n\r\n');
  const sseLast = Buffer.from('data: {"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n');
  const upstream = createServer((req, res) => {
    void (async () => {
      const body = await read(req);
      captured.push({ method: req.method!, path: req.url!, headers: req.rawHeaders, body });
      const path = req.url!.split("?")[0]!;
      const status = /^\/v1\/status\/(\d+)$/u.exec(path);
      res.setHeader("x-request-id", "synthetic-request");
      res.setHeader("x-unknown-response", ["first", "second"]);
      res.setHeader("set-cookie", ["fixture=a", "fixture=b"]);
      if (req.headers["x-policy-fixture"] === "main-generation") {
        const common = { input_tokens: 3, output_tokens: 2, total_tokens: 5 };
        const response = path === "/v1/messages"
          ? { type: "message", role: "assistant", stop_reason: "end_turn", content: [], usage: common }
          : path === "/v1/chat/completions"
            ? { object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { content: "fixture" } }],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
            : { object: "response", status: "completed", output: [], usage: common };
        res.setHeader("content-type", "application/json");
        // Completion waits for Gateway's final chunk and durable settlement, rather
        // than reaching Content-Length before its SQL transaction can finish.
        res.setHeader("transfer-encoding", "chunked");
        res.end(JSON.stringify(response));
      } else if (status) {
        res.statusCode = Number(status[1]);
        res.setHeader("retry-after", "9");
        res.setHeader("location", "http://127.0.0.1:1/never-follow");
        res.end(Buffer.from(`upstream ${status[1]}\n`));
      } else if (path === "/v1/echo-reason") {
        res.statusMessage = `upstream ${secret}`;
        res.end("safe body");
      } else if (path === "/v1/echo-header-name") {
        res.setHeader(`x-${secret}`, "safe value");
        res.end("safe body");
      } else if (path === "/v1/echo-trailer-name") {
        res.write("safe body");
        // No Trailer declaration: exercise the final trailer-name check itself,
        // rather than detecting the secret in an initial header value.
        res.addTrailers({ [`x-${secret}`]: "safe value" });
        res.end();
      } else if (path === "/v1/echo-header") {
        res.setHeader("x-upstream-debug", secret);
        res.end("must not expose response headers");
      } else if (path === "/v1/echo-body") {
        res.write(`safe prefix ${secret.slice(0, 8)}`);
        // The test releases this only after seeing the safe prefix downstream,
        // proving the secret spans distinct observed upstream chunks.
        finishEcho = () => { finishEcho = undefined; res.end(`${secret.slice(8)} unsafe suffix`); };
      } else if (path === "/v1/not-modified") {
        res.statusCode = 304;
        res.setHeader("content-encoding", "gzip");
        res.setHeader("content-length", compressed.length);
        res.end();
      } else if (path === "/v1/gzip") {
        res.setHeader("content-encoding", "gzip");
        res.setHeader("content-length", compressed.length);
        res.end(compressed);
      } else if (path === "/v1/sse") {
        res.setHeader("content-type", "text/event-stream");
        res.write(sseFirst);
        finishSse = () => { finishSse = undefined; res.end(sseLast); };
      } else if (path === "/v1/cancel") {
        res.setHeader("content-type", "text/event-stream");
        res.write(sseFirst);
        res.on("close", () => cancelSeen?.());
      } else if (path === "/v1/slow") {
        res.setHeader("content-length", slowPayload.length);
        for (let offset = 0; offset < slowPayload.length; offset += 32768) {
          if (!res.write(slowPayload.subarray(offset, offset + 32768))) await once(res, "drain");
        }
        res.end();
      } else if (path === "/v1/interrupted") {
        res.setHeader("content-length", 10000);
        res.write("partial");
        setTimeout(() => res.destroy(), 20);
      } else {
        res.setHeader("content-type", "application/octet-stream");
        res.setHeader("content-length", payload.length);
        res.end(payload);
      }
    })().catch(error => res.destroy(error));
  });
  const app = Fastify();
  try {
    await migrate();
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    gateway.registerGateway(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const gatewayAddress = app.server.address();
    assert.ok(gatewayAddress && typeof gatewayAddress !== "string");
    const gatewayPort = gatewayAddress.port;
    const projectId = randomUUID();
    const credentialId = randomUUID();
    const jobId = randomUUID();
    const encrypted = encryptSecret(secret);
    await sql`INSERT INTO projects(id,name) VALUES(${projectId},'transparent fixture')`;
    await sql`INSERT INTO credentials(id,name,kind,provider,ciphertext,nonce,auth_tag,fingerprint,last4,public_metadata_json)
      VALUES(${credentialId},'offline','llm_provider','openai',${encrypted.ciphertext},${encrypted.nonce},
        ${encrypted.auth_tag},'offline','only',${sql.json({ base_url: `http://127.0.0.1:${address.port}/v1` })})`;
    const [boundCredential] = await sql`SELECT * FROM credentials WHERE id=${credentialId}`;
    const binding = freezeGatewayProviderBinding(boundCredential as never);
    await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
      VALUES(${jobId},${projectId},'audit','running',${sql.json({ name: "audit", agent_cli: "claude-code", runtime_knobs: { job_token_max_requests: 0, stall_sec: 600, timeout_sec: 3600, provision_timeout_sec: 600, sources: {} }, upstream_model: "not-an-alias", credential_id: credentialId, credential_provider: "openai", settings_config_json: {}, gateway_provider_binding: binding })},
        now(),3600,now()+interval '1 hour')`;
    await sql.begin(tx => createAttempt(tx as unknown as typeof sql, jobId));
    const token = await gateway.mintJobToken({ jobId, projectId, credentialId, maxRequests: 0, maxTokens: 0 });
    const auth = ["authorization", `Bearer ${token.plaintext}`, "x-api-key", token.plaintext,
      "anthropic-api-key", token.plaintext, "proxy-authorization", token.plaintext];
    const via = (path: string, method = "GET", headers: string[] = [], chunks: Buffer[] = []) =>
      send(gatewayPort, `/gateway${path}`, method, [...auth, ...headers], chunks);

    await t.test("raw encoded path, repeated query/headers, JSON extensions, binary and chunked bodies match direct HTTP", async () => {
      const cases = [
        { body: Buffer.from(' { "model" : "fable", "tools": [], "future": {"x":1}, "max_tokens":21 }\n'), type: "application/json" },
        { body: Buffer.from("non-json \u2603\n"), type: "text/plain; charset=utf-8" },
        { body: payload, type: "application/octet-stream" },
        { body: Buffer.from('{ "model": "fixture", invalid-json'), type: "application/json" },
      ];
      for (const fixture of cases) {
        const path = "/v1/a%2Fb/%7e?a=1&a=2&empty=&flag&encoded=%252f+%20&octet=%ff";
        const business = ["content-type", fixture.type, "accept", "application/x-future", "user-agent", "fixture-cli",
          "x-traffic-type", "eval", "x-future-protocol", "one", "x-future-protocol", "two",
          "anthropic-future", "enabled", "x-deepsonar-business", "end-to-end", "cookie", "a=1", "cookie", "b=2"];
        const chunks = [fixture.body.subarray(0, 2), fixture.body.subarray(2)];
        const direct = await send(address.port, path, "POST", ["authorization", `Bearer ${secret}`, ...business], chunks);
        const expected = captured.at(-1)!;
        const response = await via(path, "POST", [...business, "connection", "x-connection-private", "x-connection-private", "hop-only"], chunks);
        const actual = captured.at(-1)!;
        assert.equal(response.status, direct.status);
        assert.deepEqual(response.body, direct.body);
        assert.equal(actual.path, expected.path);
        assert.equal(actual.method, expected.method);
        assert.deepEqual(actual.body, expected.body, "Gateway must not reserialize JSON or rewrite model/output fields");
        for (let i = 0; i < business.length; i += 2) assert.deepEqual(values(actual.headers, business[i]!), values(expected.headers, business[i]!));
        assert.deepEqual(values(actual.headers, "x-connection-private"), []);
        assert.deepEqual(values(actual.headers, "authorization"), [`Bearer ${secret}`]);
        for (const name of ["x-api-key", "anthropic-api-key", "proxy-authorization"]) assert.deepEqual(values(actual.headers, name), []);
        assert.ok(!actual.headers.join(" ").includes(token.plaintext));
        assert.ok(!response.headers.join(" ").includes(secret));
        assert.ok(!response.body.includes(secret));
        assert.deepEqual(values(response.headers, "x-unknown-response"), ["first", "second"]);
        assert.deepEqual(values(response.headers, "set-cookie"), ["fixture=a", "fixture=b"]);
      }
    });
    await t.test("Job token in a business header or body is rejected before forwarding", async () => {
      const before = captured.length;
      const headerLeak = await via("/v1/messages", "GET", ["x-business-data", `prefix-${token.plaintext}`]);
      assert.equal(headerLeak.status, 400);
      const bodyLeak = await via("/v1/messages", "POST", ["content-type", "application/octet-stream"], [Buffer.from(token.plaintext)]);
      assert.equal(bodyLeak.status, 400);
      for (const value of [token.plaintext, [...token.plaintext].map(char => `%${char.charCodeAt(0).toString(16)}`).join("")]) {
        assert.equal((await via(`/v1/messages?debug=${value}`)).status, 400);
        assert.equal((await via(`/v1/${value}`)).status, 400);
      }
      const partlyEncoded = `%${token.plaintext.charCodeAt(0).toString(16)}${token.plaintext.slice(1)}`;
      for (const target of [`/v1/messages?debug=${partlyEncoded}&bad=%ZZ`,
        `/v1/messages?bad=%ZZ&debug=ok&debug=${partlyEncoded}`, `/v1/${partlyEncoded}?bad=%ZZ`]) {
        assert.equal((await via(target)).status, 400, "unrelated invalid escapes cannot hide encoded credentials");
      }
      const compressedLeak = await via("/v1/messages", "POST",
        ["content-type", "application/json", "content-encoding", "gzip"],
        [gzipSync(Buffer.from(JSON.stringify({ debug: token.plaintext })))]);
      assert.equal(compressedLeak.status, 400);
      assert.equal(captured.length, before);
      // #1032: 每次凭据拒绝都必须留下可审计痕迹，而痕迹本身不得携带凭据或请求元数据。
      const denials = await sql`SELECT actor_type, actor_id, action, project_id, resource_type, resource_id,
          request_id, ip, user_agent, result, error_code, after_json
        FROM audit_logs WHERE action = 'gateway.credential_denied' ORDER BY id ASC`;
      assert.ok(denials.length >= 4, "each credential surface records one denial trace");
      const surfaces = new Set<string>();
      for (const row of denials) {
        assert.equal(row.actor_type, "system", "denial audit must not persist request actor metadata");
        assert.equal(row.action, "gateway.credential_denied");
        assert.equal(row.result, "denied");
        assert.equal(row.error_code, "credential_in_business_data");
        assert.equal(row.project_id, projectId);
        assert.equal(row.resource_type, "job_token");
        assert.equal(row.resource_id, token.id);
        assert.equal(row.request_id, null);
        assert.equal(row.ip, null);
        assert.equal(row.user_agent, null, "raw User-Agent can itself carry the rejected credential");
        assert.deepEqual(Object.keys(row.after_json as Record<string, unknown>).sort(),
          ["attempt_id", "job_id", "surface"], "after_json holds only fixed keys");
        assert.equal((row.after_json as Record<string, unknown>).job_id, jobId);
        surfaces.add(String((row.after_json as Record<string, unknown>).surface));
      }
      assert.deepEqual([...surfaces].sort(), ["body", "request_target", "upstream_data"],
        "body, request target and business-header rejections each name their surface");
      assert.ok(!JSON.stringify(denials).includes(token.plaintext), "audit entries never echo the credential");
    });
    await t.test("duplicate policy members cannot exploit different upstream JSON parsers", async () => {
      const before = captured.length;
      for (const body of ['{"model":"other","model":"fixture","max_tokens":3}',
        '{"max_tokens":9999,"max_tokens":3}', '{"n":8,"n":1,"max_tokens":3}',
        '{"stream":true,"max_tokens":3,"stream_options":{"include_usage":false,"include_usage":true}}']) {
        const result = await via("/v1/chat/completions", "POST", ["content-type", "application/json"], [Buffer.from(body)]);
        assert.equal(result.status, 400);
      }
      assert.equal(captured.length, before);
    });
    await t.test("upstream credential echoes in headers and across body chunks abort without exposing the key", async () => {
      for (const path of ["/v1/echo-header", "/v1/echo-body"]) {
        const result = await new Promise<{ headers: string[]; body: Buffer; complete: boolean }>(resolve => {
          const chunks: Buffer[] = [];
          let headers: string[] = [];
          const finish = (complete: boolean) => resolve({ headers, body: Buffer.concat(chunks), complete });
          const outgoing = request({ host: "127.0.0.1", port: gatewayPort, path: `/gateway${path}`,
            headers: ["host", `127.0.0.1:${gatewayPort}`, ...auth] }, response => {
            headers = response.rawHeaders;
            response.on("data", chunk => {
              chunks.push(Buffer.from(chunk));
              if (path === "/v1/echo-body") finishEcho?.();
            });
            response.on("aborted", () => finish(false));
            response.on("error", () => finish(false));
            response.on("end", () => finish(true));
          });
          outgoing.on("error", () => finish(false));
          outgoing.end();
        });
        assert.equal(result.complete, false, "a credential echo must terminate the HTTP exchange");
        assert.ok(!result.headers.join(" ").includes(secret));
        assert.ok(!result.body.includes(secret));
        if (path === "/v1/echo-body") assert.equal(result.body.toString(), "safe prefix ");
      }
    });
    await t.test("raw HTTP status reason, header names and trailer names cannot return the bound key", async () => {
      for (const path of ["/v1/echo-reason", "/v1/echo-header-name", "/v1/echo-trailer-name"]) {
        const direct = await rawExchange(address.port, path, secret);
        assert.ok(direct.includes(secret), "the direct raw wire fixture must actually contain the key");
        const before = captured.length;
        const proxied = await rawExchange(gatewayPort, `/gateway${path}`, token.plaintext);
        assert.equal(captured.length, before + 1, "the authenticated request must reach the synthetic upstream");
        assert.ok(!proxied.includes(secret), "no raw response bytes may expose the complete bound key");
        if (path === "/v1/echo-trailer-name") {
          assert.match(proxied.toString(), /^HTTP\/1\.1 200/u);
          assert.ok(!proxied.includes(Buffer.from("\r\n0\r\n")), "unsafe trailers must abort before the final HTTP chunk");
        } else assert.equal(proxied.length, 0, "unsafe reason/header names must be rejected before flushing headers");
      }
    });
    await t.test("HEAD and OPTIONS preserve methods and HEAD length without a body", async () => {
      for (const method of ["HEAD", "OPTIONS"]) {
        const response = await via("/v1/method", method);
        assert.equal(captured.at(-1)!.method, method);
        assert.equal(response.status, 200);
        assert.equal(Number(values(response.headers, "content-length")[0]), payload.length);
        assert.deepEqual(response.body, method === "HEAD" ? Buffer.alloc(0) : payload);
      }
      for (const method of ["GET", "HEAD"]) {
        await via("/v1/method-body", method, ["content-type", "application/octet-stream", "content-length", "3"], [Buffer.from("abc")]);
        assert.equal(captured.at(-1)!.method, method);
        assert.deepEqual(captured.at(-1)!.body, Buffer.from("abc"));
      }
    });
    await t.test("upstream errors and redirects remain original and receive exactly one attempt", async () => {
      for (const status of [301, 302, 307, 400, 401, 403, 404, 429, 500, 502, 503]) {
        const before = captured.length;
        const response = await via(`/v1/status/${status}`, "POST", ["content-type", "application/json"], [Buffer.from('{"model":"fixture"}')]);
        assert.equal(response.status, status);
        assert.equal(response.body.toString(), `upstream ${status}\n`);
        assert.deepEqual(values(response.headers, "retry-after"), ["9"]);
        assert.deepEqual(values(response.headers, "x-request-id"), ["synthetic-request"]);
        assert.deepEqual(values(response.headers, "location"), ["http://127.0.0.1:1/never-follow"]);
        assert.equal(captured.length, before + 1);
      }
    });
    await t.test("compressed bytes retain encoding and exact content length", async () => {
      const response = await via("/v1/gzip");
      assert.deepEqual(response.body, compressed);
      assert.deepEqual(values(response.headers, "content-encoding"), ["gzip"]);
      assert.deepEqual(values(response.headers, "content-length"), [String(compressed.length)]);
    });
    await t.test("HEAD and 304 representation encoding metadata does not require a compressed entity", async () => {
      const identity = randomUUID();
      const head = await via("/v1/gzip", "HEAD", ["x-deepsonar-request-id", identity]);
      const cached = await via("/v1/not-modified");
      assert.equal(head.status, 200);
      assert.equal(cached.status, 304);
      for (const response of [head, cached]) {
        assert.equal(response.body.length, 0);
        assert.deepEqual(values(response.headers, "content-encoding"), ["gzip"]);
        assert.deepEqual(values(response.headers, "content-length"), [String(compressed.length)]);
      }
      // A HEAD client completes at the headers, before usage settlement. Verify the
      // eventual effect too: empty gzip decoding used to incorrectly mark it unknown.
      let effectStatus = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        const [effect] = await sql`SELECT status FROM job_attempt_effects WHERE job_id=${jobId}
          AND intent_json->>'gateway_request_id'=${identity}`;
        effectStatus = String(effect?.status ?? "");
        if (effectStatus && effectStatus !== "effect_pending") break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(effectStatus, "settled");
    });
    await t.test("SSE first event arrives before the upstream is allowed to finish", async () => {
      let release: (() => void) | undefined;
      const first = new Promise<void>(resolve => { release = resolve; });
      const completed = new Promise<Buffer>((resolve, reject) => {
        const outgoing = request({ host: "127.0.0.1", port: gatewayPort, path: "/gateway/v1/sse", headers: ["host", `127.0.0.1:${gatewayPort}`, ...auth] }, response => {
          const chunks: Buffer[] = [];
          response.on("data", chunk => { chunks.push(Buffer.from(chunk)); release?.(); });
          response.on("error", reject);
          response.on("end", () => resolve(Buffer.concat(chunks)));
        });
        outgoing.on("error", reject);
        outgoing.setTimeout(5_000, () => outgoing.destroy(new Error("SSE first-event deadline exceeded")));
        outgoing.end();
      });
      await Promise.race([first, completed.then(() => { throw new Error("SSE ended before the release barrier"); })]);
      assert.ok(finishSse);
      finishSse();
      assert.deepEqual(await completed, Buffer.concat([sseFirst, sseLast]));
    });
    await t.test("slow downstream consumption preserves the entire response", async () => {
      const body = await new Promise<Buffer>((resolve, reject) => {
        const outgoing = request({ host: "127.0.0.1", port: gatewayPort, path: "/gateway/v1/slow",
          headers: ["host", `127.0.0.1:${gatewayPort}`, ...auth] }, response => {
          const chunks: Buffer[] = [];
          response.on("data", chunk => {
            chunks.push(Buffer.from(chunk));
            response.pause();
            setTimeout(() => response.resume(), 1);
          });
          response.on("error", reject);
          response.on("end", () => resolve(Buffer.concat(chunks)));
        });
        outgoing.on("error", reject);
        outgoing.end();
      });
      assert.deepEqual(body, slowPayload);
    });
    await t.test("client cancellation closes the upstream response", async () => {
      const cancelled = new Promise<void>(resolve => { cancelSeen = resolve; });
      const outgoing = request({ host: "127.0.0.1", port: gatewayPort, path: "/gateway/v1/cancel", headers: ["host", `127.0.0.1:${gatewayPort}`, ...auth] });
      outgoing.on("response", response => response.once("data", () => response.destroy()));
      outgoing.on("error", () => {});
      outgoing.end();
      await cancelled;
    });
    await t.test("upstream truncation is not disguised as a successful complete body", async () => {
      await assert.rejects(via("/v1/interrupted"));
    });
    await t.test("main admission adapter preserves formed requests and both OpenAI output fields using fresh SQL allowances", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "gateway-main-policy-"));
      try {
        const modulePath = path.join(directory, "model-request-policy.mjs");
        await writeFile(modulePath, MODEL_REQUEST_POLICY_SOURCE);
        const { startModelRequestPolicy } = await import(pathToFileURL(modulePath).href);
        const fixtures = [
          { cli: "claude-code", route: "/v1/messages", field: "max_tokens",
            body: { model: "fixture-model", max_tokens: 100, messages: [], extension: { preserve: true } } },
          { cli: "pi", route: "/v1/chat/completions", field: "max_tokens",
            body: { model: "fixture-model", max_tokens: 100, stream: true, stream_options: { future: "keep" },
              messages: [], extension: { preserve: true } } },
          { cli: "pi", route: "/v1/chat/completions", field: "max_completion_tokens",
            body: { model: "fixture-model", max_completion_tokens: 100, stream: true, stream_options: { future: "keep" },
              messages: [], extension: { preserve: true } } },
          { cli: "dsh", route: "/v1/responses", field: "max_output_tokens",
            body: { model: "fixture-model", max_output_tokens: 100, input: [], extension: { preserve: true } } },
        ];
        for (const fixture of fixtures) {
          const boundedJobId = randomUUID();
          await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
            VALUES(${boundedJobId},${projectId},'audit','running',${sql.json({ name: "request policy fixture", agent_cli: fixture.cli, pi_extensions: [], runtime_knobs: { job_token_max_requests: 0, stall_sec: 600, timeout_sec: 3600, provision_timeout_sec: 600, sources: {} }, credential_id: credentialId, credential_provider: "openai", settings_config_json: {}, gateway_provider_binding: binding })},
              now(),3600,now()+interval '1 hour')`;
          await sql.begin(tx => createAttempt(tx as unknown as typeof sql, boundedJobId));
          const boundedToken = await gateway.mintJobToken({ jobId: boundedJobId, projectId, credentialId, maxRequests: 0, maxTokens: 20 });
          const policy = await startModelRequestPolicy({ upstream: `http://127.0.0.1:${gatewayPort}/gateway`, token: boundedToken.plaintext, port: 0 });
          try {
            const policyAddress = policy.server.address();
            assert.ok(policyAddress && typeof policyAddress !== "string");
            for (const remaining of [20, 15]) {
              const before = captured.length;
              const response = await send(policyAddress.port, `/gateway${fixture.route}`, "POST",
                ["authorization", `Bearer ${boundedToken.plaintext}`, "content-type", "application/json", "x-policy-fixture", "main-generation"],
                [Buffer.from(JSON.stringify({ ...fixture.body, [fixture.field]: remaining,
                  ...(fixture.cli === "pi" ? { stream_options: { ...fixture.body.stream_options, include_usage: true } } : {}) }))]);
              assert.equal(response.status, 200, `${fixture.cli}: ${response.body.toString()}`);
              assert.equal(captured.length, before + 1, "allowance reads stay inside the Gateway and do not call the model");
              const actual = captured.at(-1)!;
              const generated = JSON.parse(actual.body.toString());
              assert.equal(actual.path, fixture.route);
              assert.equal(generated[fixture.field], remaining, "the second request must read the reduced SQL allowance");
              assert.equal(generated.model, fixture.body.model);
              assert.deepEqual(generated.extension, fixture.body.extension);
              if (fixture.cli === "pi") assert.deepEqual(generated.stream_options, { future: "keep", include_usage: true });
              assert.deepEqual(values(actual.headers, "authorization"), [`Bearer ${secret}`]);
              assert.ok(!actual.headers.join(" ").includes(boundedToken.plaintext));
            }
            const original = Buffer.from(`{ "model":"fixture-model", "${fixture.field}" : 1, "extension_id":9007199254740993, "escaped":"\\u0061" }\n`);
            const digest = `sha-256=:${createHash("sha256").update(original).digest("base64")}:`;
            const rawHeaders = ["authorization", `Bearer ${boundedToken.plaintext}`, "content-type", "application/json", "x-policy-fixture", "main-generation"];
            const unchanged = await send(policyAddress.port, `/gateway${fixture.route}`, "POST",
              [...rawHeaders, "content-digest", digest], [original]);
            assert.equal(unchanged.status, 200);
            assert.deepEqual(captured.at(-1)!.body, original, "already compliant requests retain every original byte");
            assert.deepEqual(values(captured.at(-1)!.headers, "content-digest"), [digest]);
            const oversized = Buffer.from(original.toString().replace(' : 1,', ' : 100,'));
            const beforeRefusal = captured.length;
            const signed = await send(policyAddress.port, `/gateway${fixture.route}`, "POST",
              [...rawHeaders, "content-digest", digest], [oversized]);
            assert.equal(signed.status, 400, "a required edit cannot silently invalidate a supplied digest");
            assert.equal(captured.length, beforeRefusal);
            const adapted = await send(policyAddress.port, `/gateway${fixture.route}`, "POST", rawHeaders, [oversized]);
            assert.equal(adapted.status, 400, "unsigned formed requests must also be refused rather than edited");
            assert.equal(captured.length, beforeRefusal);
            const [usage] = await sql`SELECT count(*)::int AS requests, sum(total_tokens)::int AS tokens,
              bool_and(settlement_status='settled') AS settled FROM job_usage_ledger WHERE job_id=${boundedJobId}`;
            assert.deepEqual({ requests: usage.requests, tokens: usage.tokens, settled: usage.settled },
              { requests: 3, tokens: 15, settled: true });
            const [counter] = await sql`SELECT used_requests, used_tokens FROM job_tokens WHERE id=${boundedToken.id}`;
            assert.equal(Number(counter.used_requests), 3, "policy allowance lookups must not consume model requests");
            assert.equal(Number(counter.used_tokens), 15);
          } finally { await policy.close(); }
        }
      } finally { await rm(directory, { recursive: true, force: true }); }
    });
    await t.test("conflicting auth and forbidden frozen models never reach the upstream", async () => {
      const before = captured.length;
      const conflict = await send(gatewayPort, "/gateway/v1/messages", "POST",
        ["authorization", `Bearer ${token.plaintext}`, "x-api-key", "deepsonarjob_aaaaaaaa_other-synthetic-token", "content-type", "application/json"], [Buffer.from('{}')]);
      assert.equal(conflict.status, 401);
      const repeated = await send(gatewayPort, "/gateway/v1/messages", "POST",
        ["authorization", `Bearer ${token.plaintext}`, "Authorization", "Bearer deepsonarjob_aaaaaaaa_other-synthetic-token",
          "content-type", "application/json"], [Buffer.from('{}')]);
      assert.equal(repeated.status, 400, "Node header normalization must not hide conflicting duplicate authorization");
      const frozenJobId = randomUUID();
      await sql`INSERT INTO jobs(id,project_id,type,status,agent_snapshot_json,started_at,timeout_sec,lease_expires_at)
        VALUES(${frozenJobId},${projectId},'audit','running',${sql.json({ agent_cli: "claude-code", runtime_knobs: { job_token_max_requests: 0, stall_sec: 600, timeout_sec: 3600, provision_timeout_sec: 600, sources: {} }, credential_id: credentialId,
          credential_provider: "openai", settings_config_json: {}, gateway_provider_binding: binding,
          provider_model: { provider: "openai", cli_model_id: "allowed", upstream_model_id: "allowed", passthrough: false },
        })},now(),3600,now()+interval '1 hour')`;
      await sql.begin(tx => createAttempt(tx as unknown as typeof sql, frozenJobId));
      const frozenToken = await gateway.mintJobToken({ jobId: frozenJobId, projectId, credentialId, maxRequests: 0, maxTokens: 0 });
      const frozenVia = (route: string, method: string, headers: string[], chunks: Buffer[]) =>
        send(gatewayPort, `/gateway${route}`, method, ["authorization", `Bearer ${frozenToken.plaintext}`, ...headers], chunks);
      const forbidden = await frozenVia("/v1/chat/completions", "POST", ["content-type", "application/json"], [Buffer.from('{"model":"forbidden"}')]);
      assert.equal(forbidden.status, 403);
      const disguised = await frozenVia("/v1/chat/completions", "POST", ["content-type", "text/plain"], [Buffer.from('{"model":"forbidden"}')]);
      assert.equal(disguised.status, 403, "changing Content-Type cannot bypass frozen model authorization");
      const opaque = await frozenVia("/v1/chat/completions", "POST", ["content-type", "application/octet-stream"], [payload]);
      assert.equal(opaque.status, 403, "a frozen model cannot be proven by an opaque request");
      assert.equal(captured.length, before);
    });
    await t.test("ambiguous Content-Length/Transfer-Encoding is rejected before forwarding", async () => {
      const before = captured.length;
      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(gatewayPort, "127.0.0.1");
        let data = "";
        socket.on("data", chunk => { data += chunk.toString(); });
        socket.on("error", reject);
        socket.on("end", () => resolve(data));
        socket.on("connect", () => socket.write(`POST /gateway/v1/messages HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token.plaintext}\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`));
      });
      assert.match(response, /^HTTP\/1\.1 400/u);
      assert.equal(captured.length, before);
    });
  } finally {
    finishSse?.();
    finishEcho?.();
    upstream.closeAllConnections();
    await app.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
});
