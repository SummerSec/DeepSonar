// Offline regression for #845 defect 2: hosts without docker buildx (podman/buildah)
// must still be able to verify a release catalog at equal strength.
//
// The fallback is Registry v2 + content addressing, so these tests pin:
//   - the body must hash to the requested digest (no trust in the registry's word);
//   - only real manifest media types are accepted;
//   - missing credentials fail closed with one actionable message, never a pass;
//   - buildx stays the primary path and is not bypassed when it works.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspectRegistryManifest, parseRegistryRef } from "./registry-v2-manifests.mjs";
import { inspectRuntimeManifestAsync, isMissingBuildx, runnablePlatformDigests } from "./runtime-platform-manifests.mjs";
import { verifyPlatformReleaseAsync } from "./check-platform-release.mjs";

const sha256 = (value) => `sha256:${createHash("sha256").update(Buffer.from(value)).digest("hex")}`;
/** Fixture documents are generated in this file; surface a broken fixture instead of
 * letting a bare JSON.parse failure look like a verification bug. */
const parseFixture = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`fixture document is not JSON: ${String(value).slice(0, 80)}`);
  }
};
const INDEX_MEDIA = "application/vnd.oci.image.index.v1+json";

function indexDocument(childDigests) {
  const body = JSON.stringify({ schemaVersion: 2, mediaType: INDEX_MEDIA, manifests: childDigests.map((digest, position) => ({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest,
    size: 1000 + position,
    platform: { os: "linux", architecture: position === 0 ? "amd64" : "arm64" },
  })) });
  return { body, digest: sha256(body) };
}

const response = ({ status = 200, body = "", mediaType = INDEX_MEDIA, headers = {} } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => (name.toLowerCase() === "content-type" ? mediaType : headers[name.toLowerCase()] ?? null) },
  arrayBuffer: async () => Buffer.from(body),
  json: async () => JSON.parse(Buffer.from(body).toString("utf8")),
});

test("references must be immutable, and the registry host is part of the identity", () => {
  assert.deepEqual(parseRegistryRef("ghcr.io/summersec/deepsonar-web@sha256:" + "a".repeat(64)), {
    registry: "ghcr.io", repository: "summersec/deepsonar-web", digest: `sha256:${"a".repeat(64)}`,
  });
  for (const ref of [
    "ghcr.io/summersec/deepsonar-web:0.6.4",
    "ghcr.io/summersec/deepsonar-web@sha256:abc",
    "deepsonar-web@sha256:" + "a".repeat(64),
    "https://ghcr.io/summersec/deepsonar-web@sha256:" + "a".repeat(64),
    "ghcr.io/summersec/deep sonar@sha256:" + "a".repeat(64),
  ]) assert.throws(() => parseRegistryRef(ref), ref);
});

test("a verified manifest is accepted only when its bytes hash to the requested digest", async () => {
  const { body, digest } = indexDocument([`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`]);
  const ref = `ghcr.io/summersec/deepsonar-web@${digest}`;
  const manifest = await inspectRegistryManifest(ref, { fetchImpl: async () => response({ body }) });
  assert.equal(manifest.manifests.length, 2);
  assert.deepEqual(runnablePlatformDigests(manifest, ["linux/amd64", "linux/arm64"]), {
    "linux/amd64": `sha256:${"1".repeat(64)}`,
    "linux/arm64": `sha256:${"2".repeat(64)}`,
  });
});

test("a registry that serves the wrong bytes is rejected, not trusted", async () => {
  const { digest } = indexDocument([`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`]);
  const ref = `ghcr.io/summersec/deepsonar-web@${digest}`;
  await assert.rejects(
    inspectRegistryManifest(ref, { fetchImpl: async () => response({ body: '{"tampered":true}' }) }),
    (error) => error.code === "REGISTRY_DIGEST_MISMATCH" && /served sha256:.+for requested/u.test(error.message),
  );
});

test("a non-manifest content type cannot pass as an index", async () => {
  const { body, digest } = indexDocument([`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`]);
  await assert.rejects(
    inspectRegistryManifest(`ghcr.io/summersec/deepsonar-web@${digest}`, {
      fetchImpl: async () => response({ body, mediaType: "text/html" }),
    }),
    (error) => error.code === "REGISTRY_MEDIA_TYPE_UNEXPECTED",
  );
});

test("an anonymous pull challenge is completed with its bearer token", async () => {
  const { body, digest } = indexDocument([`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`]);
  const ref = `ghcr.io/summersec/deepsonar-web@${digest}`;
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, authorization: init.headers?.Authorization ?? null });
    if (url.startsWith("https://ghcr.io/token")) return response({ body: JSON.stringify({ token: "anonymous-pull-token" }), mediaType: "application/json" });
    if (init.headers?.Authorization !== "Bearer anonymous-pull-token") {
      return response({ status: 401, mediaType: "application/json", headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:summersec/deepsonar-web:pull"' } });
    }
    return response({ body });
  };
  assert.equal((await inspectRegistryManifest(ref, { fetchImpl })).schemaVersion, 2);
  assert.equal(seen.length, 3, "manifest, token, manifest-with-token");
  assert.match(seen[1].url, /service=ghcr\.io/u);
});

test("missing credentials fail closed with one actionable message", async () => {
  const { digest } = indexDocument([`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`]);
  const fetchImpl = async (url) => url.startsWith("https://ghcr.io/token")
    ? response({ status: 403, mediaType: "application/json" })
    : response({ status: 401, mediaType: "application/json", headers: { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' } });
  await assert.rejects(
    inspectRegistryManifest(`ghcr.io/summersec/deepsonar-web@${digest}`, { fetchImpl }),
    (error) => error.code === "REGISTRY_AUTH_REQUIRED" && /buildx/u.test(error.message),
  );
});

test("an unreachable registry says so instead of implying a bad image", async () => {
  const { digest } = indexDocument([`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`]);
  await assert.rejects(
    inspectRegistryManifest(`crpi-example.cn-hangzhou.personal.cr.aliyuncs.com/summersec/deepsonar-web@${digest}`, {
      fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); },
    }),
    (error) => error.code === "REGISTRY_UNREACHABLE" && /outbound HTTPS/u.test(error.message),
  );
});

test("buildx is preferred; the registry fallback only runs when buildx is absent", async () => {
  const { body, digest } = indexDocument([`sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`]);
  const ref = `ghcr.io/summersec/deepsonar-web@${digest}`;

  let fetched = 0;
  const buildxWorks = () => JSON.stringify({ schemaVersion: 2, manifests: [] });
  const viaBuildx = await inspectRuntimeManifestAsync(ref, {
    run: () => buildxWorks(),
    fetchImpl: async () => { fetched += 1; return response({ body }); },
  });
  assert.deepEqual(viaBuildx, { schemaVersion: 2, manifests: [] });
  assert.equal(fetched, 0, "a working buildx must never hit the registry API");

  const buildxMissing = () => { throw Object.assign(new Error("Command failed: docker buildx imagetools inspect --raw"), { stderr: "unknown flag: --raw" }); };
  const viaRegistry = await inspectRuntimeManifestAsync(ref, { run: buildxMissing, fetchImpl: async () => response({ body }) });
  assert.equal(viaRegistry.manifests.length, 2);

  // A real image problem must not silently downgrade to the registry path.
  const otherFailure = () => { throw Object.assign(new Error("docker failed"), { stderr: "manifest unknown" }); };
  await assert.rejects(inspectRuntimeManifestAsync(ref, { run: otherFailure, fetchImpl: async () => response({ body }) }),
    (error) => /manifest unknown/u.test(`${error.stderr ?? ""}${error.message}`));
  assert.equal(isMissingBuildx({ stderr: "unknown flag: --raw" }), true);
  assert.equal(isMissingBuildx({ stderr: "manifest unknown" }), false);
});

test("the async release verification keeps platform and child-digest checks", async () => {
  const child = { "linux/amd64": `sha256:${"1".repeat(64)}`, "linux/arm64": `sha256:${"2".repeat(64)}` };
  const { body, digest } = indexDocument(Object.values(child));
  const catalog = {
    platform_version: "0.6.4",
    platform: {
      version: "0.6.4", commit_sha: "a".repeat(40), schema_version: 67,
      images: Object.fromEntries(["scheduler", "web", "image-admission"].map((service) => [service, {
        digest,
        platforms: ["linux/amd64", "linux/arm64"],
        child_digests: {...child},
        registry_refs: { github: `ghcr.io/summersec/deepsonar-${service}@${digest}` },
        registry_evidence: {
          github: { available: true, ref: `ghcr.io/summersec/deepsonar-${service}@${digest}`, inspect_digest: digest, provenance: "build-push+inspect" },
          dockerhub: { available: false, provenance: "unavailable", reason: "credentials_missing" },
          "aliyun-acr": { available: false, provenance: "unavailable", reason: "credentials_missing" },
        },
      }])),
    },
  };
  const inspect = async () => runnablePlatformDigests(parseFixture(body), ["linux/amd64", "linux/arm64"]);
  await verifyPlatformReleaseAsync(catalog, inspect);

  const tampered = structuredClone(catalog);
  tampered.platform.images.web.child_digests["linux/arm64"] = `sha256:${"9".repeat(64)}`;
  await assert.rejects(verifyPlatformReleaseAsync(tampered, inspect), /web github platform payload mismatch/u);
});