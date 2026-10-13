import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  inspectRuntimeManifest, inspectRuntimePlatformDigests,
  parsePlatformSources, resolveRuntimePlatformSources, samePlatformDigests,
} from "./runtime-platform-manifests.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const fail = (message) => { throw new Error(`publish-reverse-runtime: ${message}`); };
function repository(tag) {
  if (typeof tag !== "string" || /\s|@|:\/\//.test(tag) || tag.lastIndexOf(":") <= tag.lastIndexOf("/")) {
    fail("an explicit registry tag is required");
  }
  return tag.slice(0, tag.lastIndexOf(":"));
}

export function inspectTag(tag) {
  const result = spawnSync("docker", ["buildx", "imagetools", "inspect", tag, "--format", "{{.Manifest.Digest}}"],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
  if (result.status === 0 && digestPattern.test(result.stdout.trim())) return result.stdout.trim();
  const message = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (!result.error && result.status !== 0 &&
      /manifest unknown|manifest_unknown|not found/i.test(message) &&
      !/unauthori[sz]ed|denied|forbidden|timeout|timed out|credential|connection/i.test(message)) return null;
  fail(`cannot inspect intended tag ${tag}; refusing to treat an inspection failure as absence`);
}

function createIndex({ tags, sources, annotations = [] }) {
  const args = ["buildx", "imagetools", "create", "--prefer-index=false",
    ...annotations.flatMap((value) => ["--annotation", value]),
    ...tags.flatMap((value) => ["--tag", value]), ...sources];
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) fail("registry index publication failed; no descriptor may be emitted");
}

// Existing version/SHA tags are immutable, including their index wrapper.
// Equal child payloads permit reusing that exact index, never retagging it.
// Probe every configured destination before the first write. Missing optional
// channels are omitted by the caller; failed configured channels fail closed.
export function publishReverseRuntime({ platformSources, tags, annotations = [],
  inspectManifest = inspectRuntimeManifest, readTag = inspectTag, create = createIndex }) {
  if (!Array.isArray(tags) || tags.length === 0 || new Set(tags).size !== tags.length) fail("unique intended tags are required");
  tags.forEach(repository);
  const { platformDigests, sourceRefs } = resolveRuntimePlatformSources(platformSources, inspectManifest);
  if (Object.keys(platformDigests).sort().join(",") !== "linux/amd64,linux/arm64") fail("both tested native platforms are required");
  const existing = new Map(tags.map((tag) => [tag, readTag(tag)]));
  let digest = null;
  let source = null;
  for (const [tag, value] of existing) {
    if (value === null) continue;
    if (!digestPattern.test(value)) fail("tag inspection returned an invalid digest");
    if (digest && digest !== value) fail("intended tags already name different immutable index digests");
    const ref = `${repository(tag)}@${value}`;
    const payload = inspectRuntimePlatformDigests(ref, ["linux/amd64", "linux/arm64"], inspectManifest);
    if (!samePlatformDigests(payload, platformDigests)) fail(`existing immutable tag ${tag} does not match native-tested payloads`);
    digest = value;
    source ??= ref;
  }
  const primary = tags[0];
  if (!digest) {
    create({ tags: [primary], sources: sourceRefs, annotations });
    digest = readTag(primary);
    if (!digestPattern.test(digest ?? "")) fail("new canonical tag is not inspectable");
    source = `${repository(primary)}@${digest}`;
    if (!samePlatformDigests(inspectRuntimePlatformDigests(source, ["linux/amd64", "linux/arm64"], inspectManifest), platformDigests)) {
      fail("new canonical index changed the tested payloads");
    }
    existing.set(primary, digest);
  }
  for (const tag of tags) {
    if (existing.get(tag) === digest) continue;
    // Recheck at write time; another completed publication may have arrived.
    const current = readTag(tag);
    if (current === digest) continue;
    if (current !== null) fail(`intended tag ${tag} appeared with another immutable digest`);
    create({ tags: [tag], sources: [source] }); // no annotations: preserve exact index bytes
    if (readTag(tag) !== digest) fail(`destination ${tag} did not preserve the canonical index digest`);
    if (tag === primary) source = `${repository(primary)}@${digest}`;
  }
  return digest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const values = [process.env.GHCR_TAGS, process.env.ACR_CONFIGURED === "true" ? process.env.ACR_TAGS : "", process.env.DOCKERHUB_TAGS];
  const tags = values.flatMap((value) => (value ?? "").split(/\r?\n/).filter(Boolean));
  const digest = publishReverseRuntime({ platformSources: parsePlatformSources(process.argv.slice(2)), tags,
    annotations: [
      "index:org.opencontainers.image.title=DeepSonar Reverse",
      "index:org.opencontainers.image.description=Project-opt-in pinned REA CLI and Ghidra deep native analysis runtime.",
      "index:org.opencontainers.image.source=https://github.com/SummerSec/DeepSonar",
      "index:org.opencontainers.image.documentation=https://github.com/SummerSec/DeepSonar/blob/main/docs/RELEASE_RUNTIME_IMAGES.md",
      "index:org.opencontainers.image.licenses=LicenseRef-DeepSonar-Proprietary",
    ] });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `digest=${digest}\n`);
  console.log(`Published or preserved Reverse immutable index ${digest}`);
}
