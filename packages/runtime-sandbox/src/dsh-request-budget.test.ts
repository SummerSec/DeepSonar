import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { DSH_REQUEST_BUDGET_SOURCE, DSH_REQUEST_BUDGET_VENDOR_SHA256 } from "./dsh-request-budget.js";
import { DSH_REQUEST_BUDGET_ARTIFACT_SHA256, DSH_REQUEST_BUDGET_IMAGE_GUARD_SOURCE } from "./dsh-runtime-image-guard.js";

test("DSH image preflight rejects old, incomplete and mismatched governed plugin content", () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const root = "/opt/deepsonar/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai";
  const vendor = "synthetic pinned vendor";
  const artifact = "synthetic governed artifact";
  const manifestPath = root + "/lib/deepsonar-request-budget.manifest.json";
  const manifest = { version: 1, vendorVersion: "0.2.1-rc.2", sdkVersion: "1.4.0",
    vendorSha256: hash(vendor), artifactSha256: hash(artifact), helperSha256: hash(DSH_REQUEST_BUDGET_SOURCE) };
  const valid = new Map([
    [root + "/package.json", JSON.stringify({ name: "@deepseek-ai/dsh-llm-pi-ai", version: "0.2.1-rc.2" })],
    [manifestPath, JSON.stringify(manifest)],
    [root + "/lib/index.js", vendor], [root + "/lib/deepsonar-index.js", artifact],
    [root + "/lib/deepsonar-request-budget.mjs", DSH_REQUEST_BUDGET_SOURCE],
    ["/opt/deepsonar/dsh/node_modules/@earendil-works/pi-ai/package.json", JSON.stringify({ name: "@earendil-works/pi-ai", version: "1.4.0" })],
  ]);
  const check = (files: Map<string, string>) => {
    const output = { stdout: "", stderr: "", exitCode: 0 };
    const guard = DSH_REQUEST_BUDGET_IMAGE_GUARD_SOURCE
      .replace(DSH_REQUEST_BUDGET_VENDOR_SHA256, hash(vendor))
      .replace(DSH_REQUEST_BUDGET_ARTIFACT_SHA256, hash(artifact));
    runInNewContext(guard, {
      require: (name: string) => {
        if (name === "node:crypto") return { createHash };
        assert.equal(name, "node:fs");
        return { readFileSync: (file: string) => {
          if (!files.has(file)) throw new Error("ENOENT");
          return files.get(file);
        } };
      },
      process: { stdout: { write: (value: string) => { output.stdout += value; } },
        stderr: { write: (value: string) => { output.stderr += value; } },
        set exitCode(value: number) { output.exitCode = value; } },
    });
    return output;
  };
  assert.deepEqual(check(valid), { stdout: "DSH_REQUEST_BUDGET_IMAGE_READY\n", stderr: "", exitCode: 0 });
  for (const missing of valid.keys()) {
    const files = new Map(valid); files.delete(missing);
    assert.equal(check(files).exitCode, 78, missing);
  }
  for (const field of ["version", "vendorVersion", "sdkVersion", "vendorSha256", "helperSha256", "artifactSha256"]) {
    const files = new Map(valid); files.set(manifestPath, JSON.stringify({ ...manifest, [field]: "stale" }));
    assert.equal(check(files).exitCode, 78, field);
  }
  for (const file of ["index.js", "deepsonar-index.js", "deepsonar-request-budget.mjs"]) {
    const files = new Map(valid); files.set(root + "/lib/" + file, "changed bytes");
    assert.equal(check(files).exitCode, 78, file);
  }
  // A self-consistent image manifest is not authority to choose executable code.
  for (const replacement of [vendor, "arbitrary ungoverned entrypoint"]) {
    const files = new Map(valid);
    files.set(root + "/lib/deepsonar-index.js", replacement);
    files.set(manifestPath, JSON.stringify({ ...manifest, artifactSha256: hash(replacement) }));
    assert.deepEqual(check(files), { stdout: "", stderr: "DSH_REQUEST_BUDGET_IMAGE_CONTENT_INVALID\n", exitCode: 78 });
  }
  // Even a self-consistent old manifest cannot opt into the current helper policy.
  const stale = new Map(valid);
  stale.set(root + "/lib/deepsonar-request-budget.mjs", "old helper");
  stale.set(manifestPath, JSON.stringify({ ...manifest, helperSha256: hash("old helper") }));
  assert.equal(check(stale).exitCode, 78);
  const oldImage = new Map([[root + "/package.json", valid.get(root + "/package.json")!], [root + "/lib/index.js", vendor]]);
  assert.deepEqual(check(oldImage), { stdout: "", stderr: "DSH_REQUEST_BUDGET_IMAGE_CONTENT_INVALID\n", exitCode: 78 });
});

async function policyFixture() {
  const policy = await import(`data:text/javascript;base64,${Buffer.from(DSH_REQUEST_BUDGET_SOURCE).toString("base64")}`);
  return policy;
}

async function allowanceServer(state: { remaining: number | null; policyRequired: boolean }) {
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/gateway/_allowance");
    assert.equal(request.headers.authorization, "Bearer synthetic-main-token");
    response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ remaining_tokens: state.remaining, policy_required: state.policyRequired }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    root: `http://127.0.0.1:${(server.address() as AddressInfo).port}/gateway`,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test("DSH request generation reads each allowance, preserves frozen inputs and rejects identities", async () => {
  const policy = await policyFixture();
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

test("DSH pre-generation policy leaves an in-budget call untouched and turns an over-budget one into a compliant call", async () => {
  const policy = await policyFixture();
  const state = { remaining: 200 as number | null, policyRequired: true };
  const upstream = await allowanceServer(state);
  try {
    const model = Object.freeze({ provider: "fixture", id: "fixture-model", api: "openai-completions", baseUrl: upstream.root, maxTokens: 256 });
    const messages = Object.freeze([{ role: "user", content: [{ type: "text", text: "synthetic input" }] }]);
    const tools = Object.freeze([{ name: "fixture-tool", parameters: { type: "object" } }]);
    const options = Object.freeze({ apiKey: "synthetic-main-token", maxTokens: 96, messages, tools });
    const identity = { ...model, gatewayRoot: upstream.root, token: options.apiKey };
    const call = () => policy.prepareSdkCall({ model, options, frozenIdentity: identity });

    // In budget: the caller's own SDK inputs are passed through by reference, so the
    // SDK forms the same request; only the documented policy inputs are added.
    const untouched = await call();
    assert.equal(untouched.options.maxTokens, 96, "a compliant cap is not replaced by the allowance");
    assert.equal(untouched.options.messages, messages, "messages are never rebuilt");
    assert.equal(untouched.options.tools, tools, "tools are never rebuilt");
    assert.deepEqual(Object.keys(untouched.options).sort(), [...Object.keys(options), "maxRetries"].sort());
    assert.equal(untouched.options.maxRetries, 0);
    assert.equal(untouched.model.maxTokens, 96, "the SDK output cap stays what the caller asked for");
    assert.deepEqual({ ...untouched.model, maxTokens: undefined, compat: undefined }, { ...model, maxTokens: undefined, compat: undefined });
    assert.equal(untouched.options.apiKey, "synthetic-main-token");

    // Over budget: the same call becomes compliant instead of being refused later.
    state.remaining = 64;
    const clamped = await call();
    assert.equal(clamped.options.maxTokens, 64);
    assert.equal(clamped.model.maxTokens, 64);
    assert.equal(clamped.options.messages, messages);
    assert.equal(clamped.model.compat.supportsUsageInStreaming, true, "OpenAI chat usage is requested so settlement stays exact");
    assert.equal(options.maxTokens, 96, "the caller's frozen options are not mutated");
    assert.equal(model.maxTokens, 256, "the caller's frozen model is not mutated");

    // No finite budget: the exact objects the SDK received are returned.
    state.remaining = null;
    state.policyRequired = false;
    const unlimited = await call();
    assert.equal(unlimited.model, model);
    assert.equal(unlimited.options, options);
  } finally {
    await upstream.close();
  }
});
