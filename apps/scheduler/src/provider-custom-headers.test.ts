import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";
import { extractBaseUrlFromSettings } from "./provider-settings.js";
import {
  composeUpstreamRequestHeaders,
  isForbiddenProviderHeader,
  hasInvalidProviderHeaders,
  PROVIDER_CUSTOM_HEADER_LIMITS,
  providerCustomHeadersFromSettings,
  sanitizeProviderCustomHeaders,
} from "./provider-custom-headers.js";

// #918: a credential may configure extra upstream request headers (traffic labels, relay
// routing keys). The Gateway used to drop them, so the configured route attribute never
// reached the upstream while the health probe did not even try.

test("configured provider headers are lower-cased and preserved", () => {
  const { headers, rejected } = sanitizeProviderCustomHeaders({ "X-Traffic-Type": " eval " });
  assert.deepEqual(headers, { "x-traffic-type": " eval " });
  assert.deepEqual(rejected, []);
});

test("authentication, framing and exact controls are consumed; business protocol headers remain", () => {
  const forbidden = ["authorization", "x-api-key", "api-key", "anthropic-api-key",
    "proxy-authorization", "host", "content-length", "connection", "transfer-encoding",
    "x-deepsonar-job", "x-deepsonar-workload", "x-deepsonar-request-id"];
  for (const name of forbidden) {
    const resolution = sanitizeProviderCustomHeaders({ [name]: "synthetic" });
    assert.deepEqual(resolution.headers, {});
    assert.deepEqual(resolution.rejected, [`forbidden:${name}`]);
    assert.equal(hasInvalidProviderHeaders(resolution), false);
  }
  const allowed = { "content-type": "application/json", accept: "*/*", "accept-encoding": "gzip",
    "user-agent": "fixture-cli", "x-app": "fixture", "anthropic-version": "2023-06-01",
    "anthropic-beta": "new-feature", "anthropic-future-extension": "yes", "proxy-business": "yes",
    "x-deepsonar-business-extension": "yes", "x-traffic-type": "eval", cookie: "route=fixture",
    "x-empty": "" };
  assert.deepEqual(sanitizeProviderCustomHeaders(allowed), { headers: allowed, rejected: [] });
});

test("Connection nominates additional transport fields without reserving their prefix", () => {
  const resolution = sanitizeProviderCustomHeaders({ Connection: "X-Route, x-transport",
    "X-Route": "hop-only", "x-transport": "hop-only", "x-transport-business": "keep" });
  assert.deepEqual(resolution.headers, { "x-transport-business": "keep" });
  assert.deepEqual(resolution.rejected, ["forbidden:connection", "forbidden:x-route", "forbidden:x-transport"]);
});

test("header injection, illegal names and oversized values are refused", () => {
  const injection = sanitizeProviderCustomHeaders({ "x-evil": "value\r\nx-injected: 1" });
  assert.deepEqual(injection.headers, {}, "CRLF must never reach the upstream");
  assert.deepEqual(injection.rejected, ["invalid_value:x-evil"]);

  const nul = sanitizeProviderCustomHeaders({ "x-nul": "a\u0000b" });
  assert.deepEqual(nul.headers, {});

  const badName = sanitizeProviderCustomHeaders({ "x bad": "1", "x:y": "1", "": "1" });
  assert.deepEqual(badName.headers, {});
  assert.equal(badName.rejected.filter((reason) => reason.startsWith("invalid_name")).length, 3);

  const longName = sanitizeProviderCustomHeaders({ [`x-${"a".repeat(PROVIDER_CUSTOM_HEADER_LIMITS.maxNameLength)}`]: "1" });
  assert.deepEqual(longName.headers, {});

  const longValue = sanitizeProviderCustomHeaders({
    "x-long": "v".repeat(PROVIDER_CUSTOM_HEADER_LIMITS.maxValueLength + 1),
  });
  assert.deepEqual(longValue.headers, {});

  const nonString = sanitizeProviderCustomHeaders({ "x-num": 1, "x-ok": "1" });
  assert.deepEqual(nonString.headers, { "x-ok": "1" });
  assert.deepEqual(nonString.rejected, ["invalid_value:x-num"]);

  const empty = sanitizeProviderCustomHeaders({ "x-empty": "", "x-space": "   " });
  assert.deepEqual(empty.headers, { "x-empty": "", "x-space": "   " });
  for (const resolution of [injection, nul, badName, longName, longValue, nonString]) {
    assert.equal(hasInvalidProviderHeaders(resolution), true);
  }
  for (const value of ["a\u0001b", "a\u007fb", "你好"]) {
    assert.equal(hasInvalidProviderHeaders(sanitizeProviderCustomHeaders({ "x-illegal": value })), true);
  }
  assert.equal(hasInvalidProviderHeaders(sanitizeProviderCustomHeaders({ " x-name ": "value" })), true);
  assert.equal(hasInvalidProviderHeaders(sanitizeProviderCustomHeaders({ "X-Route": "a", "x-route": "b" })), true);
});

test("header count is capped instead of silently truncating", () => {
  const many = Object.fromEntries(
    Array.from({ length: PROVIDER_CUSTOM_HEADER_LIMITS.maxHeaders + 1 }, (_, index) => [`x-h-${index}`, "1"]),
  );
  const capped = sanitizeProviderCustomHeaders(many);
  assert.deepEqual(capped.headers, {});
  assert.deepEqual(capped.rejected, ["too_many_headers"]);
});

test("forbidden helper never reserves business prefixes", () => {
  assert.equal(isForbiddenProviderHeader("X-DeepSonar-Anything"), false);
  assert.equal(isForbiddenProviderHeader("proxy-x"), false);
  assert.equal(isForbiddenProviderHeader("anthropic-anything"), false);
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

test("official Pi wrappers resolve the selected endpoint and headers equally", () => {
  const document = {
    "llm-pi-ai": { providers: {
      a: { baseURL: "http://127.0.0.1:18080/v1", headers: { "x-tenant": "tenant-a" } },
      b: { baseURL: "http://127.0.0.1:18081/v1", headers: { "X-Traffic-Type": "eval", "x-tenant": "tenant-b" } },
    } },
    "agent-default-model": { provider: "b", model: "b-model" },
  };
  for (const settings of [document, { config: document }, { config: stringify(document) }]) {
    assert.equal(extractBaseUrlFromSettings(settings), "http://127.0.0.1:18081/v1");
    assert.deepEqual(providerCustomHeadersFromSettings(settings), {
      headers: { "x-traffic-type": "eval", "x-tenant": "tenant-b" }, rejected: [],
    });
  }
});

test("Pi headers belong to the same first endpoint profile, including empty headers", () => {
  for (const headers of [undefined, {}, { "x-api-key": "must-not-apply" }, { "x-tenant": "tenant-a" }]) {
    const settings = { providers: {
      a: { baseUrl: "http://127.0.0.1:18080/v1", headers },
      b: { baseUrl: "http://127.0.0.1:18081/v1", headers: { "x-tenant": "tenant-b" } },
    } };
    assert.equal(extractBaseUrlFromSettings(settings), "http://127.0.0.1:18080/v1");
    assert.deepEqual(providerCustomHeadersFromSettings(settings).headers,
      headers?.["x-tenant"] ? { "x-tenant": "tenant-a" } : {});
  }
  const settings = { providers: {
    a: { headers: { "x-tenant": "tenant-a" } },
    b: { base_url: "http://127.0.0.1:18081/v1", headers: { "x-tenant": "tenant-b" } },
  } };
  assert.equal(extractBaseUrlFromSettings(settings), "http://127.0.0.1:18081/v1");
  assert.deepEqual(providerCustomHeadersFromSettings(settings).headers, { "x-tenant": "tenant-b" });
});

test("metadata endpoint overrides cannot send another profile's headers upstream", () => {
  const settings = { providers: {
    a: { baseUrl: "http://127.0.0.1:18080/v1", headers: { "x-tenant": "tenant-a" } },
    b: { baseUrl: "http://127.0.0.1:18081/v1", headers: { "x-tenant": "tenant-b" } },
  } };
  assert.deepEqual(providerCustomHeadersFromSettings(settings, "http://127.0.0.1:18080/v1///").headers,
    { "x-tenant": "tenant-a" });
  assert.deepEqual(providerCustomHeadersFromSettings(settings, "http://127.0.0.1:18081/v1"),
    { headers: {}, rejected: ["upstream_endpoint_mismatch"] });
  const official = { "llm-pi-ai": { providers: settings.providers }, "agent-default-model": { provider: "b" } };
  assert.deepEqual(providerCustomHeadersFromSettings({ config: stringify(official) }, "http://127.0.0.1:18080/v1"),
    { headers: {}, rejected: ["upstream_endpoint_mismatch"] });
});

test("equivalent endpoint URLs retain headers while changed targets still reject", () => {
  for (const [configured, effective] of [
    ["HTTP://LOCALHOST:80/v1/", "http://localhost/v1"],
    ["https://LOCALHOST:443/v1", "https://localhost/v1///"],
    ["http://[::1]:80/v1", "http://[::1]/v1"],
  ]) {
    const settings = { providers: { relay: { baseURL: configured, headers: { "x-tenant": "same-route" } } } };
    assert.deepEqual(providerCustomHeadersFromSettings(settings, effective), {
      headers: { "x-tenant": "same-route" }, rejected: [],
    });
  }
  const settings = { providers: { relay: {
    baseURL: "http://localhost:80/v1", headers: { "x-tenant": "same-route" },
  } } };
  for (const other of ["http://localhost:81/v1", "http://localhost/v2", "https://localhost/v1", "http://localhost/v1?route=b", "not-a-url"]) {
    assert.deepEqual(providerCustomHeadersFromSettings(settings, other), {
      headers: {}, rejected: ["upstream_endpoint_mismatch"],
    });
  }
});

test("empty header sets remain ambiguous when no endpoint profile is selected", () => {
  const resolution = providerCustomHeadersFromSettings({ providers: {
    a: {}, b: { headers: { "x-tenant": "tenant-b" } },
  } });
  assert.deepEqual(resolution.headers, {});
  assert.deepEqual(resolution.rejected, ["ambiguous_multi_provider_headers"]);
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