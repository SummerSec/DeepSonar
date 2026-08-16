import assert from "node:assert/strict";
import test from "node:test";

import { clientSocketAddress, schedulerProxyHeaders } from "./web-server.mjs";

test("official Web hop overwrites inbound X-Forwarded-For with the TCP peer", () => {
  assert.equal(clientSocketAddress("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(clientSocketAddress("  198.51.100.7  "), "198.51.100.7");
  assert.equal(clientSocketAddress(""), "");
  const headers = schedulerProxyHeaders(
    { "x-forwarded-for": "1.1.1.1, 2.2.2.2", host: "public.example" },
    "::ffff:203.0.113.9",
  );
  assert.equal(headers["x-forwarded-for"], "203.0.113.9");
  assert.equal(headers.host, "public.example");
  assert.equal("x-forwarded-for" in schedulerProxyHeaders({ "x-forwarded-for": "9.9.9.9" }, ""), false);
});
