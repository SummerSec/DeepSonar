import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Fastify from "fastify";
import { parseProjectExportRequest } from "./export-request.js";

test("illegal and unknown export selectors return 400 with rejected values", async (t) => {
  const app = Fastify({ logger: false });
  app.post("/projects/:id/exports", async (req, reply) => {
    const parsed = parseProjectExportRequest(req.body);
    if (!parsed.ok) return reply.code(parsed.status).send(parsed.body);
    return parsed.body;
  });
  t.after(() => app.close());

  const post = (modules: string[]) =>
    app.inject({
      method: "POST",
      url: "/projects/11111111-1111-4111-8111-111111111111/exports",
      payload: { preset: "custom", modules },
    });

  for (const selector of ["constructor", "toString", "valueOf", "__proto__"]) {
    const response = await post([selector]);
    assert.equal(response.statusCode, 400, selector);
    const body = response.json<{ error: string; error_code: string; rejected: string[] }>();
    assert.equal(body.error_code, "UNKNOWN_EXPORT_MODULES");
    assert.deepEqual(body.rejected, [selector]);
    assert.match(body.error, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const unknown = await post(["finding", "reports", "artifacts"]);
  assert.equal(unknown.statusCode, 400);
  const unknownBody = unknown.json<{ error: string; error_code: string; rejected: string[] }>();
  assert.equal(unknownBody.error_code, "UNKNOWN_EXPORT_MODULES");
  assert.deepEqual(unknownBody.rejected, ["finding", "reports", "artifacts"]);
  assert.match(unknownBody.error, /finding, reports, artifacts/);

  const accepted = parseProjectExportRequest({ preset: "custom", modules: ["findings"] });
  assert.equal(accepted.ok, true);
});

test("project export route uses the shared request parser before resolveModules", () => {
  const source = readFileSync(new URL("../domains/transfer/routes.ts", import.meta.url), "utf8");
  assert.match(source, /parseProjectExportRequest/);
  assert.match(source, /reply\.code\(parsed\.status\)\.send\(parsed\.body\)/);
  assert.doesNotMatch(source, /m in MODULE_DEPS/);
});
