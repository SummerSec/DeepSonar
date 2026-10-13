import assert from "node:assert/strict";
import test from "node:test";
import { publishReverseRuntime } from "./publish-reverse-runtime.mjs";
const digest = (n) => `sha256:${n.toString(16).padStart(64, "0")}`;
const root = digest(20);
const tags = ["ghcr.io/example/deepsonar-reverse:0.1.0", "docker.io/example/deepsonar:reverse-0.1.0"];
const platformSources = { "linux/amd64": `ghcr.io/example/deepsonar-reverse@${digest(1)}`, "linux/arm64": `ghcr.io/example/deepsonar-reverse@${digest(2)}` };
const index = (entries) => ({ manifests: Object.entries(entries).map(([platform, value]) => ({
  digest: value, mediaType: "application/vnd.oci.image.manifest.v1+json", platform: { os: "linux", architecture: platform.split("/")[1] },
})) });
function fixture(existing = new Map()) {
  const payload = { "linux/amd64": digest(11), "linux/arm64": digest(12) };
  const manifests = new Map(Object.entries(platformSources).map(([platform, ref]) => [ref, index({ [platform]: payload[platform] })]));
  for (const tag of tags) manifests.set(`${tag.slice(0, tag.lastIndexOf(":"))}@${root}`, index(payload));
  const creates = [];
  return { platformSources, tags, manifests, creates, existing,
    readTag(tag) { return existing.get(tag) ?? null; },
    inspectManifest(ref) { assert.ok(manifests.has(ref), ref); return manifests.get(ref); },
    create(value) { creates.push(value); value.tags.forEach((tag) => existing.set(tag, root)); },
  };
}
test("new publication assembles exact children then copies the canonical index", () => {
  const f = fixture(); assert.equal(publishReverseRuntime(f), root); assert.equal(f.creates.length, 2);
  assert.deepEqual(f.creates[0].sources, Object.keys(platformSources).map((platform, i) => `ghcr.io/example/deepsonar-reverse@${digest(11 + i)}`));
  assert.deepEqual(f.creates[1].sources, [`ghcr.io/example/deepsonar-reverse@${root}`]);
});
test("all existing identical index tags are left untouched", () => {
  const f = fixture(new Map(tags.map((tag) => [tag, root]))); assert.equal(publishReverseRuntime(f), root); assert.equal(f.creates.length, 0);
});
test("existing matching index is preserved while only a missing mirror is copied", () => {
  const f = fixture(new Map([[tags[0], root]])); assert.equal(publishReverseRuntime(f), root); assert.equal(f.creates.length, 1);
  assert.deepEqual(f.creates[0], { tags: [tags[1]], sources: [`ghcr.io/example/deepsonar-reverse@${root}`] });
});
test("same payload with different existing index digests cannot move immutable tags", () => {
  const f = fixture(new Map([[tags[0], root], [tags[1], digest(21)]]));
  assert.throws(() => publishReverseRuntime(f), /different immutable index/); assert.equal(f.creates.length, 0);
});
test("different existing payload is rejected before any publication", () => {
  const f = fixture(new Map([[tags[1], root]])); f.manifests.set(`docker.io/example/deepsonar@${root}`, index({ "linux/amd64": digest(99), "linux/arm64": digest(12) }));
  assert.throws(() => publishReverseRuntime(f), /does not match native-tested/); assert.equal(f.creates.length, 0);
});
test("tag inspection failure is not absence", () => {
  const f = fixture(); f.readTag = () => { throw new Error("registry denied"); };
  assert.throws(() => publishReverseRuntime(f), /registry denied/); assert.equal(f.creates.length, 0);
});
test("a tag appearing with a different digest before write is rejected", () => {
  const f = fixture(new Map([[tags[0], root]])); let reads = 0;
  f.readTag = (tag) => tag === tags[0] ? root : ++reads === 1 ? null : digest(30);
  assert.throws(() => publishReverseRuntime(f), /appeared with another immutable digest/); assert.equal(f.creates.length, 0);
});
