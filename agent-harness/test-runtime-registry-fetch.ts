import assert from "node:assert/strict";

process.env.DEEPSONAR_RUNTIME_REGISTRY_GITHUB_TOKEN = "test-registry-token";

const registry = {
  schema: "deepsonar.registry/v1",
  images: [{
    image_key: "deepsonar-base",
    name: "DeepSonar Base",
    description: "test",
    publisher: "SummerSec",
    source_kind: "official",
    project_opt_in: false,
    versions: [{
      version: "test",
      image_ref: `ghcr.io/summersec/deepsonar-base@sha256:${"a".repeat(64)}`,
    }],
  }],
};

const calls: Array<{ host: string; authorization: string | null; accept: string | null }> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const headers = new Headers(init?.headers);
  calls.push({
    host: url.hostname,
    authorization: headers.get("authorization"),
    accept: headers.get("accept"),
  });
  if (url.pathname.endsWith("/releases/latest")) {
    return Response.json({
      assets: [{
        name: "runtime-image-registry.json",
        url: "https://api.github.com/repos/SummerSec/DeepSonar/releases/assets/1",
      }],
    });
  }
  if (url.hostname === "api.github.com" && url.pathname.endsWith("/assets/1")) {
    return new Response(null, {
      status: 302,
      headers: { location: "https://objects.githubusercontent.com/runtime-image-registry.json?signature=test" },
    });
  }
  if (url.hostname === "objects.githubusercontent.com") {
    return Response.json(registry);
  }
  throw new Error(`unexpected fetch: ${url}`);
}) as typeof fetch;

const { loadRuntimeImageRegistry } = await import("../apps/scheduler/src/runtime-images.js");
const result = await loadRuntimeImageRegistry({ refreshRemote: true });

assert.equal(result.source, "remote");
assert.equal(result.fallback, false);
assert.equal(result.error, null);
assert.equal(result.images[0]?.versions[0]?.image_ref, registry.images[0]?.versions[0]?.image_ref);
assert.equal(result.images.length, 6, "remote versions must be merged with the bundled six-product skeleton");
assert.deepEqual(calls.map((call) => call.host), [
  "api.github.com",
  "api.github.com",
  "objects.githubusercontent.com",
]);
assert.equal(calls[0]?.authorization, "Bearer test-registry-token");
assert.equal(calls[1]?.authorization, "Bearer test-registry-token");
assert.equal(calls[1]?.accept, "application/octet-stream");
assert.equal(calls[2]?.authorization, null, "GitHub token must be dropped before the asset host redirect");

console.log("runtime registry private-release redirect boundary: ok");
