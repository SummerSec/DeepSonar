// #1036 D: installed Pi + production main extension + actual SDK over loopback.
// The authenticated Gateway responses are fixtures, NOT SQL admission/effect proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePiPackage } from "../pi-image-packaging.mjs";
import { loadBoundaries } from "./pi-om-real-rpc.mjs";
import { RpcClient } from "./pi-rpc-client.mjs";

const TOKEN = "synthetic-native-main-token";
const MODEL = "native-recovery-model";
const PROVIDER = "native-recovery-provider";
const IMAGE_POLICY = "/opt/deepsonar/request-budget-source/pi-main-request-budget.ts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const sha256 = value => createHash("sha256").update(value).digest("hex");

async function gatewayFixture(scenario) {
  const calls = [], lookups = [], errors = [];
  let exhausted = false;
  let allowances = 0;
  const server = createServer(async (req, res) => {
    const json = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    try {
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      if (req.method === "GET" && req.url === "/gateway/_allowance") {
        allowances++;
        // Match the real safety boundary: a failed request with unknown usage
        // cannot acquire another allowance, even if Pi's native retry asks again.
        if (scenario !== "no-start" && calls.length) {
          json(409, { error: { type: "JOB_TOKEN_USAGE_UNKNOWN", message: "usage requires reconciliation" } });
        } else json(200, { policy_required: true, remaining_tokens: exhausted ? 0 : 64 });
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/gateway/_settlement/")) {
        const id = req.url.slice("/gateway/_settlement/".length);
        assert.match(id, UUID);
        assert.equal(id, calls[0]?.request_id, "lookup must authenticate the exact failed request UUID");
        lookups.push(id);
        if (scenario === "lookup-denied") json(403, { error: { type: "workload_scope_mismatch" } });
        else if (scenario === "unknown") json(200, { status: "unknown" });
        else json(200, { status: "not_started", reason: scenario === "wrong-reason" ? "quota_exhausted" : "gateway_transient" });
        return;
      }
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/main/chat/completions");
      assert.ok(calls.length < 2, "no uncontrolled replay or opaque SDK HTTP retry");
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length; assert.ok(size <= 1024 * 1024, "bounded synthetic request");
        chunks.push(Buffer.from(chunk));
      }
      const bodyBytes = Buffer.concat(chunks), body = JSON.parse(bodyBytes.toString("utf8"));
      const id = req.headers["x-deepsonar-request-id"];
      assert.match(id ?? "", UUID);
      assert.equal(body.model, MODEL);
      assert.equal(body.stream, true);
      assert.equal(body.stream_options?.include_usage, true);
      assert.equal(body.max_completion_tokens ?? body.max_tokens, 64);
      const retryOf = req.headers["x-deepsonar-retry-of"] ?? null;
      if (!calls.length) assert.equal(retryOf, null);
      else {
        assert.equal(scenario, "no-start");
        assert.equal(retryOf, calls[0].request_id);
        assert.notEqual(id, retryOf, "recovery prepares a new correlated request, never replays the old UUID");
        assert.equal(sha256(bodyBytes), calls[0].body_sha256, "no-start recovery retains the business input");
      }
      calls.push({ request_id: id, retry_of: retryOf, body_sha256: sha256(bodyBytes) });
      if (calls.length === 1) {
        // The same carrier is used for every case. Only the authenticated
        // lookup, not HTTP 503 or this body, can authorize the second request.
        const carrier = { type: "gateway_transient", effect_status: "not_started", message: "synthetic no-start claim" };
        json(503, { error: { ...carrier, message: JSON.stringify(carrier) } });
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish_reason = null, usage) => {
        const payload = { id: "native-recovered", object: "chat.completion.chunk", created: 1, model: MODEL,
          choices: [{ index: 0, delta, finish_reason }] };
        if (usage) payload.usage = usage;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      chunk({ role: "assistant", content: "NATIVE_MAIN_RECOVERED" });
      chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
      res.end("data: [DONE]\n\n");
    } catch (error) {
      errors.push(error instanceof Error ? error.name : "FixtureError");
      if (!res.headersSent) json(500, { error: { type: "fixture_assertion_failed" } });
      else res.end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { calls, lookups, errors, url: `http://127.0.0.1:${server.address().port}`,
    exhaust: () => { exhausted = true; }, allowances: () => allowances,
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}

function assertNativeSettlementRefusal(records, allowanceReads, scenario) {
  const first = records.find(record => record.type === "message_end" && record.message?.role === "assistant");
  assert.equal(first?.message.stopReason, "error");
  const message = "settlement refusal must preserve its production diagnostic, not an internal allowance rejection";
  if (scenario === "lookup-denied") {
    const prefix = "PI_MAIN_BUDGET_REQUEST_FAILED; diagnostic=";
    assert.ok(first.message.errorMessage.startsWith(prefix), message);
    assert.deepEqual(JSON.parse(first.message.errorMessage.slice(prefix.length)), {
      version: 1, stage: "settlement", category: "permanent_failure", status: 403,
    }, message);
  } else assert.match(first.message.errorMessage, /synthetic no-start claim/u, message);
  const nativeRetries = records.filter(record => record.type === "auto_retry_start").length;
  assert.equal(allowanceReads, 1 + nativeRetries,
    "only an explicit native retry may read another allowance after settlement refusal");
}

export async function runNativePiMainRecovery() {
  assert.equal(process.env.DEEPSONAR_PI_IMAGE_PROOF, "1", "native recovery must use the built image, not a host SDK delegate");
  const { executable, metadata } = resolvePiPackage();
  assert.equal(metadata.version, "1.5.2");
  const source = readFileSync(IMAGE_POLICY, "utf8");
  const expected = readFileSync(path.join(process.env.DEEPSONAR_RPC_BOUNDARY_DIR, "pi-main-request-budget.ts"), "utf8");
  assert.equal(sha256(source), sha256(expected), "installed main policy must match the current checkout");
  const root = mkdtempSync(path.join(tmpdir(), "native-pi-main-recovery-"));
  const reports = [];
  try {
    const boundary = await loadBoundaries(root);
    // Materialize the unmodified production-generated extension from installed
    // source. Pi's real loader resolves the public compat SDK import itself.
    const policyModule = path.join(root, "policy.mjs");
    writeFileSync(policyModule, stripTypeScriptTypes(source, { mode: "transform" }));
    const { PI_MAIN_REQUEST_BUDGET_SOURCE } = await import(pathToFileURL(policyModule).href);
    const extension = path.join(root, "main-request-budget.mjs");
    writeFileSync(extension, PI_MAIN_REQUEST_BUDGET_SOURCE);
    // Test-only negative control: still use the real CLI/SDK and authenticated
    // lookup, but deliberately accept both non-200 and invalid status/reason.
    // This copy is NEVER the production-path proof above or an installed file.
    let mutantSource = PI_MAIN_REQUEST_BUDGET_SOURCE;
    for (const [from, to] of [
      ["if (response.status !== 200) { await response.body?.cancel(); throw { status: response.status }; }",
        "if (response.status !== 200) { await response.body?.cancel(); return true; }"],
      ["return value?.status === 'not_started' && value.reason === 'gateway_transient';", "return true;"],
    ]) {
      assert.equal(mutantSource.split(from).length, 2, "mutation must target exactly one production guard");
      mutantSource = mutantSource.replace(from, to);
    }
    const mutantExtension = path.join(root, "settlement-mutant.mjs");
    writeFileSync(mutantExtension, mutantSource);
    const cases = ["no-start", "unknown", "wrong-reason", "lookup-denied"].flatMap(scenario =>
      (scenario === "no-start" ? [false] : [false, true]).map(mutated => ({ scenario, mutated })));
    for (const { scenario, mutated } of cases) {
      const caseId = `${scenario}${mutated ? "-mutant" : ""}`;
      const home = path.join(root, caseId, "home"), workspace = path.join(root, caseId, "workspace");
      mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true });
      const gateway = await gatewayFixture(scenario);
      let client;
      try {
        // Keep Pi's normal retry settings: the production wrapper's maxRetries=0
        // controls SDK HTTP retries; subsequent native retries must re-read allowance.
        writeFileSync(path.join(home, "models.json"), JSON.stringify({ providers: { [PROVIDER]: {
          baseUrl: `${gateway.url}/main`, api: "openai-completions", apiKey: TOKEN,
          models: [{ id: MODEL, name: MODEL, reasoning: false, input: ["text"], maxTokens: 128, contextWindow: 1000000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        } } }));
        client = new RpcClient(executable, ["--provider", PROVIDER, "--model", MODEL, "-e", mutated ? mutantExtension : extension], {
          cwd: workspace, env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home,
            DEEPSONAR_GATEWAY_TOKEN: TOKEN, DEEPSONAR_REQUEST_POLICY_UPSTREAM: `${gateway.url}/gateway` },
        }, boundary.PiJsonlFramer, line => boundary.parsePiJsonlRecord(line, 8 * 1024 * 1024));
        const before = await client.command("get_state");
        assert.equal(before.success, true); assert.ok(before.data.sessionId);
        const pid = client.child.pid;
        await client.turn("Exercise the synthetic native no-start recovery boundary.");
        assert.deepEqual(gateway.errors, []);
        assert.equal(gateway.lookups.length, 1);
        const ends = client.records.filter(record => record.type === "message_end" && record.message?.role === "assistant");
        if (scenario === "no-start") {
          assert.equal(gateway.calls.length, 2);
          assert.equal(gateway.allowances(), 2, "both model generations negotiate the original allowance");
          assert.equal(client.records.filter(record => record.type === "message_start" && record.message?.role === "assistant").length, 1,
            "no-start must not duplicate the assistant's native message_start");
          assert.equal(ends.length, 1); assert.equal(ends[0].message.stopReason, "stop");
          assert.ok(ends[0].message.content.some(part => part.type === "text" && part.text === "NATIVE_MAIN_RECOVERED"));
          assert.equal(client.records.some(record => record.type === "message_update" && record.assistantMessageEvent?.type === "error"), false);
          gateway.exhaust();
          await client.turn("This next turn has no remaining allowance.");
          assert.equal(gateway.calls.length, 2, "successful recovery must not cache or reset the allowance");
          assert.ok(client.records.some(record => record.type === "message_end" && record.message?.stopReason === "error"
            && record.message.errorMessage === "PI_MAIN_BUDGET_EXHAUSTED"));
        } else {
          assert.equal(gateway.calls.length, 1, "unconfirmed no-start cannot issue another model request");
          if (mutated) {
            assert.throws(() => assertNativeSettlementRefusal(client.records, gateway.allowances(), scenario), {
              code: "ERR_ASSERTION", message: /settlement refusal must preserve its production diagnostic/u,
            }, "a permissive settlement mutation must not pass the native refusal oracle");
            const nativeRetries = client.records.filter(record => record.type === "auto_retry_start").length;
            assert.ok(gateway.allowances() > 1 + nativeRetries, "mutation must expose the hidden internal recovery request");
          } else assertNativeSettlementRefusal(client.records, gateway.allowances(), scenario);
        }
        const after = await client.command("get_state");
        assert.equal(after.success, true); assert.equal(after.data.sessionId, before.data.sessionId);
        assert.equal(client.child.pid, pid); assert.equal(client.child.exitCode, null, "same live CLI, no process restart");
        assert.equal(client.records.some(record => record.type === "extension_error"), false, "loader failure cannot satisfy a negative case");
        assert.deepEqual(gateway.errors, []);
        reports.push({ scenario, policy_variant: mutated ? "settlement-acceptance-mutant" : "production",
          status: mutated ? "rejected-as-expected" : "passed",
          extension_sha256: sha256(mutated ? mutantSource : PI_MAIN_REQUEST_BUDGET_SOURCE),
          model_requests: gateway.calls.length, authenticated_lookups: gateway.lookups.length,
          allowance_reads: gateway.allowances(), same_live_session: true, requests: gateway.calls });
      } finally { await client?.stop(); await gateway.close(); }
    }
    return { schema: "deepsonar.native-pi-main-recovery/v1", status: "passed", pi_version: metadata.version,
      policy_sha256: sha256(source), scenarios: reports,
      boundary: "installed Pi/SDK/production extension; synthetic authenticated Gateway; no SQL ledger or Job lifecycle proof" };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
