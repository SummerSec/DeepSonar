import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { DSH_REQUEST_BUDGET_SOURCE } from "./dsh-request-budget.js";

test("DSH request generation reads each allowance, preserves frozen inputs and rejects identities", async () => {
  const policy = await import(`data:text/javascript;base64,${Buffer.from(DSH_REQUEST_BUDGET_SOURCE).toString("base64")}`);
  let remaining = 64;
  let queries = 0;
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/gateway/_allowance");
    assert.equal(request.headers.authorization, "Bearer synthetic-main-token");
    queries++;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ remaining_tokens: remaining, policy_required: true }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`;
    const model = Object.freeze({ provider: "fixture", id: "fixture-model", api: "openai-completions", baseUrl: root, maxTokens: 256 });
    const options = Object.freeze({ apiKey: "synthetic-main-token", maxTokens: 128 });
    const identity = { ...model, gatewayRoot: root, token: options.apiKey };
    const call = () => policy.prepareSdkCall({ model, options, frozenIdentity: identity });
    assert.equal((await call()).options.maxTokens, 64);
    remaining = 23;
    const second = await call();
    assert.equal(second.options.maxTokens, 23);
    assert.equal(second.model.maxTokens, 23);
    assert.equal(second.model.compat.supportsUsageInStreaming, true);
    assert.equal(model.maxTokens, 256);
    assert.equal(options.maxTokens, 128);
    assert.equal(queries, 2);
    await assert.rejects(policy.prepareSdkCall({ model: { ...model, id: "other" }, options, frozenIdentity: identity }), /DSH_BUDGET_MODEL_CHANGED/u);
    await assert.rejects(policy.prepareSdkCall({ model, options: { ...options, apiKey: "other" }, frozenIdentity: identity }), /DSH_BUDGET_AUTH_MISMATCH/u);
    assert.equal(queries, 2);
    remaining = 0;
    await assert.rejects(call(), /BUDGET_EXHAUSTED/u);
    remaining = 15;
    await assert.rejects(policy.prepareSdkCall({ model: { ...model, api: "openai-responses" }, options, frozenIdentity: { ...identity, api: "openai-responses" } }), /BUDGET_PROTOCOL_LIMIT/u);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
