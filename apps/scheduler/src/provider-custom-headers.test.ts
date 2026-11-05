import assert from "node:assert/strict";
import test from "node:test";
import {
  composeUpstreamRequestHeaders,
  isForbiddenProviderHeader,
  PROVIDER_CUSTOM_HEADER_LIMITS,
  providerCustomHeadersFromSettings,
  sanitizeProviderCustomHeaders,
} from "./provider-custom-headers.js";

// #918: a credential may configure extra upstream request headers (traffic labels, relay
// routing keys). The Gateway used to drop them, so the configured route attribute never
// reached the upstream while the health probe did not even try.

test("configured provider headers are lower-cased and preserved", () => {
  const { headers, rejected } = sanitizeProviderCustomHeaders({ "X-Traffic-Type": " eval " });
  assert.deepEqual(headers, { "x-traffic-type": "eval" });
  assert.deepEqual(rejected, []);
});

test("authentication, framing, transport and control headers cannot be configured", () => {
  const attempt = sanitizeProviderCustomHeaders({
    authorization: "Bearer attacker",
    "x-api-key": "sk-attacker",
    "anthropic-api-key": "deepsonarjob_12345678_leaked",
    "proxy-authorization": "Basic x",
    host: "internal.example",
    "content-length": "1",
    "content-type": "text/plain",
    accept: "*/*",
    connection: "close",
    "transfer-encoding": "chunked",
    "user-agent": "spoofed",
    "x-app": "spoofed",
    "anthropic-version": "1999-01-01",
    "anthropic-beta": "x",
    "x-deepsonar-job": "1",
    "x-traffic-type": "eval",
  });
  assert.deepEqual(attempt.headers, { "x-traffic-type": "eval" });
  for (const name of [
    "authorization",
    "x-api-key",
    "anthropic-api-key",
    "proxy-authorization",
    "host",
    "content-length",
    "content-type",
    "accept",
    "connection",
    "transfer-encoding",
    "user-agent",
    "x-app",
    "anthropic-version",
    "anthropic-beta",
    "x-deepsonar-job",
  ]) {
    assert.ok(attempt.rejected.includes(`forbidden:${name}`), `${name} must be refused`);
  }
});

test("header injection, illegal names and oversized values are refused", () => {
  const injection = sanitizeProviderCustomHeaders({ "x-evil": "value\r\nx-injected: 1" });
  assert.deepEqual(injection.headers, {}, "CRLF must never reach the upstream");
  assert.deepEqual(injection.rejected, ["invalid_value:x-evil"]);

  const nul = sanitizeProviderCustomHeaders({ "x-nul": "a\u0000b" });
  assert.deepEqual(nul.headers, {});

  const badName = sanitizeProviderCustomHeaders({ "x bad": "1", "x:y": "1", "": "1" });
  assert.deepEqual(badName.headers, {});
  assert.equal(badName.rejected.filter((reason) => reason.startsWith("invalid_name:")).length, 3);

  const longName = sanitizeProviderCustomHeaders({ [`x-${"a".repeat(PROVIDER_CUSTOM_HEADER_LIMITS.maxNameLength)}`]: "1" });
  assert.deepEqual(longName.headers, {});

  const longValue = sanitizeProviderCustomHeaders({
    "x-long": "v".repeat(PROVIDER_CUSTOM_HEADER_LIMITS.maxValueLength + 1),
  });
  assert.deepEqual(longValue.headers, {});

  const nonString = sanitizeProviderCustomHeaders({ "x-num": 1, "x-ok": "1" });
  assert.deepEqual(nonString.headers, { "x-ok": "1" });
  assert.deepEqual(nonString.rejected, ["invalid_value:x-num"]);

  const empty = sanitizeProviderCustomHeaders({ "x-empty": "   " });
  assert.deepEqual(empty.headers, {});
});

test("header count is capped instead of silently truncating", () => {
  const many = Object.fromEntries(
    Array.from({ length: PROVIDER_CUSTOM_HEADER_LIMITS.maxHeaders + 1 }, (_, index) => [`x-h-${index}`, "1"]),
  );
  const capped = sanitizeProviderCustomHeaders(many);
  assert.deepEqual(capped.headers, {});
  assert.deepEqual(capped.rejected, ["too_many_headers"]);
});

test("forbidden helper covers prefixes and exact names", () => {
  assert.equal(isForbiddenProviderHeader("X-DeepSonar-Anything"), true);
  assert.equal(isForbiddenProviderHeader("proxy-x"), true);
  assert.equal(isForbiddenProviderHeader("anthropic-anything"), true);
  assert.equal(isForbiddenProviderHeader("x-traffic-type"), false);
});

test("settings resolution reads the official route and Pi provider shapes", () => {
  const official = providerCustomHeadersFromSettings({
    "llm-pi-ai": { providers: { relay: { baseURL: "https://relay.example", headers: { "X-Traffic-Type": "eval" } } } },
  });
  assert.deepEqual(official.headers, { "x-traffic-type": "eval" });

  const flat = providerCustomHeadersFromSettings({ headers: { "X-Tenant": "acme" } });
  assert.deepEqual(flat.headers, { "x-tenant": "acme" });

  const pi = providerCustomHeadersFromSettings({ providers: { relay: { headers: { "X-Route": "a" } } } });
  assert.deepEqual(pi.headers, { "x-route": "a" });

  assert.deepEqual(providerCustomHeadersFromSettings({ env: { ANTHROPIC_BASE_URL: "https://x" } }).headers, {});
  assert.deepEqual(providerCustomHeadersFromSettings(null).headers, {});
});

test("the selected official route decides, and divergent provider routes are refused", () => {
  const selected = providerCustomHeadersFromSettings({
    "llm-pi-ai": { providers: { a: { headers: { "x-route": "a" } }, b: { headers: { "x-route": "b" } } } },
    "agent-default-model": { provider: "b", model: "m" },
  });
  assert.deepEqual(selected.headers, { "x-route": "b" }, "the active route's headers win, never a blend");

  const ambiguous = providerCustomHeadersFromSettings({
    providers: { a: { headers: { "x-route": "a" } }, b: { headers: { "x-route": "b" } } },
  });
  assert.deepEqual(ambiguous.headers, {}, "two different provider header sets for one credential cannot be mixed");
  assert.deepEqual(ambiguous.rejected, ["ambiguous_multi_provider_headers"]);
});

test("compose keeps authentication final and lets configured headers ride below it", () => {
  const headers = composeUpstreamRequestHeaders({
    base: { "content-type": "application/json" },
    protocol: { "anthropic-version": "2023-06-01", "user-agent": "claude-cli/1 (external, cli)", "x-app": "cli" },
    configured: { "x-traffic-type": "eval" },
    inboundProtocol: { "user-agent": "claude-cli/2 (external, cli)" },
    auth: { authorization: "Bearer real", "x-api-key": "real" },
  });
  assert.deepEqual(headers, {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-traffic-type": "eval",
    "user-agent": "claude-cli/2 (external, cli)",
    "x-app": "cli",
    authorization: "Bearer real",
    "x-api-key": "real",
  });

  // A configured header can never displace the server-generated authentication.
  const sanitized = sanitizeProviderCustomHeaders({ authorization: "Bearer attacker" }).headers;
  const final = composeUpstreamRequestHeaders({ configured: sanitized, auth: { authorization: "Bearer real" } });
  assert.equal(final.authorization, "Bearer real");
});