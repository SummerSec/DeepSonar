// CI fixture only: turn the locally built image into a genuine loopback OCI
// reference. Never substitute a config ID for a registry manifest digest.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

const repository = "127.0.0.1:15000/om-provider-base";
const origin = "http://127.0.0.1:15000";
const inspect = ref => JSON.parse(execFileSync("docker", ["image", "inspect", ref], { encoding: "utf8" }))[0];
const built = inspect("deepsonar-base:reverse-ci");
assert.match(built.Id, /^sha256:[a-f0-9]{64}$/u);
assert.equal(built.Os, "linux");
assert.ok(["amd64", "arm64"].includes(built.Architecture));
assert.equal(built.Config.Labels["io.deepsonar.image-key"], "deepsonar-base");
const deadline = Date.now() + 30_000;
let ready = false;
while (Date.now() < deadline) {
  try { ready = (await fetch(`${origin}/v2/`, { redirect: "error", signal: AbortSignal.timeout(2000) })).ok; } catch {}
  if (ready) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.ok(ready, "isolated loopback registry must become ready");
execFileSync("docker", ["tag", built.Id, `${repository}:fixture`], { stdio: "inherit" });
execFileSync("docker", ["push", `${repository}:fixture`], { stdio: "inherit", timeout: 600_000 });
const readManifest = async ref => {
  const response = await fetch(`${origin}/v2/om-provider-base/manifests/${ref}`, {
    redirect: "error", signal: AbortSignal.timeout(30_000), headers: { accept: [
      "application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json",
      "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.docker.distribution.manifest.v2+json",
    ].join(", ") },
  });
  assert.equal(response.status, 200, "loopback registry manifest lookup");
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(response.headers.get("docker-content-digest"), digest, "registry header must identify exact manifest bytes");
  if (ref.startsWith("sha256:")) assert.equal(digest, ref);
  return { digest, manifest: JSON.parse(bytes.toString("utf8")) };
};
let selected = await readManifest("fixture");
if (Array.isArray(selected.manifest.manifests)) {
  const matches = selected.manifest.manifests.filter(entry => entry.platform?.os === "linux" && entry.platform?.architecture === built.Architecture);
  assert.equal(matches.length, 1, "one runnable native payload must match the inspected build");
  assert.match(matches[0].digest, /^sha256:[a-f0-9]{64}$/u);
  selected = await readManifest(matches[0].digest);
}
assert.equal(selected.manifest.config?.digest, built.Id, "actual manifest config must be the original locally built image");
const imageRef = `${repository}@${selected.digest}`;
execFileSync("docker", ["pull", imageRef], { stdio: "inherit", timeout: 600_000 });
const pulled = inspect(imageRef);
assert.equal(pulled.Id, built.Id, "immutable pull must retain exact build content");
assert.equal(pulled.Architecture, built.Architecture);
assert.ok(pulled.RepoDigests.includes(imageRef), "Docker must record the genuine registry RepoDigest");
assert.ok(process.env.GITHUB_ENV, "this preparation writes only the current Actions job environment");
appendFileSync(process.env.GITHUB_ENV, `OM_PROVIDER_HEADERS_IMAGE=${imageRef}\nOM_PROVIDER_HEADERS_EXPECTED_CONFIG_ID=${built.Id}\n`);
console.log(JSON.stringify({ loopback_registry_fixture: true, image_ref: imageRef, manifest_digest: selected.digest, config_id: built.Id, architecture: built.Architecture }));
