import assert from "node:assert/strict";
import Fastify from "fastify";
import test from "node:test";

import { config } from "./config.js";

test("Scheduler trustProxy hop 1 uses the Web-forwarded client, not the Web socket", async () => {
  assert.equal(config.http.trustProxyHops, 1);
  const app = Fastify({
    logger: false,
    trustProxy: config.http.trustProxyHops > 0 ? config.http.trustProxyHops : false,
  });
  app.post("/echo-ip", async (req) => ({ ip: req.ip }));
  await app.ready();
  try {
    // Official Web overwrites XFF with the inbound TCP peer, then Scheduler
    // trusts exactly one hop (the Web container at remoteAddress).
    const proxied = await app.inject({
      method: "POST",
      url: "/echo-ip",
      headers: { "x-forwarded-for": "203.0.113.9" },
      remoteAddress: "10.0.0.8",
    });
    assert.equal(proxied.statusCode, 200);
    assert.equal(JSON.parse(proxied.body).ip, "203.0.113.9");

    const untrustedExtraHop = await app.inject({
      method: "POST",
      url: "/echo-ip",
      headers: { "x-forwarded-for": "8.8.8.8, 9.9.9.9" },
      remoteAddress: "10.0.0.8",
    });
    assert.equal(
      JSON.parse(untrustedExtraHop.body).ip,
      "9.9.9.9",
      "only the last hop before Scheduler is trusted; extra proxies collapse the IP bucket",
    );
  } finally {
    await app.close();
  }
});
